-- Stage detail editors: timing, location and a few DJ-preparation details
-- inside the existing chronological stages.
--
-- Where answers live. Each editor belongs to a library key, never a label:
--   ceremony            stage_ceremony
--   cocktail            stage_cocktail
--   reception_entrance  stage_entrance
--   dinner              stage_dinner
--   party               stage_party
--   closing             stage_closing
-- Answers are saved on the stage item itself (event_plan_responses, one row
-- per item, revision-checked), so hiding a stage hides its details and keeps
-- them. The earlier placeholder moments that these editors cover
-- (ceremony_details, cocktail_details, dinner_details, closing_instructions)
-- get the marker editor 'stage_details': shown as "included in the details
-- above", not counted separately, never "not available".
--
-- Fields are a fixed, typed list per editor (private.planning_editor_fields):
-- text with limits, choices, local times, explicit "next day" marks, flags and
-- bounded counts. No designer, no expressions.
--
-- Time model. Times are local to the event's time zone ("HH:MM") with an
-- explicit next-day mark (X_time plus X_next_day = true). Nothing is read
-- into an end earlier than its start: within one stage the end must come
-- after the start once next-day marks are applied, or the save is refused
-- with a message pointing at "Next day". Unknown times are allowed. Across
-- stages, private.plan_timeline_warnings compares enabled stages in the
-- staff-defined order and flags a stage that starts before the previous one
-- starts or ends; it never reorders anything. Event basics keeps its own
-- earlier model (an end before the start is shown as "next day").
--
-- Reuse. A location is "same as the event venue" (the staff-entered venue,
-- or Event basics' venue when there is none) or "somewhere else" with its own
-- text. Dinner's guest count can reuse Event basics' count; Closing's finish
-- can reuse Event basics' end time. Nothing is copied: the choice is stored
-- and resolved when read. No imported proposal answer is mapped: no
-- question key has a documented planning meaning.
--
-- Completion (minimal; optional fields never block):
--   ceremony   location, start time, microphone needs (needed / not needed;
--              "discuss with DJ" stays open)
--   cocktail   location, start time
--   entrance   entrance time, or "no formal entrance" (not applicable)
--   dinner     location, start time, guest count (a number, or Event basics'
--              count when that exists)
--   party      location, start time
--   closing    finish time (a time, or Event basics' end time when that
--              exists); "discuss with DJ" stays open
-- Requirement states stay answered / imported / not_applicable / unanswered
-- (unchanged for the deployed app); an open "discuss with DJ" is unanswered
-- with "discuss": true, and an unresolvable reuse carries a "note".
--
-- Planning writes never touch proposals, contracts, payments, gear or booking.
-- Equipment answers (microphones) are information for the DJ to review.
--
-- Compatibility: functions the deployed app calls keep their signatures and
-- shapes; views and save results only gain keys.

-- ===========================================================================
-- Library: editors for six stages, and the moments they cover
-- ===========================================================================

create or replace function private.planning_library()
returns table (kind text, key text, parent_keys text[], default_label text, description text, editor text,
               removable boolean, library_order integer)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('general', 'basics',           null::text[], 'Event basics', 'Guest count, timing and access details for the DJ.', 'basics', false, 10),
    ('general', 'contacts_vendors', null::text[], 'Contacts and vendors', 'Day-of contacts and other vendors.', null::text, true, 20),
    ('general', 'dj_preferences',   null::text[], 'DJ expectations and overall preferences', 'Overall style, volume and what matters most.', null::text, true, 30),

    ('stage', 'arrival',            null::text[], 'Guest arrival', 'Welcome and arrival of guests.', null::text, true, 100),
    ('stage', 'ceremony',           null::text[], 'Ceremony', null::text, 'stage_ceremony', true, 110),
    ('stage', 'cocktail',           null::text[], 'Cocktail', null::text, 'stage_cocktail', true, 120),
    ('stage', 'reception_entrance', null::text[], 'Reception entrance', null::text, 'stage_entrance', true, 130),
    ('stage', 'program',            null::text[], 'Speeches and program', 'Formal part of the event.', null::text, true, 135),
    ('stage', 'dinner',             null::text[], 'Dinner', null::text, 'stage_dinner', true, 140),
    ('stage', 'special_dances',     null::text[], 'Special dances', null::text, null::text, true, 150),
    ('stage', 'party',              null::text[], 'Party', null::text, 'stage_party', true, 160),
    ('stage', 'closing',            null::text[], 'Closing', null::text, 'stage_closing', true, 170),

    ('moment', 'arrival_details',      array['arrival'], 'Arrival details', null::text, null::text, true, 200),
    ('moment', 'arrival_music',        array['arrival'], 'Background music', null::text, null::text, true, 201),
    ('moment', 'ceremony_details',     array['ceremony'], 'Ceremony details', null::text, 'stage_details', true, 210),
    ('moment', 'pre_ceremony_music',   array['ceremony'], 'Pre-ceremony music', null::text, null::text, true, 211),
    ('moment', 'processional',         array['ceremony'], 'Processional participants', null::text, null::text, true, 212),
    ('moment', 'couple_entrance',      array['ceremony'], 'Couple entrance', null::text, null::text, true, 213),
    ('moment', 'ceremony_signing',     array['ceremony'], 'Signing', null::text, null::text, true, 214),
    ('moment', 'recessional',          array['ceremony'], 'Recessional', null::text, null::text, true, 215),
    ('moment', 'cocktail_details',     array['cocktail'], 'Location and timing', null::text, 'stage_details', true, 220),
    ('moment', 'cocktail_music',       array['cocktail'], 'Background music', null::text, null::text, true, 221),
    ('moment', 'mc',                   array['reception_entrance'], 'MC', null::text, null::text, true, 230),
    ('moment', 'introductions',        array['reception_entrance'], 'Introductions', null::text, null::text, true, 231),
    ('moment', 'entrance_participants', array['reception_entrance'], 'Participants and names', null::text, null::text, true, 232),
    ('moment', 'entrance_music',       array['reception_entrance'], 'Entrance music', null::text, null::text, true, 233),
    ('moment', 'program_details',      array['program'], 'Program details', null::text, null::text, true, 235),
    ('moment', 'dinner_details',       array['dinner'], 'Timing', null::text, 'stage_details', true, 240),
    ('moment', 'dinner_music',         array['dinner'], 'Background music', null::text, null::text, true, 241),
    ('moment', 'speeches',             array['dinner', 'program', 'party'], 'Speeches and toasts', null::text, null::text, true, 242),
    ('moment', 'dinner_activities',    array['dinner'], 'Activities', null::text, null::text, true, 243),
    ('moment', 'cake_cutting',         array['dinner', 'party'], 'Cake cutting', null::text, null::text, true, 244),
    ('moment', 'first_dance',          array['special_dances'], 'First dance', null::text, null::text, true, 250),
    ('moment', 'family_dances',        array['special_dances'], 'Family dances', 'Dances with parents or other family members.', null::text, true, 251),
    ('moment', 'other_dances',         array['special_dances'], 'Other special dances', null::text, null::text, true, 252),
    ('moment', 'music_preferences',    array['party'], 'Music preferences', null::text, null::text, true, 260),
    ('moment', 'must_play',            array['party'], 'Must play', null::text, null::text, true, 261),
    ('moment', 'play_if_possible',     array['party'], 'Play if possible', null::text, null::text, true, 262),
    ('moment', 'do_not_play',          array['party'], 'Do not play', null::text, null::text, true, 263),
    ('moment', 'dedications',          array['party'], 'Dedications', null::text, null::text, true, 264),
    ('moment', 'party_activities',     array['party'], 'Optional activities', 'For example a bouquet toss.', null::text, true, 265),
    ('moment', 'last_dances',          array['closing'], 'Last dances', null::text, null::text, true, 270),
    ('moment', 'final_song',           array['closing'], 'Final song', null::text, null::text, true, 271),
    ('moment', 'closing_instructions', array['closing'], 'Closing instructions', null::text, 'stage_details', true, 272)
  ) as l(kind, key, parent_keys, default_label, description, editor, removable, library_order);
