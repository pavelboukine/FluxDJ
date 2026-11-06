-- Contract-first compatibility (Release A). The database learns to represent
-- a contract with no proposal and, optionally, no financial terms, and every
-- reader and access check learns to tell them apart. Nothing here can create
-- one: there is no generator, no grant and no route. Release B adds those.
-- Users see no change.
--
-- Three shapes of contract, told apart by constraints, never by a flag a
-- caller supplies:
--
--   proposal-backed     proposal_id, selection_id and approval_id all set, all
--                       four money columns set. Every existing contract. The
--                       booking policy is still copied from the tenant, and
--                       legacy contracts keep their null policy.
--   direct, with terms  no references; total, deposit and balance set
--                       (deposit + balance = total, as before). "No deposit"
--                       is an explicit 0 and a genuine $0 contract is an
--                       explicit total of 0. deposit_percent may be null: the
--                       deposit can be a stated amount.
--   direct, no terms    no references, all money columns null and on_signature.
--                       Null means "no financial terms", never zero.
--
-- A deposit therefore can't exist without a total, on_deposit can't exist
-- without a positive deposit on a direct contract, and references are all or
-- nothing. These checks avoid a three-valued trap: a CHECK passes when its
-- expression is NULL, so each is written not to be able to evaluate to NULL.
--
-- events.contract_first: false for every existing event. There is no INSERT or
-- UPDATE grant for it, so staff can't set it, and it is immutable for every
-- role for now. A contract-first event can't have an active proposal
-- (constraint) or start one (trigger), which is what makes "direct" safe to
-- check: private.contract_is_current requires the event itself to be
-- contract-first. Missing references never grant anything by themselves.
--
-- Deposit authorization, in the database: a direct contract that doesn't meet
-- the business's required deposit needs an owner, decided by the signed-in
-- user's own membership and never by an ID on the row. See
-- contracts_booking_policy.
--
-- Consent: client-v1 says "including its payment terms", which would be false
-- on a contract without any. Such a contract freezes 'client-no-terms-v1',
-- which deliberately has NO wording in private.contract_signing_consent yet,
-- so it can't be sent or signed in client-use mode until the wording is
-- approved and added by a later migration. Existing versions and recorded
-- signatures are untouched.
--
-- Hashes, immutability and audit: unchanged. A direct contract's terms live in
-- its commercial_snapshot, which the content hash already covers; the columns
-- are all already in contracts_immutable, whose comparison treats null like
-- any other value; existing hashes aren't recomputed.
--
-- generate_contract_draft and approve_proposal_selection are not touched.
-- Function results gain keys only on direct contracts (source, and
-- no_financial_terms), so a proposal-backed response is exactly as before.
--
-- Migration-first: the deployed app never sets contract_first and can't create
-- these rows. No existing row is rewritten, so updated_at, triggers and
-- suspended tenants aren't affected.
--
-- Compatibility boundary: once Release B creates direct contracts, an app older
-- than Release A's can't read them (it fails closed: no figures, but also no
-- signing or PDF). From then on roll the app back no further than Release A.

-- ===========================================================================
-- Events
-- ===========================================================================

alter table public.events
  add column contract_first boolean not null default false;
alter table public.events
  add constraint events_contract_first_flux_only check (not contract_first or booking_source = 'flux'),
  add constraint events_contract_first_no_active_proposal check (not contract_first or active_proposal_id is null);
comment on column public.events.contract_first is
  'A Flux booking that skips the proposal: staff go straight to a contract. Immutable for now; no role can change it after insert.';

drop trigger events_immutable on public.events;
create trigger events_immutable before update on public.events
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_at', 'booking_source', 'contract_first');

-- ===========================================================================
-- Contracts
-- ===========================================================================

alter table public.contracts
  alter column proposal_id drop not null,
  alter column selection_id drop not null,
  alter column approval_id drop not null,
  alter column total_cents drop not null,
  alter column deposit_cents drop not null,
  alter column balance_cents drop not null,
  alter column deposit_percent drop not null;

alter table public.contracts
  drop constraint contracts_consent_matches_mode;

