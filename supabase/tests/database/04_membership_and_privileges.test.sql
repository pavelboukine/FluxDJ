-- Membership escalation, owner-only management and column-level write limits.
begin;
\ir _fixtures.psql
select plan(23);

-- ---------------------------------------------------------------------------
-- Staff (non-owner) cannot manage membership or escalate.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('staff_a'));

select throws_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role) values (tests.id('tenant_a'), tests.id('stranger'), 'staff') $$,
  '42501', null, 'staff cannot add members');
select is_empty(
  $$ update public.tenant_memberships set role = 'owner' where user_id = tests.id('staff_a') returning id $$,
  'staff cannot promote themselves to owner');
select is_empty(
  $$ delete from public.tenant_memberships where user_id = tests.id('owner_a') returning id $$,
  'staff cannot remove the owner');
select throws_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role) values (tests.id('tenant_b'), tests.id('staff_a'), 'staff') $$,
  '42501', null, 'staff cannot join another tenant');
select is_empty(
  $$ update public.tenants set display_name = 'Staff rename' where id = tests.id('tenant_a') returning id $$,
  'staff cannot change tenant settings');

-- ---------------------------------------------------------------------------
-- Owner manages staff of their own tenant only, and never owner rows.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));

select throws_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role) values (tests.id('tenant_a'), tests.id('stranger'), 'owner') $$,
  '42501', null, 'owner cannot create another owner');
select throws_ok(
  $$ update public.tenant_memberships set role = 'owner' where user_id = tests.id('staff_a') $$,
  '42501', null, 'owner cannot promote staff to owner');
select throws_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role) values (tests.id('tenant_b'), tests.id('stranger'), 'staff') $$,
  '42501', null, 'owner A cannot add staff to tenant B');
select is_empty(
  $$ delete from public.tenant_memberships where user_id = tests.id('owner_a') returning id $$,
  'owner cannot delete their own owner row (prevents orphaned tenants)');
select lives_ok(
  $$ insert into public.tenant_memberships (tenant_id, user_id, role) values (tests.id('tenant_a'), tests.id('stranger'), 'staff') $$,
  'owner can add staff to their tenant');
select isnt_empty(
  $$ delete from public.tenant_memberships where user_id = tests.id('staff_a') returning id $$,
  'owner can remove staff');

-- ---------------------------------------------------------------------------
-- Tenant settings: owner edits allowed fields only.
-- ---------------------------------------------------------------------------
select isnt_empty(
  $$ update public.tenants set display_name = 'BOUPROD Live' where id = tests.id('tenant_a') returning id $$,
  'owner can update display name');
select is_empty(
  $$ update public.tenants set display_name = 'Hijacked' where id = tests.id('tenant_b') returning id $$,
  'owner A cannot update tenant B');
select throws_ok(
  $$ update public.tenants set slug = 'stolen-slug' where id = tests.id('tenant_a') $$,
  '42501', null, 'slug changes are not exposed to authenticated users');
select throws_ok(
  $$ insert into public.tenants (slug, business_name, display_name) values ('self-made', 'X', 'X') $$,
  '42501', null, 'authenticated users cannot create tenants directly');

-- ---------------------------------------------------------------------------
-- Lifecycle and access columns are not directly writable by staff.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.events set lifecycle_status = 'booked' where id = tests.id('event_a1') $$,
  '42501', null, 'staff cannot set lifecycle_status directly');
select throws_ok(
  $$ update public.events set booking_confirmed_at = now() where id = tests.id('event_a1') $$,
  '42501', null, 'staff cannot set booking_confirmed_at directly');
select throws_ok(
  $$ insert into public.events (tenant_id, title, event_type, event_date, lifecycle_status) values (tests.id('tenant_a'), 'X', 'party', '2027-01-01', 'booked') $$,
  '42501', null, 'staff cannot create an event in a non-lead state');
select throws_ok(
  $$ insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id('event_a1'), tests.id('a_client_y'), tests.id('stranger')) $$,
  '42501', null, 'staff cannot grant client event access (requires verified email flow)');
select throws_ok(
  $$ delete from public.events where id = tests.id('event_a2') $$,
  '42501', null, 'events cannot be deleted by staff');
select throws_ok(
  $$ delete from public.clients where id = tests.id('a_client_u') $$,
  '42501', null, 'clients cannot be deleted by staff (archive instead)');
select isnt_empty(
  $$ update public.event_access set revoked_at = now() where user_id = tests.id('client_x') and event_id = tests.id('event_a1') returning id $$,
  'staff can revoke client access in their tenant');
select isnt_empty(
  $$ update public.clients set archived_at = now() where id = tests.id('a_client_u') returning id $$,
  'staff can archive a client');

select * from finish();
rollback;
