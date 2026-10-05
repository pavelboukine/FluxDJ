-- Client-use contract signing and frozen signed-copy senders.
--
-- 1. Usage mode on contract template versions (replaces the title rule).
--    Every version is published with an explicit usage:
--      demo        test wording; contracts and PDFs are labelled DEMO and
--                  use the demo-v1 consent
--      client_use  the business's own agreement, approved by the owner for
--                  client use; no DEMO labels; client-v1 consent
--      legacy      only for versions published before this migration that
--                  were not DEMO. Never chosen again; contracts can't be
--                  generated from them
--    Publishing for client use is owner-only and records the exact
--    confirmation statement, the owner's user id and the database time.
--    Published versions stay immutable: a different usage or wording needs a
--    new version (open_contract_template_draft copies the text, not the usage).
--
-- 2. Each contract freezes its signing mode and consent version at
--    generation (contracts_signing_terms), from its immutable template
--    version. client_contract_view shows that consent; sign_contract accepts
--    only that version and stores its exact text in the evidence, as before.
--    Contracts with mode "none" (generated from a legacy version before this
--    migration) can't be signed or sent: staff publish a version for client
--    use (or DEMO) and regenerate.
--
-- 3. Signed-copy emails freeze their sender: the business display name (also
--    used in the email text), from name and reply-to when
--    queued, the from address (an app setting) at the first delivery attempt
--    (freeze_email_sender). Retries reuse them, so a retry with the same
--    Resend idempotency key is byte-for-byte the same request even if
--    Business settings change in between. Rows queued before this migration
--    freeze at their next attempt; sent rows are not touched.
--
-- 4. Compatibility with the app deployed before this migration (58d69f1),
--    so the migration can be applied first:
--      * publish_contract_template_version(uuid, integer) stays as a wrapper.
--        It publishes DEMO agreements (title starting "DEMO, NOT FOR CLIENT
--        USE") as DEMO, exactly as before, refuses everything else (client
--        use needs the explicit, owner-confirmed flow) and replays versions
--        that are already published.
--      * claim_document_jobs keeps its three named parameters and gains an
--        optional p_contract_id, so the app can process the job of the
--        contract just signed without draining other tenants' backlog.
--      * The old worker ignores the frozen sender and still delivers both
--        signed copies; the old client page reads the consent from
--        client_contract_view, which now returns the contract's own.
--
-- Existing data: versions and contracts are classified with the rule the app
-- used until now (title starting "DEMO, NOT FOR CLIENT USE"), so existing DEMO
-- contracts stay DEMO with their demo-v1 consent and nothing else becomes
-- signable. Signatures, evidence, hashes and PDFs are not changed.

-- ===========================================================================
-- Wording
-- ===========================================================================