$$;

-- ===========================================================================
-- Field definitions and validation
-- ===========================================================================

-- kind: text (max_value = length), choice (choices), time ("HH:MM"),
-- next_day (true only; belongs to the matching *_time), flag (true only),
-- int (min_value..max_value).
create function private.planning_editor_fields()
returns table (editor text, field text, kind text, min_value integer, max_value integer, choices text[])
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('stage_ceremony', 'location_source', 'choice', null::int, null::int, array['event_venue', 'other']),
    ('stage_ceremony', 'location_other', 'text', null, 500, null::text[]),
    ('stage_ceremony', 'location_area', 'text', null, 200, null),
    ('stage_ceremony', 'guest_arrival_time', 'time', null, null, null),
    ('stage_ceremony', 'guest_arrival_next_day', 'next_day', null, null, null),
    ('stage_ceremony', 'start_time', 'time', null, null, null),
    ('stage_ceremony', 'start_next_day', 'next_day', null, null, null),
    ('stage_ceremony', 'end_time', 'time', null, null, null),
    ('stage_ceremony', 'end_next_day', 'next_day', null, null, null),
    ('stage_ceremony', 'officiant_name', 'text', null, 200, null),
    ('stage_ceremony', 'officiant_contact', 'text', null, 200, null),
    ('stage_ceremony', 'microphones', 'choice', null, null, array['not_needed', 'needed', 'discuss']),
    ('stage_ceremony', 'microphone_notes', 'text', null, 500, null),
    ('stage_ceremony', 'instructions', 'text', null, 2000, null),

    ('stage_cocktail', 'location_source', 'choice', null, null, array['event_venue', 'other']),
    ('stage_cocktail', 'location_other', 'text', null, 500, null),
    ('stage_cocktail', 'location_area', 'text', null, 200, null),
    ('stage_cocktail', 'start_time', 'time', null, null, null),
    ('stage_cocktail', 'start_next_day', 'next_day', null, null, null),
    ('stage_cocktail', 'end_time', 'time', null, null, null),
    ('stage_cocktail', 'end_next_day', 'next_day', null, null, null),
    ('stage_cocktail', 'atmosphere', 'text', null, 1000, null),
    ('stage_cocktail', 'instructions', 'text', null, 2000, null),

    ('stage_entrance', 'guest_entry_time', 'time', null, null, null),
    ('stage_entrance', 'guest_entry_next_day', 'next_day', null, null, null),
    ('stage_entrance', 'entrance_time', 'time', null, null, null),
    ('stage_entrance', 'entrance_next_day', 'next_day', null, null, null),
    ('stage_entrance', 'entrance_none', 'flag', null, null, null),

    ('stage_dinner', 'location_source', 'choice', null, null, array['event_venue', 'other']),
    ('stage_dinner', 'location_other', 'text', null, 500, null),
    ('stage_dinner', 'location_area', 'text', null, 200, null),
    ('stage_dinner', 'start_time', 'time', null, null, null),
    ('stage_dinner', 'start_next_day', 'next_day', null, null, null),
    ('stage_dinner', 'end_time', 'time', null, null, null),
    ('stage_dinner', 'end_next_day', 'next_day', null, null, null),
    ('stage_dinner', 'meal_style', 'choice', null, null, array['plated', 'buffet', 'family_style', 'stations', 'other']),
    ('stage_dinner', 'guest_count_source', 'choice', null, null, array['basics', 'number']),
    ('stage_dinner', 'guest_count', 'int', 1, 5000, null),

    ('stage_party', 'location_source', 'choice', null, null, array['event_venue', 'other']),
    ('stage_party', 'location_other', 'text', null, 500, null),
    ('stage_party', 'location_area', 'text', null, 200, null),
    ('stage_party', 'start_time', 'time', null, null, null),
    ('stage_party', 'start_next_day', 'next_day', null, null, null),
    ('stage_party', 'end_time', 'time', null, null, null),
    ('stage_party', 'end_next_day', 'next_day', null, null, null),
    ('stage_party', 'evening_guests', 'int', 0, 5000, null),

    ('stage_closing', 'finish_source', 'choice', null, null, array['time', 'basics_end', 'discuss']),
    ('stage_closing', 'finish_time', 'time', null, null, null),
    ('stage_closing', 'finish_next_day', 'next_day', null, null, null),
    ('stage_closing', 'closing_instructions', 'text', null, 2000, null)
  ) as f(editor, field, kind, min_value, max_value, choices);
