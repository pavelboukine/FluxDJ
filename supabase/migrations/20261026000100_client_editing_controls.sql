-- Immediate Open / Close of client planning edits by staff.
--
-- Until now staff could only end a temporary reopening: "Close" refused a
-- plan whose deadline hadn't arrived, and "Reopen" refused one that was still
-- open. A DJ couldn't stop changes early (the timeline is final, the client is
-- mid-edit) without moving the deadline itself, which also changes what the
-- client and the history say the deadline is.
--
-- A manual close is its own fact, kept apart from the scheduled deadline:
--   events.planning_client_closed_at  set by close_plan_client_editing, cleared
--                                     by reopen_plan_client_editing.
-- Client editing state at time t (database time), now:
--   closed    a manual close is in force (whatever the deadline says)
--   open      t < deadline
--   reopened  t >= deadline and t < planning_override_until
--   closed    otherwise
-- So a manual close wins over a deadline still in the future, and stays in
-- force until staff open editing again (moving the deadline doesn't lift it).
--
-- Staff actions (same signatures, grants and PT409 conflicts as before; the
-- event and plan locks serialize them with client saves exactly as before):
--   close_plan_client_editing   closes now, whether editing is open on its
--                               normal deadline or reopened; clears any
--                               reopening. Already closed: no change.
--   reopen_plan_client_editing  before the deadline: lifts a manual close, so
--                               editing follows the normal deadline again (no
--                               end time needed: the deadline is the end).
--                               After the deadline: a reopening until a time
--                               within 14 days, as before (it also lifts a
--                               manual close). Never permanent: either the
--                               deadline or the reopening's end closes it.
-- The reason becomes optional for these two (still required to change the
-- deadline); each is audited with the staff user and database time.
--
-- Enforcement is unchanged in shape: every client save goes through
-- private.client_plan_write_access, which reads the locked event row and
-- calls private.plan_client_editing with clock_timestamp(), so a manual close
-- refuses the very next save, including one from a tab opened earlier. The
-- staff dashboard's planning list uses the same state.
--
-- Nothing here changes answers, progress, deadlines, contracts, payments,
-- booking or emails. No existing plan changes state: the column starts empty.

alter table public.events add column planning_client_closed_at timestamptz;
comment on column public.events.planning_client_closed_at is
  'Client planning edits closed by staff at this time, whatever the deadline. Set and cleared only by the planning editing functions.';

-- The guard now covers the manual close too (no direct grant exists on it).
create or replace function private.events_planning_cutoff_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.planning_lock_at is not null or new.planning_override_until is not null or new.planning_client_closed_at is not null))
     or (tg_op = 'UPDATE' and (new.planning_lock_at is distinct from old.planning_lock_at
                               or new.planning_override_until is distinct from old.planning_override_until
                               or new.planning_client_closed_at is distinct from old.planning_client_closed_at)) then
    if current_setting('flux.planning_cutoff_event', true) is distinct from new.id::text then
      raise exception 'the planning deadline changes only through the planning cutoff functions' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
drop trigger events_planning_cutoff_guard on public.events;
create trigger events_planning_cutoff_guard before insert or update of planning_lock_at, planning_override_until, planning_client_closed_at on public.events
  for each row execute function private.events_planning_cutoff_guard();