-- Consent statements by version. demo-v1 is unchanged. The evidence stores
-- the text from here, so the stored text is exactly what was displayed.
create or replace function private.contract_signing_consent(p_version text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_version
    when 'demo-v1' then
      'I have read the agreement shown above. I intend to sign it electronically, and I agree that my typed name and '
      || 'drawn signature are my signature on this agreement.'
    when 'client-v1' then
      'I have read the entire agreement shown above, including its payment terms. I agree to sign it electronically. '
      || 'I agree that my typed name and drawn signature are my signature on this agreement and that they bind me to it '
      || 'as a handwritten signature would. I can download a copy of the signed agreement here, and a copy will be '
      || 'emailed to me.'
  end;
$$;

-- What the owner confirms when publishing a version for client use, by version.
create function private.client_use_statement(p_version text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_version
    when 'client-use-v1' then
      'I am responsible for this agreement and its wording, and I approve this version for use with my clients. '
      || 'Clients will be able to sign it online. Flux DJ has not reviewed or approved this agreement and does not '
      || 'provide legal advice.'
  end;
$$;

create function public.client_use_statement_current()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('version', 'client-use-v1', 'text', private.client_use_statement('client-use-v1'));
$$;

-- The title rule is gone: eligibility now comes from the contract's frozen
-- signing mode.
drop function private.contract_signing_enabled(jsonb);
drop function private.current_signing_consent_version();

-- ===========================================================================
-- Template versions: usage
-- ===========================================================================

alter table public.contract_template_versions
  add column usage text,
  add column client_use_statement_version text,
  add column client_use_statement text,
  add column client_use_confirmed_at timestamptz,
  add column client_use_confirmed_by_user_id uuid;
comment on column public.contract_template_versions.usage is
  'demo | client_use | legacy (published before usage modes, not DEMO; contracts cannot be generated from it). Null while a draft.';
comment on column public.contract_template_versions.client_use_statement is
  'The exact statement the owner confirmed when publishing for client use. Flux DJ does not review agreements.';
comment on column public.contract_template_versions.client_use_confirmed_at is 'Database time of the client-use confirmation (the publish time).';

-- Classify what is already published, with the rule used until now. Triggers
-- are off so published rows (otherwise immutable) only gain the new column.
alter table public.contract_template_versions disable trigger user;
update public.contract_template_versions
  set usage = case when title like 'DEMO, NOT FOR CLIENT USE%' then 'demo' else 'legacy' end
  where published_at is not null;
alter table public.contract_template_versions enable trigger user;

alter table public.contract_template_versions
  add constraint contract_template_versions_usage_valid check (usage in ('demo', 'client_use', 'legacy')),
  add constraint contract_template_versions_usage_when_published check ((published_at is null) = (usage is null)),
  add constraint contract_template_versions_client_use_confirmed check (
    (usage is not distinct from 'client_use') = (client_use_confirmed_at is not null)
    and (client_use_confirmed_at is null) = (client_use_statement_version is null)
    and (client_use_confirmed_at is null) = (client_use_statement is null)
    and (client_use_confirmed_at is null) = (client_use_confirmed_by_user_id is null));

-- Publishing stamps the time and hash (as before) and, for client use, the
-- confirmation time and exact statement. Only demo or client_use can be
-- published; legacy exists only from the classification above.
create or replace function private.contract_template_versions_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.published_at is not null then
    raise exception 'published contract template versions are immutable; open a new draft version instead'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' and new.published_at is not null then
    raise exception 'contract template versions are created as drafts and published separately'
      using errcode = 'check_violation';
  end if;
  new.placeholders := private.contract_template_placeholders_used(new.title, new.sections);
  if new.published_at is not null then
    if new.usage is null or new.usage not in ('demo', 'client_use') then
      raise exception 'contract_template_invalid: choose DEMO or client use when publishing' using errcode = 'invalid_parameter_value';
    end if;
    new.published_at := now();
    new.content_sha256 := encode(pg_catalog.sha256(convert_to(
      jsonb_build_object('title', new.title, 'sections', new.sections)::text, 'UTF8')), 'hex');
    if new.usage = 'client_use' then
      new.client_use_statement := private.client_use_statement(new.client_use_statement_version);
      new.client_use_confirmed_at := new.published_at;
    else
      new.client_use_statement_version := null;
      new.client_use_statement := null;
      new.client_use_confirmed_at := null;
      new.client_use_confirmed_by_user_id := null;
    end if;
  else
    new.content_sha256 := null;
    new.published_by_membership_id := null;
    new.usage := null;
    new.client_use_statement_version := null;
    new.client_use_statement := null;
    new.client_use_confirmed_at := null;
    new.client_use_confirmed_by_user_id := null;
  end if;
  return new;
end;
$$;

-- Publishes the saved draft exactly as last saved, with an explicit usage.
-- Client use: owner only, and p_client_use_statement_version must be the
-- current statement the owner confirmed. Publishing sends and signs nothing.
-- Publishing again returns the same result (with the usage it was published as).
drop function public.publish_contract_template_version(uuid, integer);
create function public.publish_contract_template_version(
  p_version_id uuid, p_expected_draft_version integer, p_usage text, p_client_use_statement_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.contract_template_versions%rowtype;
  v_membership_id uuid;
  v_role text;
begin
  select * into v_version from public.contract_template_versions where id = p_version_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_version.tenant_id);
  if v_version.published_at is not null then
    return jsonb_build_object('status', 'published', 'version_number', v_version.version_number,
                              'content_sha256', v_version.content_sha256, 'usage', v_version.usage, 'replayed', true);
  end if;
  if p_usage is null or p_usage not in ('demo', 'client_use') then
    perform private.contract_error('choose DEMO or client use when publishing');
  end if;
  if v_version.draft_version <> p_expected_draft_version then
    raise exception 'draft_version_conflict: expected %, current %', p_expected_draft_version, v_version.draft_version
      using errcode = 'serialization_failure';
  end if;
  if p_usage = 'client_use' then
    select m.role into v_role from public.tenant_memberships m where m.id = v_membership_id;
    if v_role <> 'owner' then
      raise exception 'only the owner can publish an agreement for client use' using errcode = 'insufficient_privilege';
    end if;
    if p_client_use_statement_version is distinct from (public.client_use_statement_current() ->> 'version') then
      perform private.contract_error('confirm the current client-use statement. Reload the page and try again');
    end if;
  end if;

  update public.contract_template_versions
    set published_at = now(), published_by_membership_id = v_membership_id, usage = p_usage,
        client_use_statement_version = case when p_usage = 'client_use' then p_client_use_statement_version end,
        client_use_confirmed_by_user_id = case when p_usage = 'client_use' then (select auth.uid()) end
    where id = v_version.id
    returning * into v_version;
  perform private.audit(v_version.tenant_id, 'contract_template', v_version.template_id, 'version_published', 'staff',
    (select auth.uid()), jsonb_build_object('version_id', v_version.id, 'version_number', v_version.version_number,
                                            'content_sha256', v_version.content_sha256, 'usage', v_version.usage,
                                            'client_use_statement_version', v_version.client_use_statement_version));
  return jsonb_build_object('status', 'published', 'version_number', v_version.version_number,
                            'content_sha256', v_version.content_sha256, 'usage', v_version.usage, 'replayed', false);
end;
$$;
revoke execute on function public.publish_contract_template_version(uuid, integer, text, text) from public, anon;
grant execute on function public.publish_contract_template_version(uuid, integer, text, text) to authenticated;

-- Compatibility wrapper for callers that predate usage modes. It never
-- approves anything for client use: only DEMO agreements are published, as
-- DEMO, like before. Everything the four-argument function checks (staff of
-- the tenant, the expected draft version, audit) still applies.
create function public.publish_contract_template_version(p_version_id uuid, p_expected_draft_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.contract_template_versions%rowtype;
begin
  -- Locked, so the title checked here is the one published.
  select * into v_version from public.contract_template_versions where id = p_version_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_version.tenant_id);
  if v_version.published_at is null and v_version.title not like 'DEMO, NOT FOR CLIENT USE%' then
    perform private.contract_error('only DEMO agreements can be published this way. Reload the page to publish this version '
      || 'as DEMO or, as the owner, for client use');
  end if;
  return public.publish_contract_template_version(p_version_id, p_expected_draft_version, 'demo', null);
end;
$$;
revoke execute on function public.publish_contract_template_version(uuid, integer) from public, anon;
grant execute on function public.publish_contract_template_version(uuid, integer) to authenticated;
revoke execute on function public.client_use_statement_current() from public, anon;
grant execute on function public.client_use_statement_current() to authenticated;

-- ===========================================================================
-- Contracts: frozen signing mode and consent version
-- ===========================================================================

alter table public.contracts
  add column signing_mode text,
  add column consent_version text;
comment on column public.contracts.signing_mode is
  'demo | client_use | none, frozen from the template version at generation. none: generated from a legacy version; cannot be signed or sent.';
comment on column public.contracts.consent_version is 'The consent statement version the signer is shown, frozen at generation. Null when signing_mode is none.';

-- Classify existing contracts with the rule used until now (the rendered
-- title). Triggers are off so frozen rows only gain the new columns.
alter table public.contracts disable trigger user;
update public.contracts
  set signing_mode = case when rendered_content ->> 'title' like 'DEMO, NOT FOR CLIENT USE%' then 'demo' else 'none' end,
      consent_version = case when rendered_content ->> 'title' like 'DEMO, NOT FOR CLIENT USE%' then 'demo-v1' end;
alter table public.contracts enable trigger user;

alter table public.contracts
  alter column signing_mode set not null,
  add constraint contracts_signing_mode_valid check (signing_mode in ('demo', 'client_use', 'none')),
  add constraint contracts_consent_matches_mode check (
    case signing_mode when 'demo' then consent_version = 'demo-v1'
                      when 'client_use' then consent_version = 'client-v1'
                      else consent_version is null end);

drop trigger contracts_immutable on public.contracts;
create trigger contracts_immutable before update on public.contracts
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'proposal_id', 'selection_id', 'approval_id', 'template_id', 'template_version_id',
    'template_content_sha256', 'replaces_id', 'signer_client_id', 'signer_name', 'signer_email', 'currency', 'total_cents',
    'deposit_percent', 'deposit_cents', 'balance_cents', 'balance_due_date', 'rendered_content', 'commercial_snapshot',
    'party_snapshot', 'content_sha256', 'generated_by_user_id', 'created_at', 'signing_mode', 'consent_version');

-- Sets the signing terms of a new contract from its (immutable, published)
-- template version. Callers cannot choose them. Runs after
-- contracts_before_insert, which checks the version belongs to the tenant.
create function private.contracts_signing_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage text;
begin
  select v.usage into v_usage from public.contract_template_versions v
  where v.tenant_id = new.tenant_id and v.id = new.template_version_id;
  if not found then
    -- Not this tenant's version: the foreign key rejects the row.
    new.signing_mode := 'none';
    new.consent_version := null;
  elsif v_usage = 'demo' then
    new.signing_mode := 'demo';
    new.consent_version := 'demo-v1';
  elsif v_usage = 'client_use' then
    new.signing_mode := 'client_use';
    new.consent_version := 'client-v1';
  else
    perform private.contract_error('this version was published before agreements could be approved for client use. '
      || 'Open the template, start a new draft version and publish it for client use (or as DEMO for testing)');
  end if;
  return new;
end;
$$;
revoke execute on function private.contracts_signing_terms() from public, anon, authenticated;
create trigger contracts_signing_terms before insert on public.contracts
  for each row execute function private.contracts_signing_terms();

-- Send problems: as before, plus contracts that cannot be signed.
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
  -- Draft (to send) and sent (to resend) contracts may proceed.
  if c.status not in ('draft', 'sent') then
    v_problems := v_problems || jsonb_build_object('code', 'not_current_draft',
      'message', 'This contract is ' || c.status || ' and can no longer be sent. Open the current contract.');
  end if;
  if p.status <> 'approved' or e.active_proposal_id is distinct from c.proposal_id then
    v_problems := v_problems || jsonb_build_object('code', 'approval_superseded',
      'message', 'The approval this contract was built from is no longer current. Generate a contract from the current approval.');
  end if;
  if c.signing_mode = 'none' then
    v_problems := v_problems || jsonb_build_object('code', 'signing_unavailable',
      'message', 'This contract was generated from a template version published before agreements could be approved for client use, '
        || 'so it can''t be signed online. Publish a version for client use (or as DEMO) in Contract templates, then regenerate the contract.');
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

-- ===========================================================================
-- Client view and signing use the frozen mode and consent
-- ===========================================================================

create or replace function public.client_contract_view(p_contract_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  t public.tenants%rowtype;
  s public.contract_signatures%rowtype;
begin
  select k.* into c from public.contracts k join public.tenants tt on tt.id = k.tenant_id
  where k.id = p_contract_id and tt.slug = p_tenant_slug;
  if not found or not private.client_can_read_contract(c.id) then
    return jsonb_build_object('state', 'unavailable');
  end if;
  select * into t from public.tenants where id = c.tenant_id;
  select * into s from public.contract_signatures where contract_id = c.id;
  return jsonb_build_object(
    'state', 'available',
    'brand', jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors),
    'contract', jsonb_build_object(
      'id', c.id, 'status', c.status, 'sent_at', c.sent_at, 'content_sha256', c.content_sha256, 'rendered_content', c.rendered_content,
      'signer_name', c.signer_name, 'currency', c.currency, 'total_cents', c.total_cents,
      'deposit_percent', c.deposit_percent, 'deposit_cents', c.deposit_cents, 'balance_cents', c.balance_cents,
      'balance_due_date', c.balance_due_date, 'signing_mode', c.signing_mode,
      'event_title', c.party_snapshot -> 'event' ->> 'title', 'event_date', c.party_snapshot -> 'event' ->> 'date',
      'legal_name', coalesce(c.party_snapshot -> 'business' ->> 'legal_name', c.party_snapshot -> 'business' ->> 'name')),
    'signing', case when c.status = 'signed' then
        jsonb_build_object('signed', true, 'typed_name', s.typed_name, 'signed_at', s.signed_at,
          'pdf_ready', exists (select 1 from public.contract_documents d where d.contract_id = c.id and d.kind = 'signed_contract'),
          'pdf_pending', exists (select 1 from public.document_jobs j where j.contract_id = c.id and j.status in ('pending', 'running')))
      else
        jsonb_build_object('signed', false, 'enabled', c.signing_mode <> 'none',
          'consent_version', c.consent_version,
          'consent_text', private.contract_signing_consent(c.consent_version))
      end
  );
end;
$$;

create or replace function public.sign_contract(
  p_contract_id uuid,
  p_tenant_slug text,
  p_user_id uuid,
  p_typed_name text,
  p_content_sha256 text,
  p_consent_version text,
  p_consent_accepted boolean,
  p_signature_path text,
  p_signature_sha256 text,
  p_signature_bytes integer,
  p_signature_width integer,
  p_signature_height integer,
  p_user_agent text,
  p_client_ip text,
  p_client_ip_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  e public.events%rowtype;
  p public.proposals%rowtype;
  s public.contract_signatures%rowtype;
  v_email text;
  v_name text := btrim(coalesce(p_typed_name, ''));
  v_consent text;
  v_object record;
  v_ip inet;
  v_ua text := nullif(left(btrim(coalesce(p_user_agent, '')), 512), '');
begin
  select k.* into c from public.contracts k join public.tenants t on t.id = k.tenant_id
  where k.id = p_contract_id and t.slug = p_tenant_slug;
  if not found or p_user_id is null then
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;

  -- Lock order everywhere: event, proposal, contract.
  select * into e from public.events where tenant_id = c.tenant_id and id = c.event_id for update;
  select * into p from public.proposals where tenant_id = c.tenant_id and id = c.proposal_id for update;
  select * into c from public.contracts where id = c.id for update;

  -- Identity and access: verified email matching the frozen signer, live
  -- access for the signer client, nothing archived. Same answer for every
  -- failure so nothing leaks to other accounts.
  if not private.signer_can_access_contract(c.id, p_user_id) then
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;

  -- Already signed: the same signer gets the existing result back.
  if c.status = 'signed' then
    select * into s from public.contract_signatures where contract_id = c.id;
    if s.signer_user_id = p_user_id then
      return jsonb_build_object('status', 'signed', 'replayed', true, 'contract_id', c.id, 'signed_at', s.signed_at,
        'typed_name', s.typed_name);
    end if;
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;

  -- Contract still sent, current, on the current approval.
  if c.status <> 'sent' or p.status <> 'approved' or e.active_proposal_id is distinct from c.proposal_id
     or e.lifecycle_status <> 'awaiting_signature'
     or not exists (select 1 from public.proposal_approvals a where a.tenant_id = c.tenant_id and a.id = c.approval_id
                    and a.proposal_id = c.proposal_id and a.selection_id = c.selection_id) then
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;
  -- The frozen signing mode decides; "none" was generated from a legacy version.
  if c.signing_mode = 'none' or c.consent_version is null then
    return jsonb_build_object('status', 'rejected', 'code', 'signing_disabled',
      'message', 'This contract can''t be signed online. Contact your DJ for an updated contract.');
  end if;
  if p_content_sha256 is distinct from c.content_sha256 then
    return jsonb_build_object('status', 'rejected', 'code', 'content_changed',
      'message', 'This contract is not the one you were shown. Reload the page and read it again before signing.');
  end if;
  v_consent := private.contract_signing_consent(c.consent_version);
  if p_consent_version is distinct from c.consent_version or v_consent is null then
    return jsonb_build_object('status', 'rejected', 'code', 'consent_changed',
      'message', 'The signing statement has changed. Reload the page and read it again before signing.');
  end if;
  if p_consent_accepted is not true then
    return jsonb_build_object('status', 'rejected', 'code', 'consent_required',
      'message', 'Check the box to confirm you agree to sign electronically.');
  end if;
  if length(v_name) not between 1 and 200 then
    return jsonb_build_object('status', 'rejected', 'code', 'name_required', 'message', 'Type your full name (up to 200 characters).');
  end if;

  -- The signature image: stored first by the server, unique, in this
  -- contract's folder, with the declared size and type, and unused.
  if p_signature_path is null
     or p_signature_path !~ ('^' || c.tenant_id || '/' || c.id || '/[0-9a-f-]{36}\.png$')
     or p_signature_sha256 is null or p_signature_sha256 !~ '^[0-9a-f]{64}$'
     or p_signature_bytes is null or p_signature_bytes not between 1 and 262144
     or p_signature_width is null or p_signature_width not between 1 and 4096
     or p_signature_height is null or p_signature_height not between 1 and 4096 then
    return jsonb_build_object('status', 'rejected', 'code', 'signature_invalid', 'message', 'Draw your signature again.');
  end if;
  select o.name, (o.metadata ->> 'size')::bigint as size, o.metadata ->> 'mimetype' as mimetype into v_object
  from storage.objects o where o.bucket_id = 'contract-signatures' and o.name = p_signature_path;
  if not found or v_object.size is distinct from p_signature_bytes or v_object.mimetype is distinct from 'image/png'
     or exists (select 1 from public.contract_signatures x where x.signature_path = p_signature_path) then
    return jsonb_build_object('status', 'rejected', 'code', 'signature_invalid', 'message', 'Draw your signature again.');
  end if;

  if p_client_ip_source = 'vercel' and p_client_ip is not null then
    begin
      v_ip := p_client_ip::inet;
    exception when others then
      v_ip := null;
    end;
  end if;

  insert into public.contract_signatures (
    tenant_id, event_id, contract_id, signer_client_id, signer_user_id, signer_email, typed_name,
    signature_path, signature_sha256, signature_bytes, signature_width, signature_height,
    content_sha256, consent_version, consent_text, user_agent, client_ip, client_ip_source)
  values (
    c.tenant_id, c.event_id, c.id, c.signer_client_id, p_user_id, v_email, v_name,
    p_signature_path, p_signature_sha256, p_signature_bytes, p_signature_width, p_signature_height,
    c.content_sha256, c.consent_version, v_consent, v_ua, v_ip, case when v_ip is null then 'unavailable' else 'vercel' end)
  returning * into s;

  perform set_config('flux.signing_contract', c.id::text, true);
  update public.contracts set status = 'signed' where id = c.id returning * into c;
  perform set_config('flux.signing_contract', '', true);
  -- The signature row and the contract share one database timestamp.
  if s.signed_at <> c.signed_at then
    raise exception 'signing timestamps diverged' using errcode = 'internal_error';
  end if;

  perform private.retire_contract_invitations(c.id, 'contract signed');
  -- PDF work is queued in this same transaction and rendered later by the
  -- worker, so a rendering failure can never undo or lose the signature.
  perform private.enqueue_signed_contract_pdf(c.id, true, null);
  -- One audit event. Evidence stays in contract_signatures, not in the log.
  perform private.audit(c.tenant_id, 'contract', c.id, 'signed', 'client', p_user_id,
    jsonb_build_object('signature_id', s.id, 'content_sha256', c.content_sha256, 'signing_mode', c.signing_mode,
                       'consent_version', c.consent_version));
  return jsonb_build_object('status', 'signed', 'replayed', false, 'contract_id', c.id, 'signed_at', s.signed_at,
    'typed_name', s.typed_name);
end;
$$;

grant execute on function private.contract_signing_consent(text), private.client_use_statement(text) to authenticated, service_role;

-- ===========================================================================
-- PDF jobs: claim one contract's job
-- ===========================================================================

-- As before, plus p_contract_id: only that contract's job (the one just
-- signed or requested), so unrelated backlog never delays it. The scheduled
-- worker keeps calling it without a contract and drains everything. A job
-- another worker holds under a live lease is not claimable, and the
-- canonical commit stays unique, so racing workers never duplicate a PDF or
-- its emails.
drop function public.claim_document_jobs(integer, integer, uuid);
create function public.claim_document_jobs(
  p_limit integer default 5, p_lease_seconds integer default 120, p_tenant_id uuid default null, p_contract_id uuid default null
)
returns table (job_id uuid, lease_token uuid, tenant_id uuid, contract_id uuid, attempts integer, max_attempts integer, deliver_copies boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.document_jobs j
    set status = 'failed', lease_token = null, locked_until = null,
        last_error = coalesce(j.last_error, 'PDF generation did not complete')
    where j.status = 'running' and j.locked_until < now() and j.attempts >= j.max_attempts
      and (p_tenant_id is null or j.tenant_id = p_tenant_id)
      and (p_contract_id is null or j.contract_id = p_contract_id);

  return query
  with due as (
    select j.id from public.document_jobs j
    where ((j.status = 'pending' and j.next_attempt_at <= now()) or (j.status = 'running' and j.locked_until < now()))
      and j.attempts < j.max_attempts
      and (p_tenant_id is null or j.tenant_id = p_tenant_id)
      and (p_contract_id is null or j.contract_id = p_contract_id)
    order by j.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 5), 20))
    for update skip locked
  ),
  claimed as (
    update public.document_jobs j
      set status = 'running', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
          locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900)))
      from due where j.id = due.id
      returning j.*
  )
  select c.id, c.lease_token, c.tenant_id, c.contract_id, c.attempts, c.max_attempts, c.deliver_copies from claimed c;
