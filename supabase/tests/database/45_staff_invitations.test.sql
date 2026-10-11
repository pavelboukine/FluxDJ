-- Staff invitations and team management: owner-only invitations, verified
-- acceptance, cancellation, expiry, soft removal, other businesses and
-- suspension. Concurrent acceptance is covered by the integration test.
begin;
\ir _fixtures.psql
select plan(95);

-- Raw invitation token in tests: 'staff-' || link id (the app uses an HMAC).
create function tests.s_hash(link uuid) returns text language sql immutable as $$
  select encode(sha256(convert_to('staff-' || link, 'UTF8')), 'hex') $$;
-- Invites with a fresh request id (remembered in tests.last_id / tests.last_link).
create function tests.invite(tenant text, email text) returns jsonb language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_link uuid := gen_random_uuid();
begin
  perform set_config('tests.last_id', v_id::text, true);
  perform set_config('tests.last_link', v_link::text, true);
  return public.create_staff_invitation(tests.id(tenant), v_id, email, v_link, tests.s_hash(v_link));
end $$;
create function tests.resend(invitation uuid, link uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
begin
  perform set_config('tests.last_link', link::text, true);
  return public.resend_staff_invitation(tests.id('tenant_a'), invitation, link, tests.s_hash(link));
end $$;
create function tests.inv(email text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.staff_invitations where email = $1 order by created_at desc limit 1 $$;
create function tests.hash_of(email text) returns text language sql stable security definer set search_path = '' as $$
  select token_hash from public.staff_invitations where email = $1 order by created_at desc limit 1 $$;
create function tests.membership(tenant text, who text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.tenant_memberships where tenant_id = tests.id(tenant) and user_id = tests.id(who) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Privileges
-- ===========================================================================
select table_privs_are('public', 'staff_invitations', 'authenticated', array[]::text[], 'no direct access to invitations');
select table_privs_are('public', 'staff_invitations', 'anon', array[]::text[], 'nor for anonymous users');
select ok(not has_function_privilege('authenticated', 'public.claim_staff_email_outbox(integer,integer,uuid,uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.request_staff_sign_in(text)', 'execute')
          and not has_function_privilege('anon', 'public.accept_staff_invitation(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.staff_invitation_status(uuid)', 'execute'),
  'workers and token requests are service-role only; acceptance needs a sign-in');
select ok(not has_table_privilege('authenticated', 'public.tenant_memberships', 'insert')
          and not has_table_privilege('authenticated', 'public.tenant_memberships', 'update')
          and not has_table_privilege('authenticated', 'public.tenant_memberships', 'delete'),
  'memberships are never written directly by signed-in users');

-- ===========================================================================
-- Only the owner manages the team
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select tests.invite('tenant_a', 'stranger@example.test') $$, '42501', null, 'staff cannot invite');
select throws_ok($$ select public.staff_team_overview(tests.id('tenant_a')) $$, '42501', null, 'staff cannot list the team');
select throws_ok($$ select public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_a', 'owner_a')) $$, '42501', null,
  'staff cannot remove the owner');
select throws_ok($$ select public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_a', 'staff_a')) $$, '42501', null,
  'staff cannot remove themselves through the owner function');

select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select tests.invite('tenant_a', 'stranger@example.test') $$, 'P0002', null, 'another business''s owner gets not found');
select throws_ok($$ select public.staff_team_overview(tests.id('tenant_a')) $$, 'P0002', null, 'nor can they list the team');

-- ===========================================================================
-- Inviting: validation, replay, duplicates, members
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select tests.invite('tenant_a', 'not-an-email') $$, '22023', 'invitation_invalid: enter a valid email address',
  'an invalid email is refused');
