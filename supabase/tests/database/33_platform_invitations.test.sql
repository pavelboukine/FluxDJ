-- Invite-only DJ onboarding: platform administrators, invitations, verified
-- acceptance and workspace creation.
begin;
\ir _fixtures.psql
select plan(97);

-- Raw invitation token in tests: 'platform-' || link id (the app uses an HMAC).
create function tests.p_hash(link uuid) returns text language sql immutable as $$
  select encode(sha256(convert_to('platform-' || link, 'UTF8')), 'hex') $$;
create function tests.invite(email text) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  perform set_config('tests.last_link', v_link::text, true);
  return public.create_platform_invitation(email, v_link, tests.p_hash(v_link));
end $$;
create function tests.resend(invitation uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  perform set_config('tests.last_link', v_link::text, true);
  return public.resend_platform_invitation(invitation, v_link, tests.p_hash(v_link));
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- A platform administrator (no tenant role anywhere), one who is not
-- verified, and a brand-new DJ.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'operator@example.test', now(), now(), now()),
  ('f0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unverified-op@example.test', null, now(), now()),
  ('f0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'new-dj@example.test', now(), now(), now());
select set_config('tests.op', 'f0000000-0000-4000-8000-000000000001', true);
select set_config('tests.op_unverified', 'f0000000-0000-4000-8000-000000000002', true);
select set_config('tests.new_dj', 'f0000000-0000-4000-8000-000000000003', true);

-- ===========================================================================
-- Granting platform administration
-- ===========================================================================
select ok(not has_function_privilege('authenticated', 'private.grant_platform_admin(text,text)', 'execute')
          and not has_function_privilege('service_role', 'private.grant_platform_admin(text,text)', 'execute')
          and not has_function_privilege('service_role', 'private.revoke_platform_admin(text)', 'execute'),
  'only the database owner can grant or revoke platform administration');
select throws_ok($$ select private.grant_platform_admin('nobody@example.test', 'x') $$, 'P0002', null, 'an unknown email cannot be granted');
select throws_ok($$ select private.grant_platform_admin('unverified-op@example.test', 'x') $$, 'P0002', null, 'an unverified identity cannot be granted');
select is(private.grant_platform_admin(' Operator@Example.test ', 'Test operator'), current_setting('tests.op')::uuid, 'grant by email, normalized');
select is(private.grant_platform_admin('operator@example.test', 'again'), current_setting('tests.op')::uuid, 'granting again is a no-op');
select is((select count(*)::int from public.platform_audit_events where entity_id = current_setting('tests.op')::uuid and action = 'granted'), 1, 'the grant is audited once');
-- The unverified operator is granted directly, to prove verification is also required at use.
insert into public.platform_admins (user_id, note) values (current_setting('tests.op_unverified')::uuid, 'unverified');

select table_privs_are('public', t, 'authenticated', array[]::text[], t || ': no direct access for authenticated')
from unnest(array['platform_admins', 'platform_invitations', 'platform_audit_events']) t;
select table_privs_are('public', 'platform_admins', 'service_role', array[]::text[], 'platform_admins: not even the service role can grant');

-- ===========================================================================
-- Who can issue invitations
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is(public.current_user_is_platform_admin(), false, 'a tenant owner is not a platform administrator');
select throws_ok($$ select tests.invite('x1@example.test') $$, '42501', null, 'a tenant owner cannot invite');
select throws_ok($$ select public.platform_invitations_overview() $$, '42501', null, 'a tenant owner cannot list invitations');
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select tests.invite('x1@example.test') $$, '42501', null, 'staff cannot invite');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select tests.invite('x1@example.test') $$, '42501', null, 'a client cannot invite');
select tests.login_as(tests.id('stranger'));
select throws_ok($$ select tests.invite('x1@example.test') $$, '42501', null, 'a stranger cannot invite');
select tests.login_as(current_setting('tests.op_unverified')::uuid);
select throws_ok($$ select tests.invite('x1@example.test') $$, '42501', null, 'an unverified administrator cannot invite');
select tests.login_as_anon();
select throws_ok($$ select public.create_platform_invitation('x1@example.test', gen_random_uuid(), repeat('a', 64)) $$, '42501', null, 'anon cannot invite');
select throws_ok($$ select public.platform_invitations_overview() $$, '42501', null, 'anon cannot list');
reset role;

