-- Client-use signing: explicit usage when publishing (owner-only client use
-- with a recorded confirmation), immutability, frozen signing mode and consent
-- on contracts, signing with the client-v1 consent, legacy versions and
-- contracts that cannot be signed, tenant isolation, and the frozen sender of
-- signed-copy emails.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(78);

create function tests.send_c(contract uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  return public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;

create function tests.sign(contract uuid, signer text, consent_version text) returns jsonb language plpgsql as $$
declare
  v_hash text;
  v_path text;
  r jsonb;
begin
  select content_sha256, tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' into v_hash, v_path from public.contracts where id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size": 4096, "mimetype": "image/png"}');
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id(signer), 'Signer Name', v_hash, consent_version, true, v_path,
    repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

-- What the client sees, as that client.
create function tests.view_as(contract uuid, who text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.client_contract_view(contract, 'test-bouprod');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test', reply_to_email = 'hello@bouprod.test'
where id = tests.id('tenant_a');

-- ===========================================================================
-- Publishing needs an explicit usage; client use is owner-only and confirmed
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.t', public.create_contract_template(tests.id('tenant_a'), 'Real agreement', 'Services agreement for {{event.title}}',
  tests.simple_sections())::text, true);
select set_config('tests.v', (select id::text from public.contract_template_versions where template_id = current_setting('tests.t')::uuid), true);
select throws_like($$ select public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, null) $$,
  '%choose DEMO or client use%', 'a usage must be chosen');
select throws_like($$ select public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, 'legacy') $$,
  '%choose DEMO or client use%', 'legacy can never be chosen');
select throws_like($$ select public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, 'client_use') $$,
  '%confirm the current client-use statement%', 'client use needs the confirmed statement');
select throws_like($$ select public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, 'client_use', 'client-use-v0') $$,
  '%confirm the current client-use statement%', 'and only the current statement');

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, 'client_use', 'client-use-v1') $$,
  '42501', 'only the owner can publish an agreement for client use', 'staff who are not the owner cannot publish for client use');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, 'client_use', 'client-use-v1') $$,
  'P0002', 'not found', 'another tenant''s owner cannot publish it');
select is((select count(*)::int from public.contract_template_versions where tenant_id = tests.id('tenant_a')), 0,
  'and sees no tenant A versions or confirmations');
reset role;
select is((select published_at from public.contract_template_versions where id = current_setting('tests.v')::uuid), null,
  'every refused attempt left the draft unpublished');

select tests.login_as(tests.id('owner_a'));
select is(public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, 'client_use', 'client-use-v1') - 'content_sha256',
  jsonb_build_object('status', 'published', 'version_number', 1, 'usage', 'client_use', 'replayed', false),
  'the owner publishes for client use after confirming');
select is(public.publish_contract_template_version(current_setting('tests.v')::uuid, 0, 'demo') ->> 'usage', 'client_use',
  'publishing again returns the original usage and changes nothing');
reset role;
select results_eq(
  $$ select usage, client_use_statement_version, client_use_statement, client_use_confirmed_by_user_id, client_use_confirmed_at = published_at,
            published_by_membership_id = (select id from public.tenant_memberships where user_id = tests.id('owner_a') and tenant_id = tests.id('tenant_a'))
     from public.contract_template_versions where id = current_setting('tests.v')::uuid $$,
  $$ values ('client_use'::text, 'client-use-v1'::text, private.client_use_statement('client-use-v1'), tests.id('owner_a'), true, true) $$,
  'the confirmation stores the exact statement, the owner''s identity and the database time');
select is(public.client_use_statement_current() ->> 'text', private.client_use_statement('client-use-v1'), 'the UI shows exactly the stored statement');
select ok(public.client_use_statement_current() ->> 'text' ~ 'responsible' and public.client_use_statement_current() ->> 'text' ~ 'has not reviewed or approved'
  and public.client_use_statement_current() ->> 'text' !~* 'lawyer|certif', 'the statement claims no review or certification');
select is((select metadata ->> 'usage' from public.audit_events where entity_id = current_setting('tests.t')::uuid and action = 'version_published'),
  'client_use', 'publishing is audited with its usage');
select throws_ok($$ update public.contract_template_versions set usage = 'demo' where id = current_setting('tests.v')::uuid $$,
  '23514', null, 'the usage of a published version cannot change');
