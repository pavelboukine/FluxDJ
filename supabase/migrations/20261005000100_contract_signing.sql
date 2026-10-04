-- Contract signing: signature capture and immutable signing evidence.
--
-- One client signer: the contract's frozen intended signer, signed in with a
-- current, verified Supabase session whose email matches the frozen signer
-- email and who holds event access for that signer. An invitation token is
-- never signer identity.
--
-- Storage and the database are separate systems, so signing is ordered:
--   1. The app server validates the Auth session with the Auth server
--      (auth.getUser), validates the drawn signature (PNG only, decoded size,
--      dimensions, real ink), re-encodes it as a clean PNG and runs the
--      read-only eligibility check (client_contract_view).
--   2. The server uploads those bytes with the service role to the private
--      "contract-signatures" bucket under a fresh, unique path
--      {tenant_id}/{contract_id}/{uuid}.png (never overwritten: no upsert,
--      no update/delete policies).
--   3. The server calls sign_contract (service role only) with the trusted
--      user id from step 1 and the stored object's path, SHA-256 and size.
--      One transaction locks event, proposal, contract (the order used by
--      every contract operation), rechecks every rule, verifies the object
--      exists in the bucket with the expected size and type and is not used
--      by any other signature, inserts the immutable evidence row, moves the
--      contract sent -> signed, retires its invitations and writes one audit
--      event.
--   If step 3 fails, nothing is signed; the server deletes its upload (best
--   effort). An upload left behind by a crash is an orphan: it is referenced
--   by no signature, readable by nobody but the service role, and listed by
--   private.contract_signature_orphans for manual cleanup. A committed
--   signature always references an object that was stored and verified first.
--   Retries and concurrent attempts wait on the event lock and then see the
--   existing signature: the same signer gets it back ("replayed"), nobody
--   else learns anything, and the first signature is never replaced.
--
-- Signing records contract completion only. The event stays
-- awaiting_signature: nothing here books the event, records payments or
-- grants planning access.
--
-- Stage limit: signing is enabled only for DEMO agreements (rendered title
-- starting "DEMO, NOT FOR CLIENT USE") until the agreement and consent
-- wording are reviewed. See private.contract_signing_enabled.
--
-- Retention of signatures and evidence is NOT decided. Nothing here deletes
-- evidence automatically, and nothing here establishes a retention period.

-- ===========================================================================
-- Storage: private signature bucket
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contract-signatures', 'contract-signatures', false, 262144, array['image/png'])
on conflict (id) do nothing;

-- ===========================================================================
-- Consent wording and the stage gate
-- ===========================================================================

-- The consent statements the client may accept, by version. The app shows the
-- current version's text from here and the evidence stores the text from
-- here, so the stored text is exactly what was displayed.
create function private.contract_signing_consent(p_version text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_version
    when 'demo-v1' then
      'I have read the agreement shown above. I intend to sign it electronically, and I agree that my typed name and '
      || 'drawn signature are my signature on this agreement.'
  end;
$$;

create function private.current_signing_consent_version()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'demo-v1'::text;
$$;

-- Signing is limited to DEMO agreements in this stage. Lifting it is a
-- deliberate, reviewed migration once the wording is approved.
create function private.contract_signing_enabled(p_rendered jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_rendered ->> 'title', '') like 'DEMO, NOT FOR CLIENT USE%';
$$;

-- ===========================================================================
-- Contracts: signed state
-- ===========================================================================

alter table public.contracts
  add column signed_at timestamptz,
  add constraint contracts_signed_matches_status check ((status = 'signed') = (signed_at is not null));
comment on column public.contracts.signed_at is 'When the contract was signed (database time, set once by sign_contract).';

-- Transitions: draft -> replaced | superseded | sent; sent -> void | signed.
-- Nothing leaves "signed" or "void". Only sign_contract may sign: it sets a
-- transaction-local marker after its checks, with the evidence and audit.
create or replace function private.contracts_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status in ('replaced', 'superseded', 'sent'))
         or (old.status = 'sent' and new.status in ('void', 'signed'))) then
      raise exception 'contract cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'sent' and current_setting('flux.sending_contract', true) is distinct from new.id::text then
      raise exception 'contracts are sent only through send_contract' using errcode = 'check_violation';
    end if;
    if new.status = 'signed' and current_setting('flux.signing_contract', true) is distinct from new.id::text then
      raise exception 'contracts are signed only through sign_contract' using errcode = 'check_violation';
    end if;
    new.status_changed_at := now();
    if new.status = 'sent' then new.sent_at := now(); end if;
    if new.status = 'void' then new.voided_at := now(); end if;
    if new.status = 'signed' then new.signed_at := now(); end if;
  elsif new.status_changed_at is distinct from old.status_changed_at then
    raise exception 'contracts.status_changed_at is set by the database' using errcode = 'check_violation';
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'contracts.sent_at cannot change once set' using errcode = 'check_violation';
  end if;
  if new.signed_at is distinct from old.signed_at and not (old.status = 'sent' and new.status = 'signed') then
    raise exception 'contracts.signed_at is set once by sign_contract' using errcode = 'check_violation';
  end if;
  if old.status = 'void' and (new.voided_at is distinct from old.voided_at or new.void_reason is distinct from old.void_reason) then
    raise exception 'a void contract cannot change' using errcode = 'check_violation';
  end if;
  if old.status = 'signed' and (new.voided_at is distinct from old.voided_at or new.void_reason is distinct from old.void_reason) then
    raise exception 'a signed contract cannot change' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- Signing evidence
