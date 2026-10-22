-- Platform operations: only platform administrators read the cross-business
-- summaries, which carry ids, businesses, categories, states, attempts and
-- times only; only the service role records worker runs. Failed and overdue
-- follow the existing statuses and claim rules. Counts are global (other
-- data may exist), so they are checked as changes within this transaction.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(55);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op@example.test', now(), now(), now());
select set_config('tests.op', 'f1000000-0000-4000-8000-000000000001', true);
insert into public.platform_admins (user_id, note) values (current_setting('tests.op')::uuid, 'operator');

-- As the platform administrator: one summary field, an email's or a PDF job's issue (null when not listed).
create function tests.ops(field text) returns bigint language plpgsql as $$
declare v bigint;
begin
  perform tests.login_as(current_setting('tests.op')::uuid);
  execute format('select (%I)::bigint from public.platform_operations_summary()', field) into v;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create function tests.email_issue(row_id uuid) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(current_setting('tests.op')::uuid);
  select i.issue || case when i.possibly_delivered then ':possibly_delivered' else '' end into v from public.platform_email_issues(200) i where i.id = row_id;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create function tests.email_summary(row_id uuid) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(current_setting('tests.op')::uuid);
  select i.error_summary into v from public.platform_email_issues(200) i where i.id = row_id;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create function tests.document_summary(job_id uuid) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(current_setting('tests.op')::uuid);
  select i.error_summary into v from public.platform_document_issues(200) i where i.id = job_id;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create function tests.document_issue(job_id uuid) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(current_setting('tests.op')::uuid);
  select i.issue into v from public.platform_document_issues(200) i where i.id = job_id;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create function tests.email(tenant text, status text, attempts int, next_attempt timestamptz, locked timestamptz default null, last_error text default null)
returns uuid language sql as $$
  insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, dedup_key, status, attempts, next_attempt_at, locked_until, last_error)
  values (tests.id(tenant), 'proposal_sent', 'ops-client@example.test', 'proposal', gen_random_uuid(), 'ops:' || gen_random_uuid(), status, attempts, next_attempt, locked, last_error)
  returning id $$;

-- ===========================================================================
-- Who may read and write
-- ===========================================================================
select ok(not has_function_privilege('anon', 'public.platform_operations_summary()', 'execute'), 'anon cannot call the summary');
select ok(not has_function_privilege('anon', 'public.platform_email_issues(integer)', 'execute')
          and not has_function_privilege('anon', 'public.platform_document_issues(integer)', 'execute'), 'anon cannot call the lists');
select ok(not has_function_privilege('authenticated', 'public.record_worker_run(text, boolean, integer, integer, integer, integer, integer, integer, integer)', 'execute'),
  'signed-in users cannot record worker runs');
select ok(has_function_privilege('service_role', 'public.record_worker_run(text, boolean, integer, integer, integer, integer, integer, integer, integer)', 'execute'),
  'the service role (the cron route) records worker runs');
select ok(not has_table_privilege('authenticated', 'private.worker_heartbeats', 'select')
          and not has_table_privilege('anon', 'private.worker_heartbeats', 'select'), 'the worker record is not readable directly');

select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select * from public.platform_operations_summary() $$, '42501', null, 'a business owner cannot read the summary');
select throws_ok($$ select * from public.platform_email_issues(50) $$, '42501', null, 'a business owner cannot list email issues');
select throws_ok($$ select * from public.platform_document_issues(50) $$, '42501', null, 'a business owner cannot list PDF issues');
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select * from public.platform_operations_summary() $$, '42501', null, 'staff cannot read the summary');
select throws_ok($$ select * from public.platform_email_issues(50) $$, '42501', null, 'staff cannot list email issues');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select * from public.platform_operations_summary() $$, '42501', null, 'a client cannot read the summary');
select throws_ok($$ select * from public.platform_document_issues(50) $$, '42501', null, 'a client cannot list PDF issues');
select tests.login_as(tests.id('stranger'));
select throws_ok($$ select * from public.platform_email_issues(50) $$, '42501', null, 'a stranger cannot list email issues');
select throws_ok($$ select public.record_worker_run('outbox_cron', true) $$, '42501', null, 'a signed-in user cannot record a worker run');
reset role;
select tests.login_as_anon();
select throws_ok($$ select * from public.platform_operations_summary() $$, '42501', null, 'anon is refused');
reset role;
select set_config('request.jwt.claims', '', true);

