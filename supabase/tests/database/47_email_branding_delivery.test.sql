-- Email branding frozen per outbox row, provider delivery events, and who
-- can see and retry a business's emails.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(36);

-- Two registered logos for BOUPROD (A1 then A2) and one for Other DJ.
select set_config('tests.logo_a1', tests.id('tenant_a') || '/logos/' || gen_random_uuid() || '.png', true);
select set_config('tests.logo_a2', tests.id('tenant_a') || '/logos/' || gen_random_uuid() || '.png', true);
select set_config('tests.logo_b', tests.id('tenant_b') || '/logos/' || gen_random_uuid() || '.png', true);
insert into public.tenant_logos (tenant_id, storage_path, sha256, byte_size, width, height, needs_dark_background, uploaded_by) values
  (tests.id('tenant_a'), current_setting('tests.logo_a1'), repeat('a', 64), 1000, 800, 200, false, tests.id('owner_a')),
  (tests.id('tenant_a'), current_setting('tests.logo_a2'), repeat('b', 64), 1000, 400, 400, true, tests.id('owner_a')),
  (tests.id('tenant_b'), current_setting('tests.logo_b'), repeat('c', 64), 1000, 300, 100, false, tests.id('owner_b'));
update public.tenants set tax_categories = '{"standard":["GST","QST"]}', logo_storage_path = current_setting('tests.logo_a1'), brand_colors = '{"primary": "#e11d48"}' where id = tests.id('tenant_a');

-- A proposal sent with logo A1 and red; then the owner switches to A2 and blue.
select tests.login_as(tests.id('owner_a'));
select set_config('tests.pid', public.open_proposal_draft(tests.id('event_a1'), tests.base_offer())::text, true);
select tests.send(current_setting('tests.pid')::uuid);
reset role;
select set_config('request.jwt.claims', '', true);
update public.tenants set logo_storage_path = current_setting('tests.logo_a2'), brand_colors = '{"primary": "#1d4ed8"}' where id = tests.id('tenant_a');

create function tests.outbox_id(event_type text) returns uuid language sql stable as $$
  select id from public.email_outbox where tenant_id = tests.id('tenant_a') and event_type = $1 order by created_at desc limit 1 $$;
create function tests.claim(id uuid) returns void language sql as $$ update public.email_outbox set status = 'sending', attempts = attempts + 1 where id = $1 $$;
-- Rows queued by the business for other purposes (no frozen proposal branding).
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, status) values
  (tests.id('tenant_a'), 'contract_voided', 'client-x@example.test', 'contract', gen_random_uuid(), '{}', 'tests-voided-a', 'pending'),
  (tests.id('tenant_b'), 'proposal_approved', 'client-x@example.test', 'proposal', current_setting('tests.pid')::uuid, '{}', 'tests-cross-b', 'pending'),
  (null, 'platform_invitation', 'someone@example.test', 'platform_invitation', gen_random_uuid(), '{}', 'tests-platform', 'pending');
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Privileges
-- ===========================================================================
select ok(not has_function_privilege('authenticated', 'public.freeze_email_branding(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.freeze_email_branding(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.record_email_provider_event(text,text,timestamptz,text)', 'execute')
          and not has_function_privilege('anon', 'public.record_email_provider_event(text,text,timestamptz,text)', 'execute'),
  'freezing branding and recording provider events are service-role only');

-- ===========================================================================
-- Branding
-- ===========================================================================
select tests.login_as_service();
select is(public.freeze_email_branding(tests.outbox_id('proposal_sent')), null, 'nothing is frozen before the worker claims the row');
reset role;
select is((select branding from public.email_outbox where id = tests.outbox_id('proposal_sent')), null, 'and the row is unchanged');

select tests.claim(tests.outbox_id('proposal_sent'));
select tests.login_as_service();
select is(public.freeze_email_branding(tests.outbox_id('proposal_sent')),
  jsonb_build_object('display_name', 'BOUPROD', 'primary_color', '#e11d48', 'source', 'proposal', 'reply_to', null,
    'logo', jsonb_build_object('path', current_setting('tests.logo_a1'), 'needs_dark_background', false, 'width', 800, 'height', 200)),
  'a proposal email uses the branding frozen when the proposal was sent, not the current one');
reset role;
update public.tenants set brand_colors = '{"primary": "#16a34a"}' where id = tests.id('tenant_a');
select tests.login_as_service();
select is(public.freeze_email_branding(tests.outbox_id('proposal_sent')) ->> 'primary_color', '#e11d48', 'a retry renders the same branding');
reset role;
select throws_ok($$ update public.email_outbox set branding = '{"display_name": "Other"}' where id = tests.outbox_id('proposal_sent') $$,
  '23514', 'email_outbox.branding is frozen once set', 'frozen branding can''t be changed, even by privileged code');

select tests.claim(tests.outbox_id('contract_voided'));
select tests.login_as_service();
select is(public.freeze_email_branding(tests.outbox_id('contract_voided')),
  jsonb_build_object('display_name', 'BOUPROD', 'primary_color', '#16a34a', 'source', 'business', 'reply_to', null,
    'logo', jsonb_build_object('path', current_setting('tests.logo_a2'), 'needs_dark_background', true, 'width', 400, 'height', 400)),
  'other emails use the business''s current branding at their first attempt');
reset role;

update public.email_outbox set status = 'sending' where dedup_key = 'tests-cross-b';
select tests.login_as_service();
select is(public.freeze_email_branding((select id from public.email_outbox where dedup_key = 'tests-cross-b')),
  jsonb_build_object('display_name', 'Other DJ', 'source', 'business', 'reply_to', null),
  'a row never takes another business''s proposal branding or logo');
