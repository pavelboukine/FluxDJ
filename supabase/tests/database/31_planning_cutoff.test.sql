-- Planning cutoff and temporary reopening: the owner-only business setting;
-- the deadline (00:00 in the event's time zone, DST days included) copied
-- into each plan when it is set up and never moved silently; client writes
-- refused at and after it on every path while reads continue; staff edits
-- after it; reopening (only after the deadline, future, at most 14 days,
-- expiring by database time, never moving the deadline) and closing early;
-- deadline changes and explicit recalculation after schedule changes;
-- versions, replays, reasons and audit; revoked, archived and cross-tenant
-- access; client-safe responses; nothing else changed.
begin;
\ir _fixtures.psql
select plan(141);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('cutoff-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- A booked event (and so a plan) for client Y in tenant A, `days_ahead` days from today.
create function tests.booked(name text, days_ahead int, tz text default 'America/Toronto') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, timezone, internal_notes)
  values (tests.id(name), tests.id('tenant_a'), name, 'wedding', current_date + days_ahead, tz, 'CUTOFF SECRET NOTE');
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  perform set_config('flux.booking_event', tests.id(name)::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id(name);
  perform set_config('flux.booking_event', '', true);
  return tests.id(name);
end $$;
create function tests.basics(event text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(event) and i.key = 'basics';
$$;
create function tests.rev(event text) returns int language sql stable as $$
  select coalesce((select revision from public.event_plan_responses where item_id = tests.basics(event)), 0);
$$;
create function tests.stored(event text) returns jsonb language sql stable as $$
  select answers from public.event_plan_responses where item_id = tests.basics(event);
$$;
create function tests.save(event text, answers jsonb, who text default 'client_y', slug text default 'test-bouprod') returns jsonb language plpgsql as $$
declare r jsonb; v_item uuid := tests.basics(event); v_rev int := tests.rev(event);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_save_plan_item(tests.id(event), slug, v_item, v_rev, answers);
  perform tests.su();
  return r;
end $$;
create function tests.save_basics(event text, answers jsonb) returns jsonb language plpgsql as $$
declare r jsonb; v_rev int := tests.rev(event);
begin
  perform tests.login_as(tests.id('client_y'));
  r := public.client_save_plan_basics(tests.id(event), 'test-bouprod', v_rev, answers);
  perform tests.su();
  return r;
end $$;
create function tests.staff_save(event text, answers jsonb) returns jsonb language plpgsql as $$
declare r jsonb; v_item uuid := tests.basics(event); v_rev int := tests.rev(event);
begin
  perform tests.login_as(tests.id('staff_a'));
  r := public.staff_save_plan_item(tests.id(event), v_item, v_rev, answers);
  perform tests.su();
  return r;
end $$;
create function tests.view(event text, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.client_planning_view(tests.id(event), 'test-bouprod');
  perform tests.su();
  return r;
end $$;
create function tests.staff_view(event text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('staff_a'));
  r := public.staff_planning_view(tests.id(event));
  perform tests.su();
  return r;
end $$;
create function tests.version(event text) returns int language sql stable as $$
  select client_cutoff_version from public.event_plans where event_id = tests.id(event);
$$;
create function tests.lock_at(event text) returns timestamptz language sql stable as $$
  select planning_lock_at from public.events where id = tests.id(event);
$$;
create function tests.override(event text) returns timestamptz language sql stable as $$
  select planning_override_until from public.events where id = tests.id(event);
$$;
-- Moves the stored deadline or reopening, as time passing would.
create function tests.set_cutoff(event text, lock_at timestamptz, override timestamptz) returns void language sql as $$
  select private.set_plan_cutoff_columns(tests.id(event), lock_at, override);
$$;
-- Local wall time in the event's time zone, `delta` from now.
create function tests.local(event text, delta interval) returns timestamp language sql stable as $$
  select (clock_timestamp() + delta) at time zone (select timezone from public.events where id = tests.id(event));
$$;
-- Staff actions as a given user (staff_a by default); errors propagate after resetting the role.
create function tests.reopen(event text, ver int, until timestamp, reason text, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.reopen_plan_client_editing(tests.id(event), ver, until, reason);
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.close(event text, ver int, reason text, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.close_plan_client_editing(tests.id(event), ver, reason);
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.set_days(event text, ver int, days int, reason text, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.set_plan_client_cutoff(tests.id(event), ver, days, reason);
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.recalc(event text, ver int, reason text, confirm boolean, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.recalculate_plan_client_cutoff(tests.id(event), ver, reason, confirm);
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.audits(event text, act text) returns int language sql stable as $$
  select count(*)::int from public.audit_events where entity_id = tests.id(event) and action = act;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The business setting
-- ---------------------------------------------------------------------------

select is((select planning_lock_days from public.tenants where id = tests.id('tenant_a')), 14, 'businesses start at 14 days');
select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'planning_lock_days'),
  '14', 'the column default is 14');

-- Plans set up now take 14; the deadline is 00:00 local on the date minus 14 days.
select tests.booked('co_open', 60);
select tests.booked('co_closed', 3);
select tests.booked('co_late', 200);
select is((select client_cutoff_days from public.event_plans where event_id = tests.id('co_open')), 14, 'a new plan copies the business''s days');
select is(tests.lock_at('co_open'), ((current_date + 46)::timestamp at time zone 'America/Toronto'), 'the deadline is 00:00 in the event''s time zone, 14 days before');
select is(to_char(tests.lock_at('co_open') at time zone 'America/Toronto', 'HH24:MI'), '00:00', 'at midnight local time');
select is(tests.override('co_open'), null, 'with no reopening');
select is(tests.stored('co_open'), null, 'and no answers are invented');
select is((select (metadata ->> 'client_cutoff_days')::int from public.audit_events where entity_id = tests.id('co_open') and action = 'planning_initialized'), 14,
  'the setup audit records the days');

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), 21, 0) $$, '42501', null, 'staff can''t change the setting');
select throws_ok($$ update public.tenants set planning_lock_days = 1 where id = tests.id('tenant_a') $$, '42501', null, 'nor write the column');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), 21, 0) $$, 'P0002', null, 'another business''s owner gets nothing');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), 21, 0) $$, 'P0002', null, 'clients get nothing');
select tests.login_as_anon();
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), 21, 0) $$, '42501', null, 'anon can''t call it');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.tenants set planning_lock_days = 1 where id = tests.id('tenant_a') $$, '42501', null, 'the owner can''t write the column directly');
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), -1, 0) $$, '22023', 'settings_invalid: enter a whole number of days from 0 to 365', 'negative days are refused');
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), 366, 0) $$, '22023', null, 'more than 365 are refused');
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), null, 0) $$, '22023', null, 'missing days are refused');
select throws_ok($$ select public.update_planning_cutoff_days(tests.id('tenant_a'), 21, 5) $$, 'PT409', null, 'a stale version is refused');
select is(public.update_planning_cutoff_days(tests.id('tenant_a'), 21, 0), 1, 'the owner sets 21 days');
select is(public.update_planning_cutoff_days(tests.id('tenant_a'), 0, 1), 2, 'and 0 (closes at the start of the event day)');
select is(public.update_planning_cutoff_days(tests.id('tenant_a'), 21, 2), 3, 'and back to 21');
select tests.su();
select ok(exists (select 1 from public.audit_events where entity_id = tests.id('tenant_a') and action = 'planning_cutoff_days_changed'
                  and metadata = '{"before": 14, "after": 21}' and actor_id = tests.id('owner_a')),
  'the change is audited with the owner, before and after');