-- The state with a manual close (the three-argument form stays for callers without one).
create function private.plan_editing_state(p_deadline timestamptz, p_override timestamptz, p_at timestamptz, p_closed_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_closed_at is not null then 'closed'
              else private.plan_editing_state(p_deadline, p_override, p_at) end;
$$;

-- Sets the deadline, reopening and manual close together (with the guard).
create function private.set_plan_editing_columns(p_event_id uuid, p_lock_at timestamptz, p_override timestamptz, p_closed_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('flux.planning_cutoff_event', p_event_id::text, true);
  update public.events
  set planning_lock_at = p_lock_at, planning_override_until = p_override, planning_client_closed_at = p_closed_at
  where id = p_event_id;
  perform set_config('flux.planning_cutoff_event', '', true);
end;
$$;

-- An optional note for opening and closing: blank is none.
create function private.planning_optional_reason(p_reason text)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if length(btrim(coalesce(p_reason, ''))) > 500 then
    perform private.planning_error('keep the reason under 500 characters');
  end if;
  return nullif(btrim(coalesce(p_reason, '')), '');
end;
$$;

-- What a client may know, now with whether staff closed editing (never who or why).
create or replace function private.plan_client_editing(p_event public.events, p_plan public.event_plans, p_at timestamptz)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_deadline timestamptz := private.plan_deadline(p_event, p_plan);
  v_override timestamptz := case when p_event.planning_override_until > p_at then p_event.planning_override_until end;
  v_state text := private.plan_editing_state(v_deadline, p_event.planning_override_until, p_at, p_event.planning_client_closed_at);
begin
  return jsonb_build_object(
    'state', v_state,
    'deadline', v_deadline,
    'closes_at', case when v_state = 'closed' then null else greatest(v_deadline, v_override) end,
    'closed_by_dj', p_event.planning_client_closed_at is not null,
    'timezone', p_event.timezone);
end;
$$;

create or replace function private.plan_staff_editing(p_event public.events, p_plan public.event_plans)
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
    'reopen_active', coalesce(p_event.planning_client_closed_at is null and p_event.planning_override_until > v_at and v_at >= v_deadline, false),
    'reopen_max_days', 14,
    'closed_at', p_event.planning_client_closed_at,
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
                               'planning_client_reopened', 'planning_client_reopen_closed',
                               'planning_client_closed', 'planning_client_opened')
            order by a.occurred_at desc limit 10) h), '[]'::jsonb));
end;
$$;

-- Closes client editing now: open on its deadline, or reopened. Staff keep editing.
create or replace function public.close_plan_client_editing(p_event_id uuid, p_expected_version integer, p_reason text)
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
  v_state text;
