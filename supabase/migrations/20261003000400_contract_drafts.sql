-- Flux DJ Phase 2, step 1 (part 2): contract drafts generated from an
-- approved proposal selection and a published template version.
-- Spec sections 4 ("contracts"), 6 (contract lifecycle) and 9.
--
-- What this step does:
--   * generate_contract_draft renders a contract inside the database from
--     exactly three sources: the published template version, the approved
--     immutable selection (commercial terms) and the client, event and
--     business records as they are at that moment. All three are copied into
--     the contract row, so later template, catalog, client or event edits can
--     never change it.
--   * Every contract row is content-immutable from the moment it is inserted:
--     rendered content, commercial terms, parties, provenance and
--     content_sha256 never change for any role. Only `status` moves, through
--     an explicit transition table.
--   * A draft is "replaced" by inserting a new row (replaces_id points back),
--     never by editing it. At most one draft per event.
--   * When a revised offer supersedes the approved proposal, that proposal's
--     draft contracts become "superseded" in the same transaction.
--
-- What this step does NOT do: sending, signing links, signatures, PDFs,
-- booking, client access or payments. The statuses sent/signed/void exist
-- for the later steps, but no transition into them is permitted yet, so no
-- code path can mark a contract sent. Generating a contract never changes the
-- event's lifecycle and never grants event access.
--
-- content_sha256 is the SHA-256 (hex) of the UTF-8 bytes of the canonical
-- Postgres jsonb text of private.contract_hash_document(...):
--   {"schema_version": 1,
--    "content":    rendered_content     (title and sections exactly as shown),
--    "commercial": commercial_snapshot  (lines, taxes, totals, deposit, balance,
--                                        balance due date, source selection),
--    "parties":    party_snapshot       (business, signer, event, venue),
--    "template":   {"version_id", "content_sha256"} of the template version}
-- It identifies the exact agreement text and the terms it was rendered from.
-- It is computed by the database on insert; any supplied value is ignored.
-- It is unrelated to the later hash of signed PDF bytes.

-- ===========================================================================
-- Composite keys used by contract foreign keys
-- ===========================================================================

alter table public.proposals
  add constraint proposals_tenant_event_id_key unique (tenant_id, event_id, id);
alter table public.proposal_approvals
  add constraint proposal_approvals_tenant_proposal_selection_id_key unique (tenant_id, proposal_id, selection_id, id);

-- ===========================================================================
-- Formatting and rendering helpers (deterministic, locale-independent)
-- ===========================================================================

