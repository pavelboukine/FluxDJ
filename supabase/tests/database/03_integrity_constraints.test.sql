-- Database-level integrity that holds even when application code is wrong:
-- composite cross-tenant foreign keys, immutability, uniqueness and validation.
begin;
\ir _fixtures.psql
select plan(27);

-- ---------------------------------------------------------------------------
-- Cross-tenant composite foreign keys. Run as a privileged role (RLS bypassed)
-- to prove the schema itself rejects the reference.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.event_clients (tenant_id, event_id, client_id)
     values (tests.id('tenant_a'), tests.id('event_a2'), tests.id('b_client_x')) $$,
  '23503', null, 'cannot attach a tenant B client to a tenant A event');
select throws_ok(
  $$ insert into public.event_clients (tenant_id, event_id, client_id)
     values (tests.id('tenant_b'), tests.id('event_a2'), tests.id('b_client_x')) $$,
  '23503', null, 'cannot label a tenant A event as tenant B to attach a B client');
select throws_ok(
  $$ insert into public.event_access (tenant_id, event_id, client_id, user_id)
     values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('b_client_x'), tests.id('stranger')) $$,
  '23503', null, 'cannot grant event access through another tenant''s client');
select throws_ok(
  $$ insert into public.event_access (tenant_id, event_id, client_id, user_id)
     values (tests.id('tenant_a'), tests.id('event_a2'), tests.id('a_client_x'), tests.id('stranger')) $$,
  '23503', null, 'cannot grant event access to a contact who is not on that event');

-- The same mismatched reference via RLS: tenant_id passes the policy, but the
-- composite key still rejects the foreign client.
select tests.login_as(tests.id('owner_a'));
select throws_ok(
  $$ insert into public.event_clients (tenant_id, event_id, client_id)
     values (tests.id('tenant_a'), tests.id('event_a2'), tests.id('b_client_x')) $$,
  '23503', null, 'owner A cannot reference a tenant B client even under own tenant_id');
reset role;

-- ---------------------------------------------------------------------------
-- Immutable references.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.event_clients set client_id = tests.id('a_client_u') where event_id = tests.id('event_a2') $$,
  '23514', null, 'event_clients.client_id is immutable');
select throws_ok(
  $$ update public.event_access set user_id = tests.id('stranger') where user_id = tests.id('client_x') $$,
  '23514', null, 'event_access.user_id is immutable');
select throws_ok(
  $$ update public.tenant_memberships set user_id = tests.id('stranger') where user_id = tests.id('staff_a') $$,
  '23514', null, 'tenant_memberships.user_id is immutable');

-- ---------------------------------------------------------------------------
-- Event contact rules.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.event_clients set is_primary = true
     where event_id = tests.id('event_a1') and client_id = tests.id('a_client_y') $$,
  '23505', null, 'at most one primary contact per event');
select throws_ok(
  $$ update public.event_clients set can_sign = true
     where event_id = tests.id('event_a1') and client_id = tests.id('a_client_y') $$,
  '23505', null, 'V1 allows one signer per event');
select throws_ok(
  $$ insert into public.event_clients (tenant_id, event_id, client_id)
     values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('a_client_x')) $$,
  '23505', null, 'a contact appears on an event at most once');

-- ---------------------------------------------------------------------------
-- Event access lifecycle.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.event_access (tenant_id, event_id, client_id, user_id)
     values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('a_client_x'), tests.id('client_x')) $$,
  '23505', null, 'one active access row per user and event');
select throws_ok(
  $$ update public.event_access set revoked_at = null
     where user_id = tests.id('client_y') and event_id = tests.id('event_a1') $$,
  '23514', null, 'revocation cannot be undone');
update public.event_access set revoked_at = '2000-01-01'
  where user_id = tests.id('client_x') and event_id = tests.id('event_a1');
select ok(
  (select revoked_at > now() - interval '1 minute' from public.event_access
   where user_id = tests.id('client_x') and event_id = tests.id('event_a1')),
  'revoked_at is stamped by the database, not backdated by the caller');
select lives_ok(
  $$ insert into public.event_access (tenant_id, event_id, client_id, user_id)
     values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('a_client_x'), tests.id('client_x')) $$,
  're-granting after revocation creates a new row and keeps history');

-- ---------------------------------------------------------------------------
-- Memberships.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role)
     values (tests.id('tenant_a'), tests.id('stranger'), 'owner') $$,
  '23505', null, 'V1 allows one owner per tenant');
select throws_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role)
     values (tests.id('tenant_a'), tests.id('stranger'), 'admin') $$,
  '23514', null, 'membership role must be owner or staff');

-- ---------------------------------------------------------------------------
-- Value validation.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.tenants (slug, business_name, display_name) values ('api', 'X', 'X') $$,
  '23514', null, 'tenant slug cannot shadow an application route');
select throws_ok(
  $$ insert into public.tenants (slug, business_name, display_name) values ('Bad_Slug', 'X', 'X') $$,
  '23514', null, 'tenant slug must be lowercase URL-safe');
select throws_ok(
  $$ update public.tenants set tax_config = '[{"code":"GST","label":"GST","rate_ppm":0.05}]' where id = tests.id('tenant_b') $$,
  '23514', null, 'tax rates must be integer parts per million');
select throws_ok(
  $$ update public.tenants set tax_config = '[{"code":"GST","label":"GST","rate_ppm":50000},{"code":"GST","label":"Dup","rate_ppm":1}]' where id = tests.id('tenant_b') $$,
  '23514', null, 'tax codes must be unique');
select throws_ok(
  $$ update public.tenants set brand_colors = '{"primary":"red"}' where id = tests.id('tenant_b') $$,
  '23514', null, 'brand colors must be #RRGGBB');
select throws_ok(
  $$ update public.tenants set booking_confirmation_policy = 'on_view' where id = tests.id('tenant_b') $$,
  '23514', null, 'booking policy must be on_signature or on_deposit');
select throws_ok(
  $$ update public.events set timezone = 'Mars/Olympus_Mons' where id = tests.id('event_b1') $$,
  '23514', null, 'event timezone must be a valid IANA name');
select throws_ok(
  $$ insert into public.clients (tenant_id, name, email) values (tests.id('tenant_b'), 'Bad', 'Not-Normalized@Example.test') $$,
  '23514', null, 'client email must be normalized lowercase');
select throws_ok(
  $$ update public.events set lifecycle_status = 'booked' where id = tests.id('event_b1') $$,
  '23514', null, 'an event cannot be booked without a booking confirmation time');
select throws_ok(
  $$ delete from public.clients where id = tests.id('a_client_x') $$,
  '23503', null, 'clients referenced by events cannot be deleted (archive instead)');

select * from finish();
rollback;
