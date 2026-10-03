-- Structural guarantees that protect every future table, not only today's.
begin;
\ir _fixtures.psql
select plan(35);

-- RLS is on for every table in the exposed schema.
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity $$,
  'every public table has row-level security enabled'
);

-- anon has no table or column privileges at all.
select is_empty(
  $$ select table_name, privilege_type from information_schema.role_table_grants
     where grantee = 'anon' and table_schema = 'public' $$,
  'anon has no table privileges in public'
);
select is_empty(
  $$ select table_name, column_name from information_schema.role_column_grants
     where grantee = 'anon' and table_schema = 'public' $$,
  'anon has no column privileges in public'
);
select is_empty(
  $$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute') $$,
  'anon cannot execute any public or private function'
);

-- authenticated has only the table-level privileges intended. Writes beyond
-- these are column-scoped grants (checked in behavior tests).
select table_privs_are('public', 'tenants',            'authenticated', array['SELECT'], 'tenants: no table-wide write/delete for authenticated');
select table_privs_are('public', 'tenant_memberships', 'authenticated', array['SELECT', 'DELETE'], 'memberships: select + delete only at table level');
select table_privs_are('public', 'clients',            'authenticated', array['SELECT'], 'clients: no delete, no table-wide write');
select table_privs_are('public', 'events',             'authenticated', array['SELECT'], 'events: no delete, no table-wide write');
select table_privs_are('public', 'event_clients',      'authenticated', array['SELECT', 'DELETE'], 'event_clients: select + delete at table level');
select table_privs_are('public', 'event_access',       'authenticated', array['SELECT'], 'event_access: no insert or delete for authenticated');

-- Catalog records are archived, never deleted; composition rows may be removed.
select table_privs_are('public', t, 'authenticated', array['SELECT'], t || ': archive only, no delete')
from unnest(array['gear_items', 'gear_media', 'packages', 'logistics_questions',
                  'logistics_rules', 'proposal_templates']) t;
select table_privs_are('public', t, 'authenticated', array['SELECT', 'DELETE'], t || ': composition rows can be removed')
from unnest(array['package_items', 'proposal_template_packages', 'proposal_template_addons',
                  'proposal_template_questions']) t;

-- Proposals and selections are written only through security definer functions.
select table_privs_are('public', t, 'authenticated', array['SELECT'], t || ': read-only for authenticated')
from unnest(array['proposals', 'proposal_selections', 'proposal_selection_lines', 'proposal_selection_drafts']) t;

-- Any function a CHECK constraint calls must be executable by the roles that
-- write rows, or legitimate writes fail with "permission denied".
select is_empty(
  $$ select distinct p.oid::regprocedure::text
     from pg_constraint c
     join pg_depend d on d.classid = 'pg_constraint'::regclass and d.objid = c.oid
                     and d.refclassid = 'pg_proc'::regclass
     join pg_proc p on p.oid = d.refobjid
     join pg_namespace n on n.oid = c.connamespace
     where c.contype = 'c' and n.nspname = 'public'
       and not (has_function_privilege('authenticated', p.oid, 'execute')
                and has_function_privilege('service_role', p.oid, 'execute')) $$,
  'functions used by CHECK constraints are executable by authenticated and service_role'
);

-- Every tenant-owned table has a non-null tenant_id.
select col_not_null('public', 'tenant_memberships', 'tenant_id', 'tenant_memberships.tenant_id not null');
select col_not_null('public', 'clients',            'tenant_id', 'clients.tenant_id not null');
select col_not_null('public', 'events',             'tenant_id', 'events.tenant_id not null');
select col_not_null('public', 'event_clients',      'tenant_id', 'event_clients.tenant_id not null');
select col_not_null('public', 'event_access',       'tenant_id', 'event_access.tenant_id not null');
select is_empty(
  $$ select c.table_name from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.table_name <> 'tenants'
       and not exists (select 1 from information_schema.columns c2
                       where c2.table_schema = 'public' and c2.table_name = c.table_name
                         and c2.column_name = 'tenant_id' and c2.is_nullable = 'NO')
     group by c.table_name $$,
  'every public table except tenants has a non-null tenant_id'
);

-- Security definer functions are hardened with a fixed search_path.
select is_empty(
  $$ select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') $$,
  'every security definer function sets search_path'
);

-- No views in public (views bypass RLS unless created with security_invoker).
select is_empty(
  $$ select viewname from pg_views where schemaname = 'public' $$,
  'no RLS-bypassing views in public'
);

-- The client projection never exposes staff-only columns.
select unalike(
  pg_get_function_result('public.my_events()'::regprocedure),
  '%internal_notes%',
  'my_events() does not return internal_notes'
);
select unalike(
  pg_get_function_result('public.my_events()'::regprocedure),
  '%planning_override%',
  'my_events() does not return planning overrides'
);

select * from finish();
rollback;