-- 270191, 'CAD' -> '2,701.91 CAD'
create function private.format_cents(p_cents bigint, p_currency text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case when p_cents < 0 then '-' else '' end
      || to_char(abs(p_cents) / 100, 'FM999,999,999,999,990')
      || '.' || lpad((abs(p_cents) % 100)::text, 2, '0')
      || ' ' || p_currency;
$$;

-- 50000 -> '5%', 99750 -> '9.975%'
create function private.format_rate_ppm(p_ppm bigint)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select rtrim(rtrim(to_char(p_ppm / 10000.0, 'FM9999990.0000'), '0'), '.') || '%';
$$;

-- Replaces each {{key}} with p_values ->> key in a single pass. Substituted
-- values are never scanned again, so a client name containing "{{...}}" is
-- shown literally. Raises if a value is missing (callers check first).
create function private.render_contract_text(p_text text, p_values jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[];
  v_keys text[];
  v_out text;
begin
  v_parts := regexp_split_to_array(p_text, private.contract_placeholder_pattern());
  select coalesce(array_agg(m.match[1] order by m.ord), '{}') into v_keys
  from regexp_matches(p_text, private.contract_placeholder_pattern(), 'g') with ordinality as m(match, ord);
  v_out := v_parts[1];
  for i in 1 .. coalesce(array_length(v_keys, 1), 0) loop
    if p_values ->> v_keys[i] is null then
      raise exception 'contract_render: no value for {{%}}', v_keys[i] using errcode = 'invalid_parameter_value';
    end if;
    v_out := v_out || (p_values ->> v_keys[i]) || v_parts[i + 1];
  end loop;
  return v_out;
end;
$$;

-- Deposit due on signing: 50% of the total including taxes, rounded half up
-- to the cent. The balance is always total - deposit, so the two add up.
create function private.contract_deposit_cents(p_total_cents bigint)
returns bigint
language sql
immutable
strict
set search_path = ''
as $$
  select (p_total_cents * 5000 + 5000) / 10000;
$$;

create function private.contract_hash_document(
  p_rendered jsonb, p_commercial jsonb, p_parties jsonb, p_template_version_id uuid, p_template_content_sha256 text
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'schema_version', 1,
    'content', p_rendered,
    'commercial', p_commercial,
    'parties', p_parties,
    'template', jsonb_build_object('version_id', p_template_version_id, 'content_sha256', p_template_content_sha256)
  );
$$;

create function private.contract_content_sha256(
  p_rendered jsonb, p_commercial jsonb, p_parties jsonb, p_template_version_id uuid, p_template_content_sha256 text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(convert_to(
    private.contract_hash_document(p_rendered, p_commercial, p_parties, p_template_version_id, p_template_content_sha256)::text,
    'UTF8')), 'hex');
$$;

grant execute on function
  private.format_cents(bigint, text),
  private.format_rate_ppm(bigint),
  private.render_contract_text(text, jsonb),
  private.contract_deposit_cents(bigint),
  private.contract_hash_document(jsonb, jsonb, jsonb, uuid, text),
  private.contract_content_sha256(jsonb, jsonb, jsonb, uuid, text)
  to authenticated, service_role;

-- ===========================================================================
-- Contracts
-- ===========================================================================

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  -- Provenance: the exact approval, selection and template version used.
  proposal_id uuid not null,
  selection_id uuid not null,
  approval_id uuid not null,
  template_id uuid not null,
  template_version_id uuid not null,
  template_content_sha256 text not null
    constraint contracts_template_sha256_format check (template_content_sha256 ~ '^[0-9a-f]{64}$'),
  -- draft: current, unsent. replaced: an explicit regeneration replaced it.
  -- superseded: a revised offer replaced the approval it was built from.
  -- sent, signed, void: reserved for later steps; no transition reaches them yet.
  status text not null default 'draft'
    constraint contracts_status_valid check (status in ('draft', 'replaced', 'superseded', 'sent', 'signed', 'void')),
  status_changed_at timestamptz,
  replaces_id uuid,
  -- Expected signer, copied at generation.
  signer_client_id uuid not null,
  signer_name text not null
    constraint contracts_signer_name_length check (length(btrim(signer_name)) between 1 and 200),
  signer_email text not null
    constraint contracts_signer_email_valid check (private.is_valid_email(signer_email)),
  -- Commercial terms (also inside commercial_snapshot), in integer cents.
  currency text not null
    constraint contracts_currency_valid check (currency ~ '^[A-Z]{3}$'),
  total_cents bigint not null
    constraint contracts_total_nonnegative check (total_cents >= 0),
  deposit_cents bigint not null
    constraint contracts_deposit_nonnegative check (deposit_cents >= 0),
  balance_cents bigint not null
    constraint contracts_balance_nonnegative check (balance_cents >= 0),
  -- Entered by staff when the template asks for it; never assumed.
  balance_due_date date,
  rendered_content jsonb not null
    constraint contracts_rendered_shape check (
      jsonb_typeof(rendered_content) = 'object'
      and jsonb_typeof(rendered_content -> 'title') = 'string'
      and jsonb_typeof(rendered_content -> 'sections') = 'array'),
  commercial_snapshot jsonb not null
    constraint contracts_commercial_object check (jsonb_typeof(commercial_snapshot) = 'object'),
  party_snapshot jsonb not null
    constraint contracts_party_object check (jsonb_typeof(party_snapshot) = 'object'),
  content_sha256 text not null
    constraint contracts_content_sha256_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  generated_by_membership_id uuid,
  generated_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contracts_deposit_plus_balance check (deposit_cents + balance_cents = total_cents),
  constraint contracts_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete restrict,
  constraint contracts_proposal_fk foreign key (tenant_id, event_id, proposal_id)
    references public.proposals (tenant_id, event_id, id) on delete restrict,
  constraint contracts_approval_fk foreign key (tenant_id, proposal_id, selection_id, approval_id)
    references public.proposal_approvals (tenant_id, proposal_id, selection_id, id) on delete restrict,
  constraint contracts_template_version_fk foreign key (tenant_id, template_id, template_version_id)
    references public.contract_template_versions (tenant_id, template_id, id) on delete restrict,
  constraint contracts_signer_fk foreign key (tenant_id, signer_client_id)
    references public.clients (tenant_id, id) on delete restrict,
  constraint contracts_generated_by_fk foreign key (tenant_id, generated_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (generated_by_membership_id),
  constraint contracts_replaces_once_key unique (replaces_id),
  constraint contracts_tenant_event_id_key unique (tenant_id, event_id, id),
  constraint contracts_tenant_id_id_key unique (tenant_id, id)
);
alter table public.contracts
  add constraint contracts_replaces_fk foreign key (tenant_id, event_id, replaces_id)
  references public.contracts (tenant_id, event_id, id) on delete restrict;
comment on table public.contracts is
  'Contracts rendered from an approved selection and a published template version. Content, terms and hash never change after insert; only status moves. Staff-only.';
comment on column public.contracts.content_sha256 is
  'SHA-256 of the canonical jsonb text of private.contract_hash_document(rendered_content, commercial_snapshot, party_snapshot, template_version_id, template_content_sha256). Not a PDF hash.';

create unique index contracts_one_draft_per_event_idx on public.contracts (event_id) where status = 'draft';
create index contracts_tenant_event_idx on public.contracts (tenant_id, event_id, created_at);
create index contracts_tenant_proposal_idx on public.contracts (tenant_id, event_id, proposal_id);
create index contracts_tenant_approval_idx on public.contracts (tenant_id, proposal_id, selection_id, approval_id);
create index contracts_tenant_template_version_idx on public.contracts (tenant_id, template_id, template_version_id);
create index contracts_tenant_signer_idx on public.contracts (tenant_id, signer_client_id);
create index contracts_tenant_generated_by_idx on public.contracts (tenant_id, generated_by_membership_id);
create index contracts_tenant_replaces_idx on public.contracts (tenant_id, event_id, replaces_id);

-- ===========================================================================
-- Triggers: freeze on insert, status-only updates, no deletes
-- ===========================================================================

-- On insert: only drafts, only from a published template version and the
-- event's current approved proposal; the database computes the hash.
create function private.contracts_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'draft' then
    raise exception 'contracts are created as drafts' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.contract_template_versions v
    where v.tenant_id = new.tenant_id and v.id = new.template_version_id
      and v.published_at is not null and v.content_sha256 = new.template_content_sha256
  ) then
    raise exception 'contracts can only be generated from a published template version' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.proposals p
    join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
    where p.tenant_id = new.tenant_id and p.id = new.proposal_id
      and p.status = 'approved' and e.active_proposal_id = p.id
  ) then
    raise exception 'contracts can only be generated from the event''s current approved proposal' using errcode = 'check_violation';
  end if;
  new.status_changed_at := null;
  new.content_sha256 := private.contract_content_sha256(
    new.rendered_content, new.commercial_snapshot, new.party_snapshot, new.template_version_id, new.template_content_sha256);
  return new;