select throws_ok($$ update public.contract_template_versions set client_use_statement = 'edited' where id = current_setting('tests.v')::uuid $$,
  '23514', null, 'nor its confirmation');

-- A different usage needs a new version: the new draft copies the text, not the usage.
select tests.login_as(tests.id('owner_a'));
select set_config('tests.v2', public.open_contract_template_draft(current_setting('tests.t')::uuid)::text, true);
reset role;
select results_eq($$ select usage, client_use_confirmed_at, title from public.contract_template_versions where id = current_setting('tests.v2')::uuid $$,
  $$ values (null::text, null::timestamptz, 'Services agreement for {{event.title}}'::text) $$, 'the new draft has the same text and no usage yet');
update public.contract_template_versions set usage = 'client_use', client_use_confirmed_by_user_id = tests.id('staff_a')
where id = current_setting('tests.v2')::uuid;
select results_eq($$ select usage, client_use_confirmed_by_user_id from public.contract_template_versions where id = current_setting('tests.v2')::uuid $$,
  $$ values (null::text, null::uuid) $$, 'a draft cannot carry a usage or confirmation, even when written directly');
select tests.login_as(tests.id('staff_a'));
select is(public.publish_contract_template_version(current_setting('tests.v2')::uuid, 0, 'demo') ->> 'usage', 'demo', 'staff may publish a DEMO version');
reset role;
select results_eq($$ select usage, client_use_statement, client_use_confirmed_by_user_id from public.contract_template_versions where id = current_setting('tests.v2')::uuid $$,
  $$ values ('demo'::text, null::text, null::uuid) $$, 'a DEMO version records no client-use confirmation');

-- ===========================================================================
-- Contracts freeze their signing mode and consent at generation
-- ===========================================================================
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
reset role;
select results_eq($$ select signing_mode, consent_version from public.contracts where id = current_setting('tests.c')::uuid $$,
  $$ values ('client_use'::text, 'client-v1'::text) $$, 'a contract from a client-use version is frozen as client use with client-v1');
select ok((select rendered_content ->> 'title' from public.contracts where id = current_setting('tests.c')::uuid) !~ 'DEMO',
  'its wording carries no DEMO marker');
select throws_ok($$ update public.contracts set signing_mode = 'demo' where id = current_setting('tests.c')::uuid $$,
  '23514', null, 'the signing mode cannot change');
select throws_ok($$ update public.contracts set consent_version = 'demo-v1' where id = current_setting('tests.c')::uuid $$,
  '23514', null, 'nor the consent version');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.contracts where tenant_id = tests.id('tenant_a')), 0, 'another tenant sees no tenant A contracts');
reset role;

-- Publishing sent and signed nothing.
select is((select count(*)::int from public.contracts where tenant_id = tests.id('tenant_a') and status <> 'draft'), 0,
  'publishing sent no contract');
select is((select count(*)::int from public.contract_signatures where tenant_id = tests.id('tenant_a')), 0, 'and signed nothing');

-- ===========================================================================
-- Client-use signing
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is(tests.send_c(current_setting('tests.c')::uuid) ->> 'status', 'sent', 'the client-use contract is sent');
reset role;
select set_config('tests.view', tests.view_as(current_setting('tests.c')::uuid, 'client_y')::text, true);
select is(current_setting('tests.view')::jsonb -> 'signing',
  jsonb_build_object('signed', false, 'enabled', true, 'consent_version', 'client-v1', 'consent_text', private.contract_signing_consent('client-v1')),
  'the signer sees the exact client-v1 consent');
select is(current_setting('tests.view')::jsonb -> 'contract' ->> 'signing_mode', 'client_use', 'and the contract is not DEMO');
select is(tests.view_as(current_setting('tests.c')::uuid, 'client_x') ->> 'state', 'unavailable', 'another client sees nothing');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', 'demo-v1') ->> 'code', 'consent_changed',
  'the DEMO consent is refused for a client-use contract');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_x', 'client-v1') ->> 'code', 'unavailable', 'another client cannot sign');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', 'client-v1') ->> 'status', 'signed', 'the signer signs with client-v1');
select results_eq($$ select consent_version, consent_text from public.contract_signatures where contract_id = current_setting('tests.c')::uuid $$,
  $$ values ('client-v1'::text, private.contract_signing_consent('client-v1')) $$, 'the evidence stores the exact client-v1 wording');
select is((select metadata ->> 'signing_mode' from public.audit_events where entity_id = current_setting('tests.c')::uuid and action = 'signed'),
  'client_use', 'the signing audit records the mode');
