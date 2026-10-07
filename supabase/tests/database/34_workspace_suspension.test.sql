-- Workspace suspension and restoration by platform administrators: who may
-- do it, what a suspended workspace blocks for every role and path, background
-- work, and what restoration does (and doesn't) bring back.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(110);

create function tests.send_c(contract uuid) returns uuid language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  perform public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
  return v_link;
end $$;
create function tests.invite_hash(link uuid) returns text language sql immutable as $$
  select encode(sha256(convert_to('invite-' || link, 'UTF8')), 'hex') $$;
create function tests.put_sig(contract uuid) returns text language plpgsql as $$
declare v_path text;
begin
  select k.tenant_id || '/' || k.id || '/' || gen_random_uuid() || '.png' into v_path from public.contracts k where k.id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size":4096,"mimetype":"image/png"}');
  return v_path;
end $$;
create function tests.sign(contract uuid, signer text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id(signer), 'Signer Name',
    (select content_sha256 from public.contracts where id = contract), 'demo-v1', true, tests.put_sig(contract), repeat('b', 64),
    4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.suspend(who uuid, tenant text, version int, reason text default 'Unpaid account, see ticket 42')
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(who);
  r := public.suspend_workspace(tests.id(tenant), version, reason);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.restore(who uuid, tenant text, version int, reason text default 'Account settled')
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(who);
  r := public.restore_workspace(tests.id(tenant), version, reason);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Setup: two platform administrators (one also owns Other DJ), a signed
-- contract on A2 with a PDF job, a sent contract on A1 with a live
-- invitation, proposal sessions, queued and claimed emails.
-- ===========================================================================
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op@example.test', now(), now(), now());
select set_config('tests.op', 'f1000000-0000-4000-8000-000000000001', true);
insert into public.platform_admins (user_id, note) values
  (current_setting('tests.op')::uuid, 'operator'), (tests.id('owner_b'), 'owner of Other DJ');

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select set_config('tests.p2_link', current_setting('tests.last_link_id'), true);
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select set_config('tests.p1_link', current_setting('tests.last_link_id'), true);
select set_config('tests.p1', (select proposal_id::text from public.proposal_approvals where id = current_setting('tests.a1')::uuid), true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c2', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select set_config('tests.l2', tests.send_c(current_setting('tests.c2')::uuid)::text, true);
select set_config('tests.c1', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select set_config('tests.l1', tests.send_c(current_setting('tests.c1')::uuid)::text, true);
reset role;
select is(tests.sign(current_setting('tests.c2')::uuid, 'client_y') ->> 'status', 'signed', 'setup: Client Y signs the A2 contract');
-- A payment on A2, recorded by staff.
select tests.login_as(tests.id('owner_a'));
select public.record_event_payment(tests.id('event_a2'), 10000, current_date, 'E-transfer', null, gen_random_uuid());
reset role;
-- An expired proposal session (expiry stays expired after restoration).
insert into public.proposal_sessions (tenant_id, proposal_id, access_link_id, session_hash, expires_at)
values (tests.id('tenant_a'), current_setting('tests.p1')::uuid, current_setting('tests.p1_link')::uuid, tests.hex('expired-session'), now() - interval '1 second');
-- An email for Other DJ, which must stay deliverable.
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, dedup_key)
values (tests.id('tenant_b'), 'proposal_approved', 'owner-b@example.test', 'proposal', gen_random_uuid(), 'tests-b-email');
-- One tenant A email already claimed by a worker ("sending"), the rest pending.
select tests.login_as_service();
select set_config('tests.sending', (select id::text from public.claim_email_outbox(1, 120, tests.id('tenant_a'), true) limit 1), true);
-- The signed contract's PDF job, claimed by a worker before the suspension.
select set_config('tests.job', (select job_id::text from public.claim_document_jobs(1, 120, tests.id('tenant_a'), current_setting('tests.c2')::uuid)), true);
reset role;

create temp table before_evidence as
  select c.id, c.status, c.content_sha256, c.signed_at, s.signature_sha256, s.signed_at as sig_at,
         e.lifecycle_status, e.booking_confirmed_at, e.planning_lock_at, e.archived_at,
         (select count(*) from public.event_payments p where p.event_id = c.event_id) as payments,
         (select count(*) from public.audit_events a where a.tenant_id = c.tenant_id) as audits
  from public.contracts c join public.events e on e.id = c.event_id
  left join public.contract_signatures s on s.contract_id = c.id
  where c.tenant_id = tests.id('tenant_a');
grant select on before_evidence to authenticated, service_role;
select set_config('tests.a_pending', (select count(*)::text from public.email_outbox where tenant_id = tests.id('tenant_a') and status in ('pending', 'sending')), true);
select ok(current_setting('tests.a_pending')::int >= 3, 'setup: several undelivered emails for BOUPROD, one already claimed');

-- ===========================================================================
-- Who may suspend
-- ===========================================================================
select throws_ok($$ select tests.suspend(tests.id('owner_a'), 'tenant_a', 0) $$, '42501', null, 'the owner cannot suspend');
select throws_ok($$ select tests.suspend(tests.id('staff_a'), 'tenant_a', 0) $$, '42501', null, 'staff cannot suspend');
select throws_ok($$ select tests.suspend(tests.id('client_x'), 'tenant_a', 0) $$, '42501', null, 'a client cannot suspend');
select throws_ok($$ select tests.suspend(tests.id('stranger'), 'tenant_a', 0) $$, '42501', null, 'a stranger cannot suspend');
select tests.login_as_anon();
select throws_ok($$ select public.suspend_workspace(tests.id('tenant_a'), 0, 'x x x') $$, '42501', null, 'anon cannot suspend');
select throws_ok($$ select * from public.platform_workspaces_overview() $$, '42501', null, 'anon cannot list workspaces');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select * from public.platform_workspaces_overview() $$, '42501', null, 'a tenant owner cannot list workspaces');
select throws_ok($$ select public.restore_workspace(tests.id('tenant_b'), 0, 'x x x') $$, '42501', null, 'a tenant owner cannot restore');
select throws_ok($$ update public.tenants set suspended_at = now() where id = tests.id('tenant_a') $$, '42501', null,
  'the owner cannot write the suspension column');
select tests.login_as_service();
select throws_ok($$ update public.tenants set suspended_at = now() where id = tests.id('tenant_a') $$, '42501', null,
  'nor can the service role');
reset role;
select throws_ok($$ update public.tenants set suspension_version = 7 where id = tests.id('tenant_a') $$, '42501', null,
  'nor privileged code outside the suspension functions');

select tests.login_as(current_setting('tests.op')::uuid);
select results_eq(
  $$ select slug, suspended_at is null, is_member from public.platform_workspaces_overview() where slug in ('test-bouprod', 'test-other-dj') order by slug $$,
  $$ values ('test-bouprod'::text, true, false), ('test-other-dj'::text, true, false) $$,
  'the operator lists workspaces with administration metadata only');
select is((select count(*)::int from public.clients) + (select count(*)::int from public.events), 0, 'and still reads no business data');
reset role;
select throws_like($$ select tests.suspend(current_setting('tests.op')::uuid, 'tenant_a', 0, '  ') $$, '%workspace_reason_required%', 'a reason is required');
select throws_ok($$ select tests.suspend(current_setting('tests.op')::uuid, 'tenant_a', 3) $$, 'PT409', null, 'a stale version is a conflict (PT409)');
select throws_like($$ select tests.suspend(tests.id('owner_b'), 'tenant_b', 0) $$, '%workspace_own%',
  'an administrator cannot suspend a workspace they belong to');
select is((select suspended_at from public.tenants where id = tests.id('tenant_a')), null, 'nothing changed so far');

-- ===========================================================================
-- Suspend
-- ===========================================================================
select set_config('tests.r', tests.suspend(current_setting('tests.op')::uuid, 'tenant_a', 0)::text, true);
select results_eq(
  $$ select r ->> 'status', r ->> 'replayed', (r ->> 'version')::int, (r ->> 'cancelled_emails')::int
     from (select current_setting('tests.r')::jsonb r) x $$,
  $$ values ('suspended'::text, 'false'::text, 1, current_setting('tests.a_pending')::int) $$,
  'the operator suspends BOUPROD; every undelivered email is cancelled');
select is((select suspended_at from public.tenants where id = tests.id('tenant_a')), now(), 'suspended at database time');
select is(tests.suspend(current_setting('tests.op')::uuid, 'tenant_a', 0) ->> 'replayed', 'true', 'a repeat (same version) returns the suspension');
select is(tests.suspend(tests.id('owner_b'), 'tenant_a', 1) ->> 'replayed', 'true', 'another administrator''s repeat too');
select results_eq(
  $$ select actor_id, metadata ->> 'reason', (metadata ->> 'version')::int, occurred_at = now()
     from public.platform_audit_events where entity_type = 'workspace' and entity_id = tests.id('tenant_a') $$,
  $$ values (current_setting('tests.op')::uuid, 'Unpaid account, see ticket 42'::text, 1, true) $$,
  'one audit event with actor, reason, version and database time');
select is((select count(*)::int from public.platform_workspaces_overview() where false), 0, 'overview still callable');
select tests.login_as(current_setting('tests.op')::uuid);
select results_eq(
  $$ select suspension_reason, suspended_by_email, suspension_version from public.platform_workspaces_overview() where slug = 'test-bouprod' $$,
  $$ values ('Unpaid account, see ticket 42'::text, 'op@example.test'::text, 1) $$, 'administrators see the reason and who suspended it');
reset role;

-- ===========================================================================
-- Staff of the suspended workspace
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.tenants), 0, 'the owner no longer reads the business');
select is((select count(*)::int from public.clients) + (select count(*)::int from public.events) + (select count(*)::int from public.contracts)
          + (select count(*)::int from public.proposals) + (select count(*)::int from public.event_payments)
          + (select count(*)::int from public.contract_signatures) + (select count(*)::int from public.email_outbox)
          + (select count(*)::int from public.gear_items) + (select count(*)::int from public.tenant_memberships), 0,
  'nor its clients, events, contracts, proposals, payments, signatures, emails, catalog or members');
