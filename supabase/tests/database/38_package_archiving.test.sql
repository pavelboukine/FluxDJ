-- Package archiving (set_package_archived): who may call it, that it changes
-- only the package's active flag (never included gear or templates), once,
-- with an audit event, and that a suspended workspace is refused.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
select plan(16);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('package-archiving-test-' || name)::uuid);
$$;

create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.archive_pkg(pkg text, archived boolean, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.set_package_archived(tests.id(pkg), archived);
  perform tests.su();
  return r;
end $$;
create function tests.items(pkg text) returns text language sql as $$
  select coalesce(string_agg(gear_item_id::text || ':' || quantity, ',' order by gear_item_id), '') from public.package_items where package_id = tests.id(pkg);
$$;

select tests.su();
create temporary table before_items as select tests.items('pkg_a_plus') as items;
create function tests.templates() returns int language sql as $$
  select count(distinct template_id)::int from public.proposal_template_packages where package_id = tests.id('pkg_a_plus');
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;
-- A template that uses the package.
insert into public.proposal_templates (id, tenant_id, name) values (tests.id('tpl_a'), tests.id('tenant_a'), 'Wedding');
insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
values (tests.id('tenant_a'), tests.id('tpl_a'), tests.id('pkg_a_plus'), 1);

-- Access ----------------------------------------------------------------------
select tests.login_as_anon();
select throws_ok($$ select public.set_package_archived(tests.id('pkg_a_plus'), true) $$, '42501', null, 'anon cannot archive a package');
select tests.su();
select throws_ok($$ select tests.archive_pkg('pkg_a_plus', true, 'owner_b') $$, 'P0002', 'not found', 'another business cannot archive it');
select throws_ok($$ select tests.archive_pkg('pkg_a_plus', true, 'client_y') $$, 'P0002', 'not found', 'nor can a client');
select throws_ok($$ select tests.archive_pkg('no_such_package', true) $$, 'P0002', 'not found', 'an unknown package is not found');
select throws_like($$ select tests.archive_pkg('pkg_a_plus', null) $$, '%archive_invalid%', 'archive or restore must be chosen');
select is((select active from public.packages where id = tests.id('pkg_a_plus')), true, 'refused calls change nothing');

-- Archive and restore -----------------------------------------------------------
select is(tests.archive_pkg('pkg_a_plus', true), '{"status": "archived", "replayed": false}'::jsonb || jsonb_build_object('templates', tests.templates()), 'staff archive a package, counting the templates that use it');
select is((select active from public.packages where id = tests.id('pkg_a_plus')), false, 'it is inactive');
select is(tests.items('pkg_a_plus'), (select items from before_items), 'its included gear is unchanged');
select ok(tests.templates() >= 1 and exists (select 1 from public.proposal_template_packages where template_id = tests.id('tpl_a') and package_id = tests.id('pkg_a_plus')), 'templates keep it');
select is(tests.archive_pkg('pkg_a_plus', true), '{"status": "archived", "replayed": true}'::jsonb, 'a repeat is a no-op');
select is(tests.archive_pkg('pkg_a_plus', false, 'owner_a'), '{"status": "active", "replayed": false}'::jsonb || jsonb_build_object('templates', tests.templates()), 'the owner restores it');
select is(
  (select array_agg(action order by occurred_at, action) from public.audit_events where entity_type = 'package' and entity_id = tests.id('pkg_a_plus')),
  array['package_archived', 'package_restored'], 'one audit event per change, none for the repeat');
select is((select actor_type || ':' || (metadata ->> 'templates') from public.audit_events where entity_id = tests.id('pkg_a_plus') and action = 'package_archived'),
  'staff:' || tests.templates(), 'audited as staff, with the templates count');

-- Suspended workspace -------------------------------------------------------------
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select throws_like($$ select tests.archive_pkg('pkg_a_plus', true) $$, '%workspace_suspended%', 'a suspended workspace is refused');
select is((select active from public.packages where id = tests.id('pkg_a_plus')), true, 'and nothing changes');

select * from finish();
rollback;
