-- Business settings and contract send review.
--
--   * tenants gains the legal identity used in contracts (business_address,
--     contact_email; business_name is already the legal name, display_name
--     stays the client-facing brand) and deposit_percent, an exact integer
--     0-100 (default 50). Only owners change them, through
--     update_business_settings; staff have no direct column grant.
--   * Contract placeholders gain business.legal_name, business.address and
--     business.email.
--   * generate_contract_draft uses the tenant's deposit percentage and freezes
--     it, the amounts and the business identity in each new contract.
--     contracts.deposit_percent is backfilled for existing rows from their own
--     frozen snapshots (all 5000 basis points = 50%); no snapshot is rewritten,
--     so every existing content_sha256 stays valid.
--   * private.contract_send_problems is the single eligibility check for
--     sending. review_contract_for_send exposes it to staff now; the send
--     transaction in the next stage must call it again under its locks.
--     Nothing here sends, issues links or queues email.

-- ===========================================================================
-- Tenant business settings
-- ===========================================================================

alter table public.tenants
  add column business_address text
    constraint tenants_business_address_length check (length(btrim(business_address)) between 1 and 500),
  add column contact_email text
    constraint tenants_contact_email_valid check (private.is_valid_email(contact_email)),
  add column deposit_percent integer not null default 50
    constraint tenants_deposit_percent_range check (deposit_percent between 0 and 100);
comment on column public.tenants.business_name is 'Legal business name used in contracts. display_name is the client-facing brand.';
comment on column public.tenants.business_address is 'Legal business address used in contracts.';
comment on column public.tenants.contact_email is 'Business contact email used in contracts (separate from reply_to_email routing).';
comment on column public.tenants.deposit_percent is 'Deposit due on signing, whole percent of the approved total including taxes (0-100).';

-- Legal identity and deposit terms change only through update_business_settings.
revoke update (business_name) on public.tenants from authenticated;