begin
  p := private.lock_plan_cutoff_for_staff(p_event_id);
  select * into e from public.events where id = p.event_id;
  v_reason := private.planning_optional_reason(p_reason);
  v_at := clock_timestamp();
  v_deadline := private.plan_deadline(e, p);
  v_state := private.plan_editing_state(v_deadline, e.planning_override_until, v_at, e.planning_client_closed_at);
  -- Already closed (by staff, the deadline, or a reopening that ended; or a repeated click): no change.
  if v_state = 'closed' then
    return jsonb_build_object('status', 'already_closed', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  if p_expected_version is null or p.client_cutoff_version <> p_expected_version then
    raise exception 'the planning deadline was changed elsewhere' using errcode = 'PT409';
  end if;
  perform private.set_plan_editing_columns(e.id, e.planning_lock_at, null, v_at);
  update public.event_plans set client_cutoff_version = client_cutoff_version + 1 where id = p.id returning * into p;
  select * into e from public.events where id = p.event_id;
  perform private.audit(e.tenant_id, 'event', e.id, 'planning_client_closed', 'staff', (select auth.uid()),
    jsonb_build_object('reason', v_reason, 'at', v_at, 'deadline', v_deadline,
                       'before', jsonb_build_object('state', v_state, 'reopened_until', case when v_state = 'reopened' then e.planning_override_until end),
                       'after', jsonb_build_object('closed_at', v_at)));
  return jsonb_build_object('status', 'closed', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
end;
$$;

-- Opens client editing now. Before the deadline: lifts a manual close (the
-- deadline ends it). After the deadline: reopens until p_until_local (event
-- local time), within 14 days.
create or replace function public.reopen_plan_client_editing(p_event_id uuid, p_expected_version integer, p_until_local timestamp, p_reason text)
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
  v_closed timestamptz;
begin
  p := private.lock_plan_cutoff_for_staff(p_event_id);
  select * into e from public.events where id = p.event_id;
  v_reason := private.planning_optional_reason(p_reason);
  v_at := clock_timestamp();
  v_until := case when p_until_local is not null then p_until_local at time zone e.timezone end;
  v_deadline := private.plan_deadline(e, p);
  v_before := e.planning_override_until;
  v_closed := e.planning_client_closed_at;
  if v_closed is null and v_at < v_deadline then
    return jsonb_build_object('status', 'already_open', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  if p_expected_version is null or p.client_cutoff_version <> p_expected_version then
    if v_closed is null and v_before = v_until and v_before > v_at then
      return jsonb_build_object('status', 'unchanged', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
    end if;
    raise exception 'the planning deadline was changed elsewhere' using errcode = 'PT409';
  end if;
  if v_at < v_deadline then
    perform private.set_plan_editing_columns(e.id, e.planning_lock_at, null, null);
    update public.event_plans set client_cutoff_version = client_cutoff_version + 1 where id = p.id returning * into p;
    select * into e from public.events where id = p.event_id;
    perform private.audit(e.tenant_id, 'event', e.id, 'planning_client_opened', 'staff', (select auth.uid()),
      jsonb_build_object('reason', v_reason, 'at', v_at, 'deadline', v_deadline,
                         'before', jsonb_build_object('closed_at', v_closed), 'after', jsonb_build_object('open_until', v_deadline)));
    return jsonb_build_object('status', 'opened', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  if v_until is null then
    perform private.planning_error('choose when the reopening ends');
  end if;
  if v_until <= v_at then
    perform private.planning_error('choose an end time in the future');
  end if;
  if v_until > v_at + interval '14 days' then
    perform private.planning_error('a reopening can last at most 14 days. Choose an earlier end time');
  end if;
  if v_closed is null and v_before = v_until then
    return jsonb_build_object('status', 'unchanged', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
  end if;
  perform private.set_plan_editing_columns(e.id, e.planning_lock_at, v_until, null);
  update public.event_plans set client_cutoff_version = client_cutoff_version + 1 where id = p.id returning * into p;
  select * into e from public.events where id = p.event_id;
  perform private.audit(e.tenant_id, 'event', e.id, 'planning_client_reopened', 'staff', (select auth.uid()),
    jsonb_build_object('reason', v_reason, 'at', v_at, 'deadline', v_deadline,
                       'before', jsonb_build_object('reopened_until', v_before, 'active', v_before > v_at, 'closed_at', v_closed),
                       'after', jsonb_build_object('reopened_until', v_until)));
  return jsonb_build_object('status', 'reopened', 'version', p.client_cutoff_version, 'editing', private.plan_staff_editing(e, p));
end;
$$;

-- The staff dashboard's planning list uses the same state (body unchanged otherwise).
create or replace function public.staff_dashboard(p_tenant_id uuid, p_upcoming_limit integer default 8)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := now();
  v_limit integer := least(greatest(coalesce(p_upcoming_limit, 8), 1), 50);
  v_upcoming jsonb;
  v_more boolean;
  t public.tenants%rowtype;
begin
  perform private.require_staff_of(p_tenant_id);
  select * into t from public.tenants where id = p_tenant_id;

  with upcoming as (
    select e.id, e.title, e.event_date, e.timezone, e.venue_name, e.lifecycle_status,
           (select c.name from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
            where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary limit 1) as client_name,
           exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed') as contract_signed
    from public.events e
    where e.tenant_id = p_tenant_id and e.archived_at is null
      and e.event_date >= (v_at at time zone e.timezone)::date
    order by e.event_date, e.title, e.id
    limit v_limit + 1
  )
  select coalesce(jsonb_agg(to_jsonb(u) order by u.event_date, u.title, u.id), '[]'::jsonb) into v_upcoming from upcoming u;
  v_more := jsonb_array_length(v_upcoming) > v_limit;
  if v_more then
    v_upcoming := v_upcoming - v_limit;
  end if;

  return jsonb_build_object(
    'now', v_at,
    'planning_window_days', 7,
    'upcoming', v_upcoming,
    'upcoming_more', v_more,
    'submitted', coalesce((
      select jsonb_agg(jsonb_build_object(
               'proposal_id', p.id, 'event_id', e.id, 'title', e.title, 'event_date', e.event_date, 'revision', p.revision,
               'submitted_at', (select max(s.submitted_at) from public.proposal_selections s where s.tenant_id = p.tenant_id and s.proposal_id = p.id))
             order by e.event_date, e.title)
      from public.proposals p
      join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id and e.active_proposal_id = p.id
      where p.tenant_id = p_tenant_id and p.status = 'submitted'
        and e.archived_at is null and e.lifecycle_status not in ('cancelled', 'completed')), '[]'::jsonb),
    'awaiting_deposit', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', e.id, 'title', e.title, 'event_date', e.event_date,
               'currency', s.summary ->> 'currency',
               'deposit_outstanding_cents', (s.summary ->> 'deposit_outstanding_cents')::bigint)
             order by e.event_date, e.title)
      from public.events e
      cross join lateral (select private.event_payment_summary(e.id) as summary) s
      where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'awaiting_deposit'), '[]'::jsonb),
    'booking_check', coalesce((
      select jsonb_agg(jsonb_build_object('event_id', e.id, 'title', e.title, 'event_date', e.event_date) order by e.event_date, e.title)
      from public.events e
      where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'awaiting_signature'
        and exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id
                    and k.status = 'signed' and k.booking_policy is null)), '[]'::jsonb),
    'planning', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', x.id, 'title', x.title, 'event_date', x.event_date, 'timezone', x.timezone,
               'state', x.state, 'deadline', x.deadline, 'closes_at', x.closes_at,
               'requirements_met', (x.progress ->> 'requirements_met')::int,
               'requirements_total', (x.progress ->> 'requirements_total')::int)
             order by coalesce(x.closes_at, x.deadline), x.title)
      from (
        select c.*, private.plan_progress(c.plan_id) as progress
        from (
          select e.id, e.title, e.event_date, e.timezone, ep.id as plan_id, d.deadline,
                 private.plan_editing_state(d.deadline, e.planning_override_until, v_at, e.planning_client_closed_at) as state,
                 case private.plan_editing_state(d.deadline, e.planning_override_until, v_at, e.planning_client_closed_at)
                   when 'open' then d.deadline
                   when 'reopened' then e.planning_override_until end as closes_at
          from public.events e
          join public.event_plans ep on ep.tenant_id = e.tenant_id and ep.event_id = e.id
          cross join lateral (select private.plan_deadline(e, ep) as deadline) d
          where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'booked'
            and e.event_date >= (v_at at time zone e.timezone)::date
        ) c
        where c.state <> 'open' or c.deadline <= v_at + interval '7 days'
      ) x
      where (x.progress ->> 'requirements_met')::int < (x.progress ->> 'requirements_total')::int), '[]'::jsonb),
    'failed_emails', (select count(*) from public.email_outbox o where o.tenant_id = p_tenant_id and o.status = 'failed'),
    'setup', jsonb_build_object(
      'identity_saved', t.business_address is not null and t.contact_email is not null,
      'tax_categories', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(t.tax_categories) k), '[]'::jsonb),
      'used_tax_categories', coalesce((
        select jsonb_agg(distinct u.cat)
        from (select g.tax_category as cat from public.gear_items g where g.tenant_id = p_tenant_id and g.active
              union
              select pk.tax_category from public.packages pk where pk.tenant_id = p_tenant_id and pk.active) u), '[]'::jsonb),
      'active_packages', (select count(*) from public.packages pk where pk.tenant_id = p_tenant_id and pk.active),
      'usable_proposal_templates', (
        select count(*) from public.proposal_templates pt
        where pt.tenant_id = p_tenant_id and pt.active
          and (select count(*) from public.proposal_template_packages tp
               join public.packages pk on pk.tenant_id = tp.tenant_id and pk.id = tp.package_id and pk.active
               where tp.tenant_id = pt.tenant_id and tp.template_id = pt.id) = 3),
      'client_use_contract_templates', (
        select count(distinct ct.id) from public.contract_templates ct
        join public.contract_template_versions v on v.tenant_id = ct.tenant_id and v.template_id = ct.id
        where ct.tenant_id = p_tenant_id and ct.active and v.published_at is not null and v.usage = 'client_use')));
end;
$$;

revoke execute on function
  private.set_plan_editing_columns(uuid, timestamptz, timestamptz, timestamptz),
  private.planning_optional_reason(text)
  from public, anon, authenticated;
grant execute on function
  private.plan_editing_state(timestamptz, timestamptz, timestamptz, timestamptz)
  to authenticated, service_role;