-- ===========================================================================
-- Creating invitations
-- ===========================================================================
select tests.login_as(current_setting('tests.op')::uuid);
select is(public.current_user_is_platform_admin(), true, 'the granted operator is a platform administrator');
select throws_like($$ select tests.invite('not an email') $$, '%invitation_invalid%', 'an invalid email is refused');
select set_config('tests.r_new', tests.invite(' New-DJ@Example.TEST ')::text, true);
select set_config('tests.link_new1', current_setting('tests.last_link'), true);
select set_config('tests.i_new', current_setting('tests.r_new')::jsonb ->> 'invitation_id', true);
select is(current_setting('tests.r_new')::jsonb ->> 'status', 'created', 'the operator invites a new DJ');
select is(current_setting('tests.r_new')::jsonb ->> 'email', 'new-dj@example.test', 'the email is normalized');
select ok((current_setting('tests.r_new')::jsonb ->> 'expires_at')::timestamptz between now() + interval '13 days' and now() + interval '15 days',
  'invitations expire after 14 days');
select results_eq(
  $$ select r ->> 'status', r ->> 'state', r ->> 'invitation_id' from (select tests.invite('NEW-dj@example.test') r) x $$,
  $$ values ('exists'::text, 'pending'::text, current_setting('tests.i_new')) $$,
  'a second invitation to the same address returns the open one');
select set_config('tests.i_client', tests.invite('client-x@example.test') ->> 'invitation_id', true);
select set_config('tests.i_staff', tests.invite('staff-a@example.test') ->> 'invitation_id', true);
select set_config('tests.i_unverified', tests.invite('client-u@example.test') ->> 'invitation_id', true);
select set_config('tests.i_revoke', tests.invite('revoke-me@example.test') ->> 'invitation_id', true);
select set_config('tests.link_revoke', current_setting('tests.last_link'), true);
select set_config('tests.i_expire', tests.invite('expire-me@example.test') ->> 'invitation_id', true);
select set_config('tests.link_expire', current_setting('tests.last_link'), true);
select is((select count(*)::int from public.platform_invitations_overview() where created_at = now()), 6, 'the operator sees every invitation');
select is((select count(*)::int from public.tenants), 0, 'platform administration gives no access to any business');
select is((select count(*)::int from public.clients) + (select count(*)::int from public.events) + (select count(*)::int from public.email_outbox), 0,
  'nor to any client, event or tenant email');
reset role;

select results_eq(
  $$ select count(*)::int, bool_and(tenant_id is null), bool_and(recipient_email = 'new-dj@example.test'),
            bool_and(payload = jsonb_build_object('link_id', current_setting('tests.link_new1'), 'expires_at', payload ->> 'expires_at')),
            bool_and(dedup_key = 'platform_invitation:' || current_setting('tests.link_new1'))
     from public.email_outbox where entity_id = current_setting('tests.i_new')::uuid $$,
  $$ values (1, true, true, true, true) $$,
  'one invitation email is queued with no tenant, the normalized address and only the link id');
select is((select token_hash from public.platform_invitations where id = current_setting('tests.i_new')::uuid),
  tests.p_hash(current_setting('tests.link_new1')::uuid), 'only the token hash is stored');
select is((select count(*)::int from public.platform_audit_events where entity_type = 'platform_invitation' and action = 'created' and occurred_at = now()), 6,
  'every invitation is audited');
select throws_ok($$ insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, dedup_key)
                    values (null, 'proposal_sent', 'a@example.test', 'proposal', gen_random_uuid(), 'x-no-tenant') $$,
  '23514', null, 'only platform emails may have no tenant');
select throws_ok($$ insert into public.platform_invitations (email, link_id, token_hash, expires_at)
                    values ('new-dj@example.test', gen_random_uuid(), repeat('b', 64), now() + interval '1 day') $$,
  '23505', null, 'the database refuses a second open invitation for an address');

