-- Clients open planning only once staff open it to them.
--
-- Until now a plan became visible to the client as soon as the event was
-- booked, unless booking had set it up with Event basics only
-- (private.plan_awaiting_setup). A plan copied from a default template, or one
-- staff set up before the booking, opened on booking, before the DJ could
-- prepare it, and adding one section to a basics-only plan opened it too.
--
-- event_plans.client_opened_at is the explicit, one-way opening. Staff set it
-- with open_client_planning (no email) or by sending the first planning
-- invitation (send_planning_invitation, in the same transaction as the
-- invitation and its queued email). It is never cleared: making an opened
-- plan read-only stays the job of the client-editing switch and the deadline,
-- which opening never changes.
--
-- Clients see the plan only when private.plan_open_to_client is true. Every
-- client path goes through client_planning_view (the existing "setting_up"
-- state), my_plans (unopened plans are left out) or client_plan_write_access
-- (behind both client save functions), so direct URLs, RPCs and existing
-- sessions are covered. Staff reading and editing are unchanged.
--
-- Compatibility: plans a client could open before this migration are marked
-- opened (private.plan_open_before_activation), so no existing client loses
-- planning. The deployed app keeps working: it already handles "setting_up",
-- and its "Send planning invitation" now also opens planning.

alter table public.event_plans
  add column client_opened_at timestamptz,
  add column client_opened_by uuid,
  add constraint event_plans_client_opened_by_needs_at check (client_opened_by is null or client_opened_at is not null);
comment on column public.event_plans.client_opened_at is
  'When staff opened planning to the client (or when this migration found it already open). Set once, never cleared. Null: staff are still preparing it and the client sees "setting up".';
comment on column public.event_plans.client_opened_by is
  'The staff user who opened planning to the client. Null for plans already open before explicit opening existed.';
grant select (client_opened_at, client_opened_by) on public.event_plans to authenticated;

-- Whether a client could open this plan before explicit opening existed:
--  * the event was booked for planning, the plan wasn't awaiting setup and a
--    client has (or had) access to the event (a Flux booking's signer, or a
--    client who accepted a planning invitation); or
--  * a planning invitation was accepted or is still unrevoked (its link keeps
--    working).
-- A set-up plan that no client could reach (an event booked elsewhere and not
-- invited yet, or a booking signed offline) is left unopened: nobody loses
-- anything, and staff open it explicitly like any new plan. Archiving and
-- suspension are left out on purpose: they are checked separately at every
-- read, so a plan that was open stays open if its event is unarchived later.
-- Used by this migration's backfill; kept so pgTAP tests the exact rule.
create function private.plan_open_before_activation(p_plan public.event_plans)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
      select 1 from public.events e
      where e.tenant_id = p_plan.tenant_id and e.id = p_plan.event_id
        and private.event_booked_for_planning(e) and not private.plan_awaiting_setup(p_plan)
        and exists (select 1 from public.event_access ea where ea.tenant_id = e.tenant_id and ea.event_id = e.id))
    or exists (
      select 1 from public.planning_invitations i
      where i.tenant_id = p_plan.tenant_id and i.event_id = p_plan.event_id
        and (i.accepted_at is not null or i.revoked_at is null));
$$;
comment on function private.plan_open_before_activation(public.event_plans) is
  'The 20261201000100 backfill rule: whether a client could open this plan before staff had to open it explicitly.';
revoke all on function private.plan_open_before_activation(public.event_plans) from public;

-- Backfill before the guard exists. created_at: the plan was open from the start.
update public.event_plans p
  set client_opened_at = p.created_at
  where p.client_opened_at is null and private.plan_open_before_activation(p);

-- Set once, and only by private.open_plan_to_client.
create function private.event_plans_opening_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.client_opened_at is not null or new.client_opened_by is not null then
      raise exception 'planning is opened to the client only through open_client_planning' using errcode = 'check_violation';
    end if;
  elsif (new.client_opened_at, new.client_opened_by) is distinct from (old.client_opened_at, old.client_opened_by) then
    if old.client_opened_at is not null then
      raise exception 'planning stays open to the client once opened' using errcode = 'check_violation';
    end if;
    if current_setting('flux.opening_plan', true) is distinct from new.id::text then
      raise exception 'planning is opened to the client only through open_client_planning' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger event_plans_opening_guard before insert or update on public.event_plans
  for each row execute function private.event_plans_opening_guard();