select is(private.contract_signing_consent('demo-v1'),
  'I have read the agreement shown above. I intend to sign it electronically, and I agree that my typed name and drawn signature are my signature on this agreement.',
  'the demo-v1 wording is unchanged');
select ok(private.contract_signing_consent('client-v1') <> private.contract_signing_consent('demo-v1'), 'client-v1 is separate wording');

-- ===========================================================================
-- Legacy versions and contracts that cannot be signed
-- ===========================================================================
-- A version published before usage modes (as the migration classified it).
select tests.login_as(tests.id('owner_a'));
select set_config('tests.tl', public.create_contract_template(tests.id('tenant_a'), 'Old agreement', 'Old agreement for {{event.title}}',
  tests.simple_sections())::text, true);
select set_config('tests.vl', (select id::text from public.contract_template_versions where template_id = current_setting('tests.tl')::uuid), true);
select public.publish_contract_template_version(current_setting('tests.vl')::uuid, 0, 'demo');
reset role;
set local session_replication_role = replica;
update public.contract_template_versions set usage = 'legacy' where id = current_setting('tests.vl')::uuid;
set local session_replication_role = origin;

select set_config('tests.a1', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.vl')::uuid) $$,
  '%published before agreements could be approved for client use%', 'no contract is generated from a legacy version');
select is(public.publish_contract_template_version(current_setting('tests.vl')::uuid, 0, 'client_use', 'client-use-v1') ->> 'usage', 'legacy',
  'publishing a legacy version again changes nothing (a new version is needed)');

-- A non-DEMO draft from before the migration (mode "none").
select set_config('tests.n', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v2')::uuid) ->> 'contract_id', true);
reset role;
set local session_replication_role = replica;
update public.contracts set signing_mode = 'none', consent_version = null where id = current_setting('tests.n')::uuid;
set local session_replication_role = origin;
select tests.login_as(tests.id('owner_a'));
select ok(public.review_contract_for_send(current_setting('tests.n')::uuid) -> 'problems' @> '[{"code":"signing_unavailable"}]',
  'review explains why it cannot be sent and how to fix it');
select is(public.review_contract_for_send(current_setting('tests.n')::uuid) ->> 'can_send', 'false', 'it cannot be sent');
select throws_like($$ select tests.send_c(current_setting('tests.n')::uuid) $$, '%can''t be signed online%', 'sending is refused');
-- The fix: regenerate from a version that can be signed.
select set_config('tests.n2', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid, null,
  current_setting('tests.n')::uuid) ->> 'contract_id', true);
reset role;
select results_eq($$ select signing_mode, consent_version from public.contracts where id = current_setting('tests.n2')::uuid $$,
  $$ values ('client_use'::text, 'client-v1'::text) $$, 'regenerating from a client-use version gives a signable contract');
select is((select signing_mode from public.contracts where id = current_setting('tests.n')::uuid), 'none', 'the replaced draft keeps its mode');

-- A sent contract from before the migration that cannot be signed.
select tests.login_as(tests.id('owner_a'));
select tests.send_c(current_setting('tests.n2')::uuid);
reset role;
set local session_replication_role = replica;
update public.contracts set signing_mode = 'none', consent_version = null where id = current_setting('tests.n2')::uuid;
set local session_replication_role = origin;
select is(tests.view_as(current_setting('tests.n2')::uuid, 'client_x') -> 'signing',
  jsonb_build_object('signed', false, 'enabled', false, 'consent_version', null, 'consent_text', null),
  'the client can read it but is offered no signing and no consent');
select is(tests.sign(current_setting('tests.n2')::uuid, 'client_x', 'demo-v1') ->> 'code', 'signing_disabled', 'signing is refused');
select is((select count(*)::int from public.contract_signatures where contract_id = current_setting('tests.n2')::uuid), 0, 'and nothing is stored');

-- ===========================================================================
-- Signed-copy emails freeze their sender
-- ===========================================================================
select private.enqueue_signed_copy_emails(current_setting('tests.c')::uuid);
select results_eq(
  $$ select recipient_email, sender from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy'
     order by recipient_email $$,
  $$ values ('client-y@example.test'::text, jsonb_build_object('display_name', 'BOUPROD', 'from_name', 'BOUPROD via Flux DJ', 'reply_to', 'hello@bouprod.test')),
            ('legal@bouprod.test', jsonb_build_object('display_name', 'BOUPROD', 'from_name', 'BOUPROD via Flux DJ', 'reply_to', 'hello@bouprod.test')) $$,
  'each recipient row freezes the display name, from name and reply-to when queued');