create function public.update_business_settings(
  p_tenant_id uuid, p_legal_name text, p_business_address text, p_contact_email text, p_deposit_percent integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select m.role into v_role from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change business settings' using errcode = 'insufficient_privilege';
  end if;
  if p_legal_name is null or length(btrim(p_legal_name)) not between 1 and 200 then
    raise exception 'settings_invalid: the legal business name must be 1 to 200 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_business_address is null or length(btrim(p_business_address)) not between 1 and 500 then
    raise exception 'settings_invalid: the business address must be 1 to 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_contact_email is null or not private.is_valid_email(lower(btrim(p_contact_email))) then
    raise exception 'settings_invalid: enter a valid contact email' using errcode = 'invalid_parameter_value';
  end if;
  if p_deposit_percent is null or p_deposit_percent not between 0 and 100 then
    raise exception 'settings_invalid: the deposit must be a whole percentage from 0 to 100' using errcode = 'invalid_parameter_value';
  end if;
  update public.tenants
    set business_name = btrim(p_legal_name), business_address = btrim(p_business_address),
        contact_email = lower(btrim(p_contact_email)), deposit_percent = p_deposit_percent
    where id = p_tenant_id;
  perform private.audit(p_tenant_id, 'tenant', p_tenant_id, 'business_settings_updated', 'staff', (select auth.uid()),
    jsonb_build_object('deposit_percent', p_deposit_percent));
end;
$$;
revoke execute on function public.update_business_settings(uuid, text, text, text, integer) from public, anon;
grant execute on function public.update_business_settings(uuid, text, text, text, integer) to authenticated;

-- ===========================================================================
-- Placeholders (additions only; every existing key keeps its meaning)
-- ===========================================================================

create or replace function private.contract_placeholders()
returns table (key text, label text, description text, missing_hint text, sort_order integer)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('business.name', 'Business name', 'Your legal business name (same as business.legal_name).', 'Business name: set the legal business name in Business settings.', 10),
    ('business.legal_name', 'Legal business name', 'Your legal business name from Business settings.', 'Legal business name: set it in Business settings.', 12),
    ('business.address', 'Business address', 'Your business address from Business settings.', 'Business address: set it in Business settings.', 14),
    ('business.email', 'Business contact email', 'Your contact email from Business settings.', 'Business contact email: set it in Business settings.', 16),
    ('business.display_name', 'Business display name', 'The name clients see on proposals.', 'Business display name: set it in your business settings.', 20),
    ('client.name', 'Client name', 'The event contact marked as signer.', 'Client name: edit the signer''s client record.', 30),
    ('client.email', 'Client email', 'The signer''s email address.', 'Client email: edit the signer''s client record.', 40),
    ('client.phone', 'Client phone', 'The signer''s phone number.', 'Client phone: add a phone number to the signer''s client record.', 50),
    ('event.title', 'Event title', 'The event''s title.', 'Event title: edit the event.', 60),
    ('event.date', 'Event date', 'The event date, for example "Saturday, June 12, 2027".', 'Event date: edit the event.', 70),
    ('venue.name', 'Venue name', 'The event''s venue name.', 'Venue name: add it to the event.', 80),
    ('venue.address', 'Venue address', 'The event''s venue address.', 'Venue address: add it to the event.', 90),
    ('package.name', 'Package', 'The approved package''s name.', 'Package: the approved selection has no package.', 100),
    ('package.price', 'Package price', 'The approved package''s base price.', 'Package price: the approved selection has no package.', 110),
    ('package.included', 'Included gear', 'A list of the gear included in the package.', 'Included gear: unavailable.', 120),
    ('gear.extras', 'Additional gear', 'A list of chargeable extra and required gear, with line totals and reasons. Says "No additional gear." when there is none.', 'Additional gear: unavailable.', 130),
    ('pricing.subtotal', 'Subtotal', 'Approved subtotal before taxes.', 'Subtotal: unavailable.', 140),
    ('pricing.taxes', 'Tax breakdown', 'A list of each configured tax with its rate and amount.', 'Tax breakdown: unavailable.', 150),
    ('pricing.tax_total', 'Total taxes', 'Sum of the approved taxes.', 'Total taxes: unavailable.', 160),
    ('pricing.total', 'Total', 'Approved total including taxes.', 'Total: unavailable.', 170),
    ('pricing.currency', 'Currency', 'Currency code, for example CAD.', 'Currency: unavailable.', 180),
    ('payment.deposit_percent', 'Deposit percentage', 'The deposit percentage from Business settings, frozen when the contract is generated.', 'Deposit percentage: unavailable.', 190),
    ('payment.deposit', 'Deposit', 'Deposit due on signing: the deposit percentage of the total including taxes, rounded half up to the cent.', 'Deposit: unavailable.', 200),
    ('payment.balance', 'Balance', 'Remaining balance: the total minus the deposit.', 'Balance: unavailable.', 210),
    ('payment.balance_due_date', 'Balance due date', 'A date staff enter when generating the contract. Nothing is assumed.', 'Balance due date: enter it when generating the contract.', 220)
  ) as p(key, label, description, missing_hint, sort_order);
$$;

-- ===========================================================================
-- Deposit arithmetic with an integer percentage
-- ===========================================================================

-- round_half_up(total * percent / 100) in integer cents. With 50 it equals the
-- original 50% function, so existing contracts are consistent with it.
create function private.contract_deposit_cents(p_total_cents bigint, p_percent integer)
returns bigint
language sql
immutable
strict
set search_path = ''
as $$
  select (p_total_cents * p_percent + 50) / 100;
$$;
grant execute on function private.contract_deposit_cents(bigint, integer) to authenticated, service_role;

-- ===========================================================================
-- Contracts: frozen deposit percentage (compatible backfill)
-- ===========================================================================

-- Every existing contract was generated at 5000 basis points (50%), recorded in
-- its own commercial snapshot. The column default fills existing rows with
-- that value without touching any snapshot, then the default is dropped so new
-- rows must state their percentage. The CHECK proves the column and snapshot agree.
alter table public.contracts add column deposit_percent integer not null default 50;
alter table public.contracts alter column deposit_percent drop default;
alter table public.contracts
  add constraint contracts_deposit_percent_range check (deposit_percent between 0 and 100),
  add constraint contracts_deposit_percent_matches_snapshot check (
    (commercial_snapshot -> 'payment' ->> 'deposit_basis_points')::integer = deposit_percent * 100);