-- Existing plans keep their days and deadline; new plans take the new setting.
select is((select client_cutoff_days from public.event_plans where event_id = tests.id('co_open')), 14, 'existing plans keep their days');
select is(tests.lock_at('co_open'), ((current_date + 46)::timestamp at time zone 'America/Toronto'), 'and their deadline');
select tests.booked('co_new', 60);
select is((select client_cutoff_days from public.event_plans where event_id = tests.id('co_new')), 21, 'a plan set up afterwards takes 21 days');
select is(tests.lock_at('co_new'), ((current_date + 39)::timestamp at time zone 'America/Toronto'), 'and its deadline follows');

-- A deadline already on the event when planning is set up is kept.
insert into public.events (id, tenant_id, title, event_type, event_date) values (tests.id('co_preset'), tests.id('tenant_a'), 'Preset', 'wedding', current_date + 90);
select tests.set_cutoff('co_preset', '2030-01-01 00:00+00', null);
select tests.login_as(tests.id('staff_a'));
select public.setup_event_plan(tests.id('co_preset'), null);
select tests.su();
select is(tests.lock_at('co_preset'), '2030-01-01 00:00+00'::timestamptz, 'setup keeps a deadline the event already had');

-- ---------------------------------------------------------------------------
-- Deadline arithmetic: time zones, DST days, midnight that doesn't exist or repeats
-- ---------------------------------------------------------------------------

