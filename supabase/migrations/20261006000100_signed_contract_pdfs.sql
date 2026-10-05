-- Signed-contract PDFs, private downloads and signed-copy emails.
--
-- Flow and responsibilities:
--   1. sign_contract (unchanged otherwise) enqueues one document job in its
--      own transaction. Nothing is rendered inside the signing transaction,
--      so a rendering, upload or email failure can never undo a signature.
--   2. The worker (src/lib/contracts/documents.server.ts, run by the
--      scheduled /api/internal/outbox route and right after signing) claims
--      jobs with a lease (claim_document_jobs). It verifies the stored
--      signature bytes against their recorded SHA-256, renders the PDF only
--      from the frozen contract and the immutable signing evidence, hashes the
--      final bytes, uploads them to a fresh unique path in the private
--      "contract-documents" bucket, then commits (commit_contract_document).
--   3. The commit is atomic: it verifies the object, inserts the one canonical
--      contract_documents row (unique per contract), marks the job succeeded,
--      queues the two signed-copy emails when the job asks for delivery, and
--      writes an audit event. A second commit for the same contract (a
--      concurrent or retried worker) returns "exists"; that worker removes
--      its own upload, and the canonical PDF is never replaced.
--   4. Emails ("contract_signed_copy") go to the frozen signer email and the
--      frozen business contact email: one outbox row, dedup key and delivery
--      status per recipient. The worker attaches the committed PDF after
--      checking its bytes against the recorded hash. No bytes, tokens or URLs
--      are stored in the outbox.
--
-- Uncertain outcomes: if a worker dies after uploading, its object stays as
-- an unreferenced orphan (listed by private.contract_document_orphans) and
-- the job's lease expires, so another worker retries. If the commit's
-- response is lost, the upload is kept (it may be the canonical one) and the
-- retry either finds the committed PDF ("exists") or commits its own.
--
-- Existing signed contracts (signed before this migration) have no job. Staff
-- create one explicitly (request_signed_contract_pdf), without email, and
-- may then send the copies separately after confirming both recipients
-- (send_signed_contract_copies).
--
-- The PDF hash (contract_documents.pdf_sha256, over the final file bytes) is
-- distinct from the contract content hash (contracts.content_sha256). The
-- PDF never contains its own hash.

-- ===========================================================================
-- Storage: private documents bucket (server access only)
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contract-documents', 'contract-documents', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;
-- No Storage policies: staff and clients never read this bucket directly.
-- Downloads stream through authenticated app routes after authorization and
-- a hash check; only the service role reads or writes objects.

-- ===========================================================================
-- Canonical signed PDFs
-- ===========================================================================

create table public.contract_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  contract_id uuid not null,
  kind text not null default 'signed_contract'
    constraint contract_documents_kind_valid check (kind = 'signed_contract'),
  storage_bucket text not null default 'contract-documents'
    constraint contract_documents_bucket_fixed check (storage_bucket = 'contract-documents'),
  storage_path text not null
    constraint contract_documents_path_format check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$'),
  -- SHA-256 of the exact final PDF bytes in Storage. Not the contract content hash.
  pdf_sha256 text not null
    constraint contract_documents_pdf_sha256_format check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer not null
    constraint contract_documents_byte_size_range check (byte_size between 1 and 10485760),
  -- What the PDF was rendered from, copied for the record.
  content_sha256 text not null
    constraint contract_documents_content_sha256_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  signature_sha256 text not null
    constraint contract_documents_signature_sha256_format check (signature_sha256 ~ '^[0-9a-f]{64}$'),
  renderer text not null
    constraint contract_documents_renderer_length check (length(renderer) between 1 and 60),
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint contract_documents_one_canonical unique (contract_id, kind),
  constraint contract_documents_path_key unique (storage_path),
  constraint contract_documents_tenant_id_id_key unique (tenant_id, id),
  constraint contract_documents_contract_fk foreign key (tenant_id, event_id, contract_id)
    references public.contracts (tenant_id, event_id, id) on delete restrict
);
comment on table public.contract_documents is
  'The one canonical signed PDF per signed contract. Immutable; written only by commit_contract_document. Retention is not decided.';
