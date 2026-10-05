-- Signed-contract PDFs: the job queued with the signature, leases and
-- recovery, one canonical immutable document, emails only after commit (one
-- per recipient), authorization for staff, signer and others, and the
-- explicit path for contracts signed before PDFs existed.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(73);

create function tests.send_c(contract uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  return public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;
create function tests.put_object(bucket text, contract uuid, ext text, size int, mime text) returns text language plpgsql as $$
declare v_path text;
begin
  select k.tenant_id || '/' || k.id || '/' || gen_random_uuid() || '.' || ext into v_path from public.contracts k where k.id = contract;
  insert into storage.objects (bucket_id, name, metadata) values (bucket, v_path, jsonb_build_object('size', size, 'mimetype', mime));
  return v_path;
end $$;
-- Signs as the service role with a stored signature image.
create function tests.sign_as(contract uuid, signer text) returns jsonb language plpgsql as $$
declare v_path text; r jsonb;
begin
  v_path := tests.put_object('contract-signatures', contract, 'png', 4096, 'image/png');
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id(signer), 'Signer Name',
    (select content_sha256 from public.contracts where id = contract), 'demo-v1', true, v_path, repeat('b', 64), 4096, 900, 300,
    'Test Browser', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.claim() returns setof record language plpgsql as $$
begin
  perform tests.login_as_service();
  return query select j.job_id, j.lease_token, j.attempts from public.claim_document_jobs(10, 120, tests.id('tenant_a')) j;
end $$;
create function tests.commit(job uuid, path text, sig text default repeat('b', 64)) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as_service();
  r := public.commit_contract_document(job, path, repeat('d', 64), 50000, sig, 'flux-signed-contract-pdf/1');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Setup: a sent DEMO contract for A2 (signer Client Y), signed.
update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections(), 'DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}')::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c(current_setting('tests.c')::uuid);
reset role;
select tests.sign_as(current_setting('tests.c')::uuid, 'client_y');
create temp table c_before as select rendered_content, commercial_snapshot, party_snapshot, content_sha256, signed_at from public.contracts where id = current_setting('tests.c')::uuid;
create temp table sig_before as select * from public.contract_signatures where contract_id = current_setting('tests.c')::uuid;
grant select on c_before, sig_before to authenticated, service_role;

-- ===========================================================================
-- Signing queues exactly one job, and no email yet
-- ===========================================================================
select results_eq(
  $$ select status, deliver_copies, attempts, document_id is null from public.document_jobs where contract_id = current_setting('tests.c')::uuid $$,
  $$ values ('pending'::text, true, 0, true) $$, 'signing queued one PDF job that will deliver copies');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy'), 0,
  'no signed-copy email before the PDF is committed');
select is(tests.sign_as(current_setting('tests.c')::uuid, 'client_y') ->> 'replayed', 'true', 'a replayed signature');
select is((select count(*)::int from public.document_jobs where contract_id = current_setting('tests.c')::uuid), 1, 'does not queue a second job');

-- ===========================================================================
-- Only the service role runs jobs
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select * from public.claim_document_jobs(10, 120, null) $$, '42501', null, 'staff cannot claim jobs');
select throws_ok($$ select public.commit_contract_document(gen_random_uuid(), 'x', repeat('d', 64), 1, repeat('b', 64), 'r') $$, '42501', null, 'or commit documents');
select throws_ok($$ select public.fail_document_job(gen_random_uuid(), gen_random_uuid(), 'x', false) $$, '42501', null, 'or fail jobs');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select * from public.claim_document_jobs(10, 120, null) $$, '42501', null, 'clients cannot claim jobs');
select tests.login_as_anon();
select throws_ok($$ select * from public.claim_document_jobs(10, 120, null) $$, '42501', null, 'nor anon');
reset role;

-- ===========================================================================
-- Leases: claim, no double claim, expiry and recovery
-- ===========================================================================
select set_config('tests.job', (select job_id::text from tests.claim() as t(job_id uuid, lease_token uuid, attempts int) limit 1), true);
reset role;
select set_config('tests.lease1', (select lease_token::text from public.document_jobs where id = current_setting('tests.job')::uuid), true);
select results_eq($$ select status, attempts, locked_until > now() from public.document_jobs where id = current_setting('tests.job')::uuid $$,
  $$ values ('running'::text, 1, true) $$, 'a claim leases the job');
