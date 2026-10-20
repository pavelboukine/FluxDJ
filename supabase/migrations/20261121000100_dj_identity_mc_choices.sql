-- DJ identity and planning question refinements (Batch 6A).
--
-- 1. The DJ's display name, separate from the business's display name (which
--    stays the company brand on proposals, contracts and planning):
--      tenants.dj_name   optional; the name most events use ("DJ Boukine").
--                        Owner only, through update_planning_dj_name. Left
--                        empty when different DJs handle the events.
--      events.dj_name    optional; the DJ handling this event, set by staff
--                        on the event's details (column grants below).
--    Planning names the DJ as coalesce(events.dj_name, tenants.dj_name); with
--    neither it says "your DJ", never the business name. client_planning_view
--    returns that resolved name as dj_name (null when there is none); staff
--    pages read both columns directly.
-- 2. The MC moment gains "shared": the DJ and another MC share duties. Like
--    "other", it keeps the other MC's name (needed: the requirement stays
--    open without it), contact and any earlier pronunciation guide. "none"
--    (No MC) is no longer offered by the app but stays valid and not
--    applicable, so saved answers keep reading and saving exactly as before.
--    The app no longer asks for a pronunciation guide; earlier ones are kept.
-- 3. DJ expectations: "interaction" gains "a_little" (A little interaction).
--    "occasional" (Occasional announcements) is no longer offered but stays
--    valid for saved answers.
--
-- Nothing is written: no saved answer, template or plan is changed.
-- Same signatures for the replaced functions; privileges kept by create or replace.

alter table public.tenants add column dj_name text
  constraint tenants_dj_name_length check (dj_name = btrim(dj_name) and length(dj_name) between 1 and 80);
comment on column public.tenants.dj_name is
  'Optional name of the DJ that planning shows clients ("DJ Boukine (your DJ)"), when no event names its own. Owner only, via update_planning_dj_name.';

alter table public.events add column dj_name text
  constraint events_dj_name_length check (dj_name = btrim(dj_name) and length(dj_name) between 1 and 80);
comment on column public.events.dj_name is
  'Optional name of the DJ handling this event; overrides tenants.dj_name in planning and the run sheet.';
grant insert (dj_name), update (dj_name) on public.events to authenticated;

create function public.update_planning_dj_name(p_tenant_id uuid, p_dj_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  t public.tenants%rowtype;
  v_name text := nullif(btrim(regexp_replace(coalesce(p_dj_name, ''), '\s+', ' ', 'g')), '');
begin
  select m.role into v_role from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid()) and m.removed_at is null;
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change the DJ name' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if length(v_name) > 80 then
    raise exception 'settings_invalid: keep the DJ name under 80 characters' using errcode = 'invalid_parameter_value';
  end if;
  if v_name is not distinct from t.dj_name then
    return v_name;
  end if;
  update public.tenants set dj_name = v_name where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'dj_name_changed', 'staff', (select auth.uid()), jsonb_build_object('set', v_name is not null));
  return v_name;
end;
$$;
revoke execute on function public.update_planning_dj_name(uuid, text) from public, anon;
grant execute on function public.update_planning_dj_name(uuid, text) to authenticated;