comment on column public.contract_documents.pdf_sha256 is 'SHA-256 of the final PDF file bytes (what is downloaded and attached). Not the contract content hash.';
create index contract_documents_tenant_event_idx on public.contract_documents (tenant_id, event_id);

create trigger contract_documents_no_update before update on public.contract_documents
  for each row execute function private.reject_change();
create trigger contract_documents_no_delete before delete on public.contract_documents
  for each row execute function private.reject_change();

alter table public.contract_documents enable row level security;
revoke all on public.contract_documents from anon, authenticated;
grant select on public.contract_documents to authenticated;
create policy contract_documents_select_staff on public.contract_documents
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- ===========================================================================
-- Document jobs
-- ===========================================================================

create table public.document_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  contract_id uuid not null,
  kind text not null default 'signed_contract_pdf'
    constraint document_jobs_kind_valid check (kind = 'signed_contract_pdf'),
  status text not null default 'pending'
    constraint document_jobs_status_valid check (status in ('pending', 'running', 'succeeded', 'failed')),
  -- New signatures deliver the copies automatically; staff-requested PDFs
  -- for contracts signed before PDFs existed never email anyone.
  deliver_copies boolean not null,
  attempts integer not null default 0
    constraint document_jobs_attempts_nonnegative check (attempts >= 0),
  max_attempts integer not null default 5
    constraint document_jobs_max_attempts_range check (max_attempts between 1 and 50),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  locked_until timestamptz,
  last_error text
    constraint document_jobs_last_error_length check (length(last_error) <= 1000),
  document_id uuid,
  requested_by_user_id uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_jobs_one_per_contract unique (contract_id, kind),
  constraint document_jobs_contract_fk foreign key (tenant_id, contract_id)
    references public.contracts (tenant_id, id) on delete restrict,
  constraint document_jobs_document_fk foreign key (tenant_id, document_id)
    references public.contract_documents (tenant_id, id) on delete restrict,
  constraint document_jobs_succeeded_has_document check ((status = 'succeeded') = (document_id is not null))
);
comment on table public.document_jobs is
  'Durable PDF work, one per signed contract. Claimed with expiring leases; bounded retries; errors shown to staff.';
create index document_jobs_due_idx on public.document_jobs (next_attempt_at) where status in ('pending', 'running');
create index document_jobs_tenant_contract_idx on public.document_jobs (tenant_id, contract_id);
create index document_jobs_tenant_document_idx on public.document_jobs (tenant_id, document_id);

create trigger document_jobs_set_updated_at before update on public.document_jobs
  for each row execute function private.set_updated_at();
create trigger document_jobs_immutable before update on public.document_jobs
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'contract_id', 'kind', 'deliver_copies', 'created_at');
create trigger document_jobs_no_delete before delete on public.document_jobs
  for each row execute function private.reject_change();

alter table public.document_jobs enable row level security;
revoke all on public.document_jobs from anon, authenticated;
grant select on public.document_jobs to authenticated;
create policy document_jobs_select_staff on public.document_jobs
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- Uploads no canonical document references (crashed or losing workers).
create view private.contract_document_orphans as
  select o.name, o.created_at, (o.metadata ->> 'size')::bigint as size
  from storage.objects o
  where o.bucket_id = 'contract-documents'
    and not exists (select 1 from public.contract_documents d where d.storage_path = o.name);
revoke all on private.contract_document_orphans from public, anon, authenticated;

-- ===========================================================================
-- Signed-copy emails
-- ===========================================================================

alter table public.email_outbox drop constraint email_outbox_event_type_valid;
alter table public.email_outbox
  add constraint email_outbox_event_type_valid check (event_type in (
    'proposal_sent', 'proposal_link_opened', 'proposal_submitted', 'proposal_approved',
    'contract_sent', 'contract_sign_in', 'contract_voided', 'contract_signed_copy'));