select results_eq($$ select slug, suspended from public.my_workspaces() $$, $$ values ('test-bouprod'::text, true) $$,
  'the owner is told their workspace is suspended, without a reason');
select ok(not (select to_jsonb(w)::text from public.my_workspaces() w limit 1) ~ 'Unpaid', 'no reason in the member view');
select throws_ok($$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_a'), 'New', 'new@example.test') $$,
  'PT423', null, 'no direct inserts');
select throws_ok($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'z@example.test', 40) $$, 'PT423', null,
  'settings writes are refused (workspace_suspended)');
select throws_ok($$ select public.event_payment_summary(tests.id('event_a2')) $$, 'PT423', null, 'staff functions answer workspace_suspended to members');
select throws_ok($$ select public.record_event_payment(tests.id('event_a2'), 500, current_date, 'Cash', null, gen_random_uuid()) $$,
  'PT423', null, 'payments cannot be recorded');
select throws_ok($$ select public.staff_planning_view(tests.id('event_a2')) $$, 'PT423', null, 'planning and the run sheet cannot be read');
select throws_ok($$ select public.open_proposal_draft(tests.id('event_a1')) $$, 'PT423', null, 'no proposal work');
select throws_ok($$ select public.void_contract(current_setting('tests.c1')::uuid, 'test') $$, 'PT423', null, 'no contract work');
select throws_ok($$ select public.request_signed_contract_pdf(current_setting('tests.c2')::uuid) $$, 'PT423', null, 'no PDF requests');
select is((select count(*)::int from storage.objects where bucket_id in ('gear-media', 'contract-signatures')), 0, 'no private media or signature files');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('gear-media', tests.id('tenant_a') || '/gear-items/' || tests.id('gear_a_speaker') || '/' || gen_random_uuid() || '.png') $$,
  '42501', null, 'no uploads');
