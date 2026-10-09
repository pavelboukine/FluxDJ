-- A verified client sees only their linked events, through a safe projection,
-- and cannot alter staff data (spec 7 and 11).
begin;
\ir _fixtures.psql
select plan(23);

-- ---------------------------------------------------------------------------
-- my_events(): event-scoped, verified, unrevoked access only.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('client_x'));
select results_eq(
  $$ select event_id from public.my_events() order by event_id $$,
  array[tests.id('event_a1'), tests.id('event_b1')],
  'client with two DJs sees exactly their event at each DJ');
select results_eq(
  $$ select tenant_slug from public.my_events() order by event_id $$,
  array['test-bouprod', 'test-other-dj'],
  'each event carries its own DJ branding');

select tests.login_as(tests.id('client_y'));
select results_eq(
  $$ select event_id from public.my_events() $$,
  array[tests.id('event_a2')],
  'revoked access is excluded; active access is included');

select tests.login_as(tests.id('client_u'));
select is_empty($$ select * from public.my_events() $$,
  'unverified email grants no event access even with an access row');

select tests.login_as(tests.id('stranger'));
select is_empty($$ select * from public.my_events() $$,
  'email match alone (no access row) grants nothing');

select tests.login_as(tests.id('owner_a'));
select is_empty($$ select * from public.my_events() $$,
  'staff membership does not appear as client event access');

-- Revocation takes effect immediately.
reset role;
update public.event_access set revoked_at = now()
  where user_id = tests.id('client_x') and event_id = tests.id('event_a1');
select tests.login_as(tests.id('client_x'));
select results_eq(
  $$ select event_id from public.my_events() $$,
  array[tests.id('event_b1')],
  'revoking access at one DJ leaves the other DJ''s event intact');

-- Archived tenants are hidden from clients.
reset role;
update public.tenants set archived_at = now() where id = tests.id('tenant_b');
select tests.login_as(tests.id('client_x'));
select is_empty($$ select * from public.my_events() $$,
  'events of an archived tenant are hidden');
reset role;
update public.tenants set archived_at = null where id = tests.id('tenant_b');

-- Archived events are hidden too, like every other client view.
update public.events set archived_at = now() where id = tests.id('event_b1');
select tests.login_as(tests.id('client_x'));
select is_empty($$ select * from public.my_events() $$,
  'an archived event is hidden (its business is active)');
reset role;
update public.events set archived_at = null where id = tests.id('event_b1');

-- ---------------------------------------------------------------------------
-- Clients get no direct table rows, so staff columns never leak.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('client_y'));
select is_empty($$ select * from public.events $$,             'client reads no rows from events (internal_notes stays private)');
select is_empty($$ select * from public.clients $$,            'client cannot list contacts');
select is_empty($$ select * from public.event_clients $$,      'client cannot list other contacts on the event');
select is_empty($$ select * from public.event_access $$,       'client cannot read access records');
select is_empty($$ select * from public.tenants $$,            'client cannot read tenant settings');
select is_empty($$ select * from public.tenant_memberships $$, 'client cannot read memberships');

-- ---------------------------------------------------------------------------
-- Clients cannot alter price/status, membership, access or internal fields.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.events set lifecycle_status = 'booked' where id = tests.id('event_a2') $$,
  '42501', null, 'client cannot change event status');
select is_empty(
  $$ update public.events set internal_notes = 'client wrote this' where id = tests.id('event_a2') returning id $$,
  'client cannot write internal notes on their own event');
select is_empty(
  $$ update public.events set event_date = '2030-01-01' where id = tests.id('event_a2') returning id $$,
  'client cannot change event details directly');
select throws_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role) values (tests.id('tenant_a'), tests.id('client_y'), 'staff') $$,
  '42501', null, 'client cannot make themselves staff');
select throws_ok(
  $$ insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('a_client_y'), tests.id('client_y')) $$,
  '42501', null, 'client cannot restore their revoked access');
select is_empty(
  $$ update public.event_access set revoked_at = now() where user_id = tests.id('client_x') returning id $$,
  'client cannot revoke another client''s access');
select throws_ok(
  $$ insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('a_client_y'), false, true) $$,
  '42501', null, 'client cannot add themselves as a signer');

-- ---------------------------------------------------------------------------
-- The client projection is a security definer function.
-- ---------------------------------------------------------------------------
reset role;
select ok(
  (select prosecdef from pg_proc where oid = 'public.my_events()'::regprocedure),
  'my_events is a security definer projection (no direct events grant needed)');

select * from finish();
rollback;