-- What a client may see: opened by staff, and not a basics-only plan from
-- booking (a plan opened before this migration can't be one, and opening now
-- requires setup, so this only matters if staff later hide every section of
-- such a plan). Event access, archiving and booking are checked by
-- private.client_can_access_plan.
create function private.plan_open_to_client(p_plan public.event_plans)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_plan.client_opened_at is not null and not private.plan_awaiting_setup(p_plan);
$$;
comment on function private.plan_open_to_client(public.event_plans) is
  'Staff opened this plan to the client and it is set up. Clients see "setting up" otherwise.';
revoke all on function private.plan_open_to_client(public.event_plans) from public;

-- Opens a plan to the client. The caller has checked staff membership and
-- locked the event (for update) and the plan (for update), in that order.
-- Refuses what can't be opened; returns false when it was already open.
-- Never touches the deadline or client editing.
create function private.open_plan_to_client(p_event public.events, p_plan public.event_plans, p_actor uuid, p_via text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tenants%rowtype;
begin
  if p_plan.client_opened_at is not null then
    return false;
  end if;
  select * into t from public.tenants where id = p_event.tenant_id;
  if p_event.archived_at is not null or t.archived_at is not null then
    perform private.planning_error('the event is archived. Unarchive it before opening planning to the client');
  end if;
  if not private.event_booked_for_planning(p_event) then
    perform private.planning_error('the event isn''t booked yet. Open planning to the client once the booking is confirmed');
  end if;
  if private.plan_awaiting_setup(p_plan) then
    perform private.planning_error('set up planning before opening it to the client');
  end if;
  perform set_config('flux.opening_plan', p_plan.id::text, true);
  update public.event_plans set client_opened_at = clock_timestamp(), client_opened_by = p_actor where id = p_plan.id;
  perform set_config('flux.opening_plan', '', true);
  perform private.audit(p_event.tenant_id, 'event', p_event.id, 'planning_opened_to_client', 'staff', p_actor,
    jsonb_build_object('plan_id', p_plan.id, 'via', p_via,
                       'editing', private.plan_editing_state(private.plan_deadline(p_event, p_plan), p_event.planning_override_until,
                                                             clock_timestamp(), p_event.planning_client_closed_at)));
  return true;
end;
$$;
revoke all on function private.open_plan_to_client(public.events, public.event_plans, uuid, text) from public;

-- Staff open planning to the client without emailing anyone. Safe to repeat.
-- A plan opened after its deadline, or while client editing is closed, opens
-- read-only: the deadline and editing are left as they are.
create function public.open_client_planning(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
  v_opened boolean;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  -- Lock order: event, then plan (as send_planning_invitation and the client saves).
  select * into e from public.events where id = e.id for update;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id for update;
  if not found then
    perform private.planning_error('set up planning before opening it to the client');
  end if;
  v_opened := private.open_plan_to_client(e, v_plan, (select auth.uid()), 'staff');
  select * into v_plan from public.event_plans where id = v_plan.id;
  return jsonb_build_object('status', case when v_opened then 'opened' else 'already_open' end,
    'opened_at', v_plan.client_opened_at,
    'editing', private.plan_editing_state(private.plan_deadline(e, v_plan), e.planning_override_until, now(), e.planning_client_closed_at));
end;
$$;
revoke all on function public.open_client_planning(uuid) from public;
grant execute on function public.open_client_planning(uuid) to authenticated, service_role;

-- Sending a planning invitation also opens planning (the first invitation is
-- "Open planning & send invitation"), in the same transaction as the
-- invitation and its queued email. Every earlier check is unchanged: an
-- invitation still needs open client editing, so this never opens planning
-- that it then can't invite to. Adds "opened" to the result.
create or replace function public.send_planning_invitation(p_event_id uuid, p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $_$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  v_plan public.event_plans%rowtype;
  v_client public.clients%rowtype;
  v_existing public.planning_invitations%rowtype;
  v_expires timestamptz := now() + interval '14 days';
  v_replaced integer;
  v_opened boolean;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = e.id for update;
  select * into t from public.tenants where id = e.tenant_id;

  if p_invitation_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation link' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_existing from public.planning_invitations where id = p_invitation_id;
  if found then
    if v_existing.event_id <> e.id or v_existing.token_hash <> p_token_hash then
      raise exception 'invalid invitation link' using errcode = 'invalid_parameter_value';
    end if;
    return jsonb_build_object('status', 'sent', 'replayed', true, 'invitation_id', v_existing.id,
      'recipient_email', v_existing.email, 'expires_at', v_existing.expires_at, 'opened', false);
  end if;

  if e.archived_at is not null or t.archived_at is not null then
    perform private.planning_error('the event is archived. Unarchive it before inviting the client');
  end if;
  if not private.event_booked_for_planning(e) then
    perform private.planning_error('the event isn''t booked yet. Invite the client to planning once the booking is confirmed');
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id for update;
  if not found or private.plan_awaiting_setup(v_plan) then
    perform private.planning_error('set up planning before inviting the client');
  end if;
  if private.plan_editing_state(private.plan_deadline(e, v_plan), e.planning_override_until, now(), e.planning_client_closed_at) = 'closed' then
    perform private.planning_error('client editing is closed. Open client editing on the planning page before inviting the client');
  end if;
  select c.* into v_client
  from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary;
  if not found or v_client.archived_at is not null then
    perform private.planning_error('add an active primary contact to invite');
  end if;

  v_opened := private.open_plan_to_client(e, v_plan, (select auth.uid()), 'invitation');
  v_replaced := private.revoke_planning_invitations(e.id, 'replaced by a new invitation', (select auth.uid()));
  insert into public.planning_invitations (id, tenant_id, event_id, client_id, email, token_hash, expires_at, invited_by)
  values (p_invitation_id, e.tenant_id, e.id, v_client.id, lower(v_client.email), p_token_hash, v_expires, (select auth.uid()));
  perform private.enqueue_planning_email(e.tenant_id, 'planning_invitation', v_client.email, p_invitation_id,
    jsonb_build_object('client_name', v_client.name, 'event_title', e.title, 'event_date', e.event_date, 'expires_at', v_expires),
    'planning_invitation:' || p_invitation_id);
  perform private.audit(e.tenant_id, 'event', e.id, 'planning_invitation_sent', 'staff', (select auth.uid()),
    jsonb_build_object('invitation_id', p_invitation_id, 'client_id', v_client.id, 'replaced', v_replaced, 'opened', v_opened));
  return jsonb_build_object('status', 'sent', 'replayed', false, 'invitation_id', p_invitation_id,
    'recipient_email', lower(v_client.email), 'expires_at', v_expires, 'opened', v_opened);
end;
$_$;

-- Client reads: "setting_up" until staff open the plan (was: until set up).
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
  if not private.plan_open_to_client(v_plan) then
    return jsonb_build_object(
      'state', 'setting_up',
      'brand', jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors),
      'event', jsonb_build_object('id', e.id, 'title', e.title, 'event_type', e.event_type, 'event_date', e.event_date,
                                  'timezone', e.timezone, 'venue_name', e.venue_name, 'venue_address', e.venue_address));
  end if;
  select i.id, r.answers, r.revision into v_basics
  from public.event_plan_items i left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = v_plan.id and i.key = 'basics';
  return jsonb_build_object(
    'state', 'available',
    'brand', jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors),
    'dj_name', coalesce(e.dj_name, t.dj_name),
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

-- Client saves: refused ("unavailable") until staff open the plan.
create or replace function private.client_plan_write_access(p_event_id uuid, p_tenant_slug text)
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
  -- Not opened to the client yet, or not set up (opening and structure changes
  -- lock the plan, so this sees them).
  if not private.plan_open_to_client(v_plan) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  -- Database time after the locks: a save that waited across the deadline is refused.
  v_editing := private.plan_client_editing(e, v_plan, clock_timestamp());
  if v_editing ->> 'state' = 'closed' then
    return jsonb_build_object('status', 'locked', 'editing', v_editing);
  end if;
  return jsonb_build_object('status', 'ok', 'plan_id', v_plan.id);
end;
$$;

-- The client's plans: only those opened to them (no progress for a plan
-- staff are still preparing).
create or replace function public.my_plans()
returns table (tenant_slug text, tenant_display_name text, event_id uuid, event_title text, event_date date,
               contract_id uuid, requirements_total integer, requirements_met integer)
language sql
stable
security definer
set search_path = ''
as $$
  select t.slug, t.display_name, e.id, e.title, e.event_date,
         (select k.id from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed'
          order by k.signed_at desc limit 1),
         (x.progress ->> 'requirements_total')::int, (x.progress ->> 'requirements_met')::int
  from public.event_plans p
  join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  join public.tenants t on t.id = e.tenant_id
  cross join lateral (select private.plan_progress(p.id) as progress) x
  where e.id in (select private.client_event_ids()) and private.client_can_access_plan(e.id)
    and private.plan_open_to_client(p)
  order by e.event_date, e.id;
$$;

-- Staff see when, and by whom, planning was opened to the client.
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
      'structure_version', v_plan.structure_version,
      'client_opened_at', v_plan.client_opened_at,
      'client_opened_by', case when v_plan.client_opened_at is null then null
                               when v_plan.client_opened_by is null then 'Flux DJ'
                               else coalesce((select u.email from auth.users u where u.id = v_plan.client_opened_by), 'Former staff member') end),
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

