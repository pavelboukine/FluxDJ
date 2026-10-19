-- Planning invitations for Flux bookings (20261118000100): staff can invite
-- the primary contact of a Flux event once Flux has booked it, through the
-- same invitation, token, verification and outbox as events booked
-- elsewhere. Nothing is sent by booking, planning setup or opening client
-- editing; an unbooked Flux event can't be invited; sending needs open
-- client editing (for both booking sources); a client who already has
-- contract access keeps exactly that access; and the identity, tenant,
-- archive, suspension, replacement and outdated-address protections hold.
begin;
\ir _fixtures.psql
select plan(44);

create table tests.created (name text primary key, id uuid not null);
grant select, insert on tests.created to anon, authenticated, service_role;
alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql stable as $$
  select coalesce(tests.id_base(name), (select c.id from tests.created c where c.name = id.name), md5('planning-invitations-flux-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.hash(token text) returns text language sql immutable as $$
  select encode(sha256(convert_to(token, 'utf8')), 'hex');
$$;
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
create function tests.invite(event text, invitation text, who text default 'staff_a') returns jsonb language sql as $$
  select tests.as_user(who, format('select public.send_planning_invitation(%L, %L, %L)', tests.id(event), tests.id(invitation), tests.hash(invitation)));
$$;
create function tests.sign_in(invitation text, slug text default 'test-bouprod') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as_service();
  r := public.request_planning_sign_in(tests.hash(invitation), slug);
  perform tests.su();
  return r;
end $$;
create function tests.inv_status(invitation text, who text, slug text default 'test-bouprod') returns jsonb language sql as $$
  select tests.as_user(who, format('select public.client_planning_invitation_status(%L, %L)', tests.id(invitation), slug));
$$;
create function tests.accept(invitation text, who text) returns jsonb language sql as $$
  select tests.as_user(who, format('select public.accept_planning_invitation(%L, %L)', tests.id(invitation), 'test-bouprod'));
$$;
create function tests.view(event text, who text default 'client_y') returns jsonb language sql as $$
  select tests.as_user(who, format('select public.client_planning_view(%L, %L)', tests.id(event), 'test-bouprod'));
$$;
create function tests.save(event text, guests int, who text default 'client_y') returns jsonb language plpgsql as $$
declare v_item uuid; v_rev int;
begin
  select i.id into v_item from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(event) and i.key = 'basics';
  v_rev := coalesce((select revision from public.event_plan_responses where item_id = v_item), 0);
  return tests.as_user(who, format('select public.client_save_plan_item(%L, %L, %L, %s, %L)', tests.id(event), 'test-bouprod', v_item, v_rev,
    jsonb_build_object('guest_count', guests)));
end $$;
create function tests.version(event text) returns int language sql stable as $$
  select client_cutoff_version from public.event_plans where event_id = tests.id(event);
$$;
create function tests.planning_emails(event text) returns int language sql stable as $$
  select count(*)::int from public.email_outbox o join public.planning_invitations i on i.id = o.entity_id
  where o.entity_type = 'planning_invitation' and i.event_id = tests.id(event);
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- A2: a Flux event whose primary contact (client Y) already has verified
-- access, as a signed contract gives. Planning set up while still an inquiry.
select lives_ok($$ select tests.as_user('staff_a', format('select public.setup_event_plan(%L, null)', tests.id('event_a2')))  $$, 'staff set up planning on a Flux inquiry');
select throws_like($$ select tests.invite('event_a2', 'early') $$, '%isn''t booked yet%', 'an unbooked Flux event cannot be invited to planning');
select throws_like($$ select tests.invite('event_a1', 'lead') $$, '%isn''t booked yet%', 'nor can a Flux lead without planning');

set local session_replication_role = replica;
update public.events set lifecycle_status = 'awaiting_deposit' where id = tests.id('event_a1');
set local session_replication_role = origin;
select throws_like($$ select tests.invite('event_a1', 'deposit') $$, '%isn''t booked yet%', 'nor one still awaiting its deposit');

select set_config('flux.booking_event', tests.id('event_a2')::text, true);
update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id('event_a2');
select set_config('flux.booking_event', '', true);
select is((select count(*)::int from public.planning_invitations where event_id = tests.id('event_a2')), 0, 'booking sends no planning invitation');
select is(tests.planning_emails('event_a2'), 0, 'and queues no planning email');

-- Client editing must be open; closing and opening it never emails anyone.
select lives_ok($$ select tests.as_user('staff_a', format('select public.close_plan_client_editing(%L, %s, null)', tests.id('event_a2'), tests.version('event_a2'))) $$,
  'staff close client editing');
select throws_like($$ select tests.invite('event_a2', 'closed') $$, '%client editing is closed%', 'a closed plan cannot be invited to');
select lives_ok($$ select tests.as_user('staff_a', format('select public.reopen_plan_client_editing(%L, %s, null, null)', tests.id('event_a2'), tests.version('event_a2'))) $$,
  'staff open client editing again');
select is(tests.planning_emails('event_a2'), 0, 'opening client editing sends nothing');

-- Who can send.
select throws_ok($$ select tests.invite('event_a2', 'by_client', 'client_y') $$, 'P0002', null, 'a client cannot invite themselves');
select throws_ok($$ select tests.invite('event_a2', 'by_other', 'owner_b') $$, 'P0002', null, 'staff of another business cannot invite');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok($$ select tests.invite('event_a2', 'by_removed') $$, 'P0002', null, 'removed staff cannot invite');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = null, removed_by = null where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok($$ select tests.invite('event_a2', 'suspended') $$, 'PT423', null, 'a suspended workspace cannot invite');
set local session_replication_role = replica;
update public.tenants set suspended_at = null where id = tests.id('tenant_a');
set local session_replication_role = origin;

-- Sending and delivery.
select is(tests.invite('event_a2', 'f1') ->> 'recipient_email', 'client-y@example.test', 'staff invite the booked Flux event''s primary contact');
select is((select array[event_type, status, recipient_email] from public.email_outbox where entity_id = tests.id('f1')),
  array['planning_invitation', 'pending', 'client-y@example.test'], 'one planning invitation email is queued to the primary contact''s address');
select is((select count(*)::int from public.email_outbox where entity_id = tests.id('f1') and event_type = 'booking_confirmed'), 0, 'separate from any booking confirmation');
select tests.login_as_service();
select is((select deliverable from public.claim_planning_email_outbox(10, 120, tests.id('tenant_a'), tests.id('f1'))), true, 'the planning worker claims it, deliverable');
select tests.su();

-- Acceptance reuses the contract access.
select is(tests.inv_status('f1', 'client_y') ->> 'state', 'accepted', 'a client with contract access sees it as already accepted');
select is(tests.inv_status('f1', 'client_x') ->> 'state', 'wrong_account', 'another verified client is the wrong account');
select is(tests.accept('f1', 'client_x') ->> 'state', 'wrong_account', 'and cannot accept it');
select is(tests.inv_status('f1', 'client_y', 'test-other-dj') ->> 'state', 'invalid', 'it is unknown under another business');
select is(tests.accept('f1', 'client_y') ->> 'state', 'accepted', 'the invited client accepts');
select is((select count(*)::int from public.event_access where event_id = tests.id('event_a2') and user_id = tests.id('client_y') and revoked_at is null), 1,
  'without a second access row');
select ok((select accepted_at is not null from public.planning_invitations where id = tests.id('f1')), 'the acceptance is recorded');
select is(tests.view('event_a2') ->> 'state', 'available', 'the client opens planning');
select is(tests.save('event_a2', 80) ->> 'status', 'saved', 'and saves while editing is open');
select is(tests.view('event_a1', 'client_y') ->> 'state', 'unavailable', 'but not another event of the business');

-- Replacement and outdated addresses.
select is(tests.invite('event_a2', 'f2') ->> 'status', 'sent', 'staff send a new invitation');
select ok((select revoked_at is not null from public.planning_invitations where id = tests.id('f1')), 'which replaces the earlier one');
select is(tests.sign_in('f1') ->> 'status', 'invalid', 'whose link stops working');
select is((select count(*)::int from public.event_access where event_id = tests.id('event_a2') and user_id = tests.id('client_y') and revoked_at is null), 1,
  'and contract access is untouched');
update public.clients set email = 'client-y-new@example.test' where id = tests.id('a_client_y');
select is(tests.sign_in('f2') ->> 'status', 'invalid', 'an invitation stops working when the contact''s email changes');
select is(tests.accept('f2', 'client_y') ->> 'state', 'invalid', 'and cannot be accepted');
update public.clients set email = 'client-y@example.test' where id = tests.id('a_client_y');

-- Closed editing after acceptance: read only.
select lives_ok($$ select tests.as_user('staff_a', format('select public.close_plan_client_editing(%L, %s, null)', tests.id('event_a2'), tests.version('event_a2'))) $$,
  'staff close editing after the client accepted');
select is(tests.save('event_a2', 85) ->> 'status', 'locked', 'client saves are refused');
select is(tests.view('event_a2') ->> 'state', 'available', 'but the client still reads planning');

-- Archived and no-longer-booked events.
select lives_ok($$ select tests.as_user('staff_a', format('select public.reopen_plan_client_editing(%L, %s, null, null)', tests.id('event_a2'), tests.version('event_a2'))) $$,
  'editing opened again');
select is(tests.as_user('staff_a', format('select public.set_event_archived(%L, true)', tests.id('event_a2'))) ->> 'status', 'archived', 'staff archive the event');
select throws_like($$ select tests.invite('event_a2', 'archived') $$, '%archived%', 'an archived event cannot be invited to');
select is(tests.view('event_a2') ->> 'state', 'unavailable', 'and its client has no planning');
select is(tests.as_user('staff_a', format('select public.set_event_archived(%L, false)', tests.id('event_a2'))) ->> 'status', 'active', 'staff restore it');
select is(tests.invite('event_a2', 'f3') ->> 'status', 'sent', 'and can invite again');
set local session_replication_role = replica;
update public.events set lifecycle_status = 'cancelled' where id = tests.id('event_a2');
set local session_replication_role = origin;
select is(tests.sign_in('f3') ->> 'status', 'invalid', 'an invitation stops working once the event is no longer booked');

select * from finish();
rollback;