update public.tenants set display_name = 'Renamed DJ', reply_to_email = 'new@bouprod.test' where id = tests.id('tenant_a');
update public.email_outbox set status = 'sending', attempts = 1 where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_signed_copy';
select set_config('tests.row', (select id::text from public.email_outbox where entity_id = current_setting('tests.c')::uuid
  and recipient_email = 'legal@bouprod.test'), true);
select tests.login_as_service();
select is(public.freeze_email_sender(current_setting('tests.row')::uuid, 'contracts@fluxdj.test'),
  jsonb_build_object('display_name', 'BOUPROD', 'from_name', 'BOUPROD via Flux DJ', 'reply_to', 'hello@bouprod.test', 'from_address', 'contracts@fluxdj.test'),
  'the first attempt adds the from address; settings changed since queueing are ignored');
select is(public.freeze_email_sender(current_setting('tests.row')::uuid, 'other@fluxdj.test') ->> 'from_address', 'contracts@fluxdj.test',
  'a retry keeps the first from address');
reset role;
select throws_ok($$ update public.email_outbox set sender = '{"from_name":"x"}' where id = current_setting('tests.row')::uuid $$,
  '23514', 'email_outbox.sender is frozen once set', 'a frozen sender cannot change');
select throws_ok($$ update public.email_outbox set sender = null where id = current_setting('tests.row')::uuid $$,
  '23514', 'email_outbox.sender is frozen once set', 'or be cleared');

-- A row queued before this migration (no sender) freezes everything at its next attempt.
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, status, attempts)
values (tests.id('tenant_a'), 'contract_signed_copy', 'old@example.test', 'contract', current_setting('tests.c')::uuid, '{}', 'legacy-row-test', 'sending', 1);
select tests.login_as_service();
select is(public.freeze_email_sender((select id from public.email_outbox where dedup_key = 'legacy-row-test'), 'contracts@fluxdj.test'),
  jsonb_build_object('display_name', 'Renamed DJ', 'from_name', 'Renamed DJ via Flux DJ', 'reply_to', 'new@bouprod.test', 'from_address', 'contracts@fluxdj.test'),
  'an older row freezes the current settings at its next attempt');
reset role;
update public.tenants set display_name = 'Renamed Again' where id = tests.id('tenant_a');
select tests.login_as_service();
select is(public.freeze_email_sender((select id from public.email_outbox where dedup_key = 'legacy-row-test'), 'contracts@fluxdj.test') ->> 'from_name',
  'Renamed DJ via Flux DJ', 'and keeps them for later retries');
reset role;
-- Rows that are not being delivered (e.g. sent) are never touched.
update public.email_outbox set status = 'sent', sent_at = now(), provider_message_id = 'x' where dedup_key = 'legacy-row-test';
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, status, attempts, sent_at, provider_message_id)
values (tests.id('tenant_a'), 'contract_signed_copy', 'sent@example.test', 'contract', current_setting('tests.c')::uuid, '{}', 'sent-row-test', 'sent', 1, now(), 'y');
select tests.login_as_service();
select is(public.freeze_email_sender((select id from public.email_outbox where dedup_key = 'sent-row-test'), 'contracts@fluxdj.test'), null,
  'a sent row is not frozen or changed');
reset role;
select is((select sender from public.email_outbox where dedup_key = 'sent-row-test'), null, 'its history stays as it was');
select throws_like($$ select public.freeze_email_sender(current_setting('tests.row')::uuid, 'not-an-email') $$, '%invalid from address%',
  'the from address must be an email address');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.freeze_email_sender(current_setting('tests.row')::uuid, 'evil@example.test') $$,
  '42501', null, 'staff cannot set senders');
reset role;
-- Re-queueing a failed row keeps its frozen sender.
update public.email_outbox set status = 'failed' where id = current_setting('tests.row')::uuid;
select private.enqueue_signed_copy_emails(current_setting('tests.c')::uuid);
select results_eq($$ select status, sender ->> 'display_name', sender ->> 'from_address' from public.email_outbox where id = current_setting('tests.row')::uuid $$,
  $$ values ('pending'::text, 'BOUPROD'::text, 'contracts@fluxdj.test'::text) $$, 'a re-queued row keeps its frozen sender');