end;
$$;
revoke execute on function public.claim_document_jobs(integer, integer, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_document_jobs(integer, integer, uuid, uuid) to service_role;

-- ===========================================================================
-- Signed-copy emails: frozen sender
-- ===========================================================================

-- {"display_name": text, "from_name": text, "reply_to": text|null,
-- "from_address": text}. display_name is also used in the email text. Keys
-- are added once and never change; null on rows that don't use it.
alter table public.email_outbox
  add column sender jsonb
    constraint email_outbox_sender_object check (sender is null or jsonb_typeof(sender) = 'object');
comment on column public.email_outbox.sender is
  'Frozen sender for emails sent with a provider idempotency key (signed copies): display_name, from_name and reply_to when queued, from_address at the first attempt. Set-once per key.';

create function private.email_outbox_sender_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.sender is not null and (new.sender is null or not new.sender @> old.sender) then
    raise exception 'email_outbox.sender is frozen once set' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger email_outbox_sender_frozen before update of sender on public.email_outbox
  for each row execute function private.email_outbox_sender_frozen();

-- The from name used for signed copies: the business display name, as the
-- app formats every other email ("<name> via Flux DJ").
create or replace function private.enqueue_signed_copy_emails(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  s public.contract_signatures%rowtype;
  t public.tenants%rowtype;
  r record;
  v_out jsonb := '[]'::jsonb;
  v_row public.email_outbox%rowtype;
begin
  select * into c from public.contracts where id = p_contract_id;
  select * into s from public.contract_signatures where contract_id = p_contract_id;
  if c.status is distinct from 'signed' or s.id is null then
    raise exception 'contract_document_invalid: only a signed contract has a signed copy' using errcode = 'invalid_parameter_value';
  end if;
  select * into t from public.tenants where id = c.tenant_id;
  for r in
    select 'client'::text as role, lower(c.signer_email) as email
    union all
    select 'business', lower(c.party_snapshot -> 'business' ->> 'contact_email')
  loop
    continue when r.email is null or not private.is_valid_email(r.email);
    insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, sender)
    values (c.tenant_id, 'contract_signed_copy', r.email, 'contract', c.id,
      jsonb_build_object(
        'recipient_role', r.role,
        'client_name', c.signer_name,
        'typed_name', s.typed_name,
        'signed_at', s.signed_at,
        'event_title', c.party_snapshot -> 'event' ->> 'title',
        'event_date', c.party_snapshot -> 'event' ->> 'date',
        'timezone', c.party_snapshot -> 'event' ->> 'timezone',
        'legal_name', coalesce(c.party_snapshot -> 'business' ->> 'legal_name', c.party_snapshot -> 'business' ->> 'name'),
        'contact_email', c.party_snapshot -> 'business' ->> 'contact_email'),
      'contract_signed_copy:' || c.id || ':' || r.role,
      jsonb_build_object('display_name', t.display_name, 'from_name', t.display_name || ' via Flux DJ', 'reply_to', t.reply_to_email))
    on conflict (dedup_key) do nothing;
    -- Re-queued rows keep their frozen sender.
    update public.email_outbox
      set status = 'pending', max_attempts = least(attempts + 3, 50), next_attempt_at = now(), locked_until = null
      where dedup_key = 'contract_signed_copy:' || c.id || ':' || r.role and status in ('failed', 'cancelled');
    select * into v_row from public.email_outbox where dedup_key = 'contract_signed_copy:' || c.id || ':' || r.role;
    v_out := v_out || jsonb_build_object('role', r.role, 'email', r.email, 'status', v_row.status);
  end loop;
  return v_out;
end;
$$;

-- Completes and returns the frozen sender of a claimed row (service role,
-- just before delivery). Keys already frozen are kept; missing ones (the from
-- address on every row, everything on rows queued before this migration) are
-- frozen now, from the current settings and p_from_address.
create function public.freeze_email_sender(p_id uuid, p_from_address text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender jsonb;
begin
  if p_from_address is null or not private.is_valid_email(p_from_address) then
    raise exception 'invalid from address' using errcode = 'invalid_parameter_value';
  end if;
  update public.email_outbox o
    set sender = jsonb_build_object(
      'display_name', coalesce(o.sender ->> 'display_name', t.display_name),
      'from_name', coalesce(o.sender ->> 'from_name', t.display_name || ' via Flux DJ'),
      'reply_to', case when o.sender ? 'reply_to' then o.sender -> 'reply_to' else to_jsonb(t.reply_to_email) end,
      'from_address', coalesce(o.sender ->> 'from_address', p_from_address))
    from public.tenants t
    where o.id = p_id and t.id = o.tenant_id and o.status = 'sending'
    returning o.sender into v_sender;
  return v_sender;
end;
$$;
revoke execute on function public.freeze_email_sender(uuid, text) from public, anon, authenticated;
grant execute on function public.freeze_email_sender(uuid, text) to service_role;