-- The dashboard reminds staff of booked events whose planning is set up but
-- not opened ("Planning not open"). Derived on each read: no reminder state is
-- stored, and opening planning clears it. Adds "planning_not_open" only.
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
    select e.id, e.title, e.event_date, e.timezone, e.venue_name, e.lifecycle_status, e.booking_source,
           (select c.name from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
            where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary limit 1) as client_name,
           exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed') as contract_signed,
           (select case when ap.status = 'sent' and ap.expires_at is not null and ap.expires_at <= v_at then 'expired' else ap.status end
            from public.proposals ap where ap.tenant_id = e.tenant_id and ap.id = e.active_proposal_id) as proposal_status,
           exists (select 1 from public.proposals d where d.tenant_id = e.tenant_id and d.event_id = e.id and d.status = 'draft') as proposal_draft,
           (select k.status from public.contracts k
            where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status in ('signed', 'sent', 'draft')
            order by case k.status when 'signed' then 1 when 'sent' then 2 else 3 end limit 1) as contract_status
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
          where e.tenant_id = p_tenant_id and e.archived_at is null
            and (e.lifecycle_status = 'booked' or e.booking_source = 'external')
            and e.event_date >= (v_at at time zone e.timezone)::date
        ) c
        where c.state <> 'open' or c.deadline <= v_at + interval '7 days'
      ) x
      where (x.progress ->> 'requirements_met')::int < (x.progress ->> 'requirements_total')::int), '[]'::jsonb),
    -- Booked (or booked elsewhere), upcoming events whose planning is set up but not opened to the client yet.
    'planning_not_open', coalesce((
      select jsonb_agg(jsonb_build_object('event_id', e.id, 'title', e.title, 'event_date', e.event_date) order by e.event_date, e.title, e.id)
      from public.events e
      join public.event_plans ep on ep.tenant_id = e.tenant_id and ep.event_id = e.id
      where e.tenant_id = p_tenant_id and e.archived_at is null
        and private.event_booked_for_planning(e) and e.lifecycle_status <> 'cancelled'
        and e.event_date >= (v_at at time zone e.timezone)::date
        and ep.client_opened_at is null and not private.plan_awaiting_setup(ep)), '[]'::jsonb),
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
