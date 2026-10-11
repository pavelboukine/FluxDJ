-- Platform administration counts only active memberships: the "your own
-- workspace" suspension guard and the workspace list's membership flag.
begin;
\ir _fixtures.psql
select plan(16);

create function tests.suspend(who uuid, tenant text) returns jsonb language plpgsql as $$
declare r jsonb; v int := (select suspension_version from public.tenants where id = tests.id(tenant));
begin
  perform tests.login_as(who);
  r := public.suspend_workspace(tests.id(tenant), v, 'Test suspension');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.restore(who uuid, tenant text) returns jsonb language plpgsql as $$
declare r jsonb; v int := (select suspension_version from public.tenants where id = tests.id(tenant));
begin
  perform tests.login_as(who);
  r := public.restore_workspace(tests.id(tenant), v, 'Test restore');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.member_flag(who uuid, slug text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform tests.login_as(who);
  select o.is_member into r from public.platform_workspaces_overview() o where o.slug = member_flag.slug;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Administrators: owner_b (active owner of Other DJ), staff_a (active staff of
-- BOUPROD), a former BOUPROD staff member, and one with no business.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f2000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'former@example.test', now(), now(), now()),
  ('f2000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-none@example.test', now(), now(), now());
select set_config('tests.former', 'f2000000-0000-4000-8000-000000000001', true);
select set_config('tests.op', 'f2000000-0000-4000-8000-000000000002', true);
insert into public.tenant_memberships (tenant_id, user_id, role) values (tests.id('tenant_a'), current_setting('tests.former')::uuid, 'staff');
insert into public.platform_admins (user_id, note) values
  (tests.id('owner_b'), 'owner of Other DJ'), (tests.id('staff_a'), 'staff of BOUPROD'),
  (current_setting('tests.former')::uuid, 'former BOUPROD staff'), (current_setting('tests.op')::uuid, 'no business');

-- The former member is removed through the owner's function (soft removal).
select tests.login_as(tests.id('owner_a'));
select is((public.remove_staff_member(tests.id('tenant_a'),
  (select id from public.tenant_memberships where user_id = current_setting('tests.former')::uuid))) ->> 'status', 'removed', 'the owner removes a staff member');
reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- The workspace list's membership flag
-- ===========================================================================
select is(tests.member_flag(tests.id('owner_b'), 'test-other-dj'), true, 'an active owner is a member of their workspace');
select is(tests.member_flag(tests.id('owner_b'), 'test-bouprod'), false, 'and not of another business');
select is(tests.member_flag(tests.id('staff_a'), 'test-bouprod'), true, 'active staff are members');
select is(tests.member_flag(current_setting('tests.former')::uuid, 'test-bouprod'), false, 'a removed staff member is not');
select is(tests.member_flag(current_setting('tests.op')::uuid, 'test-bouprod'), false, 'nor is an administrator with no business');

-- ===========================================================================
-- The self-suspension guard
-- ===========================================================================
select throws_like($$ select tests.suspend(tests.id('owner_b'), 'tenant_b') $$, '%workspace_own%', 'an active owner can''t suspend their own workspace');
select throws_like($$ select tests.suspend(tests.id('staff_a'), 'tenant_a') $$, '%workspace_own%', 'nor can active staff');
select is((select suspended_at from public.tenants where id = tests.id('tenant_a')), null, 'the workspace stays active');
select is((tests.suspend(current_setting('tests.former')::uuid, 'tenant_a')) ->> 'status', 'suspended', 'a removed staff member no longer belongs, so may suspend it');
select is((tests.restore(current_setting('tests.op')::uuid, 'tenant_a')) ->> 'status', 'active', 'restoration is unchanged');
select is((tests.suspend(tests.id('owner_b'), 'tenant_a')) ->> 'status', 'suspended', 'an administrator who owns another business may suspend this one');
select is((tests.restore(tests.id('owner_b'), 'tenant_a')) ->> 'status', 'active', 'and restore it');

-- Existing permissions: only platform administrators.
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.suspend_workspace(tests.id('tenant_b'), 0, 'x') $$, '42501', null, 'a business owner who is not an administrator can''t suspend');
select throws_ok($$ select * from public.platform_workspaces_overview() $$, '42501', null, 'nor list workspaces');
reset role;

-- The former member's row stays for attribution.
select ok((select removed_at is not null and removed_by = tests.id('owner_a') from public.tenant_memberships
           where tenant_id = tests.id('tenant_a') and user_id = current_setting('tests.former')::uuid), 'the removed membership is kept');

select * from finish();
rollback;