end;
$$;
revoke execute on function private.contracts_before_insert() from public, anon, authenticated;
create trigger contracts_before_insert before insert on public.contracts
  for each row execute function private.contracts_before_insert();

create trigger contracts_set_updated_at before update on public.contracts
  for each row execute function private.set_updated_at();
-- Everything except status, status_changed_at, updated_at and the
-- set-null membership reference is frozen for every role.
create trigger contracts_immutable before update on public.contracts
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'proposal_id', 'selection_id', 'approval_id', 'template_id',
    'template_version_id', 'template_content_sha256', 'replaces_id', 'signer_client_id', 'signer_name',
    'signer_email', 'currency', 'total_cents', 'deposit_cents', 'balance_cents', 'balance_due_date',
    'rendered_content', 'commercial_snapshot', 'party_snapshot', 'content_sha256', 'generated_by_user_id',
    'created_at');
create trigger contracts_no_delete before delete on public.contracts
  for each row execute function private.reject_change();

-- Permitted status transitions in this step. Sending, signing and voiding
-- are added by later migrations together with their transactional checks.
create function private.contracts_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (old.status = 'draft' and new.status in ('replaced', 'superseded')) then
      raise exception 'contract cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    new.status_changed_at := now();
  elsif new.status_changed_at is distinct from old.status_changed_at then
    raise exception 'contracts.status_changed_at is set by the database' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger contracts_status_transition before update on public.contracts
  for each row execute function private.contracts_status_transition();