-- A platform-admin grant on an unverified identity grants nothing.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unverified-op@example.test', null, now(), now());
insert into public.platform_admins (user_id, note) values ('f1000000-0000-4000-8000-000000000002', 'unverified operator');
select tests.login_as('f1000000-0000-4000-8000-000000000002');
select throws_ok($$ select * from public.platform_operations_summary() $$, '42501', null, 'an unverified platform-admin identity is refused');
reset role;
select set_config('request.jwt.claims', '', true);

select tests.login_as(current_setting('tests.op')::uuid);
select lives_ok($$ select * from public.platform_operations_summary() $$, 'a platform administrator reads the summary');
select lives_ok($$ select * from public.platform_email_issues(50); select * from public.platform_document_issues(50) $$, 'a platform administrator lists issues');
reset role;
select set_config('request.jwt.claims', '', true);

-- Only approved metadata: never recipients, payloads, senders, branding or links.
select unalike(pg_get_function_result('public.platform_email_issues(integer)'::regprocedure), '%recipient%', 'email issues carry no recipient');
select unalike(pg_get_function_result('public.platform_email_issues(integer)'::regprocedure), '%payload%', 'email issues carry no payload');
select ok(pg_get_function_result('public.platform_email_issues(integer)'::regprocedure) !~ '(sender|branding|access_link|dedup|provider_message)',
  'email issues carry no sender, branding, link, dedup key or provider id');
select ok(pg_get_function_result('public.platform_document_issues(integer)'::regprocedure) !~ '(lease|document_id|requested_by)',
  'PDF issues carry no lease, document or requester');
select ok(pg_get_function_result('public.platform_operations_summary()'::regprocedure) !~ '(recipient|payload|email_address|tenant_id)',
  'the summary carries counts and times only');
select ok(pg_get_function_result('public.platform_email_issues(integer)'::regprocedure) !~ 'last_error'
          and pg_get_function_result('public.platform_document_issues(integer)'::regprocedure) !~ 'last_error',
  'no raw error text leaves the database: only fixed-sentence summaries');

-- ===========================================================================
-- Email definitions (changes in this transaction)
-- ===========================================================================
select set_config('tests.f0', tests.ops('emails_failed')::text, true);
select set_config('tests.pd0', tests.ops('emails_possibly_delivered')::text, true);
select set_config('tests.o0', tests.ops('emails_overdue')::text, true);
select set_config('tests.r0', tests.ops('emails_retrying')::text, true);

select set_config('tests.e_failed', tests.email('tenant_a', 'failed', 5, now() - interval '1 hour', null, 'Resend responded 500')::text, true);
select set_config('tests.e_possibly', tests.email('tenant_a', 'failed', 5, now() - interval '1 hour', null, 'delivery did not complete')::text, true);
select set_config('tests.e_refused', tests.email('tenant_a', 'failed', 1, now() - interval '1 hour', null,
  'An earlier attempt of this email may already have been delivered: the email provider refused a changed repeat (Resend 409, invalid_idempotent_request). Check the provider''s log before retrying.')::text, true);
select set_config('tests.e_overdue', tests.email('tenant_a', 'pending', 0, now() - interval '30 minutes')::text, true);
select set_config('tests.e_due_now', tests.email('tenant_a', 'pending', 0, now() - interval '5 minutes')::text, true);
select set_config('tests.e_retrying', tests.email('tenant_a', 'pending', 2, now() + interval '10 minutes')::text, true);
select set_config('tests.e_lease_ended', tests.email('tenant_a', 'sending', 1, now() - interval '40 minutes', now() - interval '30 minutes')::text, true);
select set_config('tests.e_lease_live', tests.email('tenant_a', 'sending', 1, now() - interval '40 minutes', now() + interval '1 minute')::text, true);
select set_config('tests.e_no_attempts', tests.email('tenant_a', 'pending', 5, now() - interval '1 hour')::text, true);
select set_config('tests.e_sent', tests.email('tenant_a', 'cancelled', 0, now() - interval '1 hour')::text, true);
-- A failure older than the 30-day window.
select set_config('tests.e_old', tests.email('tenant_a', 'failed', 5, now() - interval '50 days', null, 'Resend responded 500')::text, true);
set local session_replication_role = replica;
update public.email_outbox set updated_at = now() - interval '40 days' where id = current_setting('tests.e_old')::uuid;
set local session_replication_role = origin;
-- Other DJ: one failed and one overdue email, then the business is archived (it sends nothing).
select set_config('tests.e_b_failed', tests.email('tenant_b', 'failed', 5, now() - interval '1 hour', null, 'Resend responded 500')::text, true);
select set_config('tests.e_b_overdue', tests.email('tenant_b', 'pending', 0, now() - interval '30 minutes')::text, true);
update public.tenants set archived_at = now() where id = tests.id('tenant_b');