alter table public.contracts
  add constraint contracts_proposal_references check (num_nonnulls(proposal_id, selection_id, approval_id) in (0, 3)),
  add constraint contracts_financial_terms_shape check (
    (total_cents is null and deposit_cents is null and balance_cents is null and deposit_percent is null and balance_due_date is null)
    or (total_cents is not null and deposit_cents is not null and balance_cents is not null)),
  add constraint contracts_proposal_backed_terms check (proposal_id is null or deposit_percent is not null),
  add constraint contracts_direct_booking_policy check (
    proposal_id is not null
    or booking_policy is not distinct from 'on_signature'
    or (booking_policy is not distinct from 'on_deposit' and deposit_cents is not null and deposit_cents > 0)),
  add constraint contracts_financial_terms_snapshot check (
    case
      when proposal_id is not null then not (commercial_snapshot ? 'financial_terms')
      when total_cents is null then (commercial_snapshot ->> 'financial_terms') is not distinct from 'none'
        and not (commercial_snapshot ? 'total_cents')
      else (commercial_snapshot ->> 'financial_terms') is not distinct from 'stated'
        and (commercial_snapshot ->> 'total_cents') is not distinct from total_cents::text
    end),
  add constraint contracts_consent_matches_mode check (
    case signing_mode
      when 'demo' then consent_version is not distinct from 'demo-v1'
      when 'client_use' then consent_version is not distinct from (case when total_cents is null then 'client-no-terms-v1' else 'client-v1' end)
      else consent_version is null
    end);

comment on table public.contracts is
  'Contracts rendered from an approved selection (or, for a contract-first event, with no proposal) and a published template version. Content, terms and hash never change after insert; only status moves. Staff-only.';
comment on column public.contracts.total_cents is
  'Frozen at generation. Null only on a contract without financial terms; a genuine zero-dollar contract is 0.';
comment on column public.contracts.consent_version is
  'The consent statement version the signer is shown, frozen at generation. Null when signing_mode is none. client-no-terms-v1 has no approved wording yet, so such a contract cannot be signed.';

-- ===========================================================================
-- Contract invitations
-- ===========================================================================

alter table public.access_links
  alter column proposal_id drop not null;
alter table public.access_links
  add constraint access_links_proposal_scope check (purpose <> 'proposal' or proposal_id is not null);

-- ===========================================================================
-- Whether a contract is still the event's current one
-- ===========================================================================

-- The one rule for sending, invitations, reading and signing. Proposal-backed:
-- exactly the existing check, the current approved proposal. Direct: the event
-- itself must be a contract-first Flux booking with no active proposal; missing
-- references alone are never enough. Always true or false, never null.
create function private.contract_is_current(p_contract public.contracts, p_event public.events)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(case
    when p_contract.proposal_id is not null then
      p_event.active_proposal_id = p_contract.proposal_id
      and exists (select 1 from public.proposals p
                  where p.tenant_id = p_contract.tenant_id and p.id = p_contract.proposal_id and p.status = 'approved')
    else
      p_contract.selection_id is null and p_contract.approval_id is null
      and p_event.tenant_id = p_contract.tenant_id and p_event.id = p_contract.event_id
      and p_event.contract_first and p_event.booking_source = 'flux' and p_event.active_proposal_id is null
  end, false);
$$;
comment on function private.contract_is_current(public.contracts, public.events) is
  'Whether a sent or draft contract is still current: on the approved active proposal, or direct on a contract-first event. Status, archive and identity are checked by callers.';
revoke execute on function private.contract_is_current(public.contracts, public.events) from public, anon, authenticated;

-- ===========================================================================
-- Booking policy
-- ===========================================================================

