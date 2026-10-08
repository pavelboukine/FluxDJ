-- Creating a package with its included gear (create_package): who may call
-- it, that the package and gear are saved together or not at all, and that
-- a retry with the same id returns the package already created.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
select plan(20);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('package-create-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.create_pkg(req text, key text, items jsonb, who text default 'staff_a', tenant text default 'tenant_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.create_package(tests.id(tenant), tests.id(req), key, 'Gold ' || key, 'A description', 249999, 'standard', 4, items);
  perform tests.su();
  return r;
end $$;
create function tests.items_of(req text) returns text language sql as $$
  select coalesce(string_agg(quantity::text, ',' order by quantity), '') from public.package_items where package_id = tests.id(req);
$$;
create function tests.packages_named(key text) returns int language sql as $$
  select count(*)::int from public.packages where key = $1;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select tests.su();
create temporary table gear_items_json as select
  jsonb_build_array(
    jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 2),
    jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'quantity', 1)) as two,
  jsonb_build_array(
    jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 2),
    jsonb_build_object('gear_item_id', tests.id('gear_b_speaker'), 'quantity', 1)) as foreign_gear,
  jsonb_build_array(
    jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 2),
    jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 1)) as twice,
  jsonb_build_array(jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 101)) as too_many;
grant select on gear_items_json to anon, authenticated;

-- Access ------------------------------------------------------------------------
select tests.login_as_anon();
select throws_ok($$ select public.create_package(tests.id('tenant_a'), tests.id('req_anon'), 'anon_pkg', 'Anon', null, 1, 'standard', 0, '[]') $$,
  '42501', null, 'anon cannot create a package');
select tests.su();
select throws_ok($$ select tests.create_pkg('req_b', 'b_pkg', '[]', 'owner_b', 'tenant_a') $$, 'P0002', 'not found', 'another business cannot create one here');
select throws_ok($$ select tests.create_pkg('req_c', 'c_pkg', '[]', 'client_y', 'tenant_a') $$, 'P0002', 'not found', 'nor can a client');

-- All or nothing -----------------------------------------------------------------------
select is(tests.create_pkg('req_ok', 'gold', (select two from gear_items_json)), jsonb_build_object('id', tests.id('req_ok'), 'replayed', false),
  'staff create a package with its gear');
select is((select name || '|' || base_price_cents || '|' || tax_category || '|' || sort_order || '|' || active || '|' || is_popular from public.packages where id = tests.id('req_ok')),
  'Gold gold|249999|standard|4|true|false', 'the package has the given details, active, not marked popular');
select is(tests.items_of('req_ok'), '1,2', 'and its gear with quantities');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('req_ok')), 0, '(creating is not an audited action)');

select throws_ok($$ select tests.create_pkg('req_foreign', 'foreign', (select foreign_gear from gear_items_json)) $$, '23503', null,
  'another business''s gear is refused');
select is(tests.packages_named('foreign'), 0, 'and no package is left behind');
select throws_ok($$ select tests.create_pkg('req_twice', 'twice', (select twice from gear_items_json)) $$, '23505', null, 'the same gear twice is refused');
select is(tests.packages_named('twice'), 0, 'nothing is left behind');
select throws_ok($$ select tests.create_pkg('req_many', 'many', (select too_many from gear_items_json)) $$, '23514', null, 'a quantity above 100 is refused');
select throws_like($$ select tests.create_pkg('req_bad', 'bad', '[{"gear_item_id": "nope", "quantity": 1}]') $$, '%package_invalid%', 'malformed items are refused');
select is(tests.packages_named('many') + tests.packages_named('bad'), 0, 'nothing is left behind');

-- Retry after a lost response --------------------------------------------------------------
select is(tests.create_pkg('req_ok', 'gold_retry', '[]'), jsonb_build_object('id', tests.id('req_ok'), 'replayed', true),
  'a retry with the same id returns the package already created');
select is(tests.packages_named('gold') + tests.packages_named('gold_retry'), 1, 'no second package');
select is(tests.items_of('req_ok'), '1,2', 'and its gear is unchanged');
select throws_ok($$ select tests.create_pkg('req_ok', 'other_tenant', '[]', 'owner_b', 'tenant_b') $$, 'P0002', 'not found',
  'another business cannot claim the id');

-- Suspended workspace -------------------------------------------------------------
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select throws_like($$ select tests.create_pkg('req_suspended', 'suspended', '[]') $$, '%workspace_suspended%', 'a suspended workspace is refused');
select is(tests.packages_named('suspended'), 0, 'and nothing is created');

select * from finish();
rollback;
