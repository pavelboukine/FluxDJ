-- Tenant A staff cannot read, modify or reference Tenant B rows (spec 11).
-- Covers SELECT, INSERT, UPDATE and DELETE through real RLS as `authenticated`.
begin;
\ir _fixtures.psql
select plan(36);

-- ---------------------------------------------------------------------------
-- SELECT: each staff user sees exactly their own tenant's rows.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));

select results_eq($$ select id from public.tenants $$,
  array[tests.id('tenant_a')], 'owner A sees only tenant A');
select results_eq($$ select count(*)::int from public.tenant_memberships where tenant_id <> tests.id('tenant_a') $$,
  array[0], 'owner A sees no tenant B memberships');
select results_eq($$ select id from public.clients order by id $$,
  array[tests.id('a_client_x'), tests.id('a_client_y'), tests.id('a_client_u')], 'owner A sees only tenant A clients');
select results_eq($$ select id from public.events order by id $$,
  array[tests.id('event_a1'), tests.id('event_a2')], 'owner A sees only tenant A events');
select results_eq($$ select count(*)::int from public.event_clients where tenant_id <> tests.id('tenant_a') $$,
  array[0], 'owner A sees no tenant B event contacts');
select results_eq($$ select count(*)::int from public.event_access where tenant_id <> tests.id('tenant_a') $$,
  array[0], 'owner A sees no tenant B event access');
select is_empty($$ select internal_notes from public.events where id = tests.id('event_b1') $$,
  'owner A cannot read tenant B internal notes by id');
select is_empty($$ select * from public.clients where email = 'client-x@example.test' and tenant_id = tests.id('tenant_b') $$,
  'owner A cannot find tenant B contacts by email');

select tests.login_as(tests.id('staff_a'));
select results_eq($$ select id from public.events order by id $$,
  array[tests.id('event_a1'), tests.id('event_a2')], 'staff A sees tenant A events');
select is_empty($$ select * from public.clients where tenant_id = tests.id('tenant_b') $$,
  'staff A sees no tenant B clients');

select tests.login_as(tests.id('owner_b'));
select results_eq($$ select id from public.events $$,
  array[tests.id('event_b1')], 'owner B sees only tenant B events');
select results_eq($$ select id from public.tenants $$,
  array[tests.id('tenant_b')], 'owner B sees only tenant B');

select tests.login_as(tests.id('stranger'));
select is_empty($$ select * from public.tenants $$,            'user without membership sees no tenants');
select is_empty($$ select * from public.tenant_memberships $$, 'user without membership sees no memberships');
select is_empty($$ select * from public.clients $$,            'user without membership sees no clients');
select is_empty($$ select * from public.events $$,             'user without membership sees no events');
select is_empty($$ select * from public.event_clients $$,      'user without membership sees no event contacts');
select is_empty($$ select * from public.event_access $$,       'user without membership sees no event access');

-- ---------------------------------------------------------------------------
-- INSERT into another tenant is rejected by RLS WITH CHECK.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));

select throws_ok(
  $$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_b'), 'Planted', 'planted@example.test') $$,
  '42501', null, 'owner A cannot insert a client into tenant B');
select throws_ok(
  $$ insert into public.events (tenant_id, title, event_type, event_date) values (tests.id('tenant_b'), 'Planted', 'party', '2027-01-01') $$,
  '42501', null, 'owner A cannot insert an event into tenant B');
select throws_ok(
  $$ insert into public.event_clients (tenant_id, event_id, client_id) values (tests.id('tenant_b'), tests.id('event_b1'), tests.id('b_client_x')) $$,
  '42501', null, 'owner A cannot insert event contacts into tenant B');
select lives_ok(
  $$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_a'), 'New Lead', 'lead@example.test') $$,
  'owner A can insert a client into tenant A');

-- ---------------------------------------------------------------------------
-- UPDATE / DELETE on another tenant's rows affect nothing.
-- ---------------------------------------------------------------------------
select is_empty(
  $$ update public.clients set name = 'Hijacked' where id = tests.id('b_client_x') returning id $$,
  'owner A update of a tenant B client affects no rows');
select is_empty(
  $$ update public.events set internal_notes = 'Hijacked' where id = tests.id('event_b1') returning id $$,
  'owner A update of a tenant B event affects no rows');
select is_empty(
  $$ delete from public.event_clients where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A delete of tenant B event contacts affects no rows');
select is_empty(
  $$ update public.event_access set revoked_at = now() where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot revoke tenant B event access');
select is_empty(
  $$ delete from public.tenant_memberships where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot delete tenant B memberships');

-- ---------------------------------------------------------------------------
-- Changing tenant_id: not granted to authenticated, and blocked by trigger
-- for every role (including service code with RLS bypass).
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.clients set tenant_id = tests.id('tenant_b') where id = tests.id('a_client_x') $$,
  '42501', null, 'owner A cannot change a client''s tenant_id');
select throws_ok(
  $$ update public.events set tenant_id = tests.id('tenant_b') where id = tests.id('event_a1') $$,
  '42501', null, 'owner A cannot change an event''s tenant_id');

reset role;
select throws_ok(
  $$ update public.clients set tenant_id = tests.id('tenant_b') where id = tests.id('a_client_x') $$,
  '23514', null, 'privileged code cannot move a client to another tenant');
select throws_ok(
  $$ update public.events set tenant_id = tests.id('tenant_b') where id = tests.id('event_a1') $$,
  '23514', null, 'privileged code cannot move an event to another tenant');
select throws_ok(
  $$ update public.event_access set tenant_id = tests.id('tenant_b') where event_id = tests.id('event_a1') $$,
  '23514', null, 'privileged code cannot move event access to another tenant');
select throws_ok(
  $$ update public.tenant_memberships set tenant_id = tests.id('tenant_b') where user_id = tests.id('staff_a') $$,
  '23514', null, 'privileged code cannot move a membership to another tenant');

-- Verify tenant B data is untouched after all attempts above.
select results_eq($$ select name from public.clients where id = tests.id('b_client_x') $$,
  array['Client X (B)'], 'tenant B client unchanged');
select results_eq($$ select internal_notes from public.events where id = tests.id('event_b1') $$,
  array['B1 secret staff note'], 'tenant B event unchanged');
select results_eq($$ select count(*)::int from public.event_clients where tenant_id = tests.id('tenant_b') $$,
  array[1], 'tenant B event contacts still present');

select * from finish();
rollback;