-- Proposal-backed: always the tenant's policy, as before. Direct: the policy
-- the contract states, but only an owner may go below the deposit the business
-- requires (business policy on_deposit with a percentage above zero). Anyone
-- else must require at least that percentage of the stated total. A genuine
-- zero-dollar contract owes nothing, so it needs no override. The owner is the
-- signed-in user's own membership, never generated_by_user_id (which the caller
-- supplies): with no signed-in user, such as the service role, nobody overrides.
create or replace function private.contracts_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tenants%rowtype;
begin
  select * into t from public.tenants where id = new.tenant_id;
  if new.proposal_id is not null then
    new.booking_policy := t.booking_confirmation_policy;
    return new;
  end if;
  if new.booking_policy is null then
    perform private.contract_error('choose when this booking is confirmed');
  end if;
  if t.booking_confirmation_policy = 'on_deposit' and t.deposit_percent > 0
     and (new.total_cents is null
          or (new.total_cents > 0
              and not coalesce(new.booking_policy = 'on_deposit'
                               and new.deposit_cents >= private.contract_deposit_cents(new.total_cents, t.deposit_percent), false))) then
    if not exists (select 1 from public.tenant_memberships m
                   where m.tenant_id = new.tenant_id and m.user_id = (select auth.uid()) and m.role = 'owner' and m.removed_at is null) then
      raise exception 'only the owner can go below the deposit this business requires' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "private"."access_links_contract_scope"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.purpose = 'contract' and not exists (
    select 1 from public.contracts c
    where c.tenant_id = new.tenant_id and c.id = new.contract_id
      and c.proposal_id is not distinct from new.proposal_id and c.signer_client_id = new.intended_client_id
  ) then
    raise exception 'a contract invitation must match its contract''s proposal and signer' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "private"."contract_invitation"("p_link_id" "uuid", "p_token_hash" "text", "p_tenant_slug" "text") RETURNS TABLE("usable" boolean, "link_id" "uuid", "tenant_id" "uuid", "tenant_display_name" "text", "contract_id" "uuid", "event_id" "uuid", "signer_client_id" "uuid", "signer_email" "text", "signer_name" "text", "event_title" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select (l.revoked_at is null and l.expires_at > now() and t.archived_at is null and t.suspended_at is null and c.status = 'sent'
          and e.archived_at is null and private.contract_is_current(c, e)),
         l.id, l.tenant_id, t.display_name, c.id, c.event_id, c.signer_client_id, c.signer_email, c.signer_name,
         c.party_snapshot -> 'event' ->> 'title'
  from public.access_links l
  join public.tenants t on t.id = l.tenant_id
  join public.contracts c on c.tenant_id = l.tenant_id and c.id = l.contract_id
  join public.events e on e.tenant_id = c.tenant_id and e.id = c.event_id
  where l.purpose = 'contract' and t.slug = p_tenant_slug
    and ((p_link_id is not null and l.id = p_link_id) or (p_token_hash is not null and l.token_hash = p_token_hash));
$$;

CREATE OR REPLACE FUNCTION "private"."signer_can_access_contract"("p_contract_id" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p_user_id is not null and exists (
    select 1
    from public.contracts c
    join public.events e on e.tenant_id = c.tenant_id and e.id = c.event_id
    join public.tenants t on t.id = c.tenant_id
    join public.event_access ea on ea.tenant_id = c.tenant_id and ea.event_id = c.event_id
      and ea.user_id = p_user_id and ea.client_id = c.signer_client_id and ea.revoked_at is null
    join auth.users u on u.id = p_user_id and u.email_confirmed_at is not null
    where c.id = p_contract_id and e.archived_at is null and t.archived_at is null and t.suspended_at is null
      and lower(c.signer_email) = lower(u.email)
      and (c.status = 'signed'
           or (c.status = 'sent' and private.contract_is_current(c, e)))
  );
$$;

CREATE OR REPLACE FUNCTION "private"."contract_send_problems"("p_contract_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  c public.contracts%rowtype;
  e public.events%rowtype;
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
  if not private.contract_is_current(c, e) then
    v_problems := v_problems || case when c.proposal_id is not null then
      jsonb_build_object('code', 'approval_superseded',
        'message', 'The approval this contract was built from is no longer current. Generate a contract from the current approval.')
    else
      jsonb_build_object('code', 'event_not_contract_first',
        'message', 'This contract has no proposal, and its event is no longer set up for one.')
    end;
  end if;
  if c.signing_mode = 'none' then
    v_problems := v_problems || jsonb_build_object('code', 'signing_unavailable',
      'message', 'This contract was generated from a template version published before agreements could be approved for client use, '
        || 'so it can''t be signed online. Publish a version for client use (or as DEMO) in Contract templates, then regenerate the contract.');
  elsif private.contract_signing_consent(c.consent_version) is null then
    -- Frozen on a contract without financial terms until its wording is approved.
    v_problems := v_problems || jsonb_build_object('code', 'consent_unavailable',
      'message', 'Online signing isn''t available yet for a contract without payment terms.');
  end if;

  select cl.id, cl.name, cl.email, cl.archived_at into v_signer
  from public.event_clients ec join public.clients cl on cl.tenant_id = ec.tenant_id and cl.id = ec.client_id
  where ec.tenant_id = c.tenant_id and ec.event_id = c.event_id and ec.can_sign;
  if not found then
    v_problems := v_problems || jsonb_build_object('code', 'signer_missing',
      'message', 'The event has no contact marked as signer.');
  elsif v_signer.archived_at is not null then
    -- The signer is archived: restore them, or mark another contact as signer (which then needs a new contract).
    v_problems := v_problems || jsonb_build_object('code', 'signer_archived',
      'message', 'The event''s signer, ' || v_signer.name || ' (' || v_signer.email || '), is an archived client. '
        || 'Restore them on their client page, or make another contact the signer and regenerate the contract.');
  elsif v_signer.id <> c.signer_client_id or v_signer.name <> c.signer_name or v_signer.email <> c.signer_email then
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
  -- Only a proposal-backed contract follows the business's percentage; a direct contract states its own terms.
  if c.proposal_id is not null and c.deposit_percent <> t.deposit_percent then
    v_problems := v_problems || jsonb_build_object('code', 'deposit_changed',
      'message', 'The deposit setting is now ' || t.deposit_percent || '%, but this contract uses ' || c.deposit_percent
        || '%. Regenerate the contract to use the current setting.');
  end if;
  return v_problems;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."sign_contract"("p_contract_id" "uuid", "p_tenant_slug" "text", "p_user_id" "uuid", "p_typed_name" "text", "p_content_sha256" "text", "p_consent_version" "text", "p_consent_accepted" boolean, "p_signature_path" "text", "p_signature_sha256" "text", "p_signature_bytes" integer, "p_signature_width" integer, "p_signature_height" integer, "p_user_agent" "text", "p_client_ip" "text", "p_client_ip_source" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  c public.contracts%rowtype;
  e public.events%rowtype;
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
  perform 1 from public.proposals where tenant_id = c.tenant_id and id = c.proposal_id for update;
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
  if c.status <> 'sent' or not private.contract_is_current(c, e)
     or e.lifecycle_status <> 'awaiting_signature'
     or (c.proposal_id is not null
         and not exists (select 1 from public.proposal_approvals a where a.tenant_id = c.tenant_id and a.id = c.approval_id
                         and a.proposal_id = c.proposal_id and a.selection_id = c.selection_id)) then
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
  -- Booking under the contract's frozen policy, in this same transaction
  -- (payments recorded before signing count). Rendering and email happen
  -- later, so they can never block or undo it.
  perform private.evaluate_booking(c.event_id, 'client', p_user_id, false);
  return jsonb_build_object('status', 'signed', 'replayed', false, 'contract_id', c.id, 'signed_at', s.signed_at,
    'typed_name', s.typed_name);
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."claim_email_outbox"("p_limit" integer DEFAULT 10, "p_lock_seconds" integer DEFAULT 120, "p_tenant_id" "uuid" DEFAULT NULL::"uuid", "p_include_booking" boolean DEFAULT false) RETURNS TABLE("id" "uuid", "tenant_id" "uuid", "event_type" "text", "recipient_email" "text", "entity_id" "uuid", "payload" "jsonb", "attempts" integer, "access_link_id" "uuid", "link_token_hash" "text", "link_usable" boolean, "proposal_active" boolean, "tenant_slug" "text", "tenant_display_name" "text", "tenant_reply_to" "text", "contract_deliverable" boolean, "contract_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
#variable_conflict use_column
begin
  -- Claims that expired with no attempts left are given up.
  update public.email_outbox o
    set status = 'failed', locked_until = null, last_error = coalesce(o.last_error, 'delivery did not complete')
    where o.status = 'sending' and o.locked_until < now() and o.attempts >= o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id);

  return query
  with due as (
    select o.id from public.email_outbox o
    where (o.status = 'pending' or (o.status = 'sending' and o.locked_until < now()))
      and o.next_attempt_at <= now()
      and o.attempts < o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id)
      -- Workers that predate booking emails never claim them (they would
      -- render them as something else); they wait for an updated worker.
      and (o.event_type <> 'booking_confirmed' or coalesce(p_include_booking, false))
      -- Staff invitation emails are claimed only by claim_staff_email_outbox.
      and o.entity_type <> 'staff_invitation'
      -- Planning invitation emails are claimed only by claim_planning_email_outbox.
      and o.entity_type <> 'planning_invitation'
      -- Archived businesses send nothing.
      and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null and t.suspended_at is null)
    order by o.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  ),
  claimed as (
    update public.email_outbox o
      set status = 'sending', attempts = o.attempts + 1,
          locked_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lock_seconds, 120), 900)))
      from due where o.id = due.id
      returning o.*
  )
  select c.id, c.tenant_id, c.event_type, c.recipient_email, c.entity_id, c.payload, c.attempts,
         c.access_link_id, l.token_hash, (l.id is not null and l.revoked_at is null and l.expires_at > now()),
         coalesce(e.active_proposal_id = c.entity_id, false),
         t.slug, t.display_name, t.reply_to_email,
         -- Contract emails are deliverable only while their invitation is
         -- usable and the contract is still sent, current and not archived.
         -- A void notice is deliverable while the contract is void.
         -- A signed copy is deliverable while the contract is signed, its event
         -- is not archived and its canonical PDF is committed.
         -- A booking confirmation is deliverable while the event is booked,
         -- not archived, and its contract signed.
         coalesce(case when c.event_type = 'booking_confirmed' then c.entity_type = 'contract' and k.status = 'signed'
                    and ke.archived_at is null and ke.lifecycle_status = 'booked'
                  when c.event_type = 'contract_signed_copy' then c.entity_type = 'contract' and k.status = 'signed'
                    and ke.archived_at is null
                    and exists (select 1 from public.contract_documents d where d.contract_id = k.id and d.kind = 'signed_contract')
                  when c.event_type = 'contract_voided' then c.entity_type = 'contract' and k.status = 'void'
                  else c.entity_type = 'contract' and l.purpose = 'contract' and l.contract_id = c.entity_id
                  and l.revoked_at is null and l.expires_at > now()
                  and k.status = 'sent' and ke.archived_at is null
                  and private.contract_is_current(k, ke) end, false),
         k.id
  from claimed c
  join public.tenants t on t.id = c.tenant_id
  left join public.access_links l on l.tenant_id = c.tenant_id and l.id = c.access_link_id
  left join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.entity_id
  left join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  left join public.contracts k on c.entity_type = 'contract' and k.tenant_id = c.tenant_id and k.id = c.entity_id
  left join public.events ke on ke.tenant_id = k.tenant_id and ke.id = k.event_id;