select is(private.planning_cutoff_at('2027-03-28', 'America/Toronto', 14), '2027-03-14 05:00+00'::timestamptz, 'Toronto, DST starts that day at 2:00: midnight is still EST');
select is(private.planning_cutoff_at('2027-03-29', 'America/Toronto', 14), '2027-03-15 04:00+00'::timestamptz, 'the day after: EDT');
select is(private.planning_cutoff_at('2027-11-21', 'America/Toronto', 14), '2027-11-07 04:00+00'::timestamptz, 'DST ends that day at 2:00: midnight is still EDT');
select is(private.planning_cutoff_at('2027-11-22', 'America/Toronto', 14), '2027-11-08 05:00+00'::timestamptz, 'the day after: EST');
select is(private.planning_cutoff_at('2024-03-24', 'America/Havana', 14), '2024-03-10 05:00+00'::timestamptz, 'Havana skips midnight: the deadline is 01:00, the first moment of that day');
select is(private.planning_cutoff_at('2024-11-17', 'America/Havana', 14), '2024-11-03 04:00+00'::timestamptz, 'Havana repeats midnight: the first 00:00');
select is(private.planning_cutoff_at('2024-04-14', 'Asia/Beirut', 14), '2024-03-30 22:00+00'::timestamptz, 'Beirut skips midnight: 01:00 local');
select is(private.planning_cutoff_at('2027-01-15', 'Asia/Kathmandu', 14), '2026-12-31 18:15+00'::timestamptz, 'quarter-hour offsets (UTC+5:45)');
select is(private.planning_cutoff_at('2027-01-15', 'Europe/Paris', 0), '2027-01-14 23:00+00'::timestamptz, '0 days: the start of the event day');
select is(private.planning_cutoff_at('2027-01-15', 'Pacific/Auckland', 1), '2027-01-13 11:00+00'::timestamptz, 'east of UTC the deadline is the previous UTC day');

-- Events in other zones: the deadline follows the event's zone, not the business's.
select tests.booked('co_paris', 120, 'Europe/Paris');
select is(to_char(tests.lock_at('co_paris') at time zone 'Europe/Paris', 'HH24:MI'), '00:00', 'a Paris event closes at midnight in Paris');
select is((tests.lock_at('co_paris') at time zone 'Europe/Paris')::date, current_date + 120 - 21, 'on its date minus the plan''s days');

-- No start time is needed: Event basics without times still has a deadline.
select ok(tests.stored('co_new') is null and tests.lock_at('co_new') is not null, 'events without a known start time have a deadline');

-- States at the boundary.
select is(private.plan_editing_state('2027-01-01 05:00+00', null, '2027-01-01 04:59:59.999999+00'), 'open', 'a microsecond before the deadline: open');
select is(private.plan_editing_state('2027-01-01 05:00+00', null, '2027-01-01 05:00+00'), 'closed', 'exactly at the deadline: closed');
select is(private.plan_editing_state('2027-01-01 05:00+00', null, '2027-01-02 00:00+00'), 'closed', 'after it: closed');
select is(private.plan_editing_state('2027-01-01 05:00+00', '2027-01-03 00:00+00', '2027-01-02 00:00+00'), 'reopened', 'during a reopening: reopened');
select is(private.plan_editing_state('2027-01-01 05:00+00', '2027-01-03 00:00+00', '2027-01-03 00:00+00'), 'closed', 'exactly at the reopening''s end: closed');
select is(private.plan_editing_state('2027-01-01 05:00+00', '2026-12-31 00:00+00', '2026-12-31 12:00+00'), 'open', 'an old reopening never closes an open plan');

