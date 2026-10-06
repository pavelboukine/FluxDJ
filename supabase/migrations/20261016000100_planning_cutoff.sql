-- Planning cutoff and temporary staff reopening.
--
-- Reuses the columns the tenancy migration reserved for this (never used
-- until now, and never shown in any screen):
--   tenants.planning_lock_days     the business's setting: how many calendar
--                                  days before the event client planning edits
--                                  close. Whole days, 0 to 365 (0 closes at the
--                                  start of the event day). Default 14. Changed
--                                  only by the owner through
--                                  update_planning_cutoff_days (versioned).
--   events.planning_lock_at        the event's established deadline.
--   events.planning_override_until a temporary reopening's expiry.
-- and adds, on the plan, the days its deadline was computed with
-- (event_plans.client_cutoff_days, copied from the business when the plan is
-- set up) and a version for staff changes (client_cutoff_version).
--
-- Deadline. 00:00 in the event's time zone on (event date - days). Where the
-- clocks skip midnight that day (DST starting at midnight, e.g. Havana,
-- Santiago, Beirut), it is the first moment of that day (01:00); where
-- midnight happens twice, the first one. private.planning_cutoff_at computes
-- it. The deadline is stored when the plan is set up (booking, staff setup or
-- this migration's backfill) and never recomputed silently: changing the
-- business setting affects plans set up afterwards only, and changing the
-- event's date or time zone leaves the deadline where it was. Staff see when
-- it no longer matches the schedule and recalculate it explicitly
-- (recalculate_plan_client_cutoff), or set other days for this plan
-- (set_plan_client_cutoff); both need a reason and the plan's cutoff version.
-- The event's start time plays no part, so events without one have a deadline.
--
-- Client editing state at time t (database time), private.plan_editing_state:
--   open      t < deadline
--   reopened  t >= deadline and t < planning_override_until
--   closed    otherwise (also exactly at the deadline or the expiry)
-- Clients still read their plan when it is closed; only writes stop.
--
-- Enforcement. Every client planning write (client_save_plan_item and
-- client_save_plan_basics, the only ones) goes through
-- private.client_plan_write_access, which keeps the existing checks (signed
-- in, verified event access, booked, enabled item, nothing archived) and,
-- after locking the event (share) and the plan (update), compares the
-- deadline and reopening read from those locked rows with clock_timestamp()
-- -- not now(), which is the transaction's start and could be before a lock
-- wait that crossed the deadline. A refused save returns
-- {"status":"locked","editing":{...}} and changes nothing. No scheduled job is
-- involved: the state is evaluated on every request.
--
-- Staff. Staff saves are unchanged: they keep working after the deadline
-- (still refused while the event is archived). Staff actions:
--   reopen_plan_client_editing   until a future time within 14 days (event
--                                local time), only once the deadline has
--                                passed; replacing an active reopening is
--                                allowed. Never moves the deadline.
--   close_plan_client_editing    ends an active reopening now. It never closes
--                                a plan whose deadline hasn't arrived.
--   set_plan_client_cutoff       other days for this plan, recomputed from the
--                                current schedule.
--   recalculate_plan_client_cutoff  the plan's days, recomputed from the
--                                current schedule (explicit confirmation).
-- Each locks the event (no key update) and then the plan, the order every
-- planning write already uses, so they serialize with client saves (event
-- share), archiving (event update) and each other; checks the cutoff version;
-- needs a reason; and writes an audit event with the staff user, database
-- time, reason and before/after values. Reasons and staff identities are
-- never returned to clients. A reopening can't bypass archiving or revoked
-- access: those are checked first, as before.
--
-- Nothing here changes answers, progress, contracts, prices, payments,
-- booking or emails.
--
-- Existing plans. Businesses still at the old untouched default (7, never
-- configurable) move to 14. Each existing plan gets its business's days and,
-- unless one was already set, the deadline computed from the event's current
-- date and time zone, with one audit event each. Plans already past it become
-- read-only for clients at once (staff can reopen them); nothing is emailed
-- and no booking status changes.

-- ===========================================================================
-- Business setting
-- ===========================================================================

alter table public.tenants add column planning_settings_version integer not null default 0
  constraint tenants_planning_settings_version_nonnegative check (planning_settings_version >= 0);
alter table public.tenants alter column planning_lock_days set default 14;
alter table public.tenants disable trigger user;
update public.tenants set planning_lock_days = 14 where planning_lock_days = 7;
alter table public.tenants enable trigger user;
revoke update (planning_lock_days) on public.tenants from authenticated;
comment on column public.tenants.planning_lock_days is
  'Calendar days before the event when client planning edits close (0-365, default 14). Copied into each plan when it is set up; owner only, via update_planning_cutoff_days.';

create function public.update_planning_cutoff_days(p_tenant_id uuid, p_days integer, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  t public.tenants%rowtype;
  v_before integer;
begin
  select m.role into v_role from public.tenant_memberships m where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change the planning deadline' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if p_expected_version is null or t.planning_settings_version <> p_expected_version then
    raise exception 'planning settings were changed elsewhere' using errcode = 'serialization_failure';
  end if;
  if p_days is null or p_days < 0 or p_days > 365 then
    raise exception 'settings_invalid: enter a whole number of days from 0 to 365' using errcode = 'invalid_parameter_value';
  end if;
  v_before := t.planning_lock_days;
  update public.tenants set planning_lock_days = p_days, planning_settings_version = planning_settings_version + 1
  where id = t.id returning * into t;
  perform private.audit(t.id, 'tenant', t.id, 'planning_cutoff_days_changed', 'staff', (select auth.uid()),
    jsonb_build_object('before', v_before, 'after', p_days));
  return t.planning_settings_version;
end;
$$;

-- ===========================================================================
-- Deadline columns
-- ===========================================================================

alter table public.event_plans
  add column client_cutoff_days integer
    constraint event_plans_client_cutoff_days_range check (client_cutoff_days between 0 and 365),
  add column client_cutoff_version integer not null default 1
    constraint event_plans_client_cutoff_version_positive check (client_cutoff_version >= 1);
comment on column public.event_plans.client_cutoff_days is
  'Days before the event the client deadline was computed with: the business setting when the plan was set up, or set by staff.';
comment on column public.event_plans.client_cutoff_version is
  'Optimistic version of the client deadline and reopening (events.planning_lock_at, planning_override_until).';

comment on column public.events.planning_lock_at is
  'Client planning deadline, set when the plan is set up and changed only by explicit staff actions. Clients can''t edit at or after it.';
comment on column public.events.planning_override_until is
  'Temporary reopening: clients can edit after the deadline until this time. Set and cleared only by staff actions.';

-- Staff used to have direct grants on these; only the functions below write them now.
revoke insert (planning_lock_at) on public.events from authenticated;
revoke update (planning_lock_at, planning_override_until) on public.events from authenticated;

create function private.events_planning_cutoff_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.planning_lock_at is not null or new.planning_override_until is not null))
     or (tg_op = 'UPDATE' and (new.planning_lock_at is distinct from old.planning_lock_at
                               or new.planning_override_until is distinct from old.planning_override_until)) then
    if current_setting('flux.planning_cutoff_event', true) is distinct from new.id::text then
      raise exception 'the planning deadline changes only through the planning cutoff functions' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger events_planning_cutoff_guard before insert or update of planning_lock_at, planning_override_until on public.events
  for each row execute function private.events_planning_cutoff_guard();