end;
$$;

CREATE OR REPLACE FUNCTION "private"."set_event_archived"("p_event_id" "uuid", "p_archived" boolean, "p_actor_type" "text", "p_actor_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_event public.events%rowtype;
  v_proposals uuid[];
  v_links int := 0;
  v_sessions int := 0;
  v_emails int := 0;
  v_contract_emails int := 0;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if p_archived = (v_event.archived_at is not null) then
    return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', true);
  end if;

  if p_archived then
    select coalesce(array_agg(p.id), '{}') into v_proposals
    from public.proposals p where p.tenant_id = v_event.tenant_id and p.event_id = v_event.id;
    -- Lock order everywhere: event, then proposals.
    perform 1 from public.proposals p where p.id = any (v_proposals) for update;

    update public.events set archived_at = now() where id = v_event.id;
    update public.access_links set revoked_at = now()
      where tenant_id = v_event.tenant_id and revoked_at is null
        and (proposal_id = any (v_proposals)
             -- A contract without a proposal: its invitation has no proposal to find it by.
             or contract_id in (select k.id from public.contracts k where k.tenant_id = v_event.tenant_id and k.event_id = v_event.id));
    get diagnostics v_links = row_count;
    update public.proposal_sessions set revoked_at = now()
      where tenant_id = v_event.tenant_id and proposal_id = any (v_proposals) and revoked_at is null;
    get diagnostics v_sessions = row_count;
    update public.email_outbox set status = 'cancelled', last_error = 'event archived'
      where tenant_id = v_event.tenant_id and entity_id = any (v_proposals)
        and event_type in ('proposal_sent', 'proposal_approved') and status = 'pending';
    get diagnostics v_emails = row_count;
    -- Contract invitations share the proposal links table and were revoked
    -- above; their pending emails are cancelled here.
    update public.email_outbox set status = 'cancelled', last_error = 'event archived'
      where tenant_id = v_event.tenant_id and entity_type = 'contract' and status = 'pending'
        and event_type <> 'contract_voided'
        and entity_id in (select k.id from public.contracts k where k.tenant_id = v_event.tenant_id and k.event_id = v_event.id);
    get diagnostics v_contract_emails = row_count;
    v_emails := v_emails + v_contract_emails;
  else
    update public.events set archived_at = null where id = v_event.id;
  end if;

  perform private.audit(v_event.tenant_id, 'event', v_event.id, case when p_archived then 'archived' else 'unarchived' end,
    p_actor_type, p_actor_id,
    case when p_archived then jsonb_build_object('links_revoked', v_links, 'sessions_revoked', v_sessions, 'emails_cancelled', v_emails)
         else '{}'::jsonb end);
  return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', false,
                            'links_revoked', v_links, 'sessions_revoked', v_sessions, 'emails_cancelled', v_emails);
