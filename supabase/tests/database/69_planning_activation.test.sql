-- Explicit planning activation (20261201000100): booking never opens planning
-- to the client; staff open it with open_client_planning or by sending the
-- first planning invitation (one transaction). Until then clients get only
-- "setting up" and every save is refused, while staff keep preparing it.
-- Opening is one-way, idempotent, staff-only, tenant-scoped, refused for
-- archived, unbooked or unset-up events and suspended workspaces, and never
-- changes the deadline or client editing. The backfill rule keeps every plan
-- a client could already open.
begin;
\ir _fixtures.psql
select plan(87);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('planning-activation-test-' || name)::uuid);
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
-- An event in tenant A with client Y as primary contact. `access`: client Y
-- has verified access (as a signed contract gives). `days`: event date.
create function tests.ev(name text, source text default 'flux', access boolean default true, days int default 120,
                         event_type text default 'wedding') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, timezone, booking_source)
  values (tests.id(name), tests.id('tenant_a'), name, event_type, current_date + days, 'America/Toronto', source);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  if access then
    insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  end if;
  return tests.id(name);
end $$;
create function tests.setup(name text) returns void language plpgsql as $$
begin
  perform tests.as_user('staff_a', format('select public.setup_event_plan(%L, null)', tests.id(name)));