update public.email_outbox set status = 'sending' where dedup_key = 'tests-platform';
select is(public.freeze_email_branding((select id from public.email_outbox where dedup_key = 'tests-platform')), null, 'platform emails have no business branding');
reset role;

-- A logo path that isn't one of the business's registered logos is never used.
update public.tenants set logo_storage_path = null where id = tests.id('tenant_a');
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, status)
  values (tests.id('tenant_a'), 'contract_voided', 'client-y@example.test', 'contract', gen_random_uuid(), '{}', 'tests-voided-a2', 'sending');
select tests.login_as_service();
select ok(not (public.freeze_email_branding((select id from public.email_outbox where dedup_key = 'tests-voided-a2')) ? 'logo'),
  'no logo when the business has none');
reset role;

-- ===========================================================================
-- Provider events
-- ===========================================================================
update public.email_outbox set status = 'sent', sent_at = now(), provider_message_id = 're_test_1' where id = tests.outbox_id('proposal_sent');
select tests.login_as_service();
select is(public.record_email_provider_event('re_test_1', 'delayed', '2027-01-01T10:00:00Z', null), true, 'a delay is recorded');
select is(public.record_email_provider_event('re_test_1', 'delivered', '2027-01-01T10:05:00Z', null), true, 'then delivery');
select is(public.record_email_provider_event('re_test_1', 'delivered', '2027-01-01T10:05:00Z', null), false, 'a duplicate changes nothing');
select is(public.record_email_provider_event('re_test_1', 'delayed', '2027-01-01T10:01:00Z', null), false, 'a late delay never undoes delivery');
select is(public.record_email_provider_event('re_test_1', 'bounced', '2027-01-01T10:06:00Z', 'Permanent · General'), true, 'a bounce replaces delivery');
select is(public.record_email_provider_event('re_test_1', 'delivered', '2027-01-01T10:07:00Z', null), false, 'delivery never hides a bounce');
select is(public.record_email_provider_event('re_test_1', 'complained', '2027-01-01T11:00:00Z', null), true, 'a complaint is recorded last');
select is(public.record_email_provider_event('re_unknown', 'delivered', '2027-01-01T10:00:00Z', null), false, 'unknown messages are ignored');
select throws_ok($$ select public.record_email_provider_event('re_test_1', 'opened', now(), null) $$, '22023', null, 'opens and clicks are not delivery outcomes');
reset role;
select results_eq(
  $$ select status, provider_status, provider_status_at, attempts from public.email_outbox where id = tests.outbox_id('proposal_sent') $$,
  $$ values ('sent'::text, 'complained'::text, '2027-01-01T11:00:00Z'::timestamptz, 1) $$,
  'provider events never change the outbox status or schedule a retry');
select throws_ok($$ update public.email_outbox set provider_status_at = null where id = tests.outbox_id('proposal_sent') $$,
  '23514', null, 'a provider status needs its time');

-- ===========================================================================
-- Who sees and retries a business's emails
-- ===========================================================================
update public.email_outbox set status = 'failed', attempts = 5, max_attempts = 5, last_error = 'Resend responded 503' where dedup_key = 'tests-voided-a';
select tests.login_as(tests.id('staff_a'));
select isnt_empty($$ select provider_status from public.email_outbox where id = tests.outbox_id('proposal_sent') $$, 'staff read their business''s delivery status');
select is(public.retry_email_outbox(tests.outbox_id('proposal_sent')), false, 'an accepted email can''t be retried');
select is(public.retry_email_outbox((select id from public.email_outbox where dedup_key = 'tests-voided-a')), true, 'a failed one is queued again');
select is(public.retry_email_outbox((select id from public.email_outbox where dedup_key = 'tests-voided-a')), false, 'a second retry finds nothing to do');
reset role;
select results_eq($$ select status, max_attempts from public.email_outbox where dedup_key = 'tests-voided-a' $$, $$ values ('pending'::text, 8) $$,
  'the same row, with three more attempts');

select tests.login_as(tests.id('owner_b'));
select is_empty($$ select id from public.email_outbox where tenant_id = tests.id('tenant_a') $$, 'another business sees none of these emails');
select throws_ok($$ select public.retry_email_outbox(tests.outbox_id('proposal_sent')) $$, 'P0002', null, 'nor can it retry them');
select tests.login_as(tests.id('client_x'));
select is_empty($$ select id from public.email_outbox $$, 'a client sees no outbox rows, not even emails sent to them');
select throws_ok($$ select public.retry_email_outbox(tests.outbox_id('proposal_sent')) $$, 'P0002', null, 'nor retries them');
select tests.login_as_anon();
select throws_ok($$ select id from public.email_outbox $$, '42501', null, 'anonymous users have no access');

-- Removed staff lose access at once.
select tests.login_as(tests.id('owner_a'));
select is((public.remove_staff_member(tests.id('tenant_a'), (select id from public.tenant_memberships where user_id = tests.id('staff_a')))) ->> 'status', 'removed', 'the owner removes staff');
select tests.login_as(tests.id('staff_a'));
select is_empty($$ select id from public.email_outbox where tenant_id = tests.id('tenant_a') $$, 'a removed staff member sees no emails');
select throws_ok($$ select public.retry_email_outbox(tests.outbox_id('proposal_sent')) $$, 'P0002', null, 'and can retry none');
reset role;

-- Platform emails stay out of every business's view.
select tests.login_as(tests.id('owner_a'));
select is_empty($$ select id from public.email_outbox where tenant_id is null $$, 'business owners never see platform emails');
select throws_ok($$ select public.retry_email_outbox((select id from public.email_outbox where dedup_key = 'tests-platform')) $$, 'P0002', null,
  'nor retry them');
reset role;

select * from finish();
rollback;