select tests.login_as(tests.id('staff_a'));
select is((select count(*)::int from public.events), 0, 'staff are blocked too');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_a'), 'S', 's@example.test') $$,
  '42501', null, 'staff of another business see the usual refusal, not the suspension');
select tests.login_as(tests.id('stranger'));
select throws_ok($$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_a'), 'S', 's@example.test') $$,
  '42501', null, 'and so do strangers');
select tests.login_as(tests.id('owner_b'));
select ok((select count(*)::int from public.events) > 0 and (select count(*)::int from public.tenants) = 1, 'Other DJ is unaffected');
select lives_ok($$ select public.update_business_settings(tests.id('tenant_b'), 'Other DJ Test', '2 Side St', 'b@example.test', 30) $$,
  'and keeps working');
select is(public.suspend_workspace(tests.id('tenant_a'), 1, 'repeat from another admin') ->> 'replayed', 'true',
  'administration is independent of the administrator''s own workspace');
reset role;

-- ===========================================================================
-- Clients
-- ===========================================================================
select tests.login_as(tests.id('client_x'));
select results_eq($$ select tenant_slug from public.my_events() $$, $$ values ('test-other-dj'::text) $$,
  'a client of both businesses keeps the other business''s event');
select is(public.client_contract_view(current_setting('tests.c1')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'contracts are unavailable');
select is(public.client_invitation_status(current_setting('tests.l1')::uuid, 'test-bouprod') ->> 'state', 'invalid', 'invitations can''t be opened');
select is(public.accept_contract_invitation(current_setting('tests.l1')::uuid, 'test-bouprod') ->> 'state', 'invalid', 'nor accepted');
select tests.login_as(tests.id('client_y'));
select is((select count(*)::int from public.my_contracts()), 0, 'signed contracts leave the client''s list');
select is(public.client_contract_view(current_setting('tests.c2')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'and can''t be read');
select is(public.client_signed_document(current_setting('tests.c2')::uuid, 'test-bouprod'), null, 'no signed PDF');
select is(public.client_signature_object(current_setting('tests.c2')::uuid, 'test-bouprod'), null, 'no signature image');
select is(public.client_payment_summary(current_setting('tests.c2')::uuid, 'test-bouprod'), null, 'no payment summary');
select is((select count(*)::int from public.my_plans()), 0, 'no planning');
reset role;
select tests.login_as_service();
select is(public.request_contract_sign_in(tests.invite_hash(current_setting('tests.l1')::uuid), 'test-bouprod') ->> 'status', 'invalid',
  'no verification emails from invitations');
select is(tests.sign(current_setting('tests.c1')::uuid, 'client_x') ->> 'code', 'unavailable', 'no signing');
select tests.login_as_service();
select is(public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.p1_link')), tests.hex('new-session'), 'test-bouprod', 3600) ->> 'status',
  'unavailable', 'a valid proposal link opens no session ("unavailable")');
select is((select count(*)::int from public.proposal_sessions where session_hash = tests.hex('new-session')), 0, 'and creates none');
select is(public.client_proposal_view(tests.hex('session-' || current_setting('tests.p1')), current_setting('tests.p1')::uuid, 'test-bouprod'),
  '{"state": "unavailable"}'::jsonb, 'an existing proposal session shows nothing');
select is(public.client_save_selection_draft(tests.hex('session-' || current_setting('tests.p1')), current_setting('tests.p1')::uuid, 'test-bouprod', 1,
  'signature', '{}', '{}') ->> 'status', 'unavailable', 'saves are refused');
select is(public.client_submit_selection(tests.hex('session-' || current_setting('tests.p1')), current_setting('tests.p1')::uuid, 'test-bouprod', 1,
  'key-abcdefghijklmnop', '{}') ->> 'status', 'unavailable', 'submissions are refused');
select is(public.client_proposal_view(tests.hex('expired-session'), current_setting('tests.p1')::uuid, 'test-bouprod') ->> 'state', 'invalid',
  'an expired session is still just invalid');
select is(public.public_tenant_brand('test-bouprod'), null, 'public pages see no such business');
select isnt(public.public_tenant_brand('test-other-dj'), null, 'other businesses are unaffected');

-- ===========================================================================
-- Every path that writes, for every role
-- ===========================================================================
select throws_ok($$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_a'), 'S', 's@example.test') $$, 'PT423', null,
  'the service role cannot insert');
select throws_ok($$ update public.events set title = 'Changed' where id = tests.id('event_a1') $$, 'PT423', null, 'nor update');
select throws_ok($$ delete from public.event_clients where event_id = tests.id('event_a1') and not is_primary $$, 'PT423', null, 'nor delete');
select throws_ok($$ insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, dedup_key)
                    values (tests.id('tenant_a'), 'proposal_approved', 'x@example.test', 'proposal', gen_random_uuid(), 'tests-a-new') $$,
  'PT423', null, 'nor queue an email');
select throws_ok($$ update public.tenants set display_name = 'Renamed' where id = tests.id('tenant_a') $$, 'PT423', null, 'nor change the business');
reset role;
select throws_ok($$ delete from public.tenant_memberships where tenant_id = tests.id('tenant_a') $$, 'PT423', null,
  'memberships can''t be removed, even by privileged code');
select lives_ok($$ insert into public.audit_events (tenant_id, entity_type, entity_id, action, actor_type) values (tests.id('tenant_a'), 'tenant', tests.id('tenant_a'), 'note', 'system') $$,
  'the append-only audit log still accepts entries');

-- ===========================================================================
-- Background work
-- ===========================================================================
select results_eq(
  $$ select count(*)::int, bool_and(last_error !~ 'Unpaid') from public.email_outbox
     where tenant_id = tests.id('tenant_a') and status = 'cancelled' and last_error like 'Cancelled: the workspace was suspended%' $$,
  $$ values (current_setting('tests.a_pending')::int, true) $$, 'cancelled emails say why, without the internal reason');
select tests.login_as_service();
select is((select count(*)::int from public.claim_email_outbox(100, 120, tests.id('tenant_a'), true)), 0, 'workers claim none of its emails');
select is(public.email_outbox_dispatch_allowed(current_setting('tests.sending')::uuid), false, 'an email claimed before the suspension is stopped before sending');
select public.complete_email_outbox(current_setting('tests.sending')::uuid, 'late-provider-id');
select is((select count(*)::int from public.claim_email_outbox(100, 120, tests.id('tenant_b'), true)), 1, 'other businesses'' emails are delivered');
select is((select count(*)::int from public.claim_document_jobs(5, 120, tests.id('tenant_a'), null)), 0, 'no PDF jobs are claimed');
select is(public.commit_contract_document(current_setting('tests.job')::uuid, 'x', repeat('a', 64), 1, repeat('b', 64), 'test') ->> 'status', 'suspended',
  'a PDF finished after the suspension is not committed');
reset role;
select results_eq(
  $$ select status, attempts, lease_token is null from public.document_jobs where id = current_setting('tests.job')::uuid $$,
  $$ values ('pending'::text, 0, true) $$, 'its job waits again, without losing an attempt');
select is((select status from public.email_outbox where id = current_setting('tests.sending')::uuid), 'cancelled',
  'a late completion doesn''t revive a cancelled email');
select is((select count(*)::int from public.contract_documents where contract_id = current_setting('tests.c2')::uuid), 0, 'no document was recorded');

-- Archiving stays independent.
select lives_ok($$ update public.tenants set archived_at = now() where id = tests.id('tenant_a') $$, 'a suspended workspace can still be archived');
update public.tenants set archived_at = null where id = tests.id('tenant_a');
select isnt((select suspended_at from public.tenants where id = tests.id('tenant_a')), null, 'archiving changes nothing about the suspension');

-- ===========================================================================
-- Restore
-- ===========================================================================
select set_config('tests.emails_before_restore', (select count(*)::text from public.email_outbox where tenant_id = tests.id('tenant_a')), true);
select throws_ok($$ select tests.restore(tests.id('owner_a'), 'tenant_a', 1) $$, '42501', null, 'the owner cannot restore');
select throws_like($$ select tests.restore(current_setting('tests.op')::uuid, 'tenant_a', 1, '') $$, '%workspace_reason_required%', 'restoring needs a reason');
select throws_ok($$ select tests.restore(current_setting('tests.op')::uuid, 'tenant_a', 0) $$, 'PT409', null, 'a stale version is a conflict');
select results_eq(
  $$ select r ->> 'status', r ->> 'replayed', (r ->> 'version')::int from (select tests.restore(current_setting('tests.op')::uuid, 'tenant_a', 1) r) x $$,
  $$ values ('active'::text, 'false'::text, 2) $$, 'the operator restores BOUPROD');
select is(tests.restore(current_setting('tests.op')::uuid, 'tenant_a', 1) ->> 'replayed', 'true', 'a repeat is safe');
select results_eq(
  $$ select action, metadata ->> 'reason' from public.platform_audit_events where entity_type = 'workspace' and entity_id = tests.id('tenant_a') order by occurred_at, action desc $$,
  $$ values ('suspended'::text, 'Unpaid account, see ticket 42'::text), ('restored'::text, 'Account settled'::text) $$,
  'both changes are audited with their reasons');
select is((select count(*)::text from public.email_outbox where tenant_id = tests.id('tenant_a')), current_setting('tests.emails_before_restore'),
  'restoring queues no email');
select is((select count(*)::int from public.email_outbox where tenant_id = tests.id('tenant_a') and status in ('pending', 'sending')), 0,
  'and revives none of the cancelled ones');
select tests.login_as_service();
select is((select count(*)::int from public.claim_email_outbox(100, 120, tests.id('tenant_a'), true)), 0, 'so workers have nothing old to send');
select is((select count(*)::int from public.claim_document_jobs(5, 120, tests.id('tenant_a'), null)), 1, 'the PDF job resumes');
reset role;
select results_eq(
  $$ select b.status = c.status and b.content_sha256 = c.content_sha256 and b.signed_at is not distinct from c.signed_at
            and b.signature_sha256 is not distinct from s.signature_sha256 and b.sig_at is not distinct from s.signed_at
            and b.lifecycle_status = e.lifecycle_status and b.booking_confirmed_at is not distinct from e.booking_confirmed_at
            and b.planning_lock_at is not distinct from e.planning_lock_at and b.archived_at is not distinct from e.archived_at
            and b.payments = (select count(*) from public.event_payments p where p.event_id = c.event_id)
     from before_evidence b join public.contracts c on c.id = b.id join public.events e on e.id = c.event_id
     left join public.contract_signatures s on s.contract_id = c.id $$,
  $$ values (true), (true) $$,
  'contracts, signatures, bookings, deadlines, archiving and payments are exactly as before');

select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.tenants), 1, 'the owner reads the business again');
select lives_ok($$ select public.event_payment_summary(tests.id('event_a2')) $$, 'and works in it again');
select tests.login_as(tests.id('client_x'));
select is((select count(*)::int from public.my_events()), 2, 'the client sees both businesses again');
select is(public.client_invitation_status(current_setting('tests.l1')::uuid, 'test-bouprod') ->> 'state', 'accepted', 'the live invitation works again');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c2')::uuid, 'test-bouprod') ->> 'state', 'available', 'the signed contract is readable again');
select tests.login_as_service();
select is(public.client_proposal_view(tests.hex('session-' || current_setting('tests.p1')), current_setting('tests.p1')::uuid, 'test-bouprod') ->> 'state',
  'approved', 'the existing proposal session works again');