select is((select count(*)::int from tests.claim() as t(job_id uuid, lease_token uuid, attempts int)), 0, 'a leased job is not claimed twice');
reset role;
update public.document_jobs set locked_until = now() - interval '1 second' where id = current_setting('tests.job')::uuid;
select is((select attempts from tests.claim() as t(job_id uuid, lease_token uuid, attempts int) limit 1), 2, 'an expired lease (crashed worker) is reclaimed');
reset role;
select isnt((select lease_token::text from public.document_jobs where id = current_setting('tests.job')::uuid), current_setting('tests.lease1'), 'with a new lease token');
select tests.login_as_service();
select is(public.fail_document_job(current_setting('tests.job')::uuid, current_setting('tests.lease1')::uuid, 'stale', false), false,
  'the crashed worker''s old lease cannot fail the job');
reset role;
select is((select status from public.document_jobs where id = current_setting('tests.job')::uuid), 'running', 'the job is still running for the new holder');

-- ===========================================================================
-- Commit: validation, one canonical document, emails after commit
-- ===========================================================================
select throws_like($$ select tests.commit(current_setting('tests.job')::uuid,
    (select tenant_id || '/' || id || '/' || gen_random_uuid() || '.pdf' from public.contracts where id = current_setting('tests.c')::uuid)) $$,
  '%missing or does not match%', 'a PDF that was never uploaded cannot be committed');
select throws_like($$ select tests.commit(current_setting('tests.job')::uuid, tests.put_object('contract-documents', current_setting('tests.c')::uuid, 'pdf', 50000, 'application/pdf'), repeat('e', 64)) $$,
  '%different signature image%', 'a PDF rendered from another signature image is refused');
select throws_like($$ select tests.commit(current_setting('tests.job')::uuid, tests.put_object('contract-documents', current_setting('tests.c')::uuid, 'pdf', 49999, 'application/pdf')) $$,
  '%does not match its size%', 'the stored size must match');
select throws_like($$ select tests.commit(current_setting('tests.job')::uuid, tests.put_object('contract-documents', current_setting('tests.c')::uuid, 'pdf', 50000, 'text/html')) $$,
  '%missing or does not match%', 'only a stored PDF');
select throws_like($$ select tests.commit(current_setting('tests.job')::uuid, 'aaaaaaaa-0000-4000-8000-000000000000/' || current_setting('tests.c') || '/' || gen_random_uuid() || '.pdf') $$,
  '%invalid document reference%', 'only this contract''s folder');
select is((select count(*)::int from public.contract_documents where contract_id = current_setting('tests.c')::uuid), 0, 'nothing committed by refused attempts');

select set_config('tests.pdf1', tests.put_object('contract-documents', current_setting('tests.c')::uuid, 'pdf', 50000, 'application/pdf'), true);
select is(tests.commit(current_setting('tests.job')::uuid, current_setting('tests.pdf1')) ->> 'status', 'committed', 'the first valid upload is committed');
select results_eq(
  $$ select d.storage_path, d.pdf_sha256, d.byte_size, d.content_sha256 = c.content_sha256, d.signature_sha256, d.renderer
     from public.contract_documents d join public.contracts c on c.id = d.contract_id where d.contract_id = current_setting('tests.c')::uuid $$,
  $$ values (current_setting('tests.pdf1'), repeat('d', 64), 50000, true, repeat('b', 64), 'flux-signed-contract-pdf/1'::text) $$,
  'the canonical document records path, final-PDF hash, size, content hash, signature hash and renderer');
select results_eq(
  $$ select j.status, j.document_id = d.id, j.lease_token is null, j.completed_at is not null
     from public.document_jobs j join public.contract_documents d on d.contract_id = j.contract_id where j.id = current_setting('tests.job')::uuid $$,
  $$ values ('succeeded'::text, true, true, true) $$, 'the job succeeded and references it');
select results_eq(
  $$ select recipient_email, dedup_key, status, payload ->> 'recipient_role' from public.email_outbox
     where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy' order by recipient_email $$,
  $$ values ('client-y@example.test'::text, 'contract_signed_copy:' || current_setting('tests.c') || ':client', 'pending'::text, 'client'::text),
            ('legal@bouprod.test'::text, 'contract_signed_copy:' || current_setting('tests.c') || ':business', 'pending'::text, 'business'::text) $$,
  'one email per party, with separate dedup keys, queued by the commit');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy'
           and (payload ? 'storage_path' or payload ? 'url' or payload ? 'token' or payload::text like '%' || current_setting('tests.pdf1') || '%')), 0,
  'payloads carry no path, URL, token or bytes');
select is((select count(*)::int from public.audit_events where entity_id = current_setting('tests.c')::uuid and action = 'signed_pdf_generated'), 1, 'audited once');

