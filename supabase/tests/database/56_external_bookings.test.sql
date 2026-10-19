-- Events booked outside Flux DJ: staff set booking_source once, at creation;
-- nothing Flux-booked is pretended (no proposal, contract, payment or
-- booking confirmation); planning is eligible through the one shared rule;
-- clients reach it only through a planning invitation accepted by the
-- verified invited address. Normal Flux events keep their prerequisites, and
-- other businesses, other clients, removed staff, suspended workspaces and
-- archived events stay refused.
begin;
\ir _fixtures.psql
select plan(86);

-- Events staff create get their id from the database (staff can't choose one); it is recorded here by name.
create table tests.created (name text primary key, id uuid not null);
grant select, insert on tests.created to anon, authenticated, service_role;
alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql stable as $$
  select coalesce(tests.id_base(name), (select c.id from tests.created c where c.name = id.name), md5('external-bookings-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.hash(token text) returns text language sql immutable as $$
  select encode(sha256(convert_to(token, 'utf8')), 'hex');
$$;
-- Runs a statement as someone, returning its jsonb result (errors propagate after resetting the role).
create function tests.as_user(who text, stmt text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  execute stmt into r;
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
-- Staff A creates an event through the staff insert path (RLS), with client Y as primary contact.
create function tests.create_event(name text, source text, who text default 'staff_a', tenant text default 'tenant_a') returns void language plpgsql as $$
declare v_id uuid;
begin
  perform tests.login_as(tests.id(who));
  insert into public.events (tenant_id, title, event_type, event_date, timezone, booking_source)
  values (tests.id(tenant), name, 'wedding', current_date + 120, 'America/Toronto', source)
  returning id into v_id;
  insert into tests.created (name, id) values (name, v_id);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign)
  values (tests.id(tenant), v_id, tests.id('a_client_y'), true, true);
  perform tests.su();
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.view(event text, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb; v_event uuid := tests.id(event);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_planning_view(v_event, 'test-bouprod');
  perform tests.su();
  return r;
end $$;
create function tests.basics(event text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(event) and i.key = 'basics';
$$;
create function tests.save(event text, guests int, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb; v_event uuid := tests.id(event); v_item uuid := tests.basics(event);
  v_rev int := coalesce((select revision from public.event_plan_responses where item_id = tests.basics(event)), 0);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_save_plan_item(v_event, 'test-bouprod', v_item, v_rev, jsonb_build_object('guest_count', guests));
  perform tests.su();
  return r;
end $$;
create function tests.invite(event text, invitation text, who text default 'staff_a') returns jsonb language sql as $$
  select tests.as_user(who, format('select public.send_planning_invitation(%L, %L, %L)', tests.id(event), tests.id(invitation), tests.hash(invitation)));
$$;
create function tests.sign_in(invitation text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as_service();
  r := public.request_planning_sign_in(tests.hash(invitation), 'test-bouprod');
  perform tests.su();
  return r;
end $$;
create function tests.inv_status(invitation text, who text) returns jsonb language sql as $$
  select tests.as_user(who, format('select public.client_planning_invitation_status(%L, %L)', tests.id(invitation), 'test-bouprod'));
$$;
create function tests.accept(invitation text, who text) returns jsonb language sql as $$
  select tests.as_user(who, format('select public.accept_planning_invitation(%L, %L)', tests.id(invitation), 'test-bouprod'));
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Booking source: explicit, set once, staff only
-- ===========================================================================
select is((select count(*)::int from public.events where tenant_id in (tests.id('tenant_a'), tests.id('tenant_b')) and booking_source <> 'flux'), 0,
  'existing events keep the Flux booking source');

select lives_ok($$ select tests.create_event('ext', 'external') $$, 'staff create an event booked elsewhere through the normal insert');
select lives_ok($$ select tests.create_event('flux_new', 'flux') $$, 'and a normal Flux event');
select is((select booking_source from public.events where id = tests.id('ext')), 'external', 'the booking source is stored');
select is((select array[lifecycle_status, coalesce(booking_confirmed_at::text, 'none'), coalesce(active_proposal_id::text, 'none')] from public.events where id = tests.id('ext')),
  array['lead', 'none', 'none'], 'with no Flux booking state: not booked, no confirmation, no proposal');
select is((select array[actor_type, actor_id::text] from public.audit_events where entity_id = tests.id('ext') and action = 'booked_externally'),
  array['staff', tests.id('staff_a')::text], 'the affirmation is audited with the staff member who made it');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('flux_new') and action = 'booked_externally'), 0, 'a Flux event records no such affirmation');

select throws_ok($$ select tests.as_user('staff_a', format('update public.events set booking_source = %L where id = %L returning 1', 'flux', tests.id('ext'))) $$,
  '42501', null, 'staff cannot change the booking source afterwards');
select throws_ok($$ select tests.as_user('owner_a', format('update public.events set booking_source = %L where id = %L returning 1', 'external', tests.id('flux_new'))) $$,
  '42501', null, 'not even the owner, in either direction');
select throws_ok(format('update public.events set booking_source = %L where id = %L', 'flux', tests.id('ext')), '23514', null,
  'and the database refuses it for every role');
select throws_ok($$ select tests.create_event('ext_bad', 'agency') $$, '23514', null, 'only the structured values are accepted');

select throws_ok($$ select tests.create_event('ext_client', 'external', 'client_y') $$, '42501', null, 'a client cannot create (or mark) an event booked elsewhere');
select throws_ok($$ select tests.create_event('ext_other', 'external', 'owner_b') $$, '42501', null, 'staff of another business cannot create one in this business');
select throws_ok($$ select tests.as_user('client_y', format('update public.events set booking_source = %L where id = %L returning 1', 'external', tests.id('event_a2'))) $$,
  '42501', null, 'a client cannot mark their own event as booked elsewhere');

set local session_replication_role = replica;
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok($$ select tests.create_event('ext_removed', 'external') $$, '42501', null, 'removed staff cannot create an event booked elsewhere');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = null, removed_by = null where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
set local session_replication_role = origin;
set local session_replication_role = replica;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok($$ select tests.create_event('ext_suspended', 'external') $$, 'PT423', null, 'nor can staff of a suspended workspace');
set local session_replication_role = replica;
update public.tenants set suspended_at = null where id = tests.id('tenant_a');
set local session_replication_role = origin;

-- ===========================================================================
-- No pretended booking records
-- ===========================================================================
select throws_ok($$ select tests.as_user('staff_a', format('select to_jsonb(public.open_proposal_draft(%L))', tests.id('ext'))) $$,
  '22023', null, 'no proposal can be started for an event booked elsewhere');
select is((select count(*)::int from public.proposals where event_id = tests.id('ext')), 0, 'so it has no proposal');
select is((select count(*)::int from public.contracts where event_id = tests.id('ext')), 0, 'no contract');
select is((select count(*)::int from public.event_payments where event_id = tests.id('ext')), 0, 'and no payment');
select lives_ok($$ select tests.as_user('staff_a', format('select to_jsonb(public.open_proposal_draft(%L))', tests.id('flux_new'))) $$,
  'a Flux event still starts its proposal as before');

-- Even trusted code can't put Flux booking state on it.
select set_config('flux.booking_event', tests.id('ext')::text, true);
select throws_ok(format('update public.events set lifecycle_status = %L, booking_confirmed_at = now() where id = %L', 'booked', tests.id('ext')),
  '23514', null, 'an event booked elsewhere can never be marked booked by Flux');
select set_config('flux.booking_event', '', true);
select is(tests.as_user('staff_a', format('select public.check_event_booking(%L)', tests.id('ext'))) ->> 'status', 'not_signed',
  'and a booking check finds nothing to book');

-- ===========================================================================
-- Planning: setup gate, then invitation
-- ===========================================================================
select is(tests.view('ext') ->> 'state', 'unavailable', 'before setup the client sees nothing');
select throws_ok($$ select tests.invite('ext', 'inv_early') $$, '22023', null, 'and staff cannot invite before planning is set up');

select is(tests.as_user('staff_a', format('select public.setup_event_plan(%L, null)', tests.id('ext'))) ->> 'status', 'created',
  'staff set planning up without any proposal');
select is((select initialized_via from public.event_plans where event_id = tests.id('ext')), 'staff', 'initialized by staff');
select is(tests.view('ext') ->> 'state', 'unavailable', 'set up but not invited: the client still has no access');

select throws_ok($$ select tests.invite('ext', 'inv_b', 'owner_b') $$, 'P0002', null, 'staff of another business cannot invite');
select throws_ok($$ select tests.invite('ext', 'inv_c', 'client_y') $$, 'P0002', null, 'a client cannot invite themselves');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok($$ select tests.invite('ext', 'inv_r') $$, 'P0002', null, 'removed staff cannot invite');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = null, removed_by = null where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
set local session_replication_role = origin;
set local session_replication_role = replica;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok($$ select tests.invite('ext', 'inv_s') $$, 'PT423', null, 'nor can a suspended workspace');
set local session_replication_role = replica;
update public.tenants set suspended_at = null where id = tests.id('tenant_a');
set local session_replication_role = origin;

select lives_ok($$ select tests.as_user('staff_a', format('select public.setup_event_plan(%L, null)', tests.id('flux_new'))) $$, 'a Flux event can set planning up early, as before');
select throws_ok($$ select tests.invite('flux_new', 'inv_flux') $$, '22023', null, 'but an unbooked Flux event cannot be invited to planning');

select is(tests.invite('ext', 'inv1') ->> 'status', 'sent', 'staff invite the primary contact');
select is((select array[event_type, entity_type, recipient_email] from public.email_outbox where entity_id = tests.id('inv1')),
  array['planning_invitation', 'planning_invitation', 'client-y@example.test'], 'one planning invitation email is queued to the client');
select is(tests.invite('ext', 'inv1') ->> 'replayed', 'true', 'a retried send is a replay');
select is((select count(*)::int from public.email_outbox where entity_id = tests.id('inv1')), 1, 'with no second email');

-- Delivery: only the planning claim takes these emails.
select tests.login_as_service();
select is((select count(*)::int from public.claim_email_outbox(100, 120, tests.id('tenant_a'), true) c where c.event_type like 'planning%'), 0,
  'the general worker claim never takes planning emails');
select is((select deliverable from public.claim_planning_email_outbox(10, 120, tests.id('tenant_a'), tests.id('inv1'))), true,
  'the planning claim takes it, deliverable');
select tests.su();

-- ===========================================================================
-- Client acceptance
-- ===========================================================================
select is(tests.sign_in('inv1') ->> 'status', 'ok', 'the token lets its holder ask for a verification email');
select is(tests.sign_in('not-a-token') ->> 'status', 'invalid', 'a wrong token gets nothing');
select throws_ok($$ select tests.as_user('client_y', format('select public.request_planning_sign_in(%L, %L)', tests.hash('inv1'), 'test-bouprod')) $$,
  '42501', null, 'only the server can ask (after its rate limit)');

select is(tests.inv_status('inv1', 'client_x') ->> 'state', 'wrong_account', 'another verified client is the wrong account');
select is(tests.inv_status('inv1', 'client_u') ->> 'state', 'unverified', 'an unverified account must verify first');
select is(tests.inv_status('inv1', 'client_y') ->> 'state', 'ready', 'the invited address sees it ready');
select is(tests.accept('inv1', 'client_x') ->> 'state', 'wrong_account', 'another client cannot accept it');
select is((select count(*)::int from public.event_access where event_id = tests.id('ext') and user_id = tests.id('client_x')), 0, 'and gains no access');
select is(tests.accept('inv1', 'client_y') ->> 'state', 'accepted', 'the invited client accepts');
select is((select count(*)::int from public.event_access where event_id = tests.id('ext') and user_id = tests.id('client_y') and revoked_at is null), 1,
  'which grants access to this event only');
select ok((select accepted_at is not null from public.planning_invitations where id = tests.id('inv1')), 'the invitation records the acceptance');
select is(tests.accept('inv1', 'client_y') ->> 'state', 'accepted', 'accepting again is harmless');

select is(tests.view('ext') ->> 'state', 'available', 'the client can open planning without proposal, contract or payment');
select is(tests.view('ext', 'client_x') ->> 'state', 'unavailable', 'a client of another event cannot read it');
select is(tests.save('ext', 90, 'client_x') ->> 'status', 'unavailable', 'or change it');
select is(tests.save('ext', 90) ->> 'status', 'saved', 'the invited client saves answers while editing is open');
select is((select answers -> 'guest_count' from public.event_plan_responses where item_id = tests.basics('ext')), '90'::jsonb, 'and they are stored');

select lives_ok($$ select tests.as_user('staff_a', format('select public.close_plan_client_editing(%L, %s, null)', tests.id('ext'),
  (select client_cutoff_version from public.event_plans where event_id = tests.id('ext')))) $$, 'staff close client editing');
select is(tests.save('ext', 95) ->> 'status', 'locked', 'then client saves are refused');
select is(tests.view('ext') ->> 'state', 'available', 'but the client can still read planning');

-- Client home and staff lists.
select tests.login_as(tests.id('client_y'));
select is((select booking_source from public.my_events() where event_id = tests.id('ext')), 'external', 'the client home knows the event was booked elsewhere');
select is((select count(*)::int from public.my_plans() where event_id = tests.id('ext')), 1, 'and lists its planning');
select is((select count(*)::int from public.planning_invitations), 0, 'clients cannot read invitations');
select tests.su();

select tests.login_as(tests.id('staff_a'));
select is(jsonb_path_query_array(public.staff_event_list(tests.id('tenant_a'), 'all', 'external'), '$.rows[*].id') @> to_jsonb(array[tests.id('ext')::text]),
  true, 'the event list filters events booked elsewhere');
select is(jsonb_path_query_array(public.staff_event_list(tests.id('tenant_a'), 'all', 'lead'), '$.rows[*].id') @> to_jsonb(array[tests.id('ext')::text]),
  false, 'and the Flux "lead" status no longer includes them');
select is(jsonb_path_query_first(public.staff_event_list(tests.id('tenant_a'), 'all', 'external'), '$.rows[0].booking_source') #>> '{}', 'external',
  'rows carry the booking source');
select is((select count(*)::int from public.planning_invitations where event_id = tests.id('ext')), 1, 'staff read their business''s invitations');
select throws_ok('select token_hash from public.planning_invitations', '42501', null, 'but never the token hash');
select tests.su();
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.planning_invitations), 0, 'another business sees none');
select tests.su();

-- ===========================================================================
-- Replacement, archiving, suspension
-- ===========================================================================
select throws_like($$ select tests.invite('ext', 'inv_closed') $$, '%client editing is closed%', 'no invitation while client editing is closed');
select lives_ok($$ select tests.as_user('staff_a', format('select public.reopen_plan_client_editing(%L, %s, null, null)', tests.id('ext'),
  (select client_cutoff_version from public.event_plans where event_id = tests.id('ext')))) $$, 'staff open client editing again');
select is(tests.invite('ext', 'inv2') ->> 'status', 'sent', 'a new invitation can be sent');
select ok((select revoked_at is not null from public.planning_invitations where id = tests.id('inv1')), 'it replaces the previous one');
select is(tests.sign_in('inv1') ->> 'status', 'invalid', 'whose link stops working');

select is(tests.as_user('staff_a', format('select public.set_event_archived(%L, true)', tests.id('ext'))) ->> 'status', 'archived', 'staff archive the event');
select ok((select revoked_at is not null from public.planning_invitations where id = tests.id('inv2')), 'archiving revokes the open invitation');
select is((select status from public.email_outbox where entity_id = tests.id('inv2')), 'cancelled', 'and cancels its pending email');
select is(tests.view('ext') ->> 'state', 'unavailable', 'an archived event has no client planning');
select throws_ok($$ select tests.invite('ext', 'inv3') $$, '22023', null, 'and cannot be reopened through a planning invitation');
select is(tests.accept('inv2', 'client_y') ->> 'state', 'invalid', 'nor through an earlier one');
select is(tests.as_user('staff_a', format('select public.set_event_archived(%L, false)', tests.id('ext'))) ->> 'status', 'active', 'staff restore it');
select is(tests.view('ext') ->> 'state', 'available', 'the client who already had access can read planning again, as for a Flux booking');

set local session_replication_role = replica;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select is(tests.view('ext') ->> 'state', 'unavailable', 'a suspended workspace has no client planning');
set local session_replication_role = replica;
update public.tenants set suspended_at = null where id = tests.id('tenant_a');
set local session_replication_role = origin;

-- ===========================================================================
-- Flux events keep their prerequisites
-- ===========================================================================
-- Client Y has verified access to A2 (a Flux inquiry); planning set up early.
select lives_ok($$ select tests.as_user('staff_a', format('select public.setup_event_plan(%L, null)', tests.id('event_a2'))) $$, 'a Flux inquiry with planning set up early');
select is(tests.view('event_a2') ->> 'state', 'unavailable', 'is still not open to its client before the booking');
select set_config('flux.booking_event', tests.id('event_a2')::text, true);
update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id('event_a2');
select set_config('flux.booking_event', '', true);
select is(tests.view('event_a2') ->> 'state', 'available', 'and opens once Flux books it');

select * from finish();
rollback;