-- Queues (or re-queues after failure/cancellation) the signed-copy email for
-- each party. Rows already pending, sending or sent are left alone, so a
-- completed delivery is never repeated. Frozen, non-secret details only.
create function private.enqueue_signed_copy_emails(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  s public.contract_signatures%rowtype;
  r record;
  v_out jsonb := '[]'::jsonb;
  v_row public.email_outbox%rowtype;
begin
  select * into c from public.contracts where id = p_contract_id;
  select * into s from public.contract_signatures where contract_id = p_contract_id;
  if c.status is distinct from 'signed' or s.id is null then
    raise exception 'contract_document_invalid: only a signed contract has a signed copy' using errcode = 'invalid_parameter_value';
  end if;
  for r in
    select 'client'::text as role, lower(c.signer_email) as email
    union all
    select 'business', lower(c.party_snapshot -> 'business' ->> 'contact_email')
  loop
    continue when r.email is null or not private.is_valid_email(r.email);
    insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key)
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
      'contract_signed_copy:' || c.id || ':' || r.role)
    on conflict (dedup_key) do nothing;
    update public.email_outbox
      set status = 'pending', max_attempts = least(attempts + 3, 50), next_attempt_at = now(), locked_until = null
      where dedup_key = 'contract_signed_copy:' || c.id || ':' || r.role and status in ('failed', 'cancelled');
    select * into v_row from public.email_outbox where dedup_key = 'contract_signed_copy:' || c.id || ':' || r.role;
    v_out := v_out || jsonb_build_object('role', r.role, 'email', r.email, 'status', v_row.status);
  end loop;
  return v_out;
end;
$$;
revoke execute on function private.enqueue_signed_copy_emails(uuid) from public, anon, authenticated;

-- ===========================================================================
-- Job lifecycle (service role)
-- ===========================================================================

