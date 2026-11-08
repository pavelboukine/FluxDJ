-- Which workflows setup reminders cover: owner-only, tenant-scoped, audited, and
-- guidance only. It changes no event and no other setting.
begin;
\ir _fixtures.psql
select plan(28);

select is((select count(*)::int from public.tenants where setup_guidance <> 'proposals_and_contracts' and id in (tests.id('tenant_a'), tests.id('tenant_b'))), 0, 'a business starts with proposal and contract reminders');
select col_not_null('public', 'tenants', 'setup_guidance', 'the setting is never null');
select col_default_is('public', 'tenants', 'setup_guidance', 'proposals_and_contracts'::text, 'and defaults to proposals and contracts');
select throws_ok($$ update public.tenants set setup_guidance = 'proposals_only' where id = tests.id('tenant_a') $$, '23514', null, 'only the three choices can be stored');
select is(has_function_privilege('anon', 'public.update_setup_guidance(uuid, text)', 'execute'), false, 'anonymous visitors can''t change it');
select is(has_column_privilege('authenticated', 'public.tenants', 'setup_guidance', 'update'), false, 'no one can update the column directly');
select is(has_column_privilege('authenticated', 'public.tenants', 'setup_guidance', 'select'), true, 'staff can read it');

select set_config('tests.events_before', (select md5(string_agg(id::text || contract_first::text || booking_source || lifecycle_status || updated_at::text, ',' order by id)) from public.events), true);

select tests.login_as(tests.id('staff_a'));
select is((select setup_guidance from public.tenants where id = tests.id('tenant_a')), 'proposals_and_contracts', 'staff see their business''s choice');
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_a'), 'contracts_only') $$, '42501', null, 'staff cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.tenants where id = tests.id('tenant_a')), 0, 'another business''s owner can''t read it');
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_a'), 'contracts_only') $$, 'P0002', null, 'or change it');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_a'), 'contracts_only') $$, 'P0002', null, 'nor can a client');
reset role; select set_config('request.jwt.claims', '', true);
select is((select setup_guidance from public.tenants where id = tests.id('tenant_a')), 'proposals_and_contracts', 'none of those changed it');

select tests.login_as(tests.id('owner_a'));
select is(public.update_setup_guidance(tests.id('tenant_a'), 'contracts_only'), 'contracts_only', 'the owner chooses contracts only');
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_a'), 'proposals_only') $$, '22023', null, 'an unknown choice is refused');
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_a'), null) $$, '22023', null, 'and a choice is required');
select is(public.update_setup_guidance(tests.id('tenant_a'), 'contracts_only'), 'contracts_only', 'saving the same choice again is accepted');
reset role; select set_config('request.jwt.claims', '', true);
select is((select setup_guidance from public.tenants where id = tests.id('tenant_a')), 'contracts_only', 'it is saved');
select is((select setup_guidance from public.tenants where id = tests.id('tenant_b')), 'proposals_and_contracts', 'another business keeps its own');
select is(
  (select array_agg(metadata order by occurred_at) from public.audit_events where entity_id = tests.id('tenant_a') and action = 'setup_guidance_changed'),
  array['{"from": "proposals_and_contracts", "to": "contracts_only"}'::jsonb],
  'the change is audited once, with what it changed from; an unchanged save adds nothing');

select tests.login_as(tests.id('owner_a'));
select is(public.update_setup_guidance(tests.id('tenant_a'), 'none'), 'none', 'planning only');
select is(public.update_setup_guidance(tests.id('tenant_a'), 'proposals_and_contracts'), 'proposals_and_contracts', 'and back to proposals and contracts');
reset role; select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'setup_guidance_changed'), 3, 'each change is audited');
select is((select proposals_by_default from public.tenants where id = tests.id('tenant_a')), true, 'event creation defaults are untouched');
select is((select md5(string_agg(id::text || contract_first::text || booking_source || lifecycle_status || updated_at::text, ',' order by id)) from public.events), current_setting('tests.events_before'), 'no event changed');

-- A removed member has no say (an owner's membership can't be removed).
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_a'), 'none') $$, 'P0002', null, 'a removed member cannot change it');
reset role; select set_config('request.jwt.claims', '', true);

-- Suspended and archived businesses. Suspension is set directly (suspend_workspace needs a platform administrator).
set local session_replication_role = replica;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_a'), 'none') $$, 'PT423', null, 'a suspended workspace cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
update public.tenants set archived_at = now() where id = tests.id('tenant_b');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_setup_guidance(tests.id('tenant_b'), 'none') $$, 'P0002', 'not found', 'an archived business cannot change it');
reset role; select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