-- ===========================================================================

create table public.contract_signatures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  contract_id uuid not null,
  signer_client_id uuid not null,
  -- Identity from the verified Auth session, read by the database.
  signer_user_id uuid not null,
  signer_email text not null
    constraint contract_signatures_email_valid check (private.is_valid_email(signer_email)),
  typed_name text not null
    constraint contract_signatures_typed_name_length check (length(btrim(typed_name)) between 1 and 200 and typed_name = btrim(typed_name)),
  -- The stored drawing: a server-produced PNG in the private bucket.
  signature_bucket text not null default 'contract-signatures'
    constraint contract_signatures_bucket_fixed check (signature_bucket = 'contract-signatures'),
  signature_path text not null
    constraint contract_signatures_path_format check (signature_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.png$'),
  signature_sha256 text not null
    constraint contract_signatures_sha256_format check (signature_sha256 ~ '^[0-9a-f]{64}$'),
  signature_bytes integer not null
    constraint contract_signatures_bytes_range check (signature_bytes between 1 and 262144),
  signature_width integer not null
    constraint contract_signatures_width_range check (signature_width between 1 and 4096),
  signature_height integer not null
    constraint contract_signatures_height_range check (signature_height between 1 and 4096),
  -- The exact agreement the signer saw.
  content_sha256 text not null
    constraint contract_signatures_content_sha256_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  consent_version text not null,
  consent_text text not null
    constraint contract_signatures_consent_text_present check (length(consent_text) > 0),
  -- Server time from the database.
  signed_at timestamptz not null default now(),
  -- Request context, only when reliably known; never fabricated.
  user_agent text
    constraint contract_signatures_user_agent_length check (length(user_agent) between 1 and 512),
  client_ip inet,
  client_ip_source text not null
    constraint contract_signatures_ip_source_valid check (client_ip_source in ('vercel', 'unavailable')),
  created_at timestamptz not null default now(),
  constraint contract_signatures_ip_matches_source check ((client_ip is null) = (client_ip_source = 'unavailable')),
  constraint contract_signatures_one_per_contract unique (contract_id),
  constraint contract_signatures_path_key unique (signature_path),
  constraint contract_signatures_contract_fk foreign key (tenant_id, event_id, contract_id)
    references public.contracts (tenant_id, event_id, id) on delete restrict,
  constraint contract_signatures_client_fk foreign key (tenant_id, signer_client_id)
    references public.clients (tenant_id, id) on delete restrict
);
comment on table public.contract_signatures is
  'Immutable signing evidence, one per contract, written only by sign_contract. Retention is not decided; nothing deletes it automatically.';