select is((tests.invite('tenant_a', ' Stranger@Example.test ')) ->> 'status', 'created', 'the owner invites, email normalized');
select set_config('tests.first_id', current_setting('tests.last_id'), true);
select set_config('tests.first_link', current_setting('tests.last_link'), true);
select is((public.create_staff_invitation(tests.id('tenant_a'), current_setting('tests.first_id')::uuid, 'other@example.test',
             gen_random_uuid(), tests.s_hash(gen_random_uuid()))) ->> 'replayed', 'true',
  'repeating the same request returns the invitation already created');
select is((tests.invite('tenant_a', 'stranger@example.test')) ->> 'status', 'exists', 'a second request for the same address points to the open one');
select is((tests.invite('tenant_a', 'STAFF-A@example.test')) ->> 'status', 'member', 'an active member isn''t invited');
select is((tests.invite('tenant_a', 'owner-a@example.test')) ->> 'status', 'member', 'nor is the owner');

reset role;
select is((select count(*)::int from public.staff_invitations where tenant_id = tests.id('tenant_a') and email = 'stranger@example.test'), 1,
  'exactly one invitation exists');
select results_eq(
  $$ select event_type, tenant_id, recipient_email, payload ->> 'link_id', dedup_key from public.email_outbox
     where entity_type = 'staff_invitation' and entity_id = current_setting('tests.first_id')::uuid $$,
  $$ values ('staff_invitation'::text, tests.id('tenant_a'), 'stranger@example.test'::text, current_setting('tests.first_link'),
            'staff_invitation:' || current_setting('tests.first_link')) $$,
  'one invitation email is queued for the business, carrying only the link id');
select is((select metadata ->> 'email' from public.audit_events where entity_id = current_setting('tests.first_id')::uuid and action = 'created'),
  'stranger@example.test', 'the invitation is audited');
select ok((select metadata::text from public.audit_events where entity_id = current_setting('tests.first_id')::uuid) !~ '[0-9a-f]{64}',
  'the audit holds no token hash');

-- The owner's overview: members and the pending invitation, never hashes.
select tests.login_as(tests.id('owner_a'));
select is(jsonb_array_length(public.staff_team_overview(tests.id('tenant_a')) -> 'members'), 2, 'the overview lists the owner and staff');
select is((public.staff_team_overview(tests.id('tenant_a')) -> 'invitations' -> 0 ->> 'state'), 'pending', 'and the pending invitation');
select ok(public.staff_team_overview(tests.id('tenant_a'))::text !~ '[0-9a-f]{64}', 'with no token hash');
select is((select count(*)::int from jsonb_array_elements(public.staff_team_overview(tests.id('tenant_a')) -> 'members') x
           where (x ->> 'is_you')::boolean and x ->> 'role' = 'owner'), 1, 'the owner is marked as you');

-- ===========================================================================
-- The invitee: verification request, status, wrong accounts
-- ===========================================================================
select tests.login_as_service();
select is((public.request_staff_sign_in(tests.s_hash(current_setting('tests.first_link')::uuid))) ->> 'masked_email', 's•••@example.test',
  'the token only queues a verification email to the masked invited address');
select is((public.request_staff_sign_in(tests.s_hash(gen_random_uuid()))) ->> 'status', 'invalid', 'an unknown token is invalid');
select is((public.request_staff_sign_in('nope')) ->> 'status', 'invalid', 'a malformed token is invalid');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.first_id')::uuid and event_type = 'staff_sign_in'), 1,
  'one verification email is queued');
select is((select count(*)::int from public.claim_email_outbox(100, 120, tests.id('tenant_a'), true) c where c.event_type like 'staff_%'), 0,
  'the existing worker never claims staff invitation emails');
select ok((select bool_and(c.deliverable) and count(*) = 2 from public.claim_staff_email_outbox(100, 120, tests.id('tenant_a')) c),
  'the staff worker claims both, deliverable');