select set_config('tests.pdf2', tests.put_object('contract-documents', current_setting('tests.c')::uuid, 'pdf', 50000, 'application/pdf'), true);
select is(tests.commit(current_setting('tests.job')::uuid, current_setting('tests.pdf2')) ->> 'status', 'exists', 'a second upload (concurrent or retried worker) is not canonical');
select is((select count(*)::int from public.contract_documents where contract_id = current_setting('tests.c')::uuid), 1, 'still one canonical document');
select is((select storage_path from public.contract_documents where contract_id = current_setting('tests.c')::uuid), current_setting('tests.pdf1'), 'the first one, never replaced');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy'), 2, 'and no duplicate emails');
select tests.login_as_service();
select is(public.fail_document_job(current_setting('tests.job')::uuid, current_setting('tests.lease1')::uuid, 'late', false), false, 'a succeeded job cannot be failed');
reset role;
select ok(exists (select 1 from private.contract_document_orphans where name = current_setting('tests.pdf2')), 'the unused upload is listed as an orphan');
select ok(not exists (select 1 from private.contract_document_orphans where name = current_setting('tests.pdf1')), 'the canonical one is not');

-- Immutability; the signature and contract are untouched.
select throws_ok($$ update public.contract_documents set pdf_sha256 = repeat('f', 64) where contract_id = current_setting('tests.c')::uuid $$, '23514', null, 'the document record cannot be edited');
select throws_ok($$ delete from public.contract_documents where contract_id = current_setting('tests.c')::uuid $$, '23514', null, 'or deleted');
select throws_ok($$ update public.document_jobs set deliver_copies = false where contract_id = current_setting('tests.c')::uuid $$, '23514', null, 'a job''s delivery choice is fixed');
select throws_ok($$ delete from public.document_jobs where contract_id = current_setting('tests.c')::uuid $$, '23514', null, 'jobs are kept');
select is((select row(s.*)::text from public.contract_signatures s where contract_id = current_setting('tests.c')::uuid), (select row(b.*)::text from sig_before b),
  'the signing evidence is unchanged');
select results_eq($$ select c.rendered_content = b.rendered_content and c.commercial_snapshot = b.commercial_snapshot and c.party_snapshot = b.party_snapshot
     and c.content_sha256 = b.content_sha256 and c.signed_at = b.signed_at from public.contracts c, c_before b where c.id = current_setting('tests.c')::uuid $$,
  $$ values (true) $$, 'and so is the signed contract');

-- Delivery eligibility at dispatch.
select tests.login_as_service();
select results_eq($$ select bool_and(contract_deliverable) from public.claim_email_outbox(10, 120, tests.id('tenant_a')) where event_type = 'contract_signed_copy' $$,
  $$ values (true) $$, 'signed copies are deliverable once the PDF is committed');
reset role;
update public.email_outbox set status = 'pending', locked_until = null where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy';

-- ===========================================================================
-- Who can see and download
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.contract_documents where contract_id = current_setting('tests.c')::uuid), 1, 'the owner sees the document record');
select is((select count(*)::int from storage.objects where bucket_id = 'contract-documents'), 0, 'but cannot read the bucket directly');
select is(public.client_signed_document(current_setting('tests.c')::uuid, 'test-bouprod'), null, 'nor use the client download');
select tests.login_as(tests.id('staff_a'));
select is((select count(*)::int from public.contract_documents where contract_id = current_setting('tests.c')::uuid), 1, 'staff see it too');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.contract_documents), 0, 'another tenant sees nothing');
select is((select count(*)::int from public.document_jobs), 0, 'not even jobs');
select tests.login_as(tests.id('client_y'));
select is(public.client_signed_document(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'storage_path', current_setting('tests.pdf1'), 'the signer gets the canonical PDF reference');
select is(public.client_signed_document(current_setting('tests.c')::uuid, 'test-other-dj'), null, 'not under another tenant''s path');
select is((select count(*)::int from public.contract_documents), 0, 'clients cannot read document records directly');
select is((select count(*)::int from storage.objects where bucket_id = 'contract-documents'), 0, 'or the bucket');
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') #>> '{signing,pdf_ready}', 'true', 'the client view says the PDF is ready');
select tests.login_as(tests.id('client_x'));
select is(public.client_signed_document(current_setting('tests.c')::uuid, 'test-bouprod'), null, 'another client gets nothing');
select tests.login_as_anon();
select throws_ok($$ select public.client_signed_document(gen_random_uuid(), 'test-bouprod') $$, '42501', null, 'anon cannot ask');
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a2'), true);
select tests.login_as(tests.id('client_y'));
select is(public.client_signed_document(current_setting('tests.c')::uuid, 'test-bouprod'), null, 'archiving blocks the signer''s download');
reset role;
select is((select count(*)::int from public.contract_documents where contract_id = current_setting('tests.c')::uuid), 1, 'but keeps the PDF');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy' and status = 'cancelled'), 2,
  'and cancels undelivered copies');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.send_signed_contract_copies(current_setting('tests.c')::uuid, array['client-y@example.test', 'legal@bouprod.test']) $$,
  '%archived%', 'copies cannot be sent while archived');
