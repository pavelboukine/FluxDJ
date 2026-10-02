-- Anonymous users have no direct database access (spec 7 and 11). Public
-- proposal links will go through a server route and scoped session, never
-- through anon table access.
begin;
\ir _fixtures.psql
select plan(12);

select tests.login_as_anon();

select throws_ok($$ select * from public.tenants $$,            '42501', null, 'anon cannot read tenants');
select throws_ok($$ select * from public.tenant_memberships $$, '42501', null, 'anon cannot read memberships');
select throws_ok($$ select * from public.clients $$,            '42501', null, 'anon cannot read clients');
select throws_ok($$ select * from public.events $$,             '42501', null, 'anon cannot read events');
select throws_ok($$ select * from public.event_clients $$,      '42501', null, 'anon cannot read event contacts');
select throws_ok($$ select * from public.event_access $$,       '42501', null, 'anon cannot read event access');
select throws_ok($$ select * from public.my_events() $$,        '42501', null, 'anon cannot call my_events');
select throws_ok($$ select private.member_tenant_ids() $$,      '42501', null, 'anon cannot call private helpers');

select throws_ok(
  $$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_a'), 'Anon', 'anon@example.test') $$,
  '42501', null, 'anon cannot insert clients');
select throws_ok(
  $$ insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('a_client_y'), tests.id('stranger')) $$,
  '42501', null, 'anon cannot grant event access');
select throws_ok(
  $$ update public.events set title = 'x' $$,
  '42501', null, 'anon cannot update events');
select throws_ok(
  $$ delete from public.event_clients $$,
  '42501', null, 'anon cannot delete event contacts');

select * from finish();
rollback;