-- Creates the contract's job if it has none. Idempotent.
create function private.enqueue_signed_contract_pdf(p_contract_id uuid, p_deliver boolean, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_id uuid;
begin
  select tenant_id into v_tenant from public.contracts where id = p_contract_id and status = 'signed';
  if v_tenant is null then
    raise exception 'contract_document_invalid: only a signed contract has a signed PDF' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.document_jobs (tenant_id, contract_id, deliver_copies, requested_by_user_id)
  values (v_tenant, p_contract_id, p_deliver, p_user_id)
  on conflict (contract_id, kind) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.document_jobs where contract_id = p_contract_id and kind = 'signed_contract_pdf';
  end if;
  return v_id;
end;
$$;
revoke execute on function private.enqueue_signed_contract_pdf(uuid, boolean, uuid) from public, anon, authenticated;

-- Claims due jobs with a fresh lease token. A running job whose lease expired
-- (a crashed worker) is claimable again; one with no attempts left fails.
create function public.claim_document_jobs(p_limit integer default 5, p_lease_seconds integer default 120, p_tenant_id uuid default null)
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
      and (p_tenant_id is null or j.tenant_id = p_tenant_id);

  return query
  with due as (
    select j.id from public.document_jobs j
    where ((j.status = 'pending' and j.next_attempt_at <= now()) or (j.status = 'running' and j.locked_until < now()))
      and j.attempts < j.max_attempts
      and (p_tenant_id is null or j.tenant_id = p_tenant_id)
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

-- Atomically records the canonical PDF. Returns
--   {"status":"committed","document_id"}  this upload is now canonical
--   {"status":"exists","document_id","storage_path"}  another upload already
--      is; the caller removes its own upload
-- Any worker holding a valid upload may commit, even after its lease expired
-- (the unique constraint picks one canonical PDF, and the job row lock
-- serializes commits per contract), so no lease token is needed here.
create function public.commit_contract_document(
  p_job_id uuid, p_storage_path text, p_pdf_sha256 text, p_byte_size integer,
  p_signature_sha256 text, p_renderer text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.document_jobs%rowtype;
  c public.contracts%rowtype;
  s public.contract_signatures%rowtype;
  d public.contract_documents%rowtype;
  v_object record;
begin
  select * into j from public.document_jobs where id = p_job_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  select * into c from public.contracts where id = j.contract_id;
  select * into s from public.contract_signatures where contract_id = j.contract_id;

  select * into d from public.contract_documents where contract_id = j.contract_id and kind = 'signed_contract';
  if found then
    if j.status <> 'succeeded' then
      update public.document_jobs
        set status = 'succeeded', document_id = d.id, completed_at = now(), lease_token = null, locked_until = null, last_error = null
        where id = j.id;
      if j.deliver_copies then
        perform private.enqueue_signed_copy_emails(c.id);
      end if;
    end if;
    return jsonb_build_object('status', 'exists', 'document_id', d.id, 'storage_path', d.storage_path);
  end if;

  if c.status <> 'signed' or s.id is null then
    raise exception 'contract_document_invalid: the contract is not signed' using errcode = 'invalid_parameter_value';
  end if;
  if p_signature_sha256 is distinct from s.signature_sha256 then
    raise exception 'contract_document_invalid: the PDF was rendered from a different signature image' using errcode = 'invalid_parameter_value';
  end if;
  if p_storage_path is null or p_storage_path !~ ('^' || c.tenant_id || '/' || c.id || '/[0-9a-f-]{36}\.pdf$')
     or p_pdf_sha256 is null or p_pdf_sha256 !~ '^[0-9a-f]{64}$'
     or p_byte_size is null or p_byte_size not between 1 and 10485760
     or p_renderer is null or length(p_renderer) not between 1 and 60 then
    raise exception 'contract_document_invalid: invalid document reference' using errcode = 'invalid_parameter_value';
  end if;
  select (o.metadata ->> 'size')::bigint as size, o.metadata ->> 'mimetype' as mimetype into v_object
  from storage.objects o where o.bucket_id = 'contract-documents' and o.name = p_storage_path;
  if not found or v_object.size is distinct from p_byte_size or v_object.mimetype is distinct from 'application/pdf' then
    raise exception 'contract_document_invalid: the uploaded PDF is missing or does not match its size' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.contract_documents (tenant_id, event_id, contract_id, storage_path, pdf_sha256, byte_size,
    content_sha256, signature_sha256, renderer)
  values (c.tenant_id, c.event_id, c.id, p_storage_path, p_pdf_sha256, p_byte_size, c.content_sha256, s.signature_sha256, p_renderer)
  returning * into d;
  update public.document_jobs
    set status = 'succeeded', document_id = d.id, completed_at = now(), lease_token = null, locked_until = null, last_error = null
    where id = j.id;
  -- Emails only after the artifact is committed, in the same transaction.
  if j.deliver_copies then
    perform private.enqueue_signed_copy_emails(c.id);
  end if;
  perform private.audit(c.tenant_id, 'contract', c.id, 'signed_pdf_generated', 'system', null,
    jsonb_build_object('document_id', d.id, 'pdf_sha256', d.pdf_sha256, 'byte_size', d.byte_size));
  return jsonb_build_object('status', 'committed', 'document_id', d.id);
end;
$$;

-- Records a failed attempt for the current lease holder only. Backs off
-- (1, 2, 4... minutes, capped at an hour) until max_attempts, then fails for
-- staff to retry. A succeeded job is never changed.
create function public.fail_document_job(p_job_id uuid, p_lease_token uuid, p_error text, p_permanent boolean default false)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.document_jobs
    set status = case when p_permanent or attempts >= max_attempts then 'failed' else 'pending' end,
        next_attempt_at = now() + least(interval '1 minute' * power(2, greatest(attempts - 1, 0)), interval '1 hour'),
        last_error = left(coalesce(p_error, 'unknown error'), 1000),
        lease_token = null, locked_until = null
    where id = p_job_id and status = 'running' and lease_token = p_lease_token;
  return found;
end;
$$;

-- ===========================================================================
-- Staff actions
-- ===========================================================================

-- Generates the signed PDF if missing (used for contracts signed before PDFs
-- existed, and to retry a failed job). Never emails anyone by itself.
create function public.request_signed_contract_pdf(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  j public.document_jobs%rowtype;
begin
  select * into c from public.contracts where id = p_contract_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(c.tenant_id);
  if c.status <> 'signed' then
    raise exception 'contract_document_invalid: only a signed contract has a signed PDF' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.contract_documents d where d.contract_id = c.id and d.kind = 'signed_contract') then
    return jsonb_build_object('status', 'ready');
  end if;
  perform private.enqueue_signed_contract_pdf(c.id, false, (select auth.uid()));
  select * into j from public.document_jobs where contract_id = c.id and kind = 'signed_contract_pdf' for update;
  if j.status = 'failed' then
    update public.document_jobs
      set status = 'pending', max_attempts = least(attempts + 3, 50), next_attempt_at = now(), last_error = null
      where id = j.id
      returning * into j;
    perform private.audit(c.tenant_id, 'contract', c.id, 'signed_pdf_retry_requested', 'staff', (select auth.uid()), '{}'::jsonb);
  elsif j.requested_by_user_id = (select auth.uid()) and j.attempts = 0 then
    perform private.audit(c.tenant_id, 'contract', c.id, 'signed_pdf_requested', 'staff', (select auth.uid()), '{}'::jsonb);
  end if;
  return jsonb_build_object('status', j.status);
end;
$$;

-- Sends (or re-queues failed/cancelled) signed copies after staff confirmed
-- both recipients. p_recipients must list exactly the frozen signer email and
-- frozen business contact email, so the action matches what staff saw.
create function public.send_signed_contract_copies(p_contract_id uuid, p_recipients text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  v_expected text[];
  v_result jsonb;
begin
  select * into c from public.contracts where id = p_contract_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(c.tenant_id);
  -- Lock order: event, then contract (as everywhere).
  perform 1 from public.events where tenant_id = c.tenant_id and id = c.event_id for update;
  if c.status <> 'signed' or not exists (select 1 from public.contract_documents d where d.contract_id = c.id and d.kind = 'signed_contract') then
    raise exception 'contract_document_invalid: generate the signed PDF before sending copies' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.events e where e.tenant_id = c.tenant_id and e.id = c.event_id and e.archived_at is not null) then
    raise exception 'contract_document_invalid: the event is archived. Unarchive it before sending copies' using errcode = 'invalid_parameter_value';
  end if;
  select array_agg(x order by x) into v_expected from unnest(array[
    lower(c.signer_email), lower(c.party_snapshot -> 'business' ->> 'contact_email')]) x where x is not null;
  if (select array_agg(lower(btrim(x)) order by lower(btrim(x))) from unnest(coalesce(p_recipients, '{}')) x) is distinct from v_expected then
    raise exception 'contract_document_invalid: the recipients changed. Reload the page and confirm them again' using errcode = 'invalid_parameter_value';
  end if;
  v_result := private.enqueue_signed_copy_emails(c.id);
  perform private.audit(c.tenant_id, 'contract', c.id, 'signed_copies_requested', 'staff', (select auth.uid()),
    jsonb_build_object('recipients', to_jsonb(v_expected)));
  return v_result;
end;
$$;

-- ===========================================================================
-- Client access to the signed PDF
-- ===========================================================================

-- The canonical PDF reference, only for the signer of a signed contract they
-- can still read (verified identity, live access, not archived). The app
-- streams the bytes after checking them against pdf_sha256.
create function public.client_signed_document(p_contract_id uuid, p_tenant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('document_id', d.id, 'storage_path', d.storage_path, 'pdf_sha256', d.pdf_sha256, 'byte_size', d.byte_size,
    'event_title', c.party_snapshot -> 'event' ->> 'title', 'event_date', c.party_snapshot -> 'event' ->> 'date')
  from public.contract_documents d
  join public.contracts c on c.id = d.contract_id
  join public.tenants t on t.id = c.tenant_id
  join public.contract_signatures s on s.contract_id = c.id
  where d.contract_id = p_contract_id and d.kind = 'signed_contract' and t.slug = p_tenant_slug and c.status = 'signed'
    and s.signer_user_id = (select auth.uid())
    and private.client_can_read_contract(c.id);
$$;

-- ===========================================================================
-- Signing enqueues PDF work; the outbox delivers signed copies; the client
-- view knows when the PDF is ready
-- ===========================================================================

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
  -- PDF work is queued in this same transaction and rendered later by the
  -- worker, so a rendering failure can never undo or lose the signature.
  perform private.enqueue_signed_contract_pdf(c.id, true, null);
  -- One audit event. Evidence stays in contract_signatures, not in the log.
  perform private.audit(c.tenant_id, 'contract', c.id, 'signed', 'client', p_user_id,
    jsonb_build_object('signature_id', s.id, 'content_sha256', c.content_sha256));
  return jsonb_build_object('status', 'signed', 'replayed', false, 'contract_id', c.id, 'signed_at', s.signed_at,
    'typed_name', s.typed_name);
end;
$$;

create or replace function public.claim_email_outbox(p_limit integer default 10, p_lock_seconds integer default 120, p_tenant_id uuid default null)
returns table (
  id uuid, tenant_id uuid, event_type text, recipient_email text, entity_id uuid, payload jsonb, attempts integer,
  access_link_id uuid, link_token_hash text, link_usable boolean, proposal_active boolean,
  tenant_slug text, tenant_display_name text, tenant_reply_to text,
  contract_deliverable boolean, contract_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
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
      -- Archived businesses send nothing.
      and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null)
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
         coalesce(case when c.event_type = 'contract_signed_copy' then c.entity_type = 'contract' and k.status = 'signed'
                    and ke.archived_at is null
                    and exists (select 1 from public.contract_documents d where d.contract_id = k.id and d.kind = 'signed_contract')
                  when c.event_type = 'contract_voided' then c.entity_type = 'contract' and k.status = 'void'
                  else c.entity_type = 'contract' and l.purpose = 'contract' and l.contract_id = c.entity_id
                  and l.revoked_at is null and l.expires_at > now()
                  and k.status = 'sent' and ke.archived_at is null
                  and kp.status = 'approved' and ke.active_proposal_id = k.proposal_id end, false),
         k.id
  from claimed c
  join public.tenants t on t.id = c.tenant_id
  left join public.access_links l on l.tenant_id = c.tenant_id and l.id = c.access_link_id
  left join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.entity_id
  left join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  left join public.contracts k on c.entity_type = 'contract' and k.tenant_id = c.tenant_id and k.id = c.entity_id
  left join public.events ke on ke.tenant_id = k.tenant_id and ke.id = k.event_id
  left join public.proposals kp on kp.tenant_id = k.tenant_id and kp.id = k.proposal_id;
end;
$$;

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
        jsonb_build_object('signed', true, 'typed_name', s.typed_name, 'signed_at', s.signed_at,
          'pdf_ready', exists (select 1 from public.contract_documents d where d.contract_id = c.id and d.kind = 'signed_contract'),
          'pdf_pending', exists (select 1 from public.document_jobs j where j.contract_id = c.id and j.status in ('pending', 'running')))
      else
        jsonb_build_object('signed', false, 'enabled', private.contract_signing_enabled(c.rendered_content),
          'consent_version', private.current_signing_consent_version(),
          'consent_text', private.contract_signing_consent(private.current_signing_consent_version()))
      end
  );
end;
$$;

-- ===========================================================================
-- Grants
-- ===========================================================================

revoke execute on function
  public.claim_document_jobs(integer, integer, uuid),
  public.commit_contract_document(uuid, text, text, integer, text, text),
  public.fail_document_job(uuid, uuid, text, boolean),
  public.request_signed_contract_pdf(uuid),
  public.send_signed_contract_copies(uuid, text[]),
  public.client_signed_document(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.claim_document_jobs(integer, integer, uuid),
  public.commit_contract_document(uuid, text, text, integer, text, text),
  public.fail_document_job(uuid, uuid, text, boolean)
  to service_role;
grant execute on function
  public.request_signed_contract_pdf(uuid),
  public.send_signed_contract_copies(uuid, text[]),
  public.client_signed_document(uuid, text)
  to authenticated;
