-- The owner's logo size: part of the versioned branding save, owner-only, bounded,
-- defaulting to today's appearance, and optional so the deployed app keeps working.
begin;
\ir _fixtures.psql
select plan(23);

create function tests.brand(tenant text, version int, size int default null) returns int language plpgsql as $$
begin
  return public.update_tenant_branding(tests.id(tenant), version, null, null, size);
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select col_not_null('public', 'tenants', 'logo_size_percent', 'the size is never null');
select col_default_is('public', 'tenants', 'logo_size_percent', '100', 'and defaults to today''s appearance');
select is((select count(*)::int from public.tenants where id in (tests.id('tenant_a'), tests.id('tenant_b')) and logo_size_percent <> 100), 0, 'a new business starts at 100%');
select is(has_column_privilege('authenticated', 'public.tenants', 'logo_size_percent', 'update'), false, 'no one updates the column directly');
select is(has_column_privilege('authenticated', 'public.tenants', 'logo_size_percent', 'select'), true, 'staff can read it');
select is(has_function_privilege('anon', 'public.update_tenant_branding(uuid, integer, uuid, text, integer)', 'execute'), false, 'anonymous visitors can''t change it');
select throws_ok($$ update public.tenants set logo_size_percent = 131 where id = tests.id('tenant_a') $$, '23514', null, 'the column constraint bounds it above');
select throws_ok($$ update public.tenants set logo_size_percent = 99 where id = tests.id('tenant_a') $$, '23514', null, 'and below');

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select tests.brand('tenant_a', 0, 120) $$, '42501', null, 'staff cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select tests.brand('tenant_a', 0, 120) $$, 'P0002', 'not found', 'another business''s owner cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as_anon();
select throws_ok($$ select public.update_tenant_branding(tests.id('tenant_a'), 0, null, null, 120) $$, '42501', null, 'anon cannot change it');
reset role; select set_config('request.jwt.claims', '', true);
select is((select logo_size_percent from public.tenants where id = tests.id('tenant_a')), 100, 'none of those changed it');

select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.brand('tenant_a', 0, 99) $$, '%logo size must be from 100% to 130%%', 'below 100% is refused');
select throws_like($$ select tests.brand('tenant_a', 0, 131) $$, '%logo size must be from 100% to 130%%', 'above 130% is refused');
select is(tests.brand('tenant_a', 0, 130), 1, 'the owner saves it with the rest of the branding');
select throws_ok($$ select tests.brand('tenant_a', 0, 110) $$, 'PT409', null, 'a stale tab cannot overwrite it');
-- Four named arguments: how the deployed app calls it until this release ships.
select is(public.update_tenant_branding(p_tenant_id => tests.id('tenant_a'), p_expected_version => 1, p_logo_id => null, p_primary_color => '#1a2b3c'), 2, 'the earlier call still works');
reset role; select set_config('request.jwt.claims', '', true);
select results_eq(
  $$ select logo_size_percent, branding_version, brand_colors ->> 'primary' from public.tenants where id = tests.id('tenant_a') $$,
  $$ values (130, 2, '#1a2b3c'::text) $$, 'and keeps the saved size, changing only what it was given');
select is((select logo_size_percent from public.tenants where id = tests.id('tenant_b')), 100, 'another business is untouched');
select is((select metadata ->> 'logo_size_percent' from public.audit_events where entity_id = tests.id('tenant_a') and action = 'branding_updated' and (metadata ->> 'version')::int = 1), '130', 'the change is audited');

select tests.login_as_service();
select is(public.public_tenant_brand('test-bouprod') ->> 'logo_size_percent', '130', 'client pages can read it');
reset role; select set_config('request.jwt.claims', '', true);

set local session_replication_role = replica;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select tests.brand('tenant_a', 2, 110) $$, 'PT423', null, 'a suspended workspace refuses it');
reset role; select set_config('request.jwt.claims', '', true);
select is((select logo_size_percent from public.tenants where id = tests.id('tenant_a')), 130, 'and nothing changed');

select * from finish();
rollback;
