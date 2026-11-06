-- The business's default for whether a new event starts with a proposal: owner-only,
-- tenant-scoped, and nothing but a starting value. It changes no existing event.
begin;
\ir _fixtures.psql
select plan(19);

select is((select count(*)::int from public.tenants where not proposals_by_default and id in (tests.id('tenant_a'), tests.id('tenant_b'))), 0, 'a business starts with proposals on');
select col_not_null('public', 'tenants', 'proposals_by_default', 'the setting is never null');
select col_default_is('public', 'tenants', 'proposals_by_default', 'true', 'and defaults to on');
select is(has_function_privilege('anon', 'public.update_proposal_default(uuid, boolean)', 'execute'), false, 'anonymous visitors can''t change it');
select is(has_column_privilege('authenticated', 'public.tenants', 'proposals_by_default', 'update'), false, 'no one can update the column directly');
select is(has_column_privilege('authenticated', 'public.tenants', 'proposals_by_default', 'select'), true, 'staff can read it');

select set_config('tests.events_before', (select md5(string_agg(id::text || contract_first::text || booking_source || lifecycle_status || updated_at::text, ',' order by id)) from public.events), true);

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_proposal_default(tests.id('tenant_a'), false) $$, '42501', null, 'staff cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_proposal_default(tests.id('tenant_a'), false) $$, 'P0002', null, 'another business''s owner cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.update_proposal_default(tests.id('tenant_a'), false) $$, 'P0002', null, 'nor can a client');
reset role; select set_config('request.jwt.claims', '', true);
select is((select proposals_by_default from public.tenants where id = tests.id('tenant_a')), true, 'none of those changed it');

select tests.login_as(tests.id('owner_a'));
select is(public.update_proposal_default(tests.id('tenant_a'), false), false, 'the owner turns it off');
select throws_ok($$ select public.update_proposal_default(tests.id('tenant_a'), null) $$, '22023', null, 'and must choose a value');
reset role; select set_config('request.jwt.claims', '', true);
select is((select proposals_by_default from public.tenants where id = tests.id('tenant_a')), false, 'it is saved');
select is((select proposals_by_default from public.tenants where id = tests.id('tenant_b')), true, 'another business keeps its own');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'proposal_default_changed'), 1, 'the change is audited');
select is((select md5(string_agg(id::text || contract_first::text || booking_source || lifecycle_status || updated_at::text, ',' order by id)) from public.events), current_setting('tests.events_before'), 'no event changed');

-- A removed member has no say (an owner's membership can't be removed).
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_proposal_default(tests.id('tenant_a'), true) $$, 'P0002', null, 'a removed member cannot change it');
reset role; select set_config('request.jwt.claims', '', true);

-- An archived business can't, and an event keeps its own workflow.
update public.tenants set archived_at = now() where id = tests.id('tenant_b');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_proposal_default(tests.id('tenant_b'), false) $$, 'P0002', null, 'an archived business cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('owner_a'));
select is((select contract_first from public.events where id = (select tests.id('event_a1'))), false, 'an existing event keeps its own workflow');
reset role; select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