$$;

-- Minutes from the start of the event day for a time with its next-day mark
-- (prefix "start" reads start_time and start_next_day), or null.
create function private.plan_minutes(p_answers jsonb, p_prefix text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_answers ->> (p_prefix || '_time') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    split_part(p_answers ->> (p_prefix || '_time'), ':', 1)::int * 60 + split_part(p_answers ->> (p_prefix || '_time'), ':', 2)::int
    + case when p_answers -> (p_prefix || '_next_day') = 'true'::jsonb then 1440 else 0 end
  end;
$$;

-- Validates and normalizes a stage editor's answers. Partial answers are
-- fine. Returns {"ok":true,"answers"} or {"ok":false,"field","message"}.
create function private.normalize_plan_stage(p_editor text, p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  a jsonb := '{}'::jsonb;
  f record;
  v jsonb;
  s text;
  k text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if not exists (select 1 from private.planning_editor_fields() x where x.editor = p_editor and x.field = k) then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;
  for f in select * from private.planning_editor_fields() x where x.editor = p_editor loop
    v := p_answers -> f.field;
    continue when v is null or jsonb_typeof(v) = 'null';
    if f.kind = 'text' then
      if jsonb_typeof(v) <> 'string' then
        return jsonb_build_object('ok', false, 'field', f.field, 'message', 'Reload the page and try again.');
      end if;
      s := btrim(v #>> '{}');
      if length(s) > f.max_value then
        return jsonb_build_object('ok', false, 'field', f.field, 'message', 'Keep this under ' || to_char(f.max_value, 'FM9,999') || ' characters.');
      end if;
      if s <> '' then
        a := a || jsonb_build_object(f.field, s);
      end if;
    elsif f.kind = 'choice' then
      if jsonb_typeof(v) <> 'string' or not ((v #>> '{}') = any (f.choices)) then
        return jsonb_build_object('ok', false, 'field', f.field, 'message', 'Choose an option from the list.');
      end if;
      a := a || jsonb_build_object(f.field, v #>> '{}');
    elsif f.kind = 'time' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        return jsonb_build_object('ok', false, 'field', f.field, 'message', 'Enter a time such as 18:30.');
      end if;
      a := a || jsonb_build_object(f.field, v #>> '{}');
    elsif f.kind in ('flag', 'next_day') then
      if jsonb_typeof(v) <> 'boolean' then
        return jsonb_build_object('ok', false, 'field', f.field, 'message', 'Reload the page and try again.');
      end if;
      if v = 'true'::jsonb then
        a := a || jsonb_build_object(f.field, true);
      end if;
    elsif f.kind = 'int' then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,4}$' or (v #>> '{}')::int not between f.min_value and f.max_value then
        return jsonb_build_object('ok', false, 'field', f.field,
          'message', 'Enter a whole number from ' || f.min_value || ' to ' || to_char(f.max_value, 'FM9,999') || '.');
      end if;
      a := a || jsonb_build_object(f.field, (v #>> '{}')::int);
    end if;
  end loop;
  -- A next-day mark means nothing without its time.
  for f in select * from private.planning_editor_fields() x where x.editor = p_editor and x.kind = 'next_day' loop
    if a ? f.field and not a ? replace(f.field, '_next_day', '_time') then
      a := a - f.field;
    end if;
  end loop;
  -- Within a stage the end comes after the start; after midnight is explicit.
  if a ? 'start_time' and a ? 'end_time' and private.plan_minutes(a, 'end') <= private.plan_minutes(a, 'start') then
    return jsonb_build_object('ok', false, 'field', 'end_time',
      'message', 'The end must be after the start. If it ends after midnight, check "Next day".');
  end if;
  if a ? 'entrance_none' and a ? 'entrance_time' then
    return jsonb_build_object('ok', false, 'field', 'entrance_time',
      'message', 'Remove the entrance time or uncheck "No formal entrance", not both.');
  end if;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

create function private.normalize_plan_answers(p_editor text, p_answers jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p_editor = 'basics' then private.normalize_plan_basics(p_answers)
              else private.normalize_plan_stage(p_editor, p_answers) end;
$$;

-- What a stage editor needs to be complete (see the header). p_venue_known:
-- the event has a staff-entered venue or Event basics has one.
create function private.plan_stage_requirements(p_editor text, p_answers jsonb, p_venue_known boolean, p_basics jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  a jsonb := coalesce(p_answers, '{}'::jsonb);
  b jsonb := coalesce(p_basics, '{}'::jsonb);
  r jsonb := '[]'::jsonb;
begin
  if p_editor in ('stage_ceremony', 'stage_cocktail', 'stage_dinner', 'stage_party') then
    r := r || jsonb_build_array(
      case
        when a ->> 'location_source' = 'event_venue' and p_venue_known then jsonb_build_object('key', 'location', 'state', 'answered')
        when a ->> 'location_source' = 'event_venue' then jsonb_build_object('key', 'location', 'state', 'unanswered', 'note', 'venue_unknown')
        when a ->> 'location_source' = 'other' and a ? 'location_other' then jsonb_build_object('key', 'location', 'state', 'answered')
        else jsonb_build_object('key', 'location', 'state', 'unanswered')
      end,
      jsonb_build_object('key', 'start_time', 'state', case when a ? 'start_time' then 'answered' else 'unanswered' end));
  end if;
  if p_editor = 'stage_ceremony' then
    r := r || jsonb_build_array(case a ->> 'microphones'
      when 'needed' then jsonb_build_object('key', 'microphones', 'state', 'answered')
      when 'not_needed' then jsonb_build_object('key', 'microphones', 'state', 'answered')
      when 'discuss' then jsonb_build_object('key', 'microphones', 'state', 'unanswered', 'discuss', true)
      else jsonb_build_object('key', 'microphones', 'state', 'unanswered') end);
  elsif p_editor = 'stage_dinner' then
    r := r || jsonb_build_array(case
      when a ->> 'guest_count_source' = 'number' and a ? 'guest_count' then jsonb_build_object('key', 'guest_count', 'state', 'answered')
      when a ->> 'guest_count_source' = 'basics' and b ? 'guest_count' then jsonb_build_object('key', 'guest_count', 'state', 'answered')
      when a ->> 'guest_count_source' = 'basics' then jsonb_build_object('key', 'guest_count', 'state', 'unanswered', 'note', 'basics_missing')
      else jsonb_build_object('key', 'guest_count', 'state', 'unanswered') end);
  elsif p_editor = 'stage_entrance' then
    r := r || jsonb_build_array(case
      when a ? 'entrance_time' then jsonb_build_object('key', 'entrance', 'state', 'answered')
      when a ? 'entrance_none' then jsonb_build_object('key', 'entrance', 'state', 'not_applicable')
      else jsonb_build_object('key', 'entrance', 'state', 'unanswered') end);
  elsif p_editor = 'stage_closing' then
    r := r || jsonb_build_array(case
      when a ->> 'finish_source' = 'time' and a ? 'finish_time' then jsonb_build_object('key', 'finish', 'state', 'answered')
      when a ->> 'finish_source' = 'basics_end' and b ? 'end_time' then jsonb_build_object('key', 'finish', 'state', 'answered')
      when a ->> 'finish_source' = 'basics_end' then jsonb_build_object('key', 'finish', 'state', 'unanswered', 'note', 'basics_missing')
      when a ->> 'finish_source' = 'discuss' then jsonb_build_object('key', 'finish', 'state', 'unanswered', 'discuss', true)
      else jsonb_build_object('key', 'finish', 'state', 'unanswered') end);
  end if;
  return r;
end;
$$;

grant execute on function private.planning_editor_fields(), private.plan_minutes(jsonb, text),
  private.normalize_plan_stage(text, jsonb), private.normalize_plan_answers(text, jsonb),
  private.plan_stage_requirements(text, jsonb, boolean, jsonb)
  to authenticated, service_role;

-- ===========================================================================
-- Progress and chronology
-- ===========================================================================

create or replace function private.plan_progress(p_plan_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.event_plans%rowtype;
  v_venue text;
  v_basics jsonb;
  v_venue_known boolean;
  r record;
  v_req jsonb;
  v_items jsonb := '[]'::jsonb;
  v_state text;
  v_item_total int;
  v_item_met int;
  v_total int := 0;
  v_met int := 0;
  v_available int := 0;
  v_complete int := 0;
  v_unavailable int := 0;
begin
  select * into v_plan from public.event_plans where id = p_plan_id;
  select e.venue_name into v_venue from public.events e where e.tenant_id = v_plan.tenant_id and e.id = v_plan.event_id;
  select resp.answers into v_basics from public.event_plan_items i
    join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key = 'basics';
  v_venue_known := v_venue is not null or coalesce(v_basics, '{}'::jsonb) ? 'venue_details';
  for r in
    select i.id, i.key, l.editor, resp.answers
    from public.event_plan_items i
    join private.planning_library() l on l.key = i.key
    left join public.event_plan_items p on p.tenant_id = i.tenant_id and p.plan_id = i.plan_id and p.id = i.parent_id
    left join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.disabled_at is null and (p.id is null or p.disabled_at is null)
    order by l.library_order
  loop
    -- Covered by its stage's details: nothing of its own to count.
    continue when r.editor = 'stage_details';
    if r.editor = 'basics' then
      v_req := private.plan_basics_requirements(r.answers, v_venue);
    elsif r.editor like 'stage\_%' then
      v_req := private.plan_stage_requirements(r.editor, r.answers, v_venue_known, v_basics);
    else
      v_req := null;
    end if;
    if v_req is not null then
      select count(*)::int, (count(*) filter (where x ->> 'state' <> 'unanswered'))::int into v_item_total, v_item_met
      from jsonb_array_elements(v_req) x;
      v_state := case when v_item_met = v_item_total then 'complete'
                      when coalesce(r.answers, '{}'::jsonb) <> '{}'::jsonb then 'in_progress'
                      else 'not_started' end;
      v_total := v_total + v_item_total;
      v_met := v_met + v_item_met;
      v_available := v_available + 1;
      v_complete := v_complete + case when v_state = 'complete' then 1 else 0 end;
    else
      v_req := '[]'::jsonb;
      v_item_total := 0;
      v_item_met := 0;
      v_state := 'not_available';
      v_unavailable := v_unavailable + 1;
    end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_id', r.id, 'key', r.key, 'state', v_state, 'requirements', v_req, 'met', v_item_met, 'total', v_item_total));
  end loop;
  return jsonb_build_object(
    'scope', 'available_sections_only',
    'items', v_items,
    'requirements_total', v_total,
    'requirements_met', v_met,
    'percent', case when v_total = 0 then null else (v_met * 100) / v_total end,
    'available_sections', v_available,
    'complete_sections', v_complete,
    'unavailable_sections', v_unavailable);
end;
$$;

-- Chronology warnings over enabled stages with details, in the staff's
-- order (never re-sorted by time): a stage starting before the previous one
-- starts or ends, and order problems inside a stage. Informational only.
create function private.plan_timeline_warnings(p_plan_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  a jsonb;
  b jsonb;
  w jsonb := '[]'::jsonb;
  v_s int;
  v_e int;
  v_x int;
  v_y int;
  v_basics_end int;
  prev_label text;
  prev_s int;
  prev_e int;
begin
  select resp.answers into b from public.event_plan_items i
    join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = p_plan_id and i.key = 'basics';
  b := coalesce(b, '{}'::jsonb);
  -- Event basics' end: earlier than its start means the next day (shown so in its editor).
  v_basics_end := private.plan_minutes(b, 'end');
  if v_basics_end is not null and private.plan_minutes(b, 'start') is not null and v_basics_end <= private.plan_minutes(b, 'start') then
    v_basics_end := v_basics_end + 1440;
  end if;

  for r in
    select i.id, i.key, i.label, l.editor, resp.answers
    from public.event_plan_items i
    join private.planning_library() l on l.key = i.key
    left join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = p_plan_id and i.kind = 'stage' and i.disabled_at is null
      and l.editor like 'stage\_%' and l.editor <> 'stage_details'
    order by i.position, i.id
  loop
    a := coalesce(r.answers, '{}'::jsonb);
    case r.editor
      when 'stage_ceremony' then
        v_s := private.plan_minutes(a, 'start');
        v_e := private.plan_minutes(a, 'end');
        v_x := private.plan_minutes(a, 'guest_arrival');
        if v_x is not null and v_s is not null and v_x > v_s then
          w := w || jsonb_build_array(jsonb_build_object('item_id', r.id, 'key', r.key, 'message', 'Guest arrival is after the ceremony starts.'));
        end if;
      when 'stage_entrance' then
        v_x := private.plan_minutes(a, 'guest_entry');
        v_y := private.plan_minutes(a, 'entrance');
        if v_x is not null and v_y is not null and v_y < v_x then
          w := w || jsonb_build_array(jsonb_build_object('item_id', r.id, 'key', r.key, 'message', 'The entrance is before guests enter.'));
        end if;
        v_s := coalesce(v_x, v_y);
        v_e := v_y;
      when 'stage_closing' then
        v_s := case a ->> 'finish_source' when 'time' then private.plan_minutes(a, 'finish') when 'basics_end' then v_basics_end end;
        v_e := v_s;
      else
        v_s := private.plan_minutes(a, 'start');
        v_e := private.plan_minutes(a, 'end');
    end case;
    if v_s is not null then
      if prev_s is not null and v_s < prev_s then
        w := w || jsonb_build_array(jsonb_build_object('item_id', r.id, 'key', r.key, 'message',
          case when r.editor = 'stage_closing' then 'The finish time is before ' || prev_label || ' starts.'
               else r.label || ' starts before ' || prev_label || ' starts.' end));
      elsif prev_e is not null and v_s < prev_e then
        w := w || jsonb_build_array(jsonb_build_object('item_id', r.id, 'key', r.key, 'message',
          case when r.editor = 'stage_closing' then 'The finish time is before ' || prev_label || ' ends.'
               else r.label || ' starts before ' || prev_label || ' ends.' end));
      end if;
      prev_label := r.label;
      prev_s := v_s;
      prev_e := v_e;
    end if;
  end loop;
  return w;
end;
$$;

-- Answers of enabled stages that have details, keyed by item id.
create function private.plan_stage_details(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(i.id, jsonb_build_object('answers', coalesce(r.answers, '{}'::jsonb), 'revision', coalesce(r.revision, 0))), '{}'::jsonb)
  from public.event_plan_items i
  join private.planning_library() l on l.key = i.key
  left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = p_plan_id and i.kind = 'stage' and i.disabled_at is null
    and l.editor like 'stage\_%' and l.editor <> 'stage_details';
$$;

-- Stages now carry their editor (null when they have none yet).
create or replace function private.plan_structure(p_plan_id uuid, p_include_disabled boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'general', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'key', g.key, 'label', g.label, 'editor', l.editor, 'removable', l.removable,
                                          'disabled', g.disabled_at is not null) order by g.position, g.id)
      from public.event_plan_items g join private.planning_library() l on l.key = g.key
      where g.plan_id = p_plan_id and g.kind = 'general' and (p_include_disabled or g.disabled_at is null)), '[]'::jsonb),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'label', s.label, 'editor', sl.editor, 'disabled', s.disabled_at is not null,
        'moments', coalesce((
          select jsonb_agg(jsonb_build_object('id', m.id, 'key', m.key, 'label', m.label, 'editor', ml.editor,
                                              'disabled', m.disabled_at is not null) order by m.position, m.id)
          from public.event_plan_items m join private.planning_library() ml on ml.key = m.key
          where m.plan_id = p_plan_id and m.parent_id = s.id and (p_include_disabled or m.disabled_at is null)), '[]'::jsonb))
        order by s.position, s.id)
      from public.event_plan_items s join private.planning_library() sl on sl.key = s.key
      where s.plan_id = p_plan_id and s.kind = 'stage' and (p_include_disabled or s.disabled_at is null)), '[]'::jsonb));
$$;

-- ===========================================================================
-- Saving any item with an editor
-- ===========================================================================

-- Saves one plan item's answers with an optimistic revision (0 = never
-- saved). The caller has locked the event (share) and the plan (update).
-- Hidden items and items without an editor can't be saved.
create function private.save_plan_item(p_plan_id uuid, p_item_id uuid, p_expected_revision integer, p_answers jsonb, p_actor text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.event_plan_items%rowtype;
  v_editor text;
  v_resp public.event_plan_responses%rowtype;
  v_norm jsonb;
begin
  select * into v_item from public.event_plan_items where plan_id = p_plan_id and id = p_item_id;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select l.editor into v_editor from private.planning_library() l where l.key = v_item.key;
  if v_editor is null or v_editor = 'stage_details' or v_item.disabled_at is not null
     or exists (select 1 from public.event_plan_items p where p.id = v_item.parent_id and p.disabled_at is not null) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  v_norm := private.normalize_plan_answers(v_editor, p_answers);
  if not (v_norm ->> 'ok')::boolean then
    return jsonb_build_object('status', 'invalid', 'field', v_norm -> 'field', 'message', v_norm ->> 'message');
  end if;
  select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
  if not found then
    if p_expected_revision is distinct from 0 then
      return jsonb_build_object('status', 'conflict');
    end if;
    insert into public.event_plan_responses (tenant_id, plan_id, item_id, answers, updated_by_actor, updated_by_user_id)
    values (v_item.tenant_id, p_plan_id, v_item.id, v_norm -> 'answers', p_actor, p_user_id)
    on conflict (item_id) do nothing
    returning * into v_resp;
    if v_resp.id is null then
      return jsonb_build_object('status', 'conflict');
    end if;
  else
    if p_expected_revision is distinct from v_resp.revision then
      return jsonb_build_object('status', 'conflict');
    end if;
    update public.event_plan_responses
      set answers = v_norm -> 'answers', revision = revision + 1, updated_by_actor = p_actor, updated_by_user_id = p_user_id
      where id = v_resp.id returning * into v_resp;
  end if;
  return jsonb_build_object('status', 'saved', 'revision', v_resp.revision, 'answers', v_resp.answers,
                            'progress', private.plan_progress(p_plan_id), 'timeline_warnings', private.plan_timeline_warnings(p_plan_id));
end;
$$;

-- Event basics keeps its entry points (the deployed app calls them).
create or replace function private.save_plan_basics(p_plan_id uuid, p_expected_revision integer, p_answers jsonb, p_actor text, p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.save_plan_item(p_plan_id, (select i.id from public.event_plan_items i where i.plan_id = p_plan_id and i.key = 'basics'),
                                p_expected_revision, p_answers, p_actor, p_user_id);
$$;

create function public.client_save_plan_item(p_event_id uuid, p_tenant_slug text, p_item_id uuid, p_expected_revision integer, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
begin
  if (select auth.uid()) is null then
    return jsonb_build_object('status', 'signed_out');
  end if;
  select ev.* into e from public.events ev join public.tenants tt on tt.id = ev.tenant_id
  where ev.id = p_event_id and tt.slug = p_tenant_slug;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;
  -- Lock order: event, then plan.
  select * into e from public.events where id = e.id for share;
  if not private.client_can_access_plan(e.id) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id for update;
  return private.save_plan_item(v_plan.id, p_item_id, p_expected_revision, p_answers, 'client', (select auth.uid()));
end;
$$;

create function public.staff_save_plan_item(p_event_id uuid, p_item_id uuid, p_expected_revision integer, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
begin
  p := private.lock_plan_for_staff(p_event_id, null);
  return private.save_plan_item(p.id, p_item_id, p_expected_revision, p_answers, 'staff', (select auth.uid()));
end;
$$;

-- ===========================================================================
-- Views gain stage details and chronology warnings
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
    'structure', private.plan_structure(v_plan.id, false),
    'basics', jsonb_build_object('item_id', v_basics.id, 'answers', coalesce(v_basics.answers, '{}'::jsonb),
                                 'revision', coalesce(v_basics.revision, 0)),
    'stage_details', private.plan_stage_details(v_plan.id),
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
    'structure', private.plan_structure(v_plan.id, true),
    'basics', jsonb_build_object('item_id', v_basics.id, 'answers', coalesce(v_basics.answers, '{}'::jsonb),
                                 'revision', coalesce(v_basics.revision, 0), 'updated_by', v_basics.updated_by_actor,
                                 'updated_at', v_basics.updated_at),
    'stage_details', private.plan_stage_details(v_plan.id),
    'timeline_warnings', private.plan_timeline_warnings(v_plan.id),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

-- ===========================================================================
-- Function privileges
-- ===========================================================================

revoke execute on function
  private.plan_timeline_warnings(uuid),
  private.plan_stage_details(uuid),
  private.save_plan_item(uuid, uuid, integer, jsonb, text, uuid)
  from public, anon, authenticated;
revoke execute on function
  public.client_save_plan_item(uuid, text, uuid, integer, jsonb),
  public.staff_save_plan_item(uuid, uuid, integer, jsonb)
  from public, anon;
grant execute on function
  public.client_save_plan_item(uuid, text, uuid, integer, jsonb),
  public.staff_save_plan_item(uuid, uuid, integer, jsonb)
  to authenticated;