-- Unchanged apart from "shared", which keeps the other MC's details like "other".
create or replace function private.normalize_plan_mc(p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  a jsonb := '{}'::jsonb;
  k text;
  v text;
  v_limit int;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if k not in ('mc', 'name', 'pronunciation', 'contact', 'notes') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
    if jsonb_typeof(p_answers -> k) not in ('string', 'null') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;
  if p_answers ? 'mc' and jsonb_typeof(p_answers -> 'mc') <> 'null' then
    -- 'none' is no longer offered; saved answers keep it.
    if (p_answers ->> 'mc') not in ('dj', 'other', 'shared', 'none', 'discuss') then
      return jsonb_build_object('ok', false, 'field', 'mc', 'message', 'Choose an option from the list.');
    end if;
    a := a || jsonb_build_object('mc', p_answers ->> 'mc');
  end if;
  foreach k in array array['name', 'pronunciation', 'contact', 'notes'] loop
    v := btrim(coalesce(p_answers ->> k, ''));
    v_limit := case k when 'name' then 200 when 'pronunciation' then 300 when 'contact' then 300 else 1000 end;
    if length(v) > v_limit then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Keep this under ' || to_char(v_limit, 'FM9,999') || ' characters.');
    end if;
    -- The other MC's details are kept only while someone else is the MC or shares the duties.
    if v <> '' and (k = 'notes' or a ->> 'mc' in ('other', 'shared')) then
      a := a || jsonb_build_object(k, v);
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- Unchanged apart from "shared", which needs the other MC's name like "other".
create or replace function private.plan_people_requirements(p_editor text, p_answers jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with input as (select coalesce(p_answers, '{}'::jsonb) as a)
  select case p_editor
    when 'processional' then private.plan_music_requirements('moment_songs', a) || jsonb_build_array(case
      when a ->> 'participants_choice' = 'discuss' then jsonb_build_object('key', 'participants', 'state', 'unanswered', 'discuss', true)
      when jsonb_array_length(coalesce(a -> 'participants', '[]'::jsonb)) > 0 then jsonb_build_object('key', 'participants', 'state', 'answered')
      when a ->> 'choice' = 'not_applicable' then jsonb_build_object('key', 'participants', 'state', 'not_applicable')
      else jsonb_build_object('key', 'participants', 'state', 'unanswered') end)
    when 'mc' then jsonb_build_array(case a ->> 'mc'
      when 'dj' then jsonb_build_object('key', 'mc', 'state', 'answered')
      when 'other' then jsonb_build_object('key', 'mc', 'state', case when a ? 'name' then 'answered' else 'unanswered' end)
      when 'shared' then jsonb_build_object('key', 'mc', 'state', case when a ? 'name' then 'answered' else 'unanswered' end)
      when 'none' then jsonb_build_object('key', 'mc', 'state', 'not_applicable')
      when 'discuss' then jsonb_build_object('key', 'mc', 'state', 'unanswered', 'discuss', true)
      else jsonb_build_object('key', 'mc', 'state', 'unanswered') end)
    when 'introductions' then jsonb_build_array(case
      when a ->> 'choice' = 'discuss' then jsonb_build_object('key', 'introductions', 'state', 'unanswered', 'discuss', true)
      when jsonb_array_length(coalesce(a -> 'entries', '[]'::jsonb)) > 0 then jsonb_build_object('key', 'introductions', 'state', 'answered')
      when a ->> 'choice' = 'none' then jsonb_build_object('key', 'introductions', 'state', 'not_applicable')
      else jsonb_build_object('key', 'introductions', 'state', 'unanswered') end)
      -- Everyone introduced needs their music decided: a song, or the DJ's choice.
      || case when jsonb_array_length(coalesce(a -> 'entries', '[]'::jsonb)) = 0 then '[]'::jsonb
              when exists (select 1 from jsonb_array_elements(a -> 'entries') e where not (e ? 'song_id' or e -> 'music' is not distinct from '"dj_choice"'::jsonb))
                then jsonb_build_array(jsonb_build_object('key', 'entry_music', 'state', 'unanswered', 'note', 'music_open'))
              else jsonb_build_array(jsonb_build_object('key', 'entry_music', 'state', 'answered')) end
    when 'speeches' then jsonb_build_array(case
      when a ->> 'choice' = 'discuss' then jsonb_build_object('key', 'speeches', 'state', 'unanswered', 'discuss', true)
      when jsonb_array_length(coalesce(a -> 'entries', '[]'::jsonb)) > 0 then
        case when exists (select 1 from jsonb_array_elements(a -> 'entries') e
                          where not ((e ->> 'timing' = 'time' and e ? 'time') or (e ->> 'timing' = 'cue' and e ? 'cue')))
             then jsonb_build_object('key', 'speeches', 'state', 'unanswered', 'note', 'timing_open')
             else jsonb_build_object('key', 'speeches', 'state', 'answered') end
      when a ->> 'choice' = 'none' then jsonb_build_object('key', 'speeches', 'state', 'not_applicable')
      else jsonb_build_object('key', 'speeches', 'state', 'unanswered') end)
  end
  from input;
$$;

-- Unchanged apart from "a_little"; "occasional" is no longer offered, saved answers keep it.
create or replace function private.normalize_plan_preferences(p_answers jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.normalize_plan_choices(p_answers,
    '{"interaction":["music_mostly","a_little","interactive","occasional","discuss"],"lyrics":["clean","explicit_ok","discuss"],"requests":["welcome","not_welcome","discuss"]}'::jsonb,
    '{"atmosphere":1000,"notes":1000}'::jsonb);
$$;

-- Unchanged apart from dj_name: the event's DJ, else the business's, else null.
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