-- ===========================================================================
-- Delivery claims
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select * from public.claim_platform_email_outbox() $$, '42501', null, 'staff cannot claim platform emails');
select tests.login_as_service();
select is((select count(*)::int from public.claim_email_outbox(100, 120, null, true) c where c.tenant_id is null), 0,
  'the tenant worker never claims platform emails');
select results_eq(
  $$ select count(*)::int, bool_and(deliverable), bool_and(token_hash = tests.p_hash(link_id))
     from public.claim_platform_email_outbox(100, 120, current_setting('tests.i_new')::uuid) $$,
  $$ values (1, true, true) $$,
  'the platform worker claims the invitation email, deliverable, with the current link');
reset role;

-- ===========================================================================
-- Resend
-- ===========================================================================
select tests.login_as(current_setting('tests.op')::uuid);
select throws_like($$ select tests.resend(current_setting('tests.i_new')::uuid) $$, '%invitation_resend_too_soon%', 'a resend right after sending is refused');
reset role;
update public.platform_invitations set last_sent_at = now() - interval '5 minutes' where id = current_setting('tests.i_new')::uuid;
update public.email_outbox set status = 'pending', locked_until = null where entity_id = current_setting('tests.i_new')::uuid;
select tests.login_as(current_setting('tests.op')::uuid);
select is(tests.resend(current_setting('tests.i_new')::uuid) ->> 'status', 'sent', 'the operator resends');
select set_config('tests.link_new2', current_setting('tests.last_link'), true);
reset role;
select results_eq(
  $$ select link_id::text, send_count from public.platform_invitations where id = current_setting('tests.i_new')::uuid $$,
  $$ values (current_setting('tests.link_new2'), 2) $$, 'the resend rotates the link');
select results_eq(
  $$ select payload ->> 'link_id', status from public.email_outbox where entity_id = current_setting('tests.i_new')::uuid order by created_at, status $$,
  $$ values (current_setting('tests.link_new1'), 'cancelled'::text), (current_setting('tests.link_new2'), 'pending'::text) $$,
  'the queued email for the previous link is cancelled and a new one queued');
select is((select count(*)::int from public.platform_audit_events where entity_id = current_setting('tests.i_new')::uuid and action = 'resent'), 1, 'the resend is audited');