-- ===========================================================================
-- Compatibility: the two-argument publish of the previously deployed app
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select set_config('tests.tc', public.create_contract_template(tests.id('tenant_a'), 'Old-app DEMO', 'DEMO, NOT FOR CLIENT USE: Old app for {{event.title}}',
  tests.simple_sections())::text, true);
select set_config('tests.vc', (select id::text from public.contract_template_versions where template_id = current_setting('tests.tc')::uuid), true);
select throws_ok($$ select public.publish_contract_template_version(current_setting('tests.vc')::uuid, 5) $$,
  '40001', null, 'the old call still requires the latest saved draft');
select is(public.publish_contract_template_version(current_setting('tests.vc')::uuid, 0) ->> 'usage', 'demo',
  'the old call publishes a DEMO agreement as DEMO, as before (staff may)');
reset role;
select results_eq($$ select usage, client_use_confirmed_at from public.contract_template_versions where id = current_setting('tests.vc')::uuid $$,
  $$ values ('demo'::text, null::timestamptz) $$, 'with no client-use confirmation');

select tests.login_as(tests.id('owner_a'));
select set_config('tests.tr', public.create_contract_template(tests.id('tenant_a'), 'Old-app real', 'Real agreement for {{event.title}}',
  tests.simple_sections())::text, true);
select set_config('tests.vr', (select id::text from public.contract_template_versions where template_id = current_setting('tests.tr')::uuid), true);
select throws_like($$ select public.publish_contract_template_version(current_setting('tests.vr')::uuid, 0) $$,
  '%only DEMO agreements can be published this way%', 'the old call never publishes anything else, not even for the owner');
reset role;
select is((select published_at from public.contract_template_versions where id = current_setting('tests.vr')::uuid), null, 'the version stays a draft');
select tests.login_as(tests.id('owner_a'));
select is(public.publish_contract_template_version(current_setting('tests.v')::uuid, 0) ->> 'usage', 'client_use',
  'the old call on a version already approved for client use only replays it');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.publish_contract_template_version(current_setting('tests.vc')::uuid, 0) $$,
  'P0002', 'not found', 'the old call refuses other tenants');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.publish_contract_template_version(current_setting('tests.vr')::uuid, 0) $$,
  'P0002', 'not found', 'and clients');
reset role;
select is((select count(*)::int from public.audit_events where entity_id = current_setting('tests.tc')::uuid and action = 'version_published'), 1,
  'the old call is audited once');

-- ===========================================================================
-- PDF jobs: claiming one contract's job
-- ===========================================================================
-- The client-use contract is signed and has a pending job (backlog across
-- tenants is covered by tests/integration/contract-documents.test.ts).
update public.document_jobs set next_attempt_at = now() - interval '1 minute' where contract_id = current_setting('tests.c')::uuid;
select is((select count(*)::int from public.document_jobs where contract_id = current_setting('tests.c')::uuid and status = 'pending'), 1,
  'signing queued one pending PDF job');
select tests.login_as_service();
select is((select count(*)::int from public.claim_document_jobs(5, 120, null, gen_random_uuid())), 0, 'another contract''s claim takes nothing');
select is((select contract_id from public.claim_document_jobs(1, 120, null, current_setting('tests.c')::uuid)), current_setting('tests.c')::uuid,
  'the targeted claim takes exactly this contract''s job');
select is((select count(*)::int from public.claim_document_jobs(5, 120, null, current_setting('tests.c')::uuid)), 0,
  'a job held under a live lease cannot be claimed again (no duplicate work)');
select is((select count(*)::int from public.claim_document_jobs(5, 120, tests.id('tenant_a'))), 0, 'nor by a tenant-wide worker');
select is((select count(*)::int from public.claim_document_jobs(p_limit => 5, p_lease_seconds => 120, p_tenant_id => tests.id('tenant_a'))), 0,
  'the old three-parameter call still works');
reset role;
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select * from public.claim_document_jobs(1, 120, null, current_setting('tests.c')::uuid) $$,
  '42501', null, 'staff cannot claim jobs');
reset role;

-- Nothing here changed any signature evidence.
select is((select count(*)::int from public.contract_signatures where contract_id = current_setting('tests.c')::uuid), 1, 'one signature, unchanged');
select is((select status from public.contracts where id = current_setting('tests.c')::uuid), 'signed', 'and the contract stays signed');

select * from finish();
rollback;