comment on column public.contracts.deposit_percent is 'Deposit percentage frozen at generation (also in commercial_snapshot.payment).';

drop trigger contracts_immutable on public.contracts;
create trigger contracts_immutable before update on public.contracts
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'proposal_id', 'selection_id', 'approval_id', 'template_id',
    'template_version_id', 'template_content_sha256', 'replaces_id', 'signer_client_id', 'signer_name',
    'signer_email', 'currency', 'total_cents', 'deposit_percent', 'deposit_cents', 'balance_cents', 'balance_due_date',
    'rendered_content', 'commercial_snapshot', 'party_snapshot', 'content_sha256', 'generated_by_user_id',
    'created_at');

-- ===========================================================================
-- Generation: tenant deposit percentage and business identity, frozen.
-- Otherwise unchanged from 20261003000400_contract_drafts.sql.
-- ===========================================================================

create or replace function public.generate_contract_draft(
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

  -- The tenant's deposit percentage, frozen below; deposit rounded half up
  -- to the cent from the approved total; balance = total - deposit.
  v_deposit := private.contract_deposit_cents(v_selection.total_cents, v_tenant.deposit_percent);
  v_balance := v_selection.total_cents - v_deposit;

  v_values := jsonb_build_object(
    'business.name', nullif(btrim(v_tenant.business_name), ''),
    'business.legal_name', nullif(btrim(v_tenant.business_name), ''),
    'business.address', nullif(btrim(v_tenant.business_address), ''),
    'business.email', nullif(btrim(v_tenant.contact_email), ''),
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
    'payment.deposit_percent', v_tenant.deposit_percent::text || '%',
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
      'deposit_percent', v_tenant.deposit_percent,
      'deposit_basis_points', v_tenant.deposit_percent * 100,
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
    'business', jsonb_build_object(
      'name', v_tenant.business_name, 'display_name', v_tenant.display_name, 'legal_name', v_tenant.business_name,
      'address', v_tenant.business_address, 'contact_email', v_tenant.contact_email),
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
    total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, rendered_content, commercial_snapshot,
    party_snapshot, content_sha256, generated_by_membership_id, generated_by_user_id
  ) values (
    v_tenant.id, v_event.id, v_proposal.id, v_selection.id, v_approval.id, v_version.template_id, v_version.id,
    v_version.content_sha256, v_replaced, v_signer.id, v_signer.name, v_signer.email, v_selection.currency,
    v_selection.total_cents, v_tenant.deposit_percent, v_deposit, v_balance, p_balance_due_date, v_rendered, v_commercial,
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

-- ===========================================================================
-- Send eligibility (one check for review now and for the send transaction later)
-- ===========================================================================

-- Returns [{code, message}] explaining why a contract cannot be sent, or [].
-- Callers must authorize first. The send transaction must call this again
-- after locking the event, proposal and contract.
create or replace function private.contract_send_problems(p_contract_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  e public.events%rowtype;
  p public.proposals%rowtype;
  t public.tenants%rowtype;
  v_signer record;
  v_frozen jsonb;
  v_problems jsonb := '[]'::jsonb;
  v_identity_changes text[] := '{}'::text[];
begin
  select * into c from public.contracts where id = p_contract_id;
  if not found then
    return jsonb_build_array(jsonb_build_object('code', 'not_found', 'message', 'Contract not found.'));
  end if;
  select * into e from public.events where tenant_id = c.tenant_id and id = c.event_id;
  select * into p from public.proposals where tenant_id = c.tenant_id and id = c.proposal_id;
  select * into t from public.tenants where id = c.tenant_id;
  v_frozen := c.party_snapshot -> 'business';

  if t.archived_at is not null then
    v_problems := v_problems || jsonb_build_object('code', 'tenant_archived', 'message', 'This business is archived.');
  end if;
  if e.archived_at is not null then
    v_problems := v_problems || jsonb_build_object('code', 'event_archived',
      'message', 'The event is archived. Unarchive it before sending.');
  end if;
  if c.status <> 'draft' then
    v_problems := v_problems || jsonb_build_object('code', 'not_current_draft',
      'message', 'This is not the current contract draft (it was ' || c.status || '). Open the current draft.');
  end if;
  if p.status <> 'approved' or e.active_proposal_id is distinct from c.proposal_id then
    v_problems := v_problems || jsonb_build_object('code', 'approval_superseded',
      'message', 'The approval this contract was built from is no longer current. Generate a contract from the current approval.');
  end if;

  select cl.id, cl.name, cl.email, cl.archived_at into v_signer
  from public.event_clients ec join public.clients cl on cl.tenant_id = ec.tenant_id and cl.id = ec.client_id
  where ec.tenant_id = c.tenant_id and ec.event_id = c.event_id and ec.can_sign;
  if not found then
    v_problems := v_problems || jsonb_build_object('code', 'signer_missing',
      'message', 'The event has no contact marked as signer.');
  elsif v_signer.id <> c.signer_client_id or v_signer.name <> c.signer_name or v_signer.email <> c.signer_email
        or v_signer.archived_at is not null then
    v_problems := v_problems || jsonb_build_object('code', 'signer_changed',
      'message', 'The event''s signer is now ' || v_signer.name || ' (' || v_signer.email || '), but this contract names '
        || c.signer_name || ' (' || c.signer_email || '). Regenerate the contract.');
  end if;

  if t.business_address is null or t.contact_email is null then
    v_problems := v_problems || jsonb_build_object('code', 'business_settings_incomplete',
      'message', 'Business settings are incomplete. Set the legal name, address and contact email in Business settings.');
  end if;
  if nullif(btrim(v_frozen ->> 'legal_name'), '') is null or nullif(btrim(v_frozen ->> 'address'), '') is null
     or nullif(btrim(v_frozen ->> 'contact_email'), '') is null then
    v_problems := v_problems || jsonb_build_object('code', 'business_identity_missing',
      'message', 'This contract was generated without a complete business identity. Regenerate it after completing Business settings.');
  else
    if v_frozen ->> 'legal_name' is distinct from t.business_name then v_identity_changes := array_append(v_identity_changes, 'legal name'); end if;
    if v_frozen ->> 'address' is distinct from t.business_address then v_identity_changes := array_append(v_identity_changes, 'address'); end if;
    if v_frozen ->> 'contact_email' is distinct from t.contact_email then v_identity_changes := array_append(v_identity_changes, 'contact email'); end if;
    if cardinality(v_identity_changes) > 0 then
      v_problems := v_problems || jsonb_build_object('code', 'business_changed',
        'message', 'Business settings changed since this contract was generated (' || array_to_string(v_identity_changes, ', ')
          || '). Regenerate the contract to use the current details.');
    end if;
  end if;
  if c.deposit_percent <> t.deposit_percent then
    v_problems := v_problems || jsonb_build_object('code', 'deposit_changed',
      'message', 'The deposit setting is now ' || t.deposit_percent || '%, but this contract uses ' || c.deposit_percent
        || '%. Regenerate the contract to use the current setting.');
  end if;
  return v_problems;
end;
$$;
revoke execute on function private.contract_send_problems(uuid) from public, anon, authenticated;

-- Staff review: what would be sent, and whether it may be sent. Read-only.
-- Sending itself is not available yet (verified client onboarding comes
-- first), so "can_send" is always false and says why.
create function public.review_contract_for_send(p_contract_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  v_problems jsonb;
begin
  select * into c from public.contracts where id = p_contract_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(c.tenant_id);
  v_problems := private.contract_send_problems(c.id);
  return jsonb_build_object(
    'contract_id', c.id,
    'eligible', jsonb_array_length(v_problems) = 0,
    'problems', v_problems,
    'can_send', false,
    'send_unavailable_reason', 'Sending contracts is not available yet: verified client sign-in and signing links are built in the next stage.',
    'signer', jsonb_build_object('name', c.signer_name, 'email', c.signer_email),
    'business', c.party_snapshot -> 'business',
    'deposit_percent', c.deposit_percent,
    'deposit_cents', c.deposit_cents,
    'balance_cents', c.balance_cents,
    'total_cents', c.total_cents,
    'currency', c.currency,
    'balance_due_date', c.balance_due_date,
    'content_sha256', c.content_sha256
  );
end;
$$;
revoke execute on function public.review_contract_for_send(uuid) from public, anon;
grant execute on function public.review_contract_for_send(uuid) to authenticated;