-- ---------------------------------------------------------------------------
-- Clients before and after the deadline
-- ---------------------------------------------------------------------------

select is(tests.view('co_open') -> 'editing' ->> 'state', 'open', 'the client sees an open plan');
select is((select array_agg(k order by k) from jsonb_object_keys(tests.view('co_open') -> 'editing') k), array['closes_at', 'deadline', 'state', 'timezone'],
  'and only the state, deadline, closing time and time zone');
select is((tests.view('co_open') -> 'editing' ->> 'closes_at')::timestamptz, tests.lock_at('co_open'), 'editing closes at the deadline');
select is(tests.view('co_open') -> 'editing' ->> 'timezone', 'America/Toronto', 'in the event''s time zone');
select is(tests.save('co_open', '{"guest_count": 120}') ->> 'status', 'saved', 'clients save before the deadline');

select is(tests.view('co_closed') ->> 'state', 'available', 'after the deadline the client still opens the plan');
select is(tests.view('co_closed') -> 'editing' ->> 'state', 'closed', 'read-only');
select is(tests.view('co_closed') -> 'editing' -> 'closes_at', 'null'::jsonb, 'with nothing closing later');
select is(tests.staff_save('co_closed', '{"guest_count": 80}') ->> 'status', 'saved', 'staff still edit after the deadline');
select is(tests.save('co_closed', '{"guest_count": 99}') ->> 'status', 'locked', 'client_save_plan_item is refused');
select is((select array_agg(k order by k) from jsonb_object_keys(tests.save('co_closed', '{"guest_count": 99}')) k), array['editing', 'status'],
  'with only the status and the client-safe editing state');
select is(tests.save_basics('co_closed', '{"guest_count": 99}') ->> 'status', 'locked', 'client_save_plan_basics is refused too');
select is(tests.save('co_closed', '{"guest_count": -5}') ->> 'status', 'locked', 'invalid answers get the lock, not a validation message');
select tests.basics('co_closed') as closed_item \gset
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('co_closed'), 'test-bouprod', :'closed_item', 0, '{"guest_count": 99}') ->> 'status', 'locked',
  'a stale revision gets the lock too');
select tests.su();
select is(tests.stored('co_closed'), '{"guest_count": 80}'::jsonb, 'refused saves change nothing');
select is(tests.rev('co_closed'), 1, 'not even the revision');
select is(tests.view('co_closed') -> 'basics' -> 'answers', '{"guest_count": 80}'::jsonb, 'the client reads the saved answers');
select is(tests.view('co_closed') -> 'progress', tests.staff_view('co_closed') -> 'progress', 'progress is the same for both');
select is(tests.view('co_closed') -> 'progress' -> 'items' -> 0 ->> 'state', 'in_progress', 'and the deadline completes nothing');

-- A deadline passing: move the stored deadline to just now.
select tests.set_cutoff('co_new', clock_timestamp(), null);
select is(tests.save('co_new', '{"guest_count": 50}') ->> 'status', 'locked', 'a save at or just after the deadline is refused');
select is(tests.stored('co_new'), null, 'and saves nothing');

-- ---------------------------------------------------------------------------
-- Reopening and closing
-- ---------------------------------------------------------------------------

select is(tests.reopen('co_open', 1, tests.local('co_open', '2 days'), 'Client asked') ->> 'status',
  'already_open', 'reopening an open plan explains it is already open');
select is(tests.override('co_open'), null, 'and changes nothing');
select is(tests.version('co_open'), 1, 'not even the version');

select throws_ok($$ select tests.reopen('co_closed', 1, tests.local('co_closed', '2 days'), '  ') $$,
  '22023', 'planning_invalid: enter a reason (it is kept in the history and never shown to the client)', 'a reason is required');
select throws_ok($$ select tests.reopen('co_closed', 1, tests.local('co_closed', '-1 minute'), 'Late change') $$,
  '22023', 'planning_invalid: choose an end time in the future', 'the expiry must be in the future');