create index contract_signatures_tenant_event_idx on public.contract_signatures (tenant_id, event_id);
create index contract_signatures_tenant_client_idx on public.contract_signatures (tenant_id, signer_client_id);

create trigger contract_signatures_no_update before update on public.contract_signatures
  for each row execute function private.reject_change();
create trigger contract_signatures_no_delete before delete on public.contract_signatures
  for each row execute function private.reject_change();

-- Contracts that have a signature row must be signed, and vice versa, at
-- commit; checked from both sides.
create function private.contract_signature_consistent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Read the key through jsonb: PL/pgSQL resolves every NEW field reference,
  -- even in an untaken branch, and the two tables name it differently.
  v_contract uuid := (to_jsonb(new) ->> case when tg_table_name = 'contracts' then 'id' else 'contract_id' end)::uuid;
begin
  if (select c.status = 'signed' from public.contracts c where c.id = v_contract)
     is distinct from exists (select 1 from public.contract_signatures s where s.contract_id = v_contract) then
    raise exception 'a signed contract must have exactly one signature record' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
revoke execute on function private.contract_signature_consistent() from public, anon, authenticated;
create constraint trigger contract_signatures_consistent after insert on public.contract_signatures
  deferrable initially deferred for each row execute function private.contract_signature_consistent();
create constraint trigger contracts_signature_consistent after update of status on public.contracts
  deferrable initially deferred for each row when (new.status = 'signed' and old.status is distinct from 'signed')
  execute function private.contract_signature_consistent();

alter table public.contract_signatures enable row level security;
revoke all on public.contract_signatures from anon, authenticated;
grant select on public.contract_signatures to authenticated;
-- Staff of the tenant read evidence. Clients read their own signature only
-- through client_contract_view and client_signature_object.
create policy contract_signatures_select_staff on public.contract_signatures
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- Staff may read committed signature images of their tenant (for short-lived
-- signed URLs). Orphan uploads are not readable. Clients and anon have no
-- Storage policy at all; the signer gets a short-lived URL from the server
-- after client_signature_object authorizes it. Nobody but the service role
-- writes: there are no insert, update or delete policies.
create function private.can_read_contract_signature_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.contract_signatures s
    where s.signature_path = object_name and s.tenant_id in (select private.member_tenant_ids())
  );
$$;
revoke execute on function private.can_read_contract_signature_object(text) from public, anon;
grant execute on function private.can_read_contract_signature_object(text) to authenticated;
create policy contract_signature_objects_select_staff on storage.objects
  for select to authenticated
  using (bucket_id = 'contract-signatures' and private.can_read_contract_signature_object(name));

-- Uploads that no signature references (failed or abandoned commits).
create view private.contract_signature_orphans as
  select o.name, o.created_at, (o.metadata ->> 'size')::bigint as size
  from storage.objects o
  where o.bucket_id = 'contract-signatures'
    and not exists (select 1 from public.contract_signatures s where s.signature_path = o.name);
revoke all on private.contract_signature_orphans from public, anon, authenticated;

-- ===========================================================================
-- Client access to sent and signed contracts
-- ===========================================================================

-- Whether p_user_id (a verified identity) is the contract's signer with live
-- event access: the frozen signer email, the signer client's access row, the
-- event and business not archived, and the contract either sent on the
-- current approval or signed.
create function private.signer_can_access_contract(p_contract_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
    from public.contracts c
    join public.events e on e.tenant_id = c.tenant_id and e.id = c.event_id
    join public.tenants t on t.id = c.tenant_id
    join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.proposal_id
    join public.event_access ea on ea.tenant_id = c.tenant_id and ea.event_id = c.event_id
      and ea.user_id = p_user_id and ea.client_id = c.signer_client_id and ea.revoked_at is null
    join auth.users u on u.id = p_user_id and u.email_confirmed_at is not null
    where c.id = p_contract_id and e.archived_at is null and t.archived_at is null
      and lower(c.signer_email) = lower(u.email)
      and (c.status = 'signed'
           or (c.status = 'sent' and p.status = 'approved' and e.active_proposal_id = c.proposal_id))
  );