-- ===========================================================================
-- Verification request (service role, with the token)
-- ===========================================================================
select tests.login_as(tests.id('stranger'));
select throws_ok($$ select public.request_platform_sign_in(repeat('a', 64)) $$, '42501', null, 'only the server can request a verification email');
select tests.login_as_service();
select is(public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_new1')::uuid)) ->> 'status', 'invalid', 'the previous link no longer works');
select is(public.request_platform_sign_in('not-a-hash') ->> 'status', 'invalid', 'a malformed token is invalid');
select results_eq(
  $$ select r ->> 'status', r ->> 'masked_email' from (select public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_new2')::uuid)) r) x $$,
  $$ values ('ok'::text, 'n•••@example.test'::text) $$, 'the current link asks for a verification email to the masked invited address');
select public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_new2')::uuid));
select public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_new2')::uuid));
select is(public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_new2')::uuid)) ->> 'status', 'rate_limited',
  'at most three verification emails per invitation per 15 minutes');
reset role;
select results_eq(
  $$ select count(*)::int, bool_and(recipient_email = 'new-dj@example.test'), bool_and(payload = jsonb_build_object('link_id', current_setting('tests.link_new2')))
     from public.email_outbox where entity_id = current_setting('tests.i_new')::uuid and event_type = 'platform_sign_in' $$,
  $$ values (3, true, true) $$, 'verification emails go only to the invited address and carry no token');

-- ===========================================================================
-- Status and acceptance
-- ===========================================================================
select tests.login_as(tests.id('stranger'));
select results_eq(
  $$ select s ->> 'state', s ->> 'intended_email', s ? 'email' from (select public.platform_invitation_status(current_setting('tests.i_new')::uuid) s) x $$,
  $$ values ('wrong_account'::text, 'n•••@example.test'::text, false) $$, 'a wrong account sees only the masked address');
select is(public.accept_platform_invitation(current_setting('tests.i_new')::uuid, 'Stolen DJ', 'stolen-dj') ->> 'state', 'wrong_account',
  'a wrong account cannot accept');
select is(public.platform_invitation_status(gen_random_uuid()) ->> 'state', 'invalid', 'an unknown invitation is invalid');
select tests.login_as(tests.id('client_u'));
select is(public.platform_invitation_status(current_setting('tests.i_unverified')::uuid) ->> 'state', 'unverified', 'an unverified identity must verify first');
select is(public.accept_platform_invitation(current_setting('tests.i_unverified')::uuid, 'Unverified DJ', 'unverified-dj') ->> 'state', 'unverified',
  'and cannot accept');

select tests.login_as(current_setting('tests.new_dj')::uuid);
select is(public.platform_invitation_status(current_setting('tests.i_new')::uuid) ->> 'state', 'ready', 'the verified invited DJ is ready');
select is(public.accept_platform_invitation(current_setting('tests.i_new')::uuid, ' ', 'maxwell-dj') ->> 'state', 'name_invalid', 'a name is required');
select is(public.accept_platform_invitation(current_setting('tests.i_new')::uuid, 'DJ' || chr(7) || 'Maxwell', 'maxwell-dj') ->> 'state', 'name_invalid',
  'control characters are refused');
select results_eq(
  $$ select s, public.accept_platform_invitation(current_setting('tests.i_new')::uuid, 'DJ Maxwell', s) ->> 'state'
     from unnest(array['join', 'platform', 'start', 'staff', 'login', 'my', 'a', '-maxwell', 'max--well', 'Max Well', repeat('m', 49)]) s $$,
  $$ select s, 'slug_invalid'::text
     from unnest(array['join', 'platform', 'start', 'staff', 'login', 'my', 'a', '-maxwell', 'max--well', 'Max Well', repeat('m', 49)]) s $$,
  'reserved application paths and malformed addresses are refused');
select is(public.accept_platform_invitation(current_setting('tests.i_new')::uuid, 'DJ Maxwell', 'test-bouprod') ->> 'state', 'slug_taken',
  'an existing business''s address cannot be claimed');
reset role;
select results_eq(
  $$ select t.display_name, t.business_name, (select count(*)::int from public.tenant_memberships m where m.tenant_id = t.id),
            (select accepted_at is null from public.platform_invitations where id = current_setting('tests.i_new')::uuid)
     from public.tenants t where t.slug = 'test-bouprod' $$,
  $$ values ('BOUPROD'::text, 'BOUPROD Test Inc.'::text, 2, true) $$,
  'the existing business is untouched and the invitation still open');

select tests.login_as(current_setting('tests.new_dj')::uuid);
select set_config('tests.created', public.accept_platform_invitation(current_setting('tests.i_new')::uuid, '  DJ   Maxwell ', ' Maxwell-DJ ')::text, true);
select results_eq(
  $$ select r ->> 'state', r ->> 'slug', r ->> 'replayed' from (select current_setting('tests.created')::jsonb r) x $$,
  $$ values ('created'::text, 'maxwell-dj'::text, 'false'::text) $$, 'the verified DJ creates their workspace');
select results_eq(
  $$ select r ->> 'state', r ->> 'slug', r ->> 'replayed'
     from (select public.accept_platform_invitation(current_setting('tests.i_new')::uuid, 'Another name', 'another-slug') r) x $$,
  $$ values ('created'::text, 'maxwell-dj'::text, 'true'::text) $$, 'a repeated submission returns the same workspace');
select is(public.platform_invitation_status(current_setting('tests.i_new')::uuid) ->> 'slug', 'maxwell-dj', 'the status links the creator to the workspace');
select results_eq(
  $$ select t.slug, t.display_name, m.role from public.tenants t join public.tenant_memberships m on m.tenant_id = t.id $$,
  $$ values ('maxwell-dj'::text, 'DJ Maxwell'::text, 'owner'::text) $$,
  'the DJ owns exactly the new business and sees no other');
select is((select count(*)::int from public.clients) + (select count(*)::int from public.events) + (select count(*)::int from public.gear_items)
          + (select count(*)::int from public.packages) + (select count(*)::int from public.proposal_templates)
          + (select count(*)::int from public.planning_templates) + (select count(*)::int from public.contract_templates), 0,
  'the workspace is empty: no clients, events, gear, packages or templates');
reset role;

select results_eq(
  $$ select t.business_name, t.business_address is null and t.contact_email is null and t.reply_to_email is null, t.timezone, t.currency,
            t.deposit_percent, t.booking_confirmation_policy, t.planning_lock_days, t.tax_config, t.tax_categories, t.archived_at is null
     from public.tenants t where t.slug = 'maxwell-dj' $$,
  $$ values ('DJ Maxwell'::text, true, 'America/Toronto'::text, 'CAD'::text, 50, 'on_deposit'::text, 14, '[]'::jsonb, '{}'::jsonb, true) $$,
  'defaults: display name as placeholder legal name, no address or contact email, Toronto, CAD, 50% deposit, no taxes');
select results_eq(
  $$ select (select count(*)::int from public.tenants where slug = 'maxwell-dj'),
            (select count(*)::int from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id where t.slug = 'maxwell-dj'),
            (select m.user_id from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id where t.slug = 'maxwell-dj'),
            (select i.accepted_by from public.platform_invitations i where i.id = current_setting('tests.i_new')::uuid) $$,
  $$ values (1, 1, current_setting('tests.new_dj')::uuid, current_setting('tests.new_dj')::uuid) $$,
  'exactly one tenant and one owner membership, for the signed-in user');
select results_eq(
  $$ select (select count(*)::int from public.platform_audit_events where entity_id = current_setting('tests.i_new')::uuid and action = 'accepted'),
            (select count(*)::int from public.audit_events a join public.tenants t on t.id = a.tenant_id
             where t.slug = 'maxwell-dj' and a.action = 'created' and a.actor_id = current_setting('tests.new_dj')::uuid),
            (select count(*)::int from public.email_outbox where entity_id = current_setting('tests.i_new')::uuid and status = 'pending') $$,
  $$ values (1, 1, 0) $$, 'acceptance is audited for the platform and the business; queued invitation emails are cancelled');

-- An accepted invitation is used up.
select tests.login_as(tests.id('stranger'));
select is(public.platform_invitation_status(current_setting('tests.i_new')::uuid) ->> 'state', 'invalid', 'nobody else sees the accepted workspace');
select is(public.accept_platform_invitation(current_setting('tests.i_new')::uuid, 'Second', 'second-dj') ->> 'state', 'invalid',
  'nobody else can use an accepted invitation');
select tests.login_as_service();
select is(public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_new2')::uuid)) ->> 'status', 'used', 'its link says it was used');
select tests.login_as(current_setting('tests.op')::uuid);
select throws_like($$ select tests.resend(current_setting('tests.i_new')::uuid) $$, '%already accepted%', 'an accepted invitation cannot be resent');
select throws_like($$ select public.revoke_platform_invitation(current_setting('tests.i_new')::uuid) $$, '%already accepted%', 'nor revoked');
select results_eq(
  $$ select state, workspace_slug, workspace_name from public.platform_invitations_overview() where id = current_setting('tests.i_new')::uuid $$,
  $$ values ('accepted'::text, 'maxwell-dj'::text, 'DJ Maxwell'::text) $$, 'the operator sees which workspace was created');
select is((select count(*)::int from public.tenants), 0, 'and still cannot read the business');
reset role;
select throws_ok($$ update public.platform_invitations set expires_at = now() where id = current_setting('tests.i_new')::uuid $$,
  '23514', null, 'an accepted invitation is final, even for privileged code');
select throws_ok($$ delete from public.platform_invitations where id = current_setting('tests.i_new')::uuid $$,
  '23514', null, 'invitations are never deleted');

-- ===========================================================================
-- Existing clients and staff keep their access
-- ===========================================================================
select tests.login_as(tests.id('client_x'));
select is(public.accept_platform_invitation(current_setting('tests.i_client')::uuid, 'Client X Beats', 'client-x-beats') ->> 'state', 'created',
  'an existing client accepts with the same identity');
select is((select count(*)::int from public.my_events()), 2, 'and still sees their events at both DJs');
select is((select count(*)::int from public.clients), 0, 'their new workspace shows no other business''s clients');
select tests.login_as(tests.id('staff_a'));
select is(public.accept_platform_invitation(current_setting('tests.i_staff')::uuid, 'Staff A Sound', 'staff-a-sound') ->> 'state', 'created',
  'an existing staff member accepts');
select results_eq(
  $$ select t.slug, m.role from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
     where m.user_id = tests.id('staff_a') order by t.slug $$,
  $$ values ('staff-a-sound'::text, 'owner'::text), ('test-bouprod'::text, 'staff'::text) $$,
  'and keeps their staff role, owning only the new business');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.tenants where slug in ('maxwell-dj', 'client-x-beats', 'staff-a-sound')), 0,
  'other owners cannot see the new businesses');
reset role;

-- ===========================================================================
-- Revoked and expired invitations
-- ===========================================================================
select tests.login_as(current_setting('tests.op')::uuid);
select is(public.revoke_platform_invitation(current_setting('tests.i_revoke')::uuid) ->> 'status', 'revoked', 'the operator revokes an invitation');
select is(public.revoke_platform_invitation(current_setting('tests.i_revoke')::uuid) ->> 'replayed', 'true', 'revoking again is a no-op');
select throws_like($$ select tests.resend(current_setting('tests.i_revoke')::uuid) $$, '%was revoked%', 'a revoked invitation cannot be resent');
select is(tests.invite('revoke-me@example.test') ->> 'status', 'created', 'a new invitation can follow a revoked one');
reset role;
select results_eq(
  $$ select status from public.email_outbox where entity_id = current_setting('tests.i_revoke')::uuid $$,
  $$ values ('cancelled'::text) $$, 'the revoked invitation''s queued email is cancelled');
select tests.login_as_service();
select is(public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_revoke')::uuid)) ->> 'status', 'invalid', 'a revoked link is invalid');
reset role;

update public.platform_invitations set expires_at = now() - interval '1 second', last_sent_at = now() - interval '1 hour'
  where id = current_setting('tests.i_expire')::uuid;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f0000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'expire-me@example.test', now(), now(), now());
select tests.login_as('f0000000-0000-4000-8000-000000000004');
select is(public.platform_invitation_status(current_setting('tests.i_expire')::uuid) ->> 'state', 'invalid', 'an expired invitation is invalid');
select is(public.accept_platform_invitation(current_setting('tests.i_expire')::uuid, 'Late DJ', 'late-dj') ->> 'state', 'invalid',
  'and cannot create a workspace');
select tests.login_as_service();
select is(public.request_platform_sign_in(tests.p_hash(current_setting('tests.link_expire')::uuid)) ->> 'status', 'invalid', 'nor ask for a verification email');
select tests.login_as(current_setting('tests.op')::uuid);
select is((select state from public.platform_invitations_overview() where id = current_setting('tests.i_expire')::uuid), 'expired', 'the operator sees it expired');
select is(tests.invite('expire-me@example.test') ->> 'status', 'exists', 'inviting the address again points to the expired invitation');
select is(tests.resend(current_setting('tests.i_expire')::uuid) ->> 'status', 'sent', 'which a resend renews');
select tests.login_as('f0000000-0000-4000-8000-000000000004');
select is(public.platform_invitation_status(current_setting('tests.i_expire')::uuid) ->> 'state', 'ready', 'with a fresh expiry');
reset role;

-- ===========================================================================
-- Archived businesses
-- ===========================================================================
update public.tenants set archived_at = now() where slug = 'maxwell-dj';
select tests.login_as(current_setting('tests.new_dj')::uuid);
select is(public.accept_platform_invitation(current_setting('tests.i_new')::uuid, 'DJ Maxwell', 'maxwell-dj-2') ->> 'slug', 'maxwell-dj',
  'a retry after archiving returns the archived workspace, never a new one');
reset role;
select is((select count(*)::int from public.tenants where slug like 'maxwell-dj%'), 1, 'still exactly one workspace');
select tests.login_as('f0000000-0000-4000-8000-000000000004');
select is(public.accept_platform_invitation(current_setting('tests.i_expire')::uuid, 'Maxwell Again', 'maxwell-dj') ->> 'state', 'slug_taken',
  'an archived business keeps its address');
reset role;

select * from finish();
rollback;