select is(tests.ops('emails_failed') - current_setting('tests.f0')::bigint, 3::bigint, 'failed: the three recent failures of active businesses');
select is(tests.ops('emails_possibly_delivered') - current_setting('tests.pd0')::bigint, 2::bigint,
  'possibly delivered: an attempt that never finished and a refused changed repeat');
select is(tests.ops('emails_overdue') - current_setting('tests.o0')::bigint, 2::bigint, 'overdue: a due email waiting 30 minutes and a claim whose lease ended 30 minutes ago');
select is(tests.ops('emails_retrying') - current_setting('tests.r0')::bigint, 1::bigint, 'retrying: a failed attempt waiting for its next try');
select is(tests.email_issue(current_setting('tests.e_failed')::uuid), 'failed', 'a failure is listed as failed');
select is(tests.email_issue(current_setting('tests.e_possibly')::uuid), 'failed:possibly_delivered', 'an unfinished attempt is listed as possibly delivered');
select is(tests.email_issue(current_setting('tests.e_overdue')::uuid), 'overdue', 'a due email waiting past the grace is overdue');
select is(tests.email_issue(current_setting('tests.e_lease_ended')::uuid), 'overdue', 'a claim whose lease ended long ago is overdue');
select ok(tests.email_issue(current_setting('tests.e_due_now')::uuid) is null, 'an email due 5 minutes ago is not overdue yet (the next run takes it)');
select ok(tests.email_issue(current_setting('tests.e_lease_live')::uuid) is null, 'an email being sent now is not overdue');
select ok(tests.email_issue(current_setting('tests.e_retrying')::uuid) is null, 'a normal retry is not listed');
select ok(tests.email_issue(current_setting('tests.e_old')::uuid) is null, 'a failure older than 30 days is not listed');
select ok(tests.email_issue(current_setting('tests.e_b_failed')::uuid) is null and tests.email_issue(current_setting('tests.e_b_overdue')::uuid) is null,
  'an archived business''s emails are not listed (it sends nothing on purpose)');
select ok(tests.email_issue(current_setting('tests.e_sent')::uuid) is null, 'a cancelled email is not listed');

-- Error summaries: fixed sentences, never the stored text.
select set_config('tests.e_leaky', tests.email('tenant_a', 'failed', 5, now() - interval '1 hour', null,
  'Unexpected: could not deliver to robin.smith@example.com (Robin Smith) via https://fluxdj.com/test-bouprod/p#Zk3_9aQ-xL2mN8pR4tV6wY0bC1dE5fG7hJ9kL3nP5rS')::text, true);
select is(tests.email_summary(current_setting('tests.e_leaky')::uuid), 'The last attempt failed (unexpected error).',
  'an unknown error is summarised generically');
select ok((select row(i.*)::text from (select tests.email_summary(current_setting('tests.e_leaky')::uuid)) i) !~* '(robin|example\.com|fluxdj\.com|Zk3_)',
  'no address, name, link or token from the stored error is returned');
select is(tests.email_summary(current_setting('tests.e_failed')::uuid), 'The email provider refused it (HTTP 500).', 'a provider refusal shows its HTTP status only');
select set_config('tests.e_busy', tests.email('tenant_a', 'failed', 5, now() - interval '1 hour', null, 'Resend responded 409 (concurrent_idempotent_requests)')::text, true);
select is(tests.email_summary(current_setting('tests.e_busy')::uuid), 'The email provider refused it (HTTP 409, concurrent_idempotent_requests).',
  'and Resend''s fixed error code');