end $$;
-- Booked as evaluate_booking does it (which also sets up the plan when there is none).
create function tests.book(name text) returns void language plpgsql as $$
begin
  perform set_config('flux.booking_event', tests.id(name)::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id(name);
  perform set_config('flux.booking_event', '', true);
end $$;
create function tests.plan(name text) returns public.event_plans language sql stable as $$
  select * from public.event_plans where event_id = tests.id(name);
$$;
create function tests.open(name text, who text default 'staff_a') returns jsonb language sql as $$
  select tests.as_user(who, format('select public.open_client_planning(%L)', tests.id(name)));
$$;
create function tests.invite(name text, invitation text) returns jsonb language sql as $$
  select tests.as_user('staff_a', format('select public.send_planning_invitation(%L, %L, %L)', tests.id(name), tests.id(invitation), tests.hash(invitation)));
$$;
create function tests.view(name text, who text default 'client_y') returns jsonb language sql as $$
  select tests.as_user(who, format('select public.client_planning_view(%L, %L)', tests.id(name), 'test-bouprod'));
$$;
create function tests.basics(name text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(name) and i.key = 'basics';
$$;
create function tests.save(name text, guests int default 90) returns jsonb language plpgsql as $$
declare v_rev int := coalesce((select revision from public.event_plan_responses where item_id = tests.basics(name)), 0);
begin
  return tests.as_user('client_y', format('select public.client_save_plan_item(%L, %L, %L, %s, %L)', tests.id(name), 'test-bouprod',
    tests.basics(name), v_rev, jsonb_build_object('guest_count', guests)));
end $$;
create function tests.save_basics(name text) returns jsonb language sql as $$
  select tests.as_user('client_y', format('select public.client_save_plan_basics(%L, %L, 0, %L)', tests.id(name), 'test-bouprod', '{"guest_count":50}'));
$$;
create function tests.opened_audits(name text) returns int language sql stable as $$
  select count(*)::int from public.audit_events where entity_id = tests.id(name) and action = 'planning_opened_to_client';
$$;
-- An invitation as earlier releases stored it (no opening involved).
create function tests.old_invitation(name text, invitation text, accepted boolean, revoked boolean) returns void language plpgsql as $$
begin
  insert into public.planning_invitations (id, tenant_id, event_id, client_id, email, token_hash, expires_at, invited_by,
                                           accepted_at, accepted_by, revoked_at, revoke_reason)
  values (tests.id(invitation), tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), 'client-y@example.test', tests.hash(invitation),
          now() + interval '7 days', tests.id('staff_a'),
          case when accepted then now() end, case when accepted then tests.id('client_y') end,
          case when revoked then now() end, case when revoked then 'replaced' end);
end $$;
-- The events in client Y's my_plans.
create function tests.my_plan_ids() returns uuid[] language plpgsql as $$
declare r uuid[];
begin
  perform tests.login_as(tests.id('client_y'));
  select coalesce(array_agg(event_id), '{}') into r from public.my_plans();
  perform tests.su();
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Backfill rule: plans a client could open before this release stay open
-- ===========================================================================
-- Event basics only from booking (no default template yet).
select tests.ev('b_basics'); select tests.book('b_basics');
select tests.ev('b_staff'); select tests.setup('b_staff'); select tests.book('b_staff');
select tests.ev('b_unbooked'); select tests.setup('b_unbooked');
select tests.ev('b_no_access', access => false); select tests.setup('b_no_access'); select tests.book('b_no_access');
select tests.ev('b_ext_new', 'external', false); select tests.setup('b_ext_new');
select tests.ev('b_ext_sent', 'external', false); select tests.setup('b_ext_sent'); select tests.old_invitation('b_ext_sent', 'old_sent', false, false);
select tests.ev('b_ext_accepted', 'external', true); select tests.setup('b_ext_accepted'); select tests.old_invitation('b_ext_accepted', 'old_accepted', true, true);
select tests.ev('b_ext_revoked', 'external', false); select tests.setup('b_ext_revoked'); select tests.old_invitation('b_ext_revoked', 'old_revoked', false, true);
-- A default template for weddings, then a booking that copies it.
select tests.as_user('staff_a', format('select to_jsonb(public.install_starter_planning_templates(%L))', tests.id('tenant_a')));
update public.planning_templates set default_event_type = 'wedding' where tenant_id = tests.id('tenant_a') and starter_key = 'wedding';
select tests.ev('b_template'); select tests.book('b_template');

select ok(private.plan_open_before_activation(tests.plan('b_template')), 'backfill: a booked plan from a default template with client access stays open');
select ok(private.plan_open_before_activation(tests.plan('b_staff')), 'backfill: a booked plan staff set up stays open');
select ok(not private.plan_open_before_activation(tests.plan('b_basics')), 'backfill: an Event basics only plan from booking stays closed');
select ok(not private.plan_open_before_activation(tests.plan('b_unbooked')), 'backfill: a plan on an unbooked event stays closed');
select ok(not private.plan_open_before_activation(tests.plan('b_no_access')), 'backfill: a booked plan no client can reach stays closed');
select ok(not private.plan_open_before_activation(tests.plan('b_ext_new')), 'backfill: a planning-only event not invited yet stays closed');
select ok(private.plan_open_before_activation(tests.plan('b_ext_sent')), 'backfill: a sent, unrevoked invitation keeps its plan open');
select ok(private.plan_open_before_activation(tests.plan('b_ext_accepted')), 'backfill: an accepted invitation keeps its plan open, even if later replaced');
select ok(not private.plan_open_before_activation(tests.plan('b_ext_revoked')), 'backfill: only revoked, never accepted invitations don''t');
-- A client whose access was revoked: their plan counts as having been open, but opening never restores access.
select tests.ev('b_revoked'); select tests.setup('b_revoked'); select tests.book('b_revoked');
update public.event_access set revoked_at = now() where event_id = tests.id('b_revoked');
select ok(private.plan_open_before_activation(tests.plan('b_revoked')), 'backfill: a plan whose only client access was revoked counts as having been open');
select tests.open_planning(tests.id('b_revoked'));
select is(tests.view('b_revoked') ->> 'state', 'unavailable', 'but the revoked client still gets nothing: opening grants no access');
select is(tests.save('b_revoked') ->> 'status', 'unavailable', 'and cannot save');

-- ===========================================================================
-- Booking never opens planning
-- ===========================================================================
select is((tests.plan('b_template')).client_opened_at, null, 'a booking from a default template leaves planning unopened');
select is(tests.view('b_template') ->> 'state', 'setting_up', 'the client sees that planning is being prepared');
select is((select array_agg(k order by k) from jsonb_object_keys(tests.view('b_template')) k), array['brand', 'event', 'state'],
  'with no structure, answers, editing or progress');
select is(tests.save('b_template') ->> 'status', 'unavailable', 'a direct client_save_plan_item call is refused');
select is(tests.save_basics('b_template') ->> 'status', 'unavailable', 'and client_save_plan_basics');
select is((select count(*)::int from public.event_plan_responses where plan_id = (tests.plan('b_template')).id), 0, 'nothing is stored');
select ok(not (tests.id('b_template') = any (tests.my_plan_ids())), 'my_plans leaves it out');
select is(tests.view('b_staff') ->> 'state', 'setting_up', 'a plan staff set up before the booking stays closed too');

-- Staff keep preparing it.
select is(tests.as_user('staff_a', format('select public.staff_save_plan_item(%L, %L, 0, %L)', tests.id('b_staff'), tests.basics('b_staff'), '{"guest_count":120}')) ->> 'status',
  'saved', 'staff fill planning in before opening it');
select ok(tests.as_user('staff_a', format('select public.staff_planning_view(%L)', tests.id('b_staff'))) -> 'plan' ->> 'client_opened_at' is null,
  'the staff view says it isn''t open to the client');
select lives_ok(format('select tests.as_user(%L, format(%L, %L, %s))', 'staff_a', 'select to_jsonb(public.set_event_plan_item_enabled(%L, %s, false))',
  (select i.id from public.event_plan_items i where i.plan_id = (tests.plan('b_template')).id and i.key = 'ceremony'), (tests.plan('b_template')).structure_version),
  'staff remove a section before opening');
select is(tests.view('b_template') ->> 'state', 'setting_up', 'structure changes don''t open it');

-- ===========================================================================
-- Dashboard: "Planning not open" for set-up, booked, upcoming events only
-- ===========================================================================
select tests.ev('dash_past', days => -3); select tests.setup('dash_past'); select tests.book('dash_past');
select tests.ev('dash_cancelled'); select tests.setup('dash_cancelled'); select tests.book('dash_cancelled');
set local session_replication_role = replica;
update public.events set lifecycle_status = 'cancelled' where id = tests.id('dash_cancelled');
set local session_replication_role = origin;
select is((select array_agg(x ->> 'title' order by x ->> 'title') from jsonb_array_elements(
            tests.as_user('staff_a', format('select public.staff_dashboard(%L)', tests.id('tenant_a'))) -> 'planning_not_open') x
           where x ->> 'title' in ('b_template', 'b_staff', 'b_basics', 'b_unbooked', 'b_ext_new', 'b_ext_sent', 'dash_past', 'dash_cancelled')),
  array['b_ext_new', 'b_ext_sent', 'b_staff', 'b_template'],
  'the dashboard lists set-up, booked (or booked elsewhere), upcoming plans not opened yet; never unset-up, unbooked, past or cancelled ones');
select throws_ok(format('select public.staff_dashboard(%L)', tests.id('tenant_a')), 'P0002', null, 'and only to staff');

-- ===========================================================================
-- Who can open, and what can't be opened
-- ===========================================================================
select throws_ok($$ select tests.open('b_staff', 'client_y') $$, 'P0002', null, 'a client cannot open planning');
select throws_ok($$ select tests.open('b_staff', 'owner_b') $$, 'P0002', null, 'nor staff of another business');
select throws_ok($$ select tests.open('b_staff', 'stranger') $$, 'P0002', null, 'nor a stranger');
select throws_ok(format('select public.open_client_planning(%L)', tests.id('b_staff')), 'P0002', null, 'nor anyone signed out');
select throws_like($$ select tests.open('b_unbooked') $$, '%isn''t booked yet%', 'an unbooked event cannot be opened');
select throws_like($$ select tests.open('b_basics') $$, '%set up planning%', 'nor one still awaiting setup');
select tests.ev('no_plan');
select throws_like($$ select tests.open('no_plan') $$, '%set up planning%', 'nor an event without planning');
select lives_ok($$ select tests.as_user('staff_a', format('select public.set_event_archived(%L, true)', tests.id('b_no_access'))) $$, 'staff archive an event');
select throws_like($$ select tests.open('b_no_access') $$, '%archived%', 'an archived event cannot be opened');
select lives_ok($$ select tests.as_user('staff_a', format('select public.set_event_archived(%L, false)', tests.id('b_no_access'))) $$, 'and unarchive it');
set local session_replication_role = replica;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok($$ select tests.open('b_staff') $$, 'PT423', null, 'a suspended workspace cannot open planning');
set local session_replication_role = replica;
update public.tenants set suspended_at = null where id = tests.id('tenant_a');
set local session_replication_role = origin;
select is((tests.plan('b_staff')).client_opened_at, null, 'none of these opened it');

-- ===========================================================================
-- Opening: one-way and idempotent
-- ===========================================================================
select is(tests.open('b_staff') ->> 'status', 'opened', 'staff open planning to the client');
select is((tests.plan('b_staff')).client_opened_by, tests.id('staff_a'), 'recording who opened it');
select is(tests.opened_audits('b_staff'), 1, 'audited');
select ok(not exists (select 1 from jsonb_array_elements(tests.as_user('staff_a', format('select public.staff_dashboard(%L)', tests.id('tenant_a'))) -> 'planning_not_open') x
                  where x ->> 'event_id' = tests.id('b_staff')::text), 'opening it clears the dashboard reminder');
select is(tests.view('b_staff') ->> 'state', 'available', 'the client sees the plan');
select is((tests.view('b_staff') -> 'basics' -> 'answers' ->> 'guest_count')::int, 120, 'with what staff prepared');
select is(tests.save('b_staff') ->> 'status', 'saved', 'and can save');
select ok(tests.id('b_staff') = any (tests.my_plan_ids()) and not (tests.id('b_template') = any (tests.my_plan_ids())),
  'my_plans lists it while another of the client''s plans stays unopened');
select (tests.plan('b_staff')).client_opened_at as first_opened \gset
select is(tests.open('b_staff', 'owner_a') ->> 'status', 'already_open', 'opening again changes nothing');
select is((tests.plan('b_staff')).client_opened_at, :'first_opened'::timestamptz, 'the first opening is kept');
select is(tests.opened_audits('b_staff'), 1, 'and audited once');
select is(tests.as_user('staff_a', format('select public.staff_planning_view(%L)', tests.id('b_staff'))) -> 'plan' ->> 'client_opened_by',
  'staff-a@example.test', 'the staff view names who opened it');

-- Only open_client_planning sets it, and nothing clears it.
select throws_ok($$ select tests.as_user('staff_a', format('update public.event_plans set client_opened_at = now() where event_id = %L returning to_jsonb(id)', tests.id('b_template'))) $$,
  '42501', null, 'staff cannot write the column directly');
select throws_ok(format('update public.event_plans set client_opened_at = now() where event_id = %L', tests.id('b_template')), '23514', null,
  'nor can any role without the opening function');
select set_config('flux.opening_plan', (tests.plan('b_staff')).id::text, true);
select throws_ok(format('update public.event_plans set client_opened_at = null, client_opened_by = null where event_id = %L', tests.id('b_staff')), '23514', null,
  'an opened plan is never closed again');
select set_config('flux.opening_plan', '', true);
select throws_ok(format('insert into public.event_plans (tenant_id, event_id, origin, initialized_via, client_cutoff_days, client_opened_at) values (%L, %L, %L, %L, 14, now())',
  tests.id('tenant_a'), tests.id('no_plan'), 'fallback', 'staff'), '23514', null, 'nor created already open');

-- Client editing stays the read-only switch.
select lives_ok($$ select tests.as_user('staff_a', format('select public.close_plan_client_editing(%L, %s, null)', tests.id('b_staff'), (tests.plan('b_staff')).client_cutoff_version)) $$,
  'staff close client editing on an opened plan');
select is(array[tests.view('b_staff') ->> 'state', tests.view('b_staff') -> 'editing' ->> 'state'], array['available', 'closed'],
  'the client reads it, read-only, rather than "setting up"');
select isnt((tests.plan('b_staff')).client_opened_at, null, 'still opened');

-- ===========================================================================
-- Opening after the deadline, or while editing is closed
-- ===========================================================================
select tests.ev('late', days => 3); select tests.setup('late'); select tests.book('late');
select (select planning_lock_at from public.events where id = tests.id('late')) as late_deadline \gset
select is(tests.open('late') - 'opened_at', '{"status": "opened", "editing": "closed"}'::jsonb, 'planning opens after the deadline, read-only');
select is((select planning_lock_at from public.events where id = tests.id('late')), :'late_deadline'::timestamptz, 'the deadline is unchanged');
select is(tests.view('late') -> 'editing' ->> 'state', 'closed', 'the client reads it read-only');
select is(tests.save('late') ->> 'status', 'locked', 'and their saves are refused');

select tests.ev('dj_closed'); select tests.setup('dj_closed'); select tests.book('dj_closed');
select tests.as_user('staff_a', format('select public.close_plan_client_editing(%L, %s, null)', tests.id('dj_closed'), (tests.plan('dj_closed')).client_cutoff_version));
select is(tests.open('dj_closed') ->> 'editing', 'closed', 'opening while staff closed editing keeps it closed');
select ok((select planning_client_closed_at is not null from public.events where id = tests.id('dj_closed')), 'nothing reopened it');

-- ===========================================================================
-- Open planning & send invitation: one transaction
-- ===========================================================================
select tests.ev('inv'); select tests.setup('inv'); select tests.book('inv');
select is(tests.invite('inv', 'inv_1') - array['invitation_id', 'expires_at'],
  '{"status": "sent", "replayed": false, "recipient_email": "client-y@example.test", "opened": true}'::jsonb,
  'sending the first invitation opens planning');
select is(array[(select count(*)::int from public.planning_invitations where event_id = tests.id('inv')),
                (select count(*)::int from public.email_outbox where entity_id = tests.id('inv_1') and status = 'pending'),
                tests.opened_audits('inv')],
  array[1, 1, 1], 'with the invitation and its queued email');
select is(tests.view('inv') ->> 'state', 'available', 'the client can plan');
select is(tests.invite('inv', 'inv_2') ->> 'opened', 'false', 'a new invitation finds planning already open');
select ok((select revoked_at is not null from public.planning_invitations where id = tests.id('inv_1')), 'and replaces the earlier link');
select is(tests.invite('inv', 'inv_2') - array['invitation_id', 'expires_at'],
  '{"status": "sent", "replayed": true, "recipient_email": "client-y@example.test", "opened": false}'::jsonb, 'a repeated submission is a replay');
select is((select count(*)::int from public.email_outbox where entity_type = 'planning_invitation' and entity_id in (tests.id('inv_1'), tests.id('inv_2'))), 2,
  'with no extra email');

-- A failed email never closes planning, and retrying works.
update public.email_outbox set status = 'failed', attempts = max_attempts, last_error = 'bounced' where entity_id = tests.id('inv_2');
select is(tests.view('inv') ->> 'state', 'available', 'a failed invitation email leaves planning open');
select is(tests.as_user('staff_a', format('select to_jsonb(public.retry_email_outbox(%L))',
  (select id from public.email_outbox where entity_id = tests.id('inv_2')))), 'true'::jsonb, 'staff retry it');
select is((select status from public.email_outbox where entity_id = tests.id('inv_2')), 'pending', 'queued again');

-- Sending is refused as before while editing is closed, and then opens nothing.
select tests.ev('inv_closed'); select tests.setup('inv_closed'); select tests.book('inv_closed');
select tests.as_user('staff_a', format('select public.close_plan_client_editing(%L, %s, null)', tests.id('inv_closed'), (tests.plan('inv_closed')).client_cutoff_version));
select throws_like($$ select tests.invite('inv_closed', 'inv_closed_1') $$, '%client editing is closed%', 'an invitation still needs open client editing');
select is(array[(tests.plan('inv_closed')).client_opened_at::text, (select count(*)::text from public.planning_invitations where event_id = tests.id('inv_closed'))],
  array[null, '0'], 'and nothing is opened or recorded');

-- Planning-only events: set up, then opened by the invitation the client accepts.
select tests.ev('ext', 'external', false); select tests.setup('ext');
select is((tests.plan('ext')).client_opened_at, null, 'a planning-only event''s planning starts unopened');
select is(tests.invite('ext', 'ext_1') ->> 'opened', 'true', 'its first invitation opens it');
select is(tests.as_user('client_y', format('select public.accept_planning_invitation(%L, %L)', tests.id('ext_1'), 'test-bouprod')) ->> 'state', 'accepted',
  'the client accepts');
select is(tests.view('ext') ->> 'state', 'available', 'and can plan');

-- An invitation sent before this release still works (its plan was kept open).
select tests.open_planning(tests.id('b_ext_sent'));
select is(tests.as_user('client_y', format('select public.accept_planning_invitation(%L, %L)', tests.id('old_sent'), 'test-bouprod')) ->> 'state', 'accepted',
  'an earlier invitation is accepted as before');
select is(tests.view('b_ext_sent') ->> 'state', 'available', 'into planning that stayed open');
select is(tests.as_user('staff_a', format('select public.staff_planning_view(%L)', tests.id('b_ext_sent'))) -> 'plan' ->> 'client_opened_by', 'Flux DJ',
  'a plan opened before this release names no staff member');

-- ===========================================================================
-- Archived events and removed access still win
-- ===========================================================================
select lives_ok($$ select tests.as_user('staff_a', format('select public.set_event_archived(%L, true)', tests.id('inv'))) $$, 'staff archive an opened event');
select is(tests.view('inv') ->> 'state', 'unavailable', 'the client loses planning');
select lives_ok($$ select tests.as_user('staff_a', format('select public.set_event_archived(%L, false)', tests.id('inv'))) $$, 'unarchived');
select is(tests.view('inv') ->> 'state', 'available', 'it is open again, without reopening');
update public.event_access set revoked_at = now() where event_id = tests.id('inv');
select is(tests.view('inv') ->> 'state', 'unavailable', 'revoked access gets nothing from an opened plan');

select * from finish();
rollback;