select public.set_event_archived(tests.id('event_a2'), false);
select tests.login_as(tests.id('client_y'));
select is(public.client_signed_document(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'storage_path', current_setting('tests.pdf1'), 'unarchiving restores the same PDF, not a new one');

-- ===========================================================================
-- Staff: recipient-confirmed resend, per-recipient state
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.send_signed_contract_copies(current_setting('tests.c')::uuid, array['client-y@example.test']) $$,
  '%recipients changed%', 'both confirmed recipients are required');
select throws_like($$ select public.send_signed_contract_copies(current_setting('tests.c')::uuid, array['client-y@example.test', 'attacker@example.test']) $$,
  '%recipients changed%', 'no other recipient can be substituted');
select is(jsonb_array_length(public.send_signed_contract_copies(current_setting('tests.c')::uuid, array['LEGAL@bouprod.test', 'client-y@example.test'])), 2,
  'confirmed resend re-queues the cancelled copies');
reset role;
update public.email_outbox set status = 'sent', sent_at = now() where dedup_key = 'contract_signed_copy:' || current_setting('tests.c') || ':client';
update public.email_outbox set status = 'failed' where dedup_key = 'contract_signed_copy:' || current_setting('tests.c') || ':business';
select tests.login_as(tests.id('owner_a'));
select public.send_signed_contract_copies(current_setting('tests.c')::uuid, array['client-y@example.test', 'legal@bouprod.test']);
reset role;
select results_eq($$ select payload ->> 'recipient_role', status from public.email_outbox
     where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy' order by 1 $$,
  $$ values ('business'::text, 'pending'::text), ('client'::text, 'sent'::text) $$,
  'only the failed recipient is queued again; the delivered one is not resent');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.send_signed_contract_copies(current_setting('tests.c')::uuid, array['client-y@example.test', 'legal@bouprod.test']) $$,
  'P0002', null, 'another tenant cannot send copies');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.request_signed_contract_pdf(current_setting('tests.c')::uuid) $$, 'P0002', null, 'clients cannot request PDFs');
select tests.login_as(tests.id('owner_a'));
select is(public.request_signed_contract_pdf(current_setting('tests.c')::uuid) ->> 'status', 'ready', 'requesting an existing PDF is a no-op');
reset role;

-- ===========================================================================
-- Contracts signed before PDFs existed: explicit, no automatic email
-- ===========================================================================
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.k', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c(current_setting('tests.k')::uuid);
select throws_like($$ select public.request_signed_contract_pdf(current_setting('tests.k')::uuid) $$, '%only a signed contract%', 'unsigned contracts have no PDF');
reset role;
select tests.sign_as(current_setting('tests.k')::uuid, 'client_x');
-- Simulate a contract signed before this feature: no job.
alter table public.document_jobs disable trigger document_jobs_no_delete;
delete from public.document_jobs where contract_id = current_setting('tests.k')::uuid;
alter table public.document_jobs enable trigger document_jobs_no_delete;
select tests.login_as(tests.id('owner_a'));
select is(public.request_signed_contract_pdf(current_setting('tests.k')::uuid) ->> 'status', 'pending', 'staff explicitly request the missing PDF');
select is(public.request_signed_contract_pdf(current_setting('tests.k')::uuid) ->> 'status', 'pending', 'repeating the request is idempotent');
reset role;
select results_eq($$ select count(*)::int, bool_and(not deliver_copies), bool_and(requested_by_user_id = tests.id('owner_a')) from public.document_jobs where contract_id = current_setting('tests.k')::uuid $$,
  $$ values (1, true, true) $$, 'one job, without email delivery, recording who asked');
select set_config('tests.jobk', (select id::text from public.document_jobs where contract_id = current_setting('tests.k')::uuid), true);
select tests.commit(current_setting('tests.jobk')::uuid, tests.put_object('contract-documents', current_setting('tests.k')::uuid, 'pdf', 50000, 'application/pdf'));
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.k')::uuid and event_type = 'contract_signed_copy'), 0,
  'generating it sends no retrospective email');
select tests.login_as(tests.id('owner_a'));
select is(jsonb_array_length(public.send_signed_contract_copies(current_setting('tests.k')::uuid, array['client-x@example.test', 'legal@bouprod.test'])), 2,
  'copies go out only after staff confirm both recipients');
reset role;
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.k')::uuid and event_type = 'contract_signed_copy'), 2, 'one per recipient');

select * from finish();
rollback;