select tests.login_as(tests.id('client_u'));
select is((public.staff_invitation_status(current_setting('tests.first_id')::uuid)) ->> 'state', 'unverified', 'an unverified sign-in learns nothing');
select tests.login_as(tests.id('client_x'));
select is((public.staff_invitation_status(current_setting('tests.first_id')::uuid)) - 'signed_in_email',
  '{"state": "wrong_account", "intended_email": "s•••@example.test"}'::jsonb, 'another account sees only the masked address, not the business');
select is((public.accept_staff_invitation(current_setting('tests.first_id')::uuid)) ->> 'state', 'wrong_account', 'and cannot accept');
select is(public.staff_invitation_for_token(tests.s_hash(current_setting('tests.first_link')::uuid)), null,
  'the token gives another account nothing');
select tests.login_as(tests.id('stranger'));
select is((public.staff_invitation_status(current_setting('tests.first_id')::uuid)) ->> 'display_name', 'BOUPROD',
  'the verified invited address sees the business');
select is(public.staff_invitation_for_token(tests.s_hash(current_setting('tests.first_link')::uuid)), current_setting('tests.first_id')::uuid,
  'and, signed in, can go straight to acceptance');
select is_empty($$ select id from public.events where tenant_id = tests.id('tenant_a') $$, 'no access before accepting');

-- ===========================================================================
-- Acceptance
-- ===========================================================================
select is((public.accept_staff_invitation(current_setting('tests.first_id')::uuid)) - 'replayed',
  '{"state": "accepted", "slug": "test-bouprod", "outcome": "joined"}'::jsonb, 'the invited address accepts');
select is((public.accept_staff_invitation(current_setting('tests.first_id')::uuid)) ->> 'replayed', 'true', 'repeating it is a replay');
select isnt_empty($$ select id from public.events where tenant_id = tests.id('tenant_a') $$, 'the new staff member sees the business''s events');
select is((select role from public.my_workspaces() where slug = 'test-bouprod'), 'staff', 'as staff');
select throws_ok($$ select tests.invite('tenant_a', 'friend@example.test') $$, '42501', null, 'a new staff member cannot invite');
select tests.login_as(tests.id('client_x'));
select is((public.accept_staff_invitation(current_setting('tests.first_id')::uuid)) ->> 'state', 'invalid', 'nobody else can use an accepted invitation');
reset role;
select is((select count(*)::int from public.tenant_memberships where tenant_id = tests.id('tenant_a') and user_id = tests.id('stranger')), 1,
  'exactly one membership');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.first_id')::uuid and status = 'pending'), 0,
  'nothing is left to send');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select tests.resend(current_setting('tests.first_id')::uuid) $$, '22023', null, 'an accepted invitation can''t be resent');
select throws_ok($$ select public.cancel_staff_invitation(tests.id('tenant_a'), current_setting('tests.first_id')::uuid) $$, '22023', null,
  'nor cancelled');

-- ===========================================================================
-- Removal
-- ===========================================================================
select throws_ok($$ select public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_a', 'owner_a')) $$, '42501',
  'member_owner_protected: the business owner can''t be removed', 'the owner can''t be removed');
select throws_ok($$ select public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_b', 'owner_b')) $$, 'P0002', null,
  'nor another business''s member');