$$;
revoke execute on function private.signer_can_access_contract(uuid, uuid) from public, anon, authenticated;

create or replace function private.client_can_read_contract(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.signer_can_access_contract(p_contract_id, (select auth.uid()));
$$;

-- The client's view: frozen contract data, plus what signing needs (status,
-- consent wording, whether signing is enabled) and, once signed, the signed
-- name and time. No evidence metadata (IP, user agent, hashes of the image).
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
      'balance_due_date', c.balance_due_date,
      'event_title', c.party_snapshot -> 'event' ->> 'title', 'event_date', c.party_snapshot -> 'event' ->> 'date',
      'legal_name', coalesce(c.party_snapshot -> 'business' ->> 'legal_name', c.party_snapshot -> 'business' ->> 'name')),
    'signing', case when c.status = 'signed' then
        jsonb_build_object('signed', true, 'typed_name', s.typed_name, 'signed_at', s.signed_at)
      else
        jsonb_build_object('signed', false, 'enabled', private.contract_signing_enabled(c.rendered_content),
          'consent_version', private.current_signing_consent_version(),
          'consent_text', private.contract_signing_consent(private.current_signing_consent_version()))
      end
  );
end;
$$;

drop function public.my_contracts();
create function public.my_contracts()
returns table (tenant_slug text, tenant_display_name text, contract_id uuid, event_title text, event_date text, sent_at timestamptz,
               status text, signed_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.slug, t.display_name, c.id, c.party_snapshot -> 'event' ->> 'title', c.party_snapshot -> 'event' ->> 'date', c.sent_at,
         c.status, c.signed_at
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id
  join public.event_access ea on ea.tenant_id = c.tenant_id and ea.event_id = c.event_id
    and ea.user_id = (select auth.uid()) and ea.revoked_at is null
  where c.status in ('sent', 'signed') and private.client_can_read_contract(c.id)
  order by c.sent_at desc;
$$;
revoke execute on function public.my_contracts() from public, anon;
grant execute on function public.my_contracts() to authenticated;

-- The stored signature image path, only for the signer of a signed contract
-- they can still read. The server turns it into a short-lived signed URL.
create function public.client_signature_object(p_contract_id uuid, p_tenant_slug text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.signature_path
  from public.contract_signatures s
  join public.contracts c on c.id = s.contract_id
  join public.tenants t on t.id = c.tenant_id
  where s.contract_id = p_contract_id and t.slug = p_tenant_slug and c.status = 'signed'
    and s.signer_user_id = (select auth.uid())
    and private.client_can_read_contract(c.id);
$$;
revoke execute on function public.client_signature_object(uuid, text) from public, anon;
grant execute on function public.client_signature_object(uuid, text) to authenticated;

-- ===========================================================================
-- Signing (service role; the app passes the Auth-validated user id)
-- ===========================================================================

-- Returns one of:
--   {"status":"signed","replayed":false|true,"contract_id","signed_at","typed_name"}
--   {"status":"rejected","code","message"}   nothing was stored
-- "replayed" is returned only to the same signer, after the same access
-- checks; the caller then removes its unused upload.
create function public.sign_contract(
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
  if not private.contract_signing_enabled(c.rendered_content) then
    return jsonb_build_object('status', 'rejected', 'code', 'signing_disabled',
      'message', 'Online signing isn''t available for this contract yet.');
  end if;
  if p_content_sha256 is distinct from c.content_sha256 then
    return jsonb_build_object('status', 'rejected', 'code', 'content_changed',
      'message', 'This contract is not the one you were shown. Reload the page and read it again before signing.');
  end if;
  v_consent := private.contract_signing_consent(p_consent_version);
  if p_consent_version is distinct from private.current_signing_consent_version() or v_consent is null then
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
    c.content_sha256, p_consent_version, v_consent, v_ua, v_ip, case when v_ip is null then 'unavailable' else 'vercel' end)
  returning * into s;

  perform set_config('flux.signing_contract', c.id::text, true);
  update public.contracts set status = 'signed' where id = c.id returning * into c;
  perform set_config('flux.signing_contract', '', true);
  -- The signature row and the contract share one database timestamp.
  if s.signed_at <> c.signed_at then
    raise exception 'signing timestamps diverged' using errcode = 'internal_error';
  end if;

  perform private.retire_contract_invitations(c.id, 'contract signed');
  -- One audit event. Evidence stays in contract_signatures, not in the log.
  perform private.audit(c.tenant_id, 'contract', c.id, 'signed', 'client', p_user_id,
    jsonb_build_object('signature_id', s.id, 'content_sha256', c.content_sha256));
  return jsonb_build_object('status', 'signed', 'replayed', false, 'contract_id', c.id, 'signed_at', s.signed_at,
    'typed_name', s.typed_name);
end;
$$;
revoke execute on function public.sign_contract(uuid, text, uuid, text, text, text, boolean, text, text, integer, integer, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.sign_contract(uuid, text, uuid, text, text, text, boolean, text, text, integer, integer, integer, text, text, text)
  to service_role;

-- ===========================================================================
-- Signed contracts block commercial revisions (no amendments yet)
-- ===========================================================================

-- Superseding the proposal a signed contract was built from would change
-- the commercial terms under it; refuse until an amendment workflow exists.
-- send_proposal supersedes earlier proposals, so a revision fails here and
-- its whole transaction (freeze, links, email) rolls back.
create function private.proposals_protect_signed_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.contracts k where k.tenant_id = new.tenant_id and k.proposal_id = new.id and k.status = 'signed') then
    perform private.offer_error('a contract has been signed for this event, so its terms cannot be revised. Amendments are not available yet');
  end if;
  return new;
end;
$$;
revoke execute on function private.proposals_protect_signed_terms() from public, anon, authenticated;
create trigger proposals_protect_signed_terms before update of status on public.proposals
  for each row when (new.status is distinct from old.status and old.status = 'approved')
  execute function private.proposals_protect_signed_terms();

-- Staff see the reason before they start a revision draft.
create or replace function public.open_proposal_draft(p_event_id uuid, p_offer jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_membership_id uuid;
  v_existing uuid;
  v_revision int;
  v_offer jsonb := p_offer;
  v_id uuid;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_event.tenant_id);

  select p.id into v_existing from public.proposals p where p.event_id = v_event.id and p.status = 'draft';
  if v_existing is not null then
    return v_existing;
  end if;

  if v_event.lifecycle_status in ('cancelled', 'completed', 'booked') then
    perform private.offer_error('event is ' || v_event.lifecycle_status);
  end if;
  if exists (select 1 from public.contracts k where k.tenant_id = v_event.tenant_id and k.event_id = v_event.id and k.status = 'signed') then
    perform private.offer_error('a contract has been signed for this event, so its terms cannot be revised. Amendments are not available yet');
  end if;
  -- A revision starts from the offer the client currently has.
  if v_offer is null and v_event.active_proposal_id is not null then
    select p.draft_offer into v_offer from public.proposals p
    where p.tenant_id = v_event.tenant_id and p.id = v_event.active_proposal_id;
  end if;
  v_offer := coalesce(v_offer, '{}'::jsonb);
  if not private.is_valid_draft_offer(v_offer) then
    perform private.offer_error('draft offer has an invalid shape');
  end if;

  select coalesce(max(p.revision), 0) + 1 into v_revision from public.proposals p where p.event_id = v_event.id;

  insert into public.proposals (tenant_id, event_id, revision, status, draft_offer, source_template_id, created_by_membership_id)
  values (
    v_event.tenant_id, v_event.id, v_revision, 'draft', v_offer,
    case when private.is_uuid_text(v_offer ->> 'template_id') then (v_offer ->> 'template_id')::uuid end,
    v_membership_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Staff review shows the signed state instead of send problems.
create or replace function public.review_contract_for_send(p_contract_id uuid)
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
  );
end;
$$;

grant execute on function private.contract_signing_consent(text), private.current_signing_consent_version(),
  private.contract_signing_enabled(jsonb) to authenticated, service_role;