-- ===========================================================================
-- Deadline and state
-- ===========================================================================

-- The first moment of (event date - days) in the time zone: 00:00, or the
-- first moment of that day when the clocks skip or repeat midnight. UTC
-- offsets are multiples of 15 minutes, so stepping back in quarter hours
-- from Postgres's reading of 00:00 finds it exactly.
create function private.planning_cutoff_at(p_event_date date, p_timezone text, p_days integer)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(x.at)
  from (select ((p_event_date - p_days)::timestamp at time zone p_timezone) - make_interval(mins => 15 * k) as at
        from generate_series(0, 12) k) x
  where (x.at at time zone p_timezone)::date = p_event_date - p_days;
$$;

create function private.plan_editing_state(p_deadline timestamptz, p_override timestamptz, p_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_at < p_deadline then 'open'
              when p_override is not null and p_at < p_override then 'reopened'
              else 'closed' end;
$$;

-- The deadline in force for an event and its plan (computed from the plan's
-- days only if none was ever stored, which the setup and backfill prevent).
create function private.plan_deadline(p_event public.events, p_plan public.event_plans)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select coalesce(p_event.planning_lock_at,
                  private.planning_cutoff_at(p_event.event_date, p_event.timezone, coalesce(p_plan.client_cutoff_days, 14)));
$$;

-- What a client may know: the state, the normal deadline, when editing
-- closes (the deadline, or the reopening's expiry) and the time zone. No
-- reasons, no staff, no versions.
create function private.plan_client_editing(p_event public.events, p_plan public.event_plans, p_at timestamptz)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_deadline timestamptz := private.plan_deadline(p_event, p_plan);
  v_override timestamptz := case when p_event.planning_override_until > p_at then p_event.planning_override_until end;
  v_state text := private.plan_editing_state(v_deadline, p_event.planning_override_until, p_at);
begin
  return jsonb_build_object(
    'state', v_state,
    'deadline', v_deadline,
    'closes_at', case when v_state = 'closed' then null else greatest(v_deadline, v_override) end,
    'timezone', p_event.timezone);
end;
$$;

-- Staff: the client state plus the plan's days, what the current schedule
-- gives, the reopening, the version and the recent history with reasons.
create function private.plan_staff_editing(p_event public.events, p_plan public.event_plans)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- A read: the statement's time is enough (writes recheck with clock_timestamp()).
  v_at timestamptz := now();
  v_deadline timestamptz := private.plan_deadline(p_event, p_plan);
  v_days integer := coalesce(p_plan.client_cutoff_days, 14);
  v_expected timestamptz := private.planning_cutoff_at(p_event.event_date, p_event.timezone, v_days);
begin
  return private.plan_client_editing(p_event, p_plan, v_at) || jsonb_build_object(
    'now', v_at,
    'cutoff_days', v_days,
    'business_days', (select t.planning_lock_days from public.tenants t where t.id = p_event.tenant_id),
    'expected_deadline', v_expected,
    'schedule_changed', v_expected is distinct from v_deadline,
    'reopened_until', p_event.planning_override_until,
    'reopen_active', coalesce(p_event.planning_override_until > v_at and v_at >= v_deadline, false),
    'reopen_max_days', 14,
    'version', p_plan.client_cutoff_version,
    'history', coalesce((
      select jsonb_agg(h.entry order by h.occurred_at desc)
      from (select a.occurred_at,
                   jsonb_build_object('action', a.action, 'at', coalesce(a.metadata -> 'at', to_jsonb(a.occurred_at)),
                                      'actor', case when a.actor_type = 'staff' then coalesce(u.email, 'Former staff member') else 'Flux DJ' end,
                                      'reason', a.metadata ->> 'reason', 'before', a.metadata -> 'before', 'after', a.metadata -> 'after') as entry
            from public.audit_events a
            left join auth.users u on u.id = a.actor_id
            where a.tenant_id = p_event.tenant_id and a.entity_type = 'event' and a.entity_id = p_event.id
              and a.action in ('planning_cutoff_set', 'planning_cutoff_changed', 'planning_cutoff_recalculated',
                               'planning_client_reopened', 'planning_client_reopen_closed')
            order by a.occurred_at desc limit 10) h), '[]'::jsonb));
end;
$$;

-- Sets the event's deadline and reopening (the only writer, with the guard).
create function private.set_plan_cutoff_columns(p_event_id uuid, p_lock_at timestamptz, p_override timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('flux.planning_cutoff_event', p_event_id::text, true);
  update public.events set planning_lock_at = p_lock_at, planning_override_until = p_override where id = p_event_id;
  perform set_config('flux.planning_cutoff_event', '', true);
end;
$$;

-- ===========================================================================
-- Plans get their deadline when they are set up
-- ===========================================================================

create or replace function private.ensure_event_plan(p_event_id uuid, p_template_id uuid, p_via text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
  v_template public.planning_templates%rowtype;
  v_days integer;
  v_deadline timestamptz;
begin
  select * into e from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  if not found then
    if p_template_id is not null then
      select * into v_template from public.planning_templates t where t.tenant_id = e.tenant_id and t.id = p_template_id;
      if not found then
        raise exception 'not found' using errcode = 'no_data_found';
      end if;
      if v_template.archived_at is not null then
        perform private.planning_error('this template is archived. Unarchive it or choose another');
      end if;
    else
      select * into v_template from public.planning_templates t
      where t.tenant_id = e.tenant_id and t.archived_at is null and t.default_event_type = e.event_type;
    end if;
    select t.planning_lock_days into v_days from public.tenants t where t.id = e.tenant_id;
    insert into public.event_plans (tenant_id, event_id, source_template_id, source_template_name, source_template_version,
                                    origin, initialized_via, client_cutoff_days)
    values (e.tenant_id, e.id, v_template.id, v_template.name, v_template.version,
            case when v_template.id is null then 'fallback' else 'template' end, p_via, v_days)
    on conflict (event_id) do nothing
    returning * into v_plan;
    if v_plan.id is null then
      select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
    else
      perform private.copy_template_into_plan(v_template.id, v_plan.id);
      -- The deadline is established now; a deadline already on the event is kept.
      v_deadline := coalesce(e.planning_lock_at, private.planning_cutoff_at(e.event_date, e.timezone, v_days));
      if e.planning_lock_at is null then
        perform private.set_plan_cutoff_columns(e.id, v_deadline, e.planning_override_until);
      end if;
      perform private.audit(e.tenant_id, 'event', e.id, 'planning_initialized', case when p_via = 'staff' then 'staff' else 'system' end,
        case when p_via = 'staff' then (select auth.uid()) end,
        jsonb_build_object('plan_id', v_plan.id, 'origin', v_plan.origin, 'template_id', v_template.id, 'via', p_via,
                           'client_cutoff_days', v_days, 'client_deadline', v_deadline));
    end if;
  end if;
  perform private.capture_plan_import(v_plan.id);
  return v_plan.id;
end;
$$;

-- ===========================================================================
-- Backfill existing plans (answers untouched)
-- ===========================================================================

alter table public.events disable trigger user;
alter table public.event_plans disable trigger user;

update public.event_plans p set client_cutoff_days = t.planning_lock_days
from public.tenants t where t.id = p.tenant_id and p.client_cutoff_days is null;

with set_now as (
  update public.events e
     set planning_lock_at = private.planning_cutoff_at(e.event_date, e.timezone, p.client_cutoff_days)
    from public.event_plans p
   where p.tenant_id = e.tenant_id and p.event_id = e.id and e.planning_lock_at is null
  returning e.id, e.tenant_id, e.planning_lock_at, p.client_cutoff_days
)
insert into public.audit_events (tenant_id, entity_type, entity_id, action, actor_type, actor_id, metadata)
select s.tenant_id, 'event', s.id, 'planning_cutoff_set', 'system', null,
       jsonb_build_object('via', 'migration', 'after', jsonb_build_object('deadline', s.planning_lock_at, 'days', s.client_cutoff_days),
                          'closed_for_client_at_migration', s.planning_lock_at <= clock_timestamp())
from set_now s;

alter table public.events enable trigger user;
alter table public.event_plans enable trigger user;

alter table public.event_plans alter column client_cutoff_days set not null;

-- ===========================================================================
-- Client writes: one gate for every save
-- ===========================================================================

-- Locks and checks a client planning write. Lock order: event (share), then
-- plan (update), as every planning write. Returns {"status":"ok","plan_id"}
-- or the refusal to return as is (signed_out, unavailable, locked).
create function private.client_plan_write_access(p_event_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
  v_editing jsonb;
begin
  if (select auth.uid()) is null then
    return jsonb_build_object('status', 'signed_out');
  end if;
  select ev.* into e from public.events ev join public.tenants tt on tt.id = ev.tenant_id
  where ev.id = p_event_id and tt.slug = p_tenant_slug;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;
  -- Archiving and staff deadline changes lock the event exclusively, so they
  -- wait for this save or this save sees them.
  select * into e from public.events where id = e.id for share;
  if not private.client_can_access_plan(e.id) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id for update;
  -- Database time after the locks: a save that waited across the deadline is refused.
  v_editing := private.plan_client_editing(e, v_plan, clock_timestamp());
  if v_editing ->> 'state' = 'closed' then
    return jsonb_build_object('status', 'locked', 'editing', v_editing);
  end if;
  return jsonb_build_object('status', 'ok', 'plan_id', v_plan.id);
end;
$$;

create or replace function public.client_save_plan_item(p_event_id uuid, p_tenant_slug text, p_item_id uuid, p_expected_revision integer, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb := private.client_plan_write_access(p_event_id, p_tenant_slug);
begin
  if v_access ->> 'status' <> 'ok' then
    return v_access;
  end if;
  return private.save_plan_item((v_access ->> 'plan_id')::uuid, p_item_id, p_expected_revision, p_answers, 'client', (select auth.uid()));
end;
$$;

create or replace function public.client_save_plan_basics(p_event_id uuid, p_tenant_slug text, p_expected_revision integer, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb := private.client_plan_write_access(p_event_id, p_tenant_slug);
begin
  if v_access ->> 'status' <> 'ok' then
    return v_access;
  end if;
  return private.save_plan_basics((v_access ->> 'plan_id')::uuid, p_expected_revision, p_answers, 'client', (select auth.uid()));
end;
$$;

-- ===========================================================================
-- Staff deadline and reopening actions
-- ===========================================================================

-- Locks an event's plan for a deadline change by staff of its business:
-- event (no key update: it waits for client saves and blocks new ones), then
-- plan. Refuses archived events and missing plans. Version checked by the caller.
create function private.lock_plan_cutoff_for_staff(p_event_id uuid)
returns public.event_plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  p public.event_plans%rowtype;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = e.id for no key update;
  if e.archived_at is not null then
    perform private.planning_error('the event is archived. Unarchive it before changing its planning');
  end if;
  select * into p from public.event_plans where tenant_id = e.tenant_id and event_id = e.id for update;
  if not found then
    perform private.planning_error('planning isn''t set up for this event yet');
  end if;
  return p;
end;
$$;

create function private.planning_reason(p_reason text)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    perform private.planning_error('enter a reason (it is kept in the history and never shown to the client)');
  end if;
  if length(btrim(p_reason)) > 500 then
    perform private.planning_error('keep the reason under 500 characters');
  end if;
  return btrim(p_reason);
end;
$$;

-- Moves the plan's deadline to its days (or new days) before the event's
-- current date, in its current time zone. p_op: 'changed' or 'recalculated'.
create function private.move_plan_client_cutoff(p_event_id uuid, p_expected_version integer, p_days integer, p_reason text, p_op text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
  e public.events%rowtype;
  v_reason text;
  v_days integer;
  v_before timestamptz;
  v_before_days integer;
  v_after timestamptz;
begin
  p := private.lock_plan_cutoff_for_staff(p_event_id);
  v_before_days := p.client_cutoff_days;
  select * into e from public.events where id = p.event_id;
  v_reason := private.planning_reason(p_reason);
  v_days := coalesce(p_days, p.client_cutoff_days);
  if v_days < 0 or v_days > 365 then
    perform private.planning_error('enter a whole number of days from 0 to 365');
  end if;
  v_before := private.plan_deadline(e, p);
  v_after := private.planning_cutoff_at(e.event_date, e.timezone, v_days);
  if p_expected_version is null or p.client_cutoff_version <> p_expected_version then
    -- A repeated click whose change is already in place is the same change.
    if v_before = v_after and p.client_cutoff_days = v_days then
      return jsonb_build_object('status', 'unchanged', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
    end if;
    raise exception 'the planning deadline was changed elsewhere' using errcode = 'serialization_failure';
  end if;
  if v_before = v_after and p.client_cutoff_days = v_days then
    return jsonb_build_object('status', 'unchanged', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  perform private.set_plan_cutoff_columns(e.id, v_after, e.planning_override_until);
  update public.event_plans set client_cutoff_days = v_days, client_cutoff_version = client_cutoff_version + 1
  where id = p.id returning * into p;
  select * into e from public.events where id = p.event_id;
  perform private.audit(e.tenant_id, 'event', e.id, 'planning_cutoff_' || p_op, 'staff', (select auth.uid()),
    jsonb_build_object('reason', v_reason, 'at', clock_timestamp(),
                       'event_date', e.event_date, 'timezone', e.timezone,
                       'before', jsonb_build_object('deadline', v_before, 'days', v_before_days),
                       'after', jsonb_build_object('deadline', v_after, 'days', v_days)));
  return jsonb_build_object('status', p_op, 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
end;
$$;

create function public.set_plan_client_cutoff(p_event_id uuid, p_expected_version integer, p_days integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_days is null then
    perform private.planning_error('enter a whole number of days from 0 to 365');
  end if;
  return private.move_plan_client_cutoff(p_event_id, p_expected_version, p_days, p_reason, 'changed');
end;
$$;

create function public.recalculate_plan_client_cutoff(p_event_id uuid, p_expected_version integer, p_reason text, p_confirm boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_confirm is distinct from true then
    perform private.planning_error('confirm that the deadline should move to match the event''s current date');
  end if;
  return private.move_plan_client_cutoff(p_event_id, p_expected_version, null, p_reason, 'recalculated');
end;
$$;

-- Reopens client editing until p_until_local, a wall-clock time in the
-- event's time zone. Only after the deadline; within 14 days from now.
create function public.reopen_plan_client_editing(p_event_id uuid, p_expected_version integer, p_until_local timestamp, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
  e public.events%rowtype;
  v_reason text;
  v_at timestamptz;
  v_until timestamptz;
  v_deadline timestamptz;
  v_before timestamptz;
begin
  p := private.lock_plan_cutoff_for_staff(p_event_id);
  select * into e from public.events where id = p.event_id;
  v_reason := private.planning_reason(p_reason);
  if p_until_local is null then
    perform private.planning_error('choose when the reopening ends');
  end if;
  v_at := clock_timestamp();
  v_until := p_until_local at time zone e.timezone;
  v_deadline := private.plan_deadline(e, p);
  v_before := e.planning_override_until;
  if p_expected_version is null or p.client_cutoff_version <> p_expected_version then
    if v_before = v_until and v_before > v_at then
      return jsonb_build_object('status', 'unchanged', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
    end if;
    raise exception 'the planning deadline was changed elsewhere' using errcode = 'serialization_failure';
  end if;
  if v_at < v_deadline then
    return jsonb_build_object('status', 'already_open', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  if v_until <= v_at then
    perform private.planning_error('choose an end time in the future');
  end if;
  if v_until > v_at + interval '14 days' then
    perform private.planning_error('a reopening can last at most 14 days. Choose an earlier end time');
  end if;
  if v_before = v_until then
    return jsonb_build_object('status', 'unchanged', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  perform private.set_plan_cutoff_columns(e.id, e.planning_lock_at, v_until);
  update public.event_plans set client_cutoff_version = client_cutoff_version + 1 where id = p.id returning * into p;
  select * into e from public.events where id = p.event_id;
  perform private.audit(e.tenant_id, 'event', e.id, 'planning_client_reopened', 'staff', (select auth.uid()),
    jsonb_build_object('reason', v_reason, 'at', v_at, 'deadline', v_deadline,
                       'before', jsonb_build_object('reopened_until', v_before, 'active', v_before > v_at),
                       'after', jsonb_build_object('reopened_until', v_until)));
  return jsonb_build_object('status', 'reopened', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
end;
$$;

-- Ends an active reopening now. Never closes a plan before its deadline.
create function public.close_plan_client_editing(p_event_id uuid, p_expected_version integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
  e public.events%rowtype;
  v_reason text;
  v_at timestamptz;
  v_deadline timestamptz;
  v_before timestamptz;
begin
  p := private.lock_plan_cutoff_for_staff(p_event_id);
  select * into e from public.events where id = p.event_id;
  v_reason := private.planning_reason(p_reason);
  v_at := clock_timestamp();
  v_deadline := private.plan_deadline(e, p);
  v_before := e.planning_override_until;
  -- Nothing to end (already ended, expired, or a repeated click): no change.
  if v_before is null or v_before <= v_at or v_at < v_deadline then
    return jsonb_build_object('status', case when v_at < v_deadline then 'already_open' else 'not_reopened' end,
                              'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  if p_expected_version is null or p.client_cutoff_version <> p_expected_version then
    raise exception 'the planning deadline was changed elsewhere' using errcode = 'serialization_failure';
  end if;
  perform private.set_plan_cutoff_columns(e.id, e.planning_lock_at, null);
  update public.event_plans set client_cutoff_version = client_cutoff_version + 1 where id = p.id returning * into p;
  select * into e from public.events where id = p.event_id;
  perform private.audit(e.tenant_id, 'event', e.id, 'planning_client_reopen_closed', 'staff', (select auth.uid()),
    jsonb_build_object('reason', v_reason, 'at', v_at, 'deadline', v_deadline,
                       'before', jsonb_build_object('reopened_until', v_before), 'after', jsonb_build_object('reopened_until', null)));
  return jsonb_build_object('status', 'closed', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
end;
$$;

-- ===========================================================================
-- Views gain the editing state
-- ===========================================================================

create or replace function public.client_planning_view(p_event_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  v_plan public.event_plans%rowtype;
  v_basics record;
begin
  select ev.* into e from public.events ev join public.tenants tt on tt.id = ev.tenant_id
  where ev.id = p_event_id and tt.slug = p_tenant_slug;
  if not found or not private.client_can_access_plan(e.id) then
    return jsonb_build_object('state', 'unavailable');
  end if;
  select * into t from public.tenants where id = e.tenant_id;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  select i.id, r.answers, r.revision into v_basics
  from public.event_plan_items i left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = v_plan.id and i.key = 'basics';
  return jsonb_build_object(
    'state', 'available',
    'brand', jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors),
    'event', jsonb_build_object('id', e.id, 'title', e.title, 'event_type', e.event_type, 'event_date', e.event_date,
                                'timezone', e.timezone, 'venue_name', e.venue_name, 'venue_address', e.venue_address),
    'editing', private.plan_client_editing(e, v_plan, now()),
    'structure', private.plan_structure(v_plan.id, false),
    'basics', jsonb_build_object('item_id', v_basics.id, 'answers', coalesce(v_basics.answers, '{}'::jsonb),
                                 'revision', coalesce(v_basics.revision, 0)),
    'stage_details', private.plan_stage_details(v_plan.id),
    'music', private.plan_music(v_plan.id),
    'moments', private.plan_moment_answers(v_plan.id),
    'event_contacts', private.plan_event_contacts(v_plan.id),
    'timeline_warnings', private.plan_timeline_warnings(v_plan.id),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

create or replace function public.staff_planning_view(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
  v_basics record;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  if not found then
    return jsonb_build_object('plan', null);
  end if;
  select i.id, r.answers, r.revision, r.updated_by_actor, r.updated_at into v_basics
  from public.event_plan_items i left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = v_plan.id and i.key = 'basics';
  return jsonb_build_object(
    'plan', jsonb_build_object(
      'id', v_plan.id, 'origin', v_plan.origin, 'initialized_via', v_plan.initialized_via, 'created_at', v_plan.created_at,
      'source_template_id', v_plan.source_template_id, 'source_template_name', v_plan.source_template_name,
      'structure_version', v_plan.structure_version),
    'editing', private.plan_staff_editing(e, v_plan),
    'structure', private.plan_structure(v_plan.id, true),
    'basics', jsonb_build_object('item_id', v_basics.id, 'answers', coalesce(v_basics.answers, '{}'::jsonb),
                                 'revision', coalesce(v_basics.revision, 0), 'updated_by', v_basics.updated_by_actor,
                                 'updated_at', v_basics.updated_at),
    'stage_details', private.plan_stage_details(v_plan.id),
    'music', private.plan_music(v_plan.id),
    'moments', private.plan_moment_answers(v_plan.id),
    'event_contacts', private.plan_event_contacts(v_plan.id),
    'timeline_warnings', private.plan_timeline_warnings(v_plan.id),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

-- ===========================================================================
-- Function privileges
-- ===========================================================================

revoke execute on function
  private.events_planning_cutoff_guard(),
  private.plan_deadline(public.events, public.event_plans),
  private.plan_client_editing(public.events, public.event_plans, timestamptz),
  private.plan_staff_editing(public.events, public.event_plans),
  private.set_plan_cutoff_columns(uuid, timestamptz, timestamptz),
  private.client_plan_write_access(uuid, text),
  private.lock_plan_cutoff_for_staff(uuid),
  private.move_plan_client_cutoff(uuid, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function
  private.planning_cutoff_at(date, text, integer),
  private.plan_editing_state(timestamptz, timestamptz, timestamptz),
  private.planning_reason(text)
  to authenticated, service_role;
revoke execute on function
  public.update_planning_cutoff_days(uuid, integer, integer),
  public.set_plan_client_cutoff(uuid, integer, integer, text),
  public.recalculate_plan_client_cutoff(uuid, integer, text, boolean),
  public.reopen_plan_client_editing(uuid, integer, timestamp, text),
  public.close_plan_client_editing(uuid, integer, text)
  from public, anon;
grant execute on function
  public.update_planning_cutoff_days(uuid, integer, integer),
  public.set_plan_client_cutoff(uuid, integer, integer, text),
  public.recalculate_plan_client_cutoff(uuid, integer, text, boolean),
  public.reopen_plan_client_editing(uuid, integer, timestamp, text),
  public.close_plan_client_editing(uuid, integer, text)
  to authenticated;