select throws_ok($$ select tests.reopen('co_closed', 1, tests.local('co_closed', '14 days 1 minute'), 'Late change') $$,
  '22023', null, 'and at most 14 days away');
select throws_ok($$ select tests.reopen('co_closed', 7, tests.local('co_closed', '2 days'), 'Late change') $$,
  'PT409', null, 'a stale version is refused');
select throws_ok($$ select tests.reopen('co_closed', 1, tests.local('co_closed', '2 days'), 'x', 'client_y') $$,
  'P0002', null, 'clients can''t reopen');
select throws_ok($$ select tests.reopen('co_closed', 1, tests.local('co_closed', '2 days'), 'x', 'owner_b') $$,
  'P0002', null, 'another business can''t reopen');
select tests.login_as_anon();
select throws_ok(format($$ select public.reopen_plan_client_editing(%L, 1, now()::timestamp, 'x') $$, tests.id('co_closed')), '42501', null, 'anon can''t call it');
select tests.su();

select tests.lock_at('co_closed') as closed_deadline \gset
select tests.local('co_closed', '2 days') as until_local \gset
select is(tests.reopen('co_closed', 1, :'until_local', 'Guest count changed after the deadline') ->> 'status',
  'reopened', 'staff reopen until a time in the event''s zone');
select is(tests.override('co_closed'), :'until_local'::timestamp at time zone 'America/Toronto', 'the expiry is stored');
select is(tests.lock_at('co_closed'), :'closed_deadline'::timestamptz, 'the deadline is not moved');
select is(tests.version('co_closed'), 2, 'the version moves');
select is(tests.view('co_closed') -> 'editing' ->> 'state', 'reopened', 'the client sees the reopening');
select is((tests.view('co_closed') -> 'editing' ->> 'closes_at')::timestamptz, tests.override('co_closed'), 'with its exact end');
select is(tests.save('co_closed', '{"guest_count": 95}') ->> 'status', 'saved', 'the client saves during the reopening');
select is(tests.stored('co_closed'), '{"guest_count": 95}'::jsonb, 'answers are kept, never cleared');
select is(tests.reopen('co_closed', 1, :'until_local', 'Guest count changed after the deadline') ->> 'status',
  'unchanged', 'a repeated click (stale version, same expiry) is the same reopening');
select is(tests.audits('co_closed', 'planning_client_reopened'), 1, 'audited once');
select throws_ok($$ select tests.reopen('co_closed', 1, tests.local('co_closed', '3 days'), 'Other') $$,
  'PT409', null, 'a different expiry from a stale tab is refused');
select ok((select metadata ->> 'reason' = 'Guest count changed after the deadline' and actor_id = tests.id('staff_a') and actor_type = 'staff'
                  and metadata -> 'before' ->> 'reopened_until' is null and (metadata -> 'after' ->> 'reopened_until')::timestamptz = tests.override('co_closed')
                  and (metadata ->> 'at') is not null
           from public.audit_events where entity_id = tests.id('co_closed') and action = 'planning_client_reopened'),
  'the audit has the staff user, database time, reason and before/after');
select ok(tests.view('co_closed')::text not like '%Guest count changed%' and tests.view('co_closed')::text not like '%staff-a@%'
          and tests.view('co_closed')::text not like '%CUTOFF SECRET%' and tests.view('co_closed')::text not like '%One more%',
  'the client view has no reason, staff identity or notes');
select ok(tests.staff_view('co_closed') -> 'editing' -> 'history' -> 0 ->> 'reason' = 'Guest count changed after the deadline'
          and tests.staff_view('co_closed') -> 'editing' -> 'history' -> 0 ->> 'actor' = 'staff-a@example.test',
  'staff see the history with reasons and who');
select is((tests.staff_view('co_closed') -> 'editing' ->> 'reopen_active')::boolean, true, 'and that the reopening is active');
select is(tests.staff_view('co_open') -> 'editing' -> 'reopen_active', 'false'::jsonb, 'without a reopening it reads false, never null');