select is((public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_a', 'stranger'))) ->> 'replayed', 'false', 'the owner removes staff');
select is((public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_a', 'stranger'))) ->> 'replayed', 'true', 'repeating it is a no-op');
select is((select x ->> 'removed_at' is not null from jsonb_array_elements(public.staff_team_overview(tests.id('tenant_a')) -> 'members') x
           where x ->> 'email' = 'stranger@example.test'), true, 'the overview shows them as removed');
select tests.login_as(tests.id('stranger'));
select is_empty($$ select id from public.events where tenant_id = tests.id('tenant_a') $$, 'a removed member loses access at once');
select is_empty($$ select slug from public.my_workspaces() $$, 'and no longer has the workspace');
select throws_ok($$ select private.require_staff_of(tests.id('tenant_a')) $$, '42501', null, 'private gates aren''t callable');
select throws_ok($$ select public.staff_dashboard(tests.id('tenant_a'), 8) $$, 'P0002', null, 'staff functions answer not found');
select throws_ok($$ update public.tenant_memberships set removed_at = null where user_id = tests.id('stranger') $$, '42501', null,
  'and they can''t restore themselves');
reset role;
select ok((select removed_at is not null and removed_by = tests.id('owner_a') from public.tenant_memberships
           where tenant_id = tests.id('tenant_a') and user_id = tests.id('stranger')), 'the row stays, for attribution');
select is((select count(*)::int from public.audit_events where entity_id = tests.membership('tenant_a', 'stranger') and action = 'removed'), 1,
  'the removal is audited once');
select throws_ok($$ update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where user_id = tests.id('owner_a') $$,
  '23514', null, 'an owner row can''t be removed even by privileged code');

-- A removed member can be invited again; accepting restores the same membership.
select tests.login_as(tests.id('owner_a'));
select is((tests.invite('tenant_a', 'stranger@example.test')) ->> 'status', 'created', 'a removed member can be invited again');
select set_config('tests.second_id', current_setting('tests.last_id'), true);
select tests.login_as(tests.id('stranger'));
select is((public.accept_staff_invitation(current_setting('tests.second_id')::uuid)) ->> 'outcome', 'restored', 'accepting restores the membership');
reset role;
select ok((select count(*) = 1 and bool_and(removed_at is null) from public.tenant_memberships
           where tenant_id = tests.id('tenant_a') and user_id = tests.id('stranger')), 'the same row, active again');

-- ===========================================================================
-- Cancellation
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is((tests.invite('tenant_a', 'client-x@example.test')) ->> 'status', 'created', 'an existing client of the business can be invited');
select set_config('tests.cx_id', current_setting('tests.last_id'), true);
select set_config('tests.cx_link', current_setting('tests.last_link'), true);
select is((public.cancel_staff_invitation(tests.id('tenant_a'), current_setting('tests.cx_id')::uuid)) ->> 'replayed', 'false', 'the owner cancels');
select is((public.cancel_staff_invitation(tests.id('tenant_a'), current_setting('tests.cx_id')::uuid)) ->> 'replayed', 'true', 'repeating it is a no-op');
select throws_ok($$ select tests.resend(current_setting('tests.cx_id')::uuid) $$, '22023', null, 'a cancelled invitation can''t be resent');
reset role;
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.cx_id')::uuid and status = 'pending'), 0,
  'its queued email is cancelled');
select tests.login_as(tests.id('client_x'));
select is((public.accept_staff_invitation(current_setting('tests.cx_id')::uuid)) ->> 'state', 'invalid', 'a cancelled invitation can''t be accepted');
select is((public.staff_invitation_status(current_setting('tests.cx_id')::uuid)) ->> 'state', 'invalid', 'and names no business');
select tests.login_as_service();
select is((public.request_staff_sign_in(tests.s_hash(current_setting('tests.cx_link')::uuid))) ->> 'status', 'invalid',
  'its link stops working');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.cancel_staff_invitation(tests.id('tenant_a'), tests.inv('stranger@example.test')) $$, 'P0002', null,
  'another business can''t cancel this business''s invitations');
select throws_ok($$ select public.cancel_staff_invitation(tests.id('tenant_b'), tests.inv('stranger@example.test')) $$, 'P0002', null,
  'not even through its own business id');

-- ===========================================================================
-- Expiry, resend and a client who becomes staff
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is((tests.invite('tenant_a', 'client-y@example.test')) ->> 'status', 'created', 'a client is invited');
select set_config('tests.cy_id', current_setting('tests.last_id'), true);
reset role;
update public.staff_invitations set expires_at = now() - interval '1 minute', last_sent_at = now() - interval '8 days' where id = current_setting('tests.cy_id')::uuid;
select tests.login_as(tests.id('client_y'));
select is((public.accept_staff_invitation(current_setting('tests.cy_id')::uuid)) ->> 'state', 'invalid', 'an expired invitation can''t be accepted');
select tests.login_as_service();
select is((public.request_staff_sign_in(tests.hash_of('client-y@example.test'))) ->> 'status', 'invalid', 'nor its link used');
select tests.login_as(tests.id('owner_a'));
select is((select x ->> 'state' from jsonb_array_elements(public.staff_team_overview(tests.id('tenant_a')) -> 'invitations') x
           where x ->> 'email' = 'client-y@example.test'), 'expired', 'the owner sees it expired');
select is((tests.invite('tenant_a', 'client-y@example.test')) ->> 'state', 'expired', 'a new request points to the expired one');
select set_config('tests.resend_link', gen_random_uuid()::text, true);
select is((tests.resend(current_setting('tests.cy_id')::uuid, current_setting('tests.resend_link')::uuid)) ->> 'replayed', 'false',
  'the owner resends it with a new expiry');
select is((tests.resend(current_setting('tests.cy_id')::uuid, current_setting('tests.resend_link')::uuid)) ->> 'replayed', 'true',
  'repeating the same resend is a replay');
select throws_ok($$ select tests.resend(current_setting('tests.cy_id')::uuid) $$, '22023', null, 'another resend right away is refused');
reset role;
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.cy_id')::uuid and event_type = 'staff_invitation'), 2,
  'two invitation emails in all, one per link');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.cy_id')::uuid and status = 'pending'), 1,
  'only the newest is still to send');