-- A revised offer that supersedes a proposal also supersedes its draft
-- contracts, in the same transaction, so a stale draft can never be used.
create function private.proposals_supersede_contract_drafts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.contracts set status = 'superseded'
    where tenant_id = new.tenant_id and proposal_id = new.id and status = 'draft';
  return null;
end;
$$;
revoke execute on function private.proposals_supersede_contract_drafts() from public, anon, authenticated;
create trigger proposals_supersede_contract_drafts after update of status on public.proposals
  for each row when (new.status = 'superseded' and old.status is distinct from 'superseded')
  execute function private.proposals_supersede_contract_drafts();

-- ===========================================================================
-- Generation (staff; membership checked inside)
-- ===========================================================================

-- Renders a contract draft from an approval and a published template version.
--
-- Returns one of:
--   {"status":"created",   "contract_id", "content_sha256", "replaced_id"}
--   {"status":"replayed",  "contract_id"}   identical draft already exists
--                                           (repeated clicks, or nothing changed)
--   {"status":"incomplete","missing":[{"key","label","hint"}]}  nothing stored
--   {"status":"draft_exists","contract_id"} a different draft exists; pass its
--                                           id as p_replace_contract_id to replace it
--   {"status":"conflict",  "contract_id"}   p_replace_contract_id is not the
--                                           current draft (stale page)
-- Raises (SQLSTATE 22023) for a stale or superseded approval, an unpublished,
-- archived or unknown template version, or an invalid balance due date.
create function public.generate_contract_draft(
  p_approval_id uuid,
  p_template_version_id uuid,
  p_balance_due_date date default null,
  p_replace_contract_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.proposal_approvals%rowtype;
  v_membership_id uuid;
  v_event_id uuid;
  v_event public.events%rowtype;
  v_proposal public.proposals%rowtype;
  v_selection public.proposal_selections%rowtype;
  v_tenant public.tenants%rowtype;
  v_version public.contract_template_versions%rowtype;
  v_template_active boolean;
  v_signer record;
  v_has_signer boolean;
  v_package record;
  v_deposit bigint;
  v_balance bigint;
  v_values jsonb;
  v_missing jsonb;
  v_rendered jsonb;
  v_commercial jsonb;
  v_parties jsonb;
  v_hash text;
  v_existing public.contracts%rowtype;
  v_has_existing boolean;
  v_replaced uuid;
  v_id uuid;
begin
  select * into v_approval from public.proposal_approvals where id = p_approval_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_approval.tenant_id);

  -- Lock order everywhere: event, then proposal. The event lock serializes
  -- generation, so concurrent clicks cannot create two drafts.
  select p.event_id into v_event_id from public.proposals p
  where p.tenant_id = v_approval.tenant_id and p.id = v_approval.proposal_id;
  select * into v_event from public.events where tenant_id = v_approval.tenant_id and id = v_event_id for update;
  select * into v_proposal from public.proposals where tenant_id = v_approval.tenant_id and id = v_approval.proposal_id for update;
  select * into v_selection from public.proposal_selections where tenant_id = v_approval.tenant_id and id = v_approval.selection_id;
  select * into v_tenant from public.tenants where id = v_approval.tenant_id;

  if v_proposal.status <> 'approved' or v_event.active_proposal_id is distinct from v_proposal.id then
    raise exception 'contract_stale_approval: this approval is no longer current because a revised offer replaced it'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_event.lifecycle_status <> 'awaiting_signature' then
    raise exception 'contract_not_allowed: the event is %', replace(v_event.lifecycle_status, '_', ' ')
      using errcode = 'invalid_parameter_value';
  end if;
  if v_tenant.archived_at is not null then
    raise exception 'contract_not_allowed: the business is archived' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_version from public.contract_template_versions
  where tenant_id = v_tenant.id and id = p_template_version_id;
  if not found then
    perform private.contract_error('template version not found');
  end if;
  if v_version.published_at is null then
    perform private.contract_error('publish this template version before generating a contract');
  end if;
  select t.active into v_template_active from public.contract_templates t
  where t.tenant_id = v_tenant.id and t.id = v_version.template_id;
  if not v_template_active then
    perform private.contract_error('this template is archived');
  end if;

  if p_balance_due_date is not null then
    if not ('payment.balance_due_date' = any (v_version.placeholders)) then
      raise exception 'contract_input_invalid: this template version has no balance due date, so leave it blank'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_balance_due_date < (now() at time zone v_event.timezone)::date then
      raise exception 'contract_input_invalid: the balance due date is in the past' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- Parties, copied now -------------------------------------------------------
  select c.id, c.name, c.email, c.phone, c.archived_at into v_signer
  from public.event_clients ec
  join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where ec.tenant_id = v_event.tenant_id and ec.event_id = v_event.id and ec.can_sign;
  v_has_signer := found;

  -- Commercial terms, from the approved selection only -------------------------
  select l.item_key, l.name, l.unit_price_cents into v_package
  from public.proposal_selection_lines l
  where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source = 'package';

  -- 50% deposit on signing, rounded half up to the cent; balance = total - deposit.
  v_deposit := private.contract_deposit_cents(v_selection.total_cents);
  v_balance := v_selection.total_cents - v_deposit;

  v_values := jsonb_build_object(
    'business.name', nullif(btrim(v_tenant.business_name), ''),
    'business.display_name', nullif(btrim(v_tenant.display_name), ''),
    'client.name', case when v_has_signer then nullif(btrim(v_signer.name), '') end,
    'client.email', case when v_has_signer then nullif(btrim(v_signer.email), '') end,
    'client.phone', case when v_has_signer then nullif(btrim(v_signer.phone), '') end,
    'event.title', nullif(btrim(v_event.title), ''),
    'event.date', to_char(v_event.event_date, 'FMDay, FMMonth FMDD, YYYY'),
    'venue.name', nullif(btrim(v_event.venue_name), ''),
    'venue.address', nullif(btrim(v_event.venue_address), ''),
    'package.name', v_package.name,
    'package.price', private.format_cents(v_package.unit_price_cents, v_selection.currency),
    'package.included', coalesce((
      select string_agg('- ' || l.quantity || ' × ' || l.name, E'\n' order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source = 'included'
    ), 'No gear is listed as included in the package.'),
    'gear.extras', coalesce((
      select string_agg(
        '- ' || l.quantity || ' × ' || l.name || ': ' || private.format_cents(l.line_total_cents, v_selection.currency)
        || case when l.source = 'required' then ' (required: ' || array_to_string(l.required_reasons, '; ') || ')' else '' end,
        E'\n' order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source in ('optional', 'required')
    ), 'No additional gear.'),
    'pricing.subtotal', private.format_cents(v_selection.subtotal_cents, v_selection.currency),
    'pricing.taxes', coalesce((
      select string_agg(
        '- ' || (t ->> 'label') || ' (' || private.format_rate_ppm((t ->> 'rate_ppm')::bigint) || '): '
        || private.format_cents((t ->> 'amount_cents')::bigint, v_selection.currency),
        E'\n' order by ord)
      from jsonb_array_elements(v_selection.tax_breakdown) with ordinality as x(t, ord)
    ), 'No taxes apply.'),
    'pricing.tax_total', private.format_cents(v_selection.tax_cents, v_selection.currency),
    'pricing.total', private.format_cents(v_selection.total_cents, v_selection.currency),
    'pricing.currency', v_selection.currency,
    'payment.deposit_percent', '50%',
    'payment.deposit', private.format_cents(v_deposit, v_selection.currency),
    'payment.balance', private.format_cents(v_balance, v_selection.currency),
    'payment.balance_due_date', to_char(p_balance_due_date, 'FMMonth FMDD, YYYY')
  );

  -- Every placeholder the template uses needs a real value, and a signer is
  -- always required. Nothing is stored when anything is missing.
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'label', p.label, 'hint', p.missing_hint) order by p.sort_order), '[]')
    into v_missing
  from private.contract_placeholders() p
  where p.key = any (v_version.placeholders) and v_values ->> p.key is null;
  if not v_has_signer then
    v_missing := jsonb_build_array(jsonb_build_object('key', 'signer', 'label', 'Signer',
      'hint', 'Signer: mark one of the event''s contacts as the signer.')) || v_missing;
  elsif v_signer.archived_at is not null then
    v_missing := jsonb_build_array(jsonb_build_object('key', 'signer', 'label', 'Signer',
      'hint', 'Signer: the signer''s client record is archived. Restore it or choose another signer.')) || v_missing;
  end if;
  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object('status', 'incomplete', 'missing', v_missing);
  end if;

  v_rendered := jsonb_build_object(
    'schema_version', 1,
    'title', private.render_contract_text(v_version.title, v_values),
    'sections', (
      select jsonb_agg(jsonb_build_object(
        'heading', private.render_contract_text(s ->> 'heading', v_values),
        'body', private.render_contract_text(s ->> 'body', v_values)) order by ord)
      from jsonb_array_elements(v_version.sections) with ordinality as x(s, ord)
    )
  );
  v_commercial := jsonb_build_object(
    'schema_version', 1,
    'currency', v_selection.currency,
    'package', jsonb_build_object('key', v_package.item_key, 'name', v_package.name, 'base_price_cents', v_package.unit_price_cents),
    'lines', (
      select jsonb_agg(jsonb_build_object(
        'line_no', l.line_no, 'source', l.source, 'item_key', l.item_key, 'name', l.name, 'description', l.description,
        'quantity', l.quantity, 'unit_price_cents', l.unit_price_cents, 'line_total_cents', l.line_total_cents,
        'required_quantity', l.required_quantity, 'required_reasons', to_jsonb(l.required_reasons),
        'tax_category', l.tax_category) order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id
    ),
    'subtotal_cents', v_selection.subtotal_cents,
    'tax_breakdown', v_selection.tax_breakdown,
    'tax_cents', v_selection.tax_cents,
    'total_cents', v_selection.total_cents,
    'payment', jsonb_build_object(
      'deposit_basis_points', 5000,
      'deposit_rounding', 'half_up_to_cent',
      'deposit_due', 'on_signing',
      'deposit_cents', v_deposit,
      'balance_cents', v_balance,
      'balance_due_date', p_balance_due_date
    ),
    'source', jsonb_build_object(
      'proposal_id', v_proposal.id, 'proposal_revision', v_proposal.revision, 'offer_sha256', v_proposal.offer_sha256,
      'selection_id', v_selection.id, 'selection_version', v_selection.version,
      'approval_id', v_approval.id, 'selection_sha256', v_approval.selection_sha256, 'approved_at', v_approval.approved_at
    )
  );
  v_parties := jsonb_build_object(
    'business', jsonb_build_object('name', v_tenant.business_name, 'display_name', v_tenant.display_name),
    'client', jsonb_build_object('client_id', v_signer.id, 'name', v_signer.name, 'email', v_signer.email, 'phone', v_signer.phone),
    'event', jsonb_build_object(
      'event_id', v_event.id, 'title', v_event.title, 'event_type', v_event.event_type, 'date', v_event.event_date,
      'timezone', v_event.timezone, 'venue_name', v_event.venue_name, 'venue_address', v_event.venue_address)
  );
  v_hash := private.contract_content_sha256(v_rendered, v_commercial, v_parties, v_version.id, v_version.content_sha256);

  -- One draft per event: repeat or replace explicitly ---------------------------
  select * into v_existing from public.contracts
  where tenant_id = v_event.tenant_id and event_id = v_event.id and status = 'draft'
  for update;
  v_has_existing := found;

  if v_has_existing then
    if v_existing.content_sha256 = v_hash
       and (p_replace_contract_id is null or p_replace_contract_id in (v_existing.id, v_existing.replaces_id)) then
      return jsonb_build_object('status', 'replayed', 'contract_id', v_existing.id);
    end if;
    if p_replace_contract_id is null then
      return jsonb_build_object('status', 'draft_exists', 'contract_id', v_existing.id);
    end if;
    if p_replace_contract_id <> v_existing.id then
      return jsonb_build_object('status', 'conflict', 'contract_id', v_existing.id);
    end if;
    update public.contracts set status = 'replaced' where id = v_existing.id;
    v_replaced := v_existing.id;
  elsif p_replace_contract_id is not null then
    return jsonb_build_object('status', 'conflict', 'contract_id', null);
  end if;

  insert into public.contracts (
    tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
    template_content_sha256, replaces_id, signer_client_id, signer_name, signer_email, currency,
    total_cents, deposit_cents, balance_cents, balance_due_date, rendered_content, commercial_snapshot,
    party_snapshot, content_sha256, generated_by_membership_id, generated_by_user_id
  ) values (
    v_tenant.id, v_event.id, v_proposal.id, v_selection.id, v_approval.id, v_version.template_id, v_version.id,
    v_version.content_sha256, v_replaced, v_signer.id, v_signer.name, v_signer.email, v_selection.currency,
    v_selection.total_cents, v_deposit, v_balance, p_balance_due_date, v_rendered, v_commercial,
    v_parties, v_hash, v_membership_id, (select auth.uid())
  )
  returning id, content_sha256 into v_id, v_hash;

  perform private.audit(v_tenant.id, 'contract', v_id, case when v_replaced is null then 'draft_generated' else 'draft_regenerated' end,
    'staff', (select auth.uid()),
    jsonb_build_object('event_id', v_event.id, 'approval_id', v_approval.id, 'template_version_id', v_version.id,
                       'content_sha256', v_hash, 'replaces_id', v_replaced));
  if v_replaced is not null then
    perform private.audit(v_tenant.id, 'contract', v_replaced, 'draft_replaced', 'staff', (select auth.uid()),
      jsonb_build_object('replaced_by', v_id));
  end if;

  return jsonb_build_object('status', 'created', 'contract_id', v_id, 'content_sha256', v_hash, 'replaced_id', v_replaced);
end;
$$;
revoke execute on function public.generate_contract_draft(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.generate_contract_draft(uuid, uuid, date, uuid) to authenticated;

-- ===========================================================================
-- Privileges and RLS: staff read only; writes go through the function above.
-- Clients and anonymous users have no access to contracts in this step.
-- ===========================================================================

revoke all on public.contracts from anon, authenticated;
grant select on public.contracts to authenticated;
alter table public.contracts enable row level security;
create policy contracts_select_staff on public.contracts
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
