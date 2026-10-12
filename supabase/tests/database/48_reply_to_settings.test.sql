-- The owner-editable reply-to address, and the reply-to frozen per email.
begin;
\ir _fixtures.psql
select plan(18);

select ok(not has_column_privilege('authenticated', 'public.tenants', 'reply_to_email', 'update'), 'the address is no longer written directly');
select ok(not has_function_privilege('anon', 'public.update_reply_to_email(uuid,text)', 'execute'), 'anonymous users can''t call it');

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_reply_to_email(tests.id('tenant_a'), 'x@example.test') $$, '42501', null, 'staff can''t change it');
select throws_ok($$ update public.tenants set reply_to_email = 'x@example.test' where id = tests.id('tenant_a') $$, '42501', null, 'nor write it directly');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_reply_to_email(tests.id('tenant_a'), 'x@example.test') $$, 'P0002', null, 'another business gets not found');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.update_reply_to_email(tests.id('tenant_a'), 'x@example.test') $$, 'P0002', null, 'so does a client');

select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.update_reply_to_email(tests.id('tenant_a'), 'not-an-email') $$, '22023', 'settings_invalid: enter a valid reply-to email address', 'an invalid address is refused');
select is(public.update_reply_to_email(tests.id('tenant_a'), '  Office@BOUPROD.example '), 'office@bouprod.example', 'the owner sets it, normalized');
select is(public.update_reply_to_email(tests.id('tenant_a'), 'office@bouprod.example'), 'office@bouprod.example', 'saving the same address again is a no-op');
reset role;
select is((select reply_to_email from public.tenants where id = tests.id('tenant_a')), 'office@bouprod.example', 'stored');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'reply_to_changed'), 1, 'audited once, without the address');
select is(private.staff_notification_email(tests.id('tenant_a')), 'office@bouprod.example', 'staff notifications follow it');

-- Frozen at an email's first attempt; a later change doesn't alter that email.
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, status)
  values (tests.id('tenant_a'), 'contract_voided', 'client-x@example.test', 'contract', gen_random_uuid(), '{}', 'tests-reply-1', 'sending');
select tests.login_as_service();
select is(public.freeze_email_branding((select id from public.email_outbox where dedup_key = 'tests-reply-1')) ->> 'reply_to', 'office@bouprod.example', 'the first attempt freezes the reply-to');
reset role;
select tests.login_as(tests.id('owner_a'));
select is(public.update_reply_to_email(tests.id('tenant_a'), ''), null, 'the owner clears it');
reset role;
select is(private.staff_notification_email(tests.id('tenant_a')), 'owner-a@example.test', 'notifications fall back to the owner''s sign-in email');
select tests.login_as_service();
select is(public.freeze_email_branding((select id from public.email_outbox where dedup_key = 'tests-reply-1')) ->> 'reply_to', 'office@bouprod.example', 'a retry keeps the frozen reply-to');
reset role;
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, status)
  values (tests.id('tenant_a'), 'contract_voided', 'client-x@example.test', 'contract', gen_random_uuid(), '{}', 'tests-reply-2', 'sending');
select tests.login_as_service();
select ok((public.freeze_email_branding((select id from public.email_outbox where dedup_key = 'tests-reply-2')) -> 'reply_to') = 'null'::jsonb,
  'a new email records "no reply-to" explicitly');
reset role;

-- A suspended workspace can't change it.
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.update_reply_to_email(tests.id('tenant_a'), 'later@bouprod.example') $$, 'PT423', null, 'a suspended workspace can''t change it');
reset role;

select * from finish();
rollback;