select tests.login_as(tests.id('client_y'));
select is((public.accept_staff_invitation(current_setting('tests.cy_id')::uuid)) ->> 'outcome', 'joined', 'the resent invitation is accepted');
select tests.login_as(tests.id('owner_a'));
select is((public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_a', 'client_y'))) ->> 'status', 'removed', 'and later removed');
select tests.login_as(tests.id('client_y'));
select results_eq($$ select event_id from public.my_events() $$, array[tests.id('event_a2')],
  'the removed staff member keeps their own client event');
select is_empty($$ select id from public.events where tenant_id = tests.id('tenant_a') $$, 'but no staff access to the business');

-- ===========================================================================
-- Suspended workspace
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is((tests.invite('tenant_a', 'pending@example.test')) ->> 'status', 'created', 'an invitation open before suspension');
select set_config('tests.p_id', current_setting('tests.last_id'), true);
select set_config('tests.p_link', current_setting('tests.last_link'), true);
reset role;
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select tests.invite('tenant_a', 'later@example.test') $$, 'PT423', null, 'a suspended business can''t invite');
select throws_ok($$ select public.remove_staff_member(tests.id('tenant_a'), tests.membership('tenant_a', 'staff_a')) $$, 'PT423', null,
  'nor remove staff');
select tests.login_as_service();
select is((public.request_staff_sign_in(tests.s_hash(current_setting('tests.p_link')::uuid))) ->> 'status', 'invalid',
  'its invitation links answer invalid');
select is((select count(*)::int from public.claim_staff_email_outbox(100, 120, tests.id('tenant_a'))), 0, 'and none of its emails are claimed');
reset role;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f0000000-0000-4000-8000-0000000000aa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pending@example.test', now(), now(), now());
select tests.login_as('f0000000-0000-4000-8000-0000000000aa');
select is((public.staff_invitation_status(current_setting('tests.p_id')::uuid)) ->> 'state', 'unavailable', 'the invited address is told it is unavailable');
select is((public.accept_staff_invitation(current_setting('tests.p_id')::uuid)) ->> 'state', 'unavailable', 'and cannot accept');
reset role;
select is((select count(*)::int from public.tenant_memberships where user_id = 'f0000000-0000-4000-8000-0000000000aa'), 0, 'no membership was created');

select * from finish();
rollback;