select is(public.client_proposal_view(tests.hex('expired-session'), current_setting('tests.p1')::uuid, 'test-bouprod') ->> 'state', 'invalid',
  'an expired session stays expired');
select is(public.request_contract_sign_in(tests.invite_hash(current_setting('tests.l2')::uuid), 'test-bouprod') ->> 'status', 'invalid',
  'an invitation revoked before (by signing) stays revoked');
select is(public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.p1_link')), tests.hex('newer-session'), 'test-bouprod', 3600) ->> 'status',
  'ok', 'a still-valid proposal link opens again');
reset role;
select ok((select expires_at from public.proposal_sessions where session_hash = tests.hex('newer-session'))
          <= (select expires_at from public.access_links where id = current_setting('tests.p1_link')::uuid), 'with no extended expiry');
select is((select public_tenant_brand('test-bouprod') ->> 'display_name'), 'BOUPROD', 'public pages see the business again');

-- Restoring needs a suspension; restoring an active one is a no-op.
select is(tests.restore(tests.id('owner_b'), 'tenant_b', 0) ->> 'replayed', 'true', 'restoring an active workspace changes nothing');
select is((select count(*)::int from public.platform_audit_events where entity_type = 'workspace' and entity_id = tests.id('tenant_b')), 0,
  'and records nothing');
select throws_ok($$ insert into public.tenants (slug, business_name, display_name, suspended_at) values ('born-suspended', 'X', 'X', now()) $$,
  '42501', null, 'a workspace is never created suspended');
select is(private.is_claimable_tenant_slug('unavailable'), false, 'the unavailable page''s address is reserved');

select * from finish();
rollback;