end;
$$;

CREATE OR REPLACE FUNCTION "private"."evaluate_booking"("p_event_id" "uuid", "p_actor_type" "text", "p_actor_id" "uuid", "p_explicit" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  c public.contracts%rowtype;
  v_policy text;
  v_received bigint;
begin
  select * into e from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  select * into t from public.tenants where id = e.tenant_id;
  if e.lifecycle_status = 'booked' then
    return jsonb_build_object('status', 'already_booked', 'booking_confirmed_at', e.booking_confirmed_at);
  end if;
  if e.lifecycle_status in ('cancelled', 'completed') then
    return jsonb_build_object('status', 'not_bookable');
  end if;
  select * into c from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed';
  if not found then
    return jsonb_build_object('status', 'not_signed');
  end if;
  if e.archived_at is not null or t.archived_at is not null then
    return jsonb_build_object('status', 'archived');
  end if;
  -- Legacy contracts: only an explicit staff check (or one already done,
  -- which left the event awaiting its deposit) evaluates them, as on_deposit.
  v_policy := coalesce(c.booking_policy,
    case when p_explicit or e.lifecycle_status = 'awaiting_deposit' then 'on_deposit' end);
  if v_policy is null then
    return jsonb_build_object('status', 'needs_check');
  end if;
  -- The table forbids this; if it ever happened, a null deposit must never count as met.
  if v_policy = 'on_deposit' and c.deposit_cents is null then
    return jsonb_build_object('status', 'terms_invalid');
  end if;
  select coalesce(sum(p.amount_cents), 0) into v_received from public.event_payments p
  where p.tenant_id = e.tenant_id and p.event_id = e.id and p.invalidated_at is null and p.currency = c.currency;

  if v_policy = 'on_deposit' and v_received < c.deposit_cents then
    if e.lifecycle_status <> 'awaiting_deposit' then
      update public.events set lifecycle_status = 'awaiting_deposit' where id = e.id;
      perform private.audit(e.tenant_id, 'event', e.id, 'awaiting_deposit', p_actor_type, p_actor_id,
        jsonb_build_object('contract_id', c.id, 'policy', v_policy, 'deposit_cents', c.deposit_cents, 'received_cents', v_received));
    end if;
    return jsonb_build_object('status', 'awaiting_deposit', 'policy', v_policy,
      'deposit_outstanding_cents', c.deposit_cents - v_received);
  end if;

  perform set_config('flux.booking_event', e.id::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = e.id returning * into e;
  perform set_config('flux.booking_event', '', true);
  perform private.audit(e.tenant_id, 'event', e.id, 'booking_confirmed', p_actor_type, p_actor_id,
    jsonb_build_object('contract_id', c.id, 'policy', v_policy, 'legacy', c.booking_policy is null,
                       'deposit_cents', c.deposit_cents, 'received_cents', v_received));
  -- One confirmation email, queued with the booking. Frozen recipient,
  -- sender and figures, so retries are identical.
  insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, sender)
  values (e.tenant_id, 'booking_confirmed', lower(c.signer_email), 'contract', c.id,
    jsonb_build_object(
      'client_name', c.signer_name,
      'event_title', c.party_snapshot -> 'event' ->> 'title',
      'event_date', c.party_snapshot -> 'event' ->> 'date',
      'legal_name', coalesce(c.party_snapshot -> 'business' ->> 'legal_name', c.party_snapshot -> 'business' ->> 'name'),
      'contact_email', c.party_snapshot -> 'business' ->> 'contact_email',
      'currency', c.currency,
      'total_cents', c.total_cents,
      'deposit_cents', c.deposit_cents,
      'received_cents', v_received,
      -- Null without financial terms: greatest() ignores nulls and would say nothing is owed.
      'remaining_cents', case when c.total_cents is not null then greatest(c.total_cents - v_received, 0) end,
      'credit_cents', case when c.total_cents is not null then greatest(v_received - c.total_cents, 0) end,
      'balance_due_date', c.balance_due_date,
      'booked_on', (e.booking_confirmed_at at time zone t.timezone)::date),
    'booking_confirmed:' || e.id,
    jsonb_build_object('display_name', t.display_name, 'from_name', t.display_name || ' via Flux DJ', 'reply_to', t.reply_to_email))
  on conflict (dedup_key) do nothing;
  return jsonb_build_object('status', 'booked', 'policy', v_policy, 'booking_confirmed_at', e.booking_confirmed_at);
end;
$$;

CREATE OR REPLACE FUNCTION "private"."event_payment_summary"("p_event_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  c public.contracts%rowtype;
  v_has_contract boolean;
  v_has_terms boolean;
  v_currency text;
  v_received bigint;
  v_valid int;
  v_other_currency int;
begin
  select * into e from public.events where id = p_event_id;
  select * into t from public.tenants where id = e.tenant_id;
  -- The authoritative contract: signed, else currently sent (at most one of
  -- either exists per event).
  select * into c from public.contracts k
  where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status in ('signed', 'sent')
  order by (k.status = 'signed') desc, k.sent_at desc
  limit 1;
  v_has_contract := found;
  -- A contract without financial terms has a null total: no figures are derived from it.
  v_has_terms := v_has_contract and c.total_cents is not null;
  v_currency := case when v_has_contract then c.currency else t.currency end;
  select coalesce(sum(p.amount_cents) filter (where p.currency = v_currency), 0),
         count(*) filter (where p.currency = v_currency),
         count(*) filter (where p.currency <> v_currency)
    into v_received, v_valid, v_other_currency
  from public.event_payments p
  where p.tenant_id = e.tenant_id and p.event_id = e.id and p.invalidated_at is null;

  return jsonb_build_object(
    'currency', v_currency,
    'terms', case when v_has_terms then jsonb_build_object(
        'status', c.status, 'contract_id', c.id,
        'total_cents', c.total_cents, 'deposit_percent', c.deposit_percent, 'deposit_cents', c.deposit_cents,
        'balance_cents', c.balance_cents, 'balance_due_date', c.balance_due_date) end,
    'received_cents', v_received,
    'valid_payments', v_valid,
    'other_currency_payments', v_other_currency,
    'deposit_outstanding_cents', case when v_has_terms then greatest(c.deposit_cents - v_received, 0) end,
    'remaining_balance_cents', case when v_has_terms then greatest(c.total_cents - v_received, 0) end,
    'credit_cents', case when v_has_terms then greatest(v_received - c.total_cents, 0) end,
    'invoice_url', (select b.invoice_url from public.event_billing b where b.event_id = e.id),
    'booking', jsonb_build_object(
      'lifecycle_status', e.lifecycle_status,
      'booking_confirmed_at', e.booking_confirmed_at,
      -- The signed contract's frozen policy; null for contracts generated
      -- before policies existed (staff check those explicitly).
      'policy', case when v_has_contract and c.status = 'signed' then c.booking_policy end,
      'legacy_signed', v_has_contract and c.status = 'signed' and c.booking_policy is null,
      -- Booked under the deposit policy but valid payments no longer cover
      -- the deposit (a payment was invalidated). The booking stands.
      'deposit_no_longer_met', e.lifecycle_status = 'booked' and v_has_terms and c.status = 'signed'
        and coalesce(c.booking_policy, 'on_deposit') = 'on_deposit' and v_received < c.deposit_cents)
  )
  -- Only without financial terms, so every other summary is exactly as before.
  || case when v_has_contract and not v_has_terms then jsonb_build_object('no_financial_terms', true) else '{}'::jsonb end;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."client_payment_summary"("p_contract_id" "uuid", "p_tenant_slug" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  c public.contracts%rowtype;
  s jsonb;
begin
  select k.* into c from public.contracts k join public.tenants t on t.id = k.tenant_id
  where k.id = p_contract_id and t.slug = p_tenant_slug;
  if not found or not private.client_can_read_contract(c.id) then
    return null;
  end if;
  s := private.event_payment_summary(c.event_id);
  return jsonb_build_object(
    'currency', s ->> 'currency',
    'terms_status', s -> 'terms' ->> 'status',
    'total_cents', s -> 'terms' -> 'total_cents',
    'deposit_percent', s -> 'terms' -> 'deposit_percent',
    'deposit_cents', s -> 'terms' -> 'deposit_cents',
    'balance_due_date', s -> 'terms' -> 'balance_due_date',
    'received_cents', s -> 'received_cents',
    'deposit_outstanding_cents', s -> 'deposit_outstanding_cents',
    'remaining_balance_cents', s -> 'remaining_balance_cents',
    'credit_cents', s -> 'credit_cents',
    'invoice_url', s -> 'invoice_url',
    'booking_status', case s -> 'booking' ->> 'lifecycle_status' when 'booked' then 'booked' when 'awaiting_deposit' then 'awaiting_deposit' end
  )
  -- The viewed contract's frozen price breakdown, only when it has a discount.
  || case when c.commercial_snapshot ? 'discount' then jsonb_build_object('pricing', jsonb_build_object(
       'subtotal_cents', c.commercial_snapshot -> 'subtotal_cents',
       'discount', c.commercial_snapshot -> 'discount',
       'discounted_subtotal_cents', c.commercial_snapshot -> 'discounted_subtotal_cents',
       'tax_breakdown', (select coalesce(jsonb_agg(jsonb_build_object('label', t ->> 'label', 'rate_ppm', t -> 'rate_ppm', 'amount_cents', t -> 'amount_cents') order by ord), '[]'::jsonb)
                         from jsonb_array_elements(c.commercial_snapshot -> 'tax_breakdown') with ordinality as x(t, ord)),
       'total_cents', c.commercial_snapshot -> 'total_cents'))
     else '{}'::jsonb end
  || case when s ? 'no_financial_terms' then jsonb_build_object('no_financial_terms', true) else '{}'::jsonb end;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."client_contract_view"("p_contract_id" "uuid", "p_tenant_slug" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
      'legal_name', coalesce(c.party_snapshot -> 'business' ->> 'legal_name', c.party_snapshot -> 'business' ->> 'name'))
      -- Only on a direct contract, so every other view is exactly as before.
      || case when c.proposal_id is null then jsonb_build_object('source', 'direct') else '{}'::jsonb end,
    'signing', case when c.status = 'signed' then
        jsonb_build_object('signed', true, 'typed_name', s.typed_name, 'signed_at', s.signed_at,
          'pdf_ready', exists (select 1 from public.contract_documents d where d.contract_id = c.id and d.kind = 'signed_contract'),
          'pdf_pending', exists (select 1 from public.document_jobs j where j.contract_id = c.id and j.status in ('pending', 'running')))
      else
        jsonb_build_object('signed', false,
          'enabled', c.signing_mode <> 'none' and private.contract_signing_consent(c.consent_version) is not null,
          'consent_version', c.consent_version,
          'consent_text', private.contract_signing_consent(c.consent_version))
      end
  );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."review_contract_for_send"("p_contract_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
    'status', c.status,
    'sent_at', c.sent_at,
    'eligible', jsonb_array_length(v_problems) = 0,
    'problems', v_problems,
    'can_send', c.status = 'draft' and jsonb_array_length(v_problems) = 0,
    'send_unavailable_reason', case
      when c.status = 'signed' then 'This contract has been signed. It can no longer be sent, resent or voided.'
      when c.status = 'sent' then 'This contract has already been sent. Resend or void it from the contract page.'
      when c.status <> 'draft' then 'This contract is ' || c.status || ' and cannot be sent.'
      when jsonb_array_length(v_problems) > 0 then 'Fix the problems above before sending.'
      end,
    'signer', jsonb_build_object('name', c.signer_name, 'email', c.signer_email),
    'business', c.party_snapshot -> 'business',
    'deposit_percent', c.deposit_percent,
    'deposit_cents', c.deposit_cents,
    'balance_cents', c.balance_cents,
    'total_cents', c.total_cents,
    'currency', c.currency,
    'balance_due_date', c.balance_due_date,
    'content_sha256', c.content_sha256
  )
  || case when c.proposal_id is null then jsonb_build_object('source', 'direct') else '{}'::jsonb end;
end;
$$;

CREATE OR REPLACE FUNCTION "private"."contracts_before_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.status <> 'draft' then
    raise exception 'contracts are created as drafts' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.events e where e.tenant_id = new.tenant_id and e.id = new.event_id and e.archived_at is not null) then
    raise exception 'contract_not_allowed: the event is archived' using errcode = 'invalid_parameter_value';
  end if;
  -- After sending, a replacement needs the sent contract voided first.
  if exists (select 1 from public.contracts k where k.tenant_id = new.tenant_id and k.event_id = new.event_id and k.status in ('sent', 'signed')) then
    raise exception 'contract_not_allowed: a contract has already been sent for this event. Void it before generating a replacement'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (
    select 1 from public.contract_template_versions v
    where v.tenant_id = new.tenant_id and v.id = new.template_version_id
      and v.published_at is not null and v.content_sha256 = new.template_content_sha256
  ) then
    raise exception 'contracts can only be generated from a published template version' using errcode = 'check_violation';
  end if;
  if new.proposal_id is null then
    -- Never because references are missing: only for an event that is itself contract-first.
    if not exists (
      select 1 from public.events e
      where e.tenant_id = new.tenant_id and e.id = new.event_id and e.contract_first and e.booking_source = 'flux'
        and e.active_proposal_id is null and e.lifecycle_status in ('lead', 'awaiting_signature')
    ) then
      raise exception 'a contract without a proposal needs a contract-first event that is still being booked' using errcode = 'check_violation';
    end if;
  elsif not exists (
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

CREATE OR REPLACE FUNCTION "private"."contracts_signing_terms"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
    -- client-v1 says "including its payment terms", so it can't go on a contract without any.
    new.consent_version := case when new.total_cents is null then 'client-no-terms-v1' else 'client-v1' end;
  else
    perform private.contract_error('this version was published before agreements could be approved for client use. '
      || 'Open the template, start a new draft version and publish it for client use (or as DEMO for testing)');
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "private"."proposals_block_external_event"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if exists (select 1 from public.events e where e.tenant_id = new.tenant_id and e.id = new.event_id and e.booking_source = 'external') then
    raise exception 'external_booking: this event was booked outside Flux DJ, so it has no proposal or contract. Plan it from its planning page'
      using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.events e where e.tenant_id = new.tenant_id and e.id = new.event_id and e.contract_first) then
    raise exception 'contract_first: this event goes straight to a contract, so it has no proposal'
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;