-- Expiry by database time, with no job. (Reads use the request's time, which
-- here is the start of this test's transaction.)
select tests.set_cutoff('co_closed', tests.lock_at('co_closed'), now());
select is(tests.save('co_closed', '{"guest_count": 96}') ->> 'status', 'locked', 'an expired reopening refuses saves');
select is(tests.view('co_closed') -> 'editing' ->> 'state', 'closed', 'and reads as closed');
select is(tests.stored('co_closed'), '{"guest_count": 95}'::jsonb, 'with the answers kept');

-- Closing early.
select is(tests.close('co_closed', 2, 'Nothing to end') ->> 'status',
  'not_reopened', 'closing an expired reopening changes nothing');
select is(tests.reopen('co_closed', 2, tests.local('co_closed', '1 day'), 'One more change') ->> 'status',
  'reopened', 'staff reopen again');
select throws_ok($$ select tests.close('co_closed', 3, '') $$,
  '22023', null, 'closing needs a reason');
select throws_ok($$ select tests.close('co_closed', 2, 'Done') $$,
  'PT409', null, 'closing from a stale tab is refused while the reopening is active');
select is(tests.close('co_closed', 3, 'Client confirmed, done') ->> 'status',
  'closed', 'staff close client editing now');
select is(tests.override('co_closed'), null, 'the reopening ends');
select is(tests.lock_at('co_closed'), :'closed_deadline'::timestamptz, 'the deadline stays');
select is(tests.save('co_closed', '{"guest_count": 97}') ->> 'status', 'locked', 'client saves are refused again');
select is(tests.close('co_closed', 3, 'Again') ->> 'status',
  'not_reopened', 'a repeated close changes nothing');
select is(tests.audits('co_closed', 'planning_client_reopen_closed'), 1, 'and is audited once');
select is(tests.close('co_open', 1, 'Close it') ->> 'status',
  'already_open', 'closing never closes a plan before its deadline');
select is(tests.save('co_open', '{"guest_count": 121}') ->> 'status', 'saved', 'which stays open');

-- ---------------------------------------------------------------------------
-- Changing the deadline, and schedule changes
-- ---------------------------------------------------------------------------

select throws_ok($$ select tests.set_days('co_open', 1, 400, 'x') $$, '22023', null, 'days above 365 are refused');
select throws_ok($$ select tests.set_days('co_open', 1, 30, '') $$, '22023', null, 'a reason is required');
select throws_ok($$ select tests.set_days('co_open', 9, 30, 'x') $$, 'PT409', null, 'a stale version is refused');
select is(tests.set_days('co_open', 1, 30, 'Venue needs the plan earlier') ->> 'status',
  'changed', 'staff set other days for this plan');
select is(tests.lock_at('co_open'), ((current_date + 30)::timestamp at time zone 'America/Toronto'), 'the deadline follows the new days');
select is((select client_cutoff_days from public.event_plans where event_id = tests.id('co_open')), 30, 'which the plan records');
select is((select client_cutoff_days from public.event_plans where event_id = tests.id('co_late')), 14, 'other plans are untouched');
select is(tests.set_days('co_open', 1, 30, 'Venue needs the plan earlier') ->> 'status',
  'unchanged', 'a repeated click is the same change');
select ok((select (metadata -> 'before' ->> 'days')::int = 14 and (metadata -> 'after' ->> 'days')::int = 30 and metadata ->> 'reason' = 'Venue needs the plan earlier'
           from public.audit_events where entity_id = tests.id('co_open') and action = 'planning_cutoff_changed'), 'audited with before and after');

-- Two staff tabs: the second (stale) gets a conflict, never a silent overwrite.
select throws_ok($$ select tests.set_days('co_open', 1, 7, 'Other tab', 'owner_a') $$, 'PT409', null,
  'a second staff change from a stale tab conflicts');

-- The event moves: the deadline stays, staff see it no longer matches.
update public.events set event_date = event_date + 10, timezone = 'America/Vancouver' where id = tests.id('co_open');
select is(tests.lock_at('co_open'), ((current_date + 30)::timestamp at time zone 'America/Toronto'), 'changing the date and zone doesn''t move the deadline');
select is((tests.staff_view('co_open') -> 'editing' ->> 'schedule_changed')::boolean, true, 'staff see it no longer matches the schedule');
select is((tests.staff_view('co_open') -> 'editing' ->> 'expected_deadline')::timestamptz, ((current_date + 40)::timestamp at time zone 'America/Vancouver'),
  'and what the current schedule gives');
select throws_ok($$ select tests.recalc('co_open', 2, 'Date moved', false) $$, '22023', null,
  'recalculating needs confirmation');
select is(tests.recalc('co_open', 2, 'Wedding moved by ten days', true) ->> 'status',
  'recalculated', 'staff recalculate explicitly');
select is(tests.lock_at('co_open'), ((current_date + 40)::timestamp at time zone 'America/Vancouver'), 'from the new date and zone, with the plan''s days');
select is((tests.staff_view('co_open') -> 'editing' ->> 'schedule_changed')::boolean, false, 'and it matches again');
select is(tests.audits('co_open', 'planning_cutoff_recalculated'), 1, 'audited');
select is(tests.stored('co_open'), '{"guest_count": 121}'::jsonb, 'answers untouched throughout');

-- ---------------------------------------------------------------------------
-- Guards: direct writes, archiving, revoked access, other businesses
-- ---------------------------------------------------------------------------

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ update public.events set planning_override_until = now() + interval '1 day' where id = tests.id('co_closed') $$, '42501', null,
  'staff can''t write the reopening directly');