select is(tests.email_summary(current_setting('tests.e_refused')::uuid),
  'An earlier attempt may already have been delivered: the email provider refused a changed repeat. Check before retrying.',
  'a refused changed repeat is summarised as possibly delivered');

-- ===========================================================================
-- PDF job definitions
-- ===========================================================================
update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c1', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select set_config('tests.c2', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('tests.df0', tests.ops('documents_failed')::text, true);
select set_config('tests.do0', tests.ops('documents_overdue')::text, true);
insert into public.document_jobs (tenant_id, contract_id, deliver_copies, status, attempts, last_error)
  values (tests.id('tenant_a'), current_setting('tests.c1')::uuid, true, 'failed', 5, 'PDF generation did not complete');
select set_config('tests.j1', (select id::text from public.document_jobs where contract_id = current_setting('tests.c1')::uuid), true);
insert into public.document_jobs (tenant_id, contract_id, deliver_copies, status, attempts, next_attempt_at)
  values (tests.id('tenant_a'), current_setting('tests.c2')::uuid, true, 'pending', 0, now() - interval '30 minutes');
select set_config('tests.j2', (select id::text from public.document_jobs where contract_id = current_setting('tests.c2')::uuid), true);

select is(tests.ops('documents_failed') - current_setting('tests.df0')::bigint, 1::bigint, 'failed PDFs: the failed job');
select is(tests.ops('documents_overdue') - current_setting('tests.do0')::bigint, 1::bigint, 'overdue PDFs: a job due 30 minutes ago');
select is(tests.document_issue(current_setting('tests.j1')::uuid), 'failed', 'the failed job is listed as failed');
select is(tests.document_issue(current_setting('tests.j2')::uuid), 'overdue', 'the waiting job is listed as overdue');
select is(tests.document_summary(current_setting('tests.j1')::uuid), 'The last attempt didn''t finish.', 'a PDF attempt that never finished, by name');
-- A raw database error (which can quote values) is never returned.
update public.document_jobs set last_error = 'The signed PDF could not be recorded (duplicate key value violates unique constraint; Key (name)=(Robin Smith)).'
  where id = current_setting('tests.j1')::uuid;
select is(tests.document_summary(current_setting('tests.j1')::uuid), 'The signed PDF could not be recorded.', 'a database error is summarised without its text');
update public.document_jobs set last_error = 'Cannot render text "Robin Smith, 12 Rue Privée" in font'
  where id = current_setting('tests.j1')::uuid;
select is(tests.document_summary(current_setting('tests.j1')::uuid), 'The PDF could not be generated (unexpected error).', 'an unknown rendering error quoting contract text is generic');
update public.document_jobs set status = 'running', attempts = 1, lease_token = gen_random_uuid(), locked_until = now() + interval '1 minute'
  where id = current_setting('tests.j2')::uuid;
select ok(tests.document_issue(current_setting('tests.j2')::uuid) is null, 'a job running under a live lease is not overdue');

-- ===========================================================================
-- Worker heartbeat
-- ===========================================================================
delete from private.worker_heartbeats;
select ok(tests.ops('worker_consecutive_failures') is null, 'no run recorded yet: no worker record');
select tests.login_as_service();
select public.record_worker_run('outbox_cron', false, 3, 1, 1, 0, 1, 1, 0);
select public.record_worker_run('outbox_cron', false, 0, 0, 0, 0, 0, 2, 0);
reset role;
select is(tests.ops('worker_consecutive_failures'), 2::bigint, 'two failing runs in a row');
select tests.login_as_service();
select public.record_worker_run('outbox_cron', true, 2, 2, 0, 0, 0, 0, 0);
reset role;
select set_config('request.jwt.claims', '', true);
select is((select (last_outcome, consecutive_failures, last_summary ->> 'sent', last_success_at is not null, last_failure_at is not null)::text
           from private.worker_heartbeats where worker = 'outbox_cron'), '(ok,0,2,t,t)', 'a successful run resets the streak and keeps the last failure time');
select throws_ok($$ select public.record_worker_run('something_else', true) $$, '22023', null, 'only the known worker can be recorded');

select * from finish();
rollback;
