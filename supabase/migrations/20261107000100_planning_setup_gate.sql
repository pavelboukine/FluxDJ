-- Planning that booking set up with Event basics only waits for staff setup.
--
-- Why a migration: when an event is booked and no planning template is the
-- default for its type, booking creates a fallback plan holding only Event
-- basics. Until now the client could open and fill that plan as if planning
-- were ready, while staff still had to choose the event's template.
--
-- Awaiting setup (derived from existing columns, no new state):
--   origin = 'fallback', initialized_via is 'booking' or 'backfill' (not a
--   staff choice), and no enabled item other than Event basics.
-- It ends when staff apply a template (origin becomes 'template'), add or
-- restore any section, stage or moment, or set planning up themselves with
-- Event basics only (initialized_via = 'staff', which never applies here).
--
--   client_planning_view       returns {"state":"setting_up"} with the safe
--                              brand and event details only (no structure,
--                              answers or progress) while awaiting setup.
--   client_plan_write_access   refuses client saves ("unavailable", which
--                              the deployed app already handles) while
--                              awaiting setup, after the same locks as before.
--
-- Same signatures, grants and access checks as before (verified access,
-- booked, nothing archived, deadline and staff close). Staff planning, the
-- deadline, answers, templates, proposals, contracts, payments and booking
-- are unchanged. The previously deployed app treats "setting_up" as
-- unavailable (its schema rejects it), so applying this first is safe.

create function private.plan_awaiting_setup(p_plan public.event_plans)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_plan.origin = 'fallback'
     and p_plan.initialized_via in ('booking', 'backfill')
     and not exists (
       select 1 from public.event_plan_items i
       where i.tenant_id = p_plan.tenant_id and i.plan_id = p_plan.id
         and i.key <> 'basics' and i.disabled_at is null
     );
$$;
comment on function private.plan_awaiting_setup(public.event_plans) is
  'Booking (or backfill) set the plan up with Event basics only and staff have not configured it: clients see "setting up" and cannot save.';

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
  -- Staff haven't set planning up yet (structure changes lock the plan, so
  -- this sees a template applied before the save).
  if private.plan_awaiting_setup(v_plan) then
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
  if private.plan_awaiting_setup(v_plan) then
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

revoke execute on function private.plan_awaiting_setup(public.event_plans) from public, anon, authenticated;