select throws_ok($$ update public.events set planning_lock_at = now() + interval '1 day' where id = tests.id('co_closed') $$, '42501', null,
  'nor the deadline');
select throws_ok($$ update public.event_plans set client_cutoff_days = 1 $$, '42501', null, 'nor the plan''s days');
select tests.su();
select throws_ok($$ update public.events set planning_override_until = now() + interval '1 day' where id = tests.id('co_closed') $$, '23514', null,
  'even trusted code changes them only through the cutoff functions');

-- Archived: no client reads or writes, no reopening.
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('co_late'), true);
select tests.su();
select throws_ok($$ select tests.set_days('co_late', 1, 20, 'x') $$, '22023',
  'planning_invalid: the event is archived. Unarchive it before changing its planning', 'archived events can''t change their deadline');
select tests.set_cutoff('co_late', clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day');
select is(tests.save('co_late', '{"guest_count": 10}') ->> 'status', 'unavailable', 'a reopening never bypasses archiving');
select is(tests.view('co_late') ->> 'state', 'unavailable', 'nor does it show the plan');

-- Revoked access during a reopening.
update public.event_access set revoked_at = now() where event_id = tests.id('co_paris');
select tests.set_cutoff('co_paris', clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day');
select is(tests.save('co_paris', '{"guest_count": 10}') ->> 'status', 'unavailable', 'nor revoked access');

-- Another business's client and slug.
select is(tests.save('co_open', '{"guest_count": 10}', 'client_x') ->> 'status', 'unavailable', 'another client gets nothing');
select is(tests.save('co_open', '{"guest_count": 10}', 'client_y', 'test-other-dj') ->> 'status', 'unavailable', 'a wrong business slug gets nothing');
select format($$ select public.client_save_plan_item(%L, 'test-bouprod', %L, 0, '{}') $$, tests.id('co_open'), tests.basics('co_open')) as anon_save \gset
select tests.login_as_anon();
select throws_ok(:'anon_save', '42501', null,
  'anon can''t call the save');
select tests.su();

-- Every existing plan has a deadline (backfill and setup).
select is_empty($$ select p.id from public.event_plans p join public.events e on e.id = p.event_id where e.planning_lock_at is null $$,
  'every plan has an established deadline');

-- Nothing contractual or lifecycle changed.
select is((select array_agg(distinct lifecycle_status) from public.events where id in (tests.id('co_open'), tests.id('co_closed'), tests.id('co_new'))), array['booked'],
  'booking status is unchanged');
select is((select count(*)::int from public.email_outbox where entity_id in (tests.id('co_open'), tests.id('co_closed'))), 0, 'and no email is queued');

select * from finish();
rollback;
