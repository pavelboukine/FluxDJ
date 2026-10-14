-- Reception entrance (Batch 4C).
--
-- 1. A formal grand entrance is an explicit decision on the Reception entrance
--    stage: "grand_entrance" = planned | none | undecided. Older answers keep
--    their meaning without being rewritten: "entrance_none" reads as none and
--    an entrance time without a decision reads as planned. A decision of none
--    or undecided keeps any saved entrance time (hidden, never cleared), so
--    switching back restores it; the time counts only while planned.
-- 2. The stage can say where the reception takes place ("location_area",
--    optional free text, the same field name the other stages use).
-- 3. Completion of the stage: the decision is needed; while planned, so is
--    the grand entrance time; none is not applicable; undecided stays open
--    ("not_decided"). Guest entry stays optional and independent.
-- 4. Introductions (and the older Entrance music list) belong to the grand
--    entrance: while it is none or undecided, or not answered and they hold
--    nothing yet, they are left out of progress entirely (not counted, not
--    complete) and keep everything saved. Older plans whose introductions
--    already hold answers are counted as before until a decision is made.
-- 5. Introductions can hold their own songs (moment songs: title, artist,
--    instructions, ...), entered right with a person or group, like the
--    Processional. Entries may link to their own songs or, in older plans, to
--    Entrance music; anything else is refused. Entrance music saves are now
--    refused only for removing a song an introduction links to.
-- 6. Chronology warnings use the entrance time only while it counts.
-- 7. The Wedding starter's Reception entrance holds MC and Introductions
--    ("Grand entrance order"), without the separate Participants and names
--    and Entrance music moments. Only templates created from the starter from
--    now on are affected; installed templates (BOUPROD's included), plans and
--    answers are untouched, and both moments stay in the library.
--
-- Same signatures (privileges kept by create or replace); one new private
-- helper, private.plan_grand_entrance, not executable by API roles.

create function private.plan_grand_entrance(p_answers jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_answers ->> 'grand_entrance' in ('planned', 'none', 'undecided') then p_answers ->> 'grand_entrance'
    when p_answers -> 'entrance_none' = 'true'::jsonb then 'none'
    when p_answers ? 'entrance_time' then 'planned'
  end;
$$;

revoke execute on function private.plan_grand_entrance(jsonb) from public, anon, authenticated;

create or replace function private.planning_editor_fields()
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
    ('stage_entrance', 'location_area', 'text', null, 200, null),
    ('stage_entrance', 'grand_entrance', 'choice', null, null, array['planned', 'none', 'undecided']),
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
    ('stage_closing', 'closing_instructions', 'text', null, 2000, null),

    ('arrival', 'location_source', 'choice', null, null, array['event_venue', 'ceremony', 'other']),
    ('arrival', 'location_other', 'text', null, 500, null),
    ('arrival', 'location_area', 'text', null, 200, null),
    ('arrival', 'time_source', 'choice', null, null, array['time', 'ceremony']),
    ('arrival', 'start_time', 'time', null, null, null),
    ('arrival', 'start_next_day', 'next_day', null, null, null),
    ('arrival', 'end_time', 'time', null, null, null),
    ('arrival', 'end_next_day', 'next_day', null, null, null),
    ('arrival', 'welcome', 'text', null, 2000, null),
    ('arrival', 'announcement', 'text', null, 1000, null),
    ('arrival', 'arrival_none', 'flag', null, null, null),

    ('program', 'start_time', 'time', null, null, null),
    ('program', 'start_next_day', 'next_day', null, null, null),
    ('program', 'end_time', 'time', null, null, null),
    ('program', 'end_next_day', 'next_day', null, null, null),
    ('program', 'host', 'text', null, 200, null),
    ('program', 'host_pronunciation', 'text', null, 300, null),
    ('program', 'notes', 'text', null, 2000, null)
  ) as f(editor, field, kind, min_value, max_value, choices);
$$;

create or replace function private.normalize_plan_stage(p_editor text, p_answers jsonb)
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
  -- The grand entrance decision replaces the older "No formal entrance" mark;
  -- the two are never stored together. A time kept beside "none" or
  -- "undecided" is a hidden earlier answer, preserved for switching back.
  if a ? 'grand_entrance' and a ? 'entrance_none' then
    return jsonb_build_object('ok', false, 'field', 'grand_entrance', 'message', 'Reload the page and try again.');
  end if;
  if a ? 'entrance_none' and a ? 'entrance_time' then
    return jsonb_build_object('ok', false, 'field', 'entrance_time',
      'message', 'Remove the entrance time or uncheck "No formal entrance", not both.');
  end if;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- Introductions: {"entries": [...], "choice": "none" | "discuss", "songs": [...]};
-- speeches: {"entries": [...], "choice": ...}.
create or replace function private.normalize_plan_entry_list(p_editor text, p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  pe jsonb;
  e jsonb;
  o jsonb;
  m jsonb;
  r jsonb;
  v_out jsonb := '[]'::jsonb;
  v_t text;
  a jsonb := '{}'::jsonb;
  k text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if k not in ('entries', 'choice') and not (p_editor = 'introductions' and k = 'songs') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;
  if p_editor = 'introductions' then
    -- The grand entrance's own songs, validated as moment songs (no choice of their own).
    m := private.normalize_plan_music('moment_songs', jsonb_build_object('songs', p_answers -> 'songs'));
    if not (m ->> 'ok')::boolean then
      return m;
    end if;
    pe := private.normalize_plan_entries(p_answers -> 'entries', 40,
      '{"names":300,"role":120,"pronunciation":300,"wording":500,"notes":500}'::jsonb, array['names'], array['song_id']);
    if not (pe ->> 'ok')::boolean then
      return pe;
    end if;
    -- Well-formed links here; which songs they may name is checked with the
    -- plan (private.check_plan_song_links), since Entrance music is another row.
    r := private.check_song_links(pe -> 'entries',
      array(select x ->> 'song_id' from jsonb_array_elements(pe -> 'entries') x
            where x ->> 'song_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
      'Reload the page and try again.');
    if not (r ->> 'ok')::boolean then
      return r;
    end if;
    v_out := pe -> 'entries';
    if (m -> 'answers') ? 'songs' then
      a := a || jsonb_build_object('songs', m -> 'answers' -> 'songs');
    end if;
  else
    pe := private.normalize_plan_entries(p_answers -> 'entries', 30,
      '{"speaker":200,"role":120,"pronunciation":300,"cue":300,"av_notes":500,"notes":500}'::jsonb, array['speaker'],
      array['timing', 'time', 'next_day', 'duration']);
    if not (pe ->> 'ok')::boolean then
      return pe;
    end if;
    -- Timing: an exact local time (with an explicit next-day mark), a cue, or not decided.
    for e in select x from jsonb_array_elements(pe -> 'entries') x loop
      v_t := coalesce(e ->> 'timing', 'undecided');
      if jsonb_typeof(coalesce(e -> 'timing', '"undecided"'::jsonb)) <> 'string' or v_t not in ('time', 'cue', 'undecided') then
        return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':timing', 'message', 'Choose an option from the list.');
      end if;
      if e ? 'time' and (jsonb_typeof(e -> 'time') <> 'string' or (e ->> 'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
        return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':time', 'message', 'Enter a time such as 18:30.');
      end if;
      if e ? 'next_day' and jsonb_typeof(e -> 'next_day') <> 'boolean' then
        return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':next_day', 'message', 'Reload the page and try again.');
      end if;
      if e ? 'duration' and (jsonb_typeof(e -> 'duration') <> 'number' or (e ->> 'duration') !~ '^[0-9]{1,3}$' or (e ->> 'duration')::int not between 1 and 240) then
        return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':duration', 'message', 'Enter whole minutes from 1 to 240.');
      end if;
      -- Only the chosen timing's fields are kept; a next-day mark needs its time.
      o := e - 'time' - 'next_day' - 'cue' || jsonb_build_object('timing', v_t);
      if v_t = 'time' and e ? 'time' then
        o := o || jsonb_build_object('time', e ->> 'time');
        if e -> 'next_day' = 'true'::jsonb then
          o := o || jsonb_build_object('next_day', true);
        end if;
      elsif v_t = 'cue' and e ? 'cue' then
        o := o || jsonb_build_object('cue', e ->> 'cue');
      end if;
      v_out := v_out || jsonb_build_array(o);
    end loop;
  end if;
  if p_answers ? 'choice' and jsonb_typeof(p_answers -> 'choice') <> 'null' then
    if jsonb_typeof(p_answers -> 'choice') <> 'string' or (p_answers ->> 'choice') not in ('none', 'discuss') then
      return jsonb_build_object('ok', false, 'field', 'choice', 'message', 'Choose an option from the list.');
    end if;
    if p_answers ->> 'choice' = 'none' and jsonb_array_length(v_out) > 0 then
      return jsonb_build_object('ok', false, 'field', 'choice',
        'message', 'Remove the entries first, or keep them and choose "I''ll list them".');
    end if;
    a := a || jsonb_build_object('choice', p_answers ->> 'choice');
  end if;
  if jsonb_array_length(v_out) > 0 then
    a := a || jsonb_build_object('entries', v_out);
  end if;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- Song links into another moment of the same plan, checked when either side
-- saves. The callers hold the plan row lock (every plan save takes it), so a
-- link and a removal can't pass each other. Returns null when fine, or an
-- "invalid" result.
create or replace function private.check_plan_song_links(p_plan_id uuid, p_item_key text, p_old jsonb, p_new jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_other jsonb;
  r jsonb;
  v_link record;
begin
  if p_item_key = 'processional' then
    select resp.answers into v_other from public.event_plan_items i
      join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
      where i.plan_id = p_plan_id and i.key = 'couple_entrance';
    r := private.check_song_links(coalesce(p_new -> 'participants', '[]'::jsonb),
      array(select s ->> 'id' from jsonb_array_elements(coalesce(p_new -> 'songs', '[]'::jsonb) || coalesce(v_other -> 'songs', '[]'::jsonb)) s),
      'That song is no longer in Processional or Couple entrance. Choose another song or none.');
    if not (r ->> 'ok')::boolean then
      return jsonb_build_object('status', 'invalid', 'field', r -> 'field', 'message', r ->> 'message');
    end if;
  elsif p_item_key = 'couple_entrance' then
    select resp.answers into v_other from public.event_plan_items i
      join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
      where i.plan_id = p_plan_id and i.key = 'processional';
    -- Processional people linked to a Couple entrance song this save removes.
    select e ->> 'song_id' as song_id, string_agg(e ->> 'names', ', ' order by o) as names into v_link
    from jsonb_array_elements(coalesce(v_other -> 'participants', '[]'::jsonb)) with ordinality as x(e, o)
    where exists (select 1 from jsonb_array_elements(coalesce(p_old -> 'songs', '[]'::jsonb)) s where s ->> 'id' = e ->> 'song_id')
      and not exists (select 1 from jsonb_array_elements(coalesce(p_new -> 'songs', '[]'::jsonb)) s where s ->> 'id' = e ->> 'song_id')
    group by e ->> 'song_id'
    limit 1;
    if v_link.song_id is not null then
      return jsonb_build_object('status', 'invalid', 'field', 'song:' || v_link.song_id || ':linked', 'message',
        '"' || (select s ->> 'title' from jsonb_array_elements(p_old -> 'songs') s where s ->> 'id' = v_link.song_id)
        || '" is linked to who walks in (' || v_link.names || '). Change those entries under Processional first.');
    end if;
  elsif p_item_key = 'introductions' then
    -- Their own songs, or (older plans) Entrance music's.
    select resp.answers into v_other from public.event_plan_items i
      join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
      where i.plan_id = p_plan_id and i.key = 'entrance_music';
    r := private.check_song_links(coalesce(p_new -> 'entries', '[]'::jsonb),
      array(select s ->> 'id' from jsonb_array_elements(coalesce(p_new -> 'songs', '[]'::jsonb) || coalesce(v_other -> 'songs', '[]'::jsonb)) s),
      'That song is no longer in the grand entrance songs or Entrance music. Choose another song or none.');
    if not (r ->> 'ok')::boolean then
      return jsonb_build_object('status', 'invalid', 'field', r -> 'field', 'message', r ->> 'message');
    end if;
  elsif p_item_key = 'entrance_music' then
    select resp.answers into v_other from public.event_plan_items i
      join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
      where i.plan_id = p_plan_id and i.key = 'introductions';
    -- Introductions linked to an Entrance music song this save removes (links
    -- to the introductions' own songs are not Entrance music's concern).
    select e ->> 'song_id' as song_id, string_agg(e ->> 'names', ', ' order by o) as names into v_link
    from jsonb_array_elements(coalesce(v_other -> 'entries', '[]'::jsonb)) with ordinality as x(e, o)
    where exists (select 1 from jsonb_array_elements(coalesce(p_old -> 'songs', '[]'::jsonb)) s where s ->> 'id' = e ->> 'song_id')
      and not exists (select 1 from jsonb_array_elements(coalesce(p_new -> 'songs', '[]'::jsonb)) s where s ->> 'id' = e ->> 'song_id')
    group by e ->> 'song_id'
    limit 1;
    if v_link.song_id is not null then
      return jsonb_build_object('status', 'invalid', 'field', 'song:' || v_link.song_id || ':linked', 'message',
        '"' || coalesce((select s ->> 'title' from jsonb_array_elements(coalesce(p_old -> 'songs', '[]'::jsonb)) s where s ->> 'id' = v_link.song_id), 'This song')
        || '" is linked to introductions (' || v_link.names || '). Change those introductions first.');
    end if;
  end if;
  return null;
end;
$$;

create or replace function private.plan_stage_requirements(p_editor text, p_answers jsonb, p_venue_known boolean, p_basics jsonb)
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
      end);
    -- A ceremony needs its guest arrival time (no default is ever assumed).
    if p_editor = 'stage_ceremony' then
      r := r || jsonb_build_array(jsonb_build_object('key', 'guest_arrival', 'state', case when a ? 'guest_arrival_time' then 'answered' else 'unanswered' end));
    end if;
    r := r || jsonb_build_array(jsonb_build_object('key', 'start_time', 'state', case when a ? 'start_time' then 'answered' else 'unanswered' end));
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
    -- The decision, then (only while planned) its time. Guest entry stays optional.
    r := r || jsonb_build_array(case private.plan_grand_entrance(a)
      when 'planned' then jsonb_build_object('key', 'grand_entrance', 'state', 'answered')
      when 'none' then jsonb_build_object('key', 'grand_entrance', 'state', 'not_applicable')
      when 'undecided' then jsonb_build_object('key', 'grand_entrance', 'state', 'unanswered', 'note', 'not_decided')
      else jsonb_build_object('key', 'grand_entrance', 'state', 'unanswered') end);
    if private.plan_grand_entrance(a) = 'planned' then
      r := r || jsonb_build_array(jsonb_build_object('key', 'entrance', 'state', case when a ? 'entrance_time' then 'answered' else 'unanswered' end));
    end if;
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
  v_ceremony jsonb;
  v_entrance text;
  v_entrance_saved boolean;
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
  -- The visible Ceremony's details, for arrival answers that reuse them.
  select resp.answers into v_ceremony from public.event_plan_items i
    join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key = 'ceremony' and i.disabled_at is null;
  -- The grand entrance decision, and whether its moments already hold answers
  -- (older plans answered them before the decision existed).
  select private.plan_grand_entrance(coalesce(resp.answers, '{}'::jsonb)) into v_entrance from public.event_plan_items i
    left join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key = 'reception_entrance';
  select exists (select 1 from public.event_plan_items i
    join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key in ('introductions', 'entrance_music') and i.disabled_at is null
      and resp.answers <> '{}'::jsonb) into v_entrance_saved;
  for r in
    select i.id, i.key, i.kind, l.editor, resp.answers
    from public.event_plan_items i
    join private.planning_library() l on l.key = i.key
    left join public.event_plan_items p on p.tenant_id = i.tenant_id and p.plan_id = i.plan_id and p.id = i.parent_id
    left join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.disabled_at is null and (p.id is null or p.disabled_at is null)
    order by l.library_order
  loop
    -- Covered by another editor: nothing of its own to count.
    continue when r.editor in ('stage_details', 'included');
    -- A stage without fields of its own (Guest arrival, Speeches and program,
    -- Special dances) only holds moments, which count themselves.
    continue when r.kind = 'stage' and r.editor is null;
    -- The grand entrance's moments count only while it is planned (or, before
    -- any decision, once they hold answers). Otherwise they are left out of
    -- progress altogether, keeping what is saved.
    continue when r.key in ('introductions', 'entrance_music')
      and (v_entrance in ('none', 'undecided') or (v_entrance is null and not v_entrance_saved));
    if r.editor = 'basics' then
      v_req := private.plan_basics_requirements(r.answers, v_venue);
    elsif r.editor = 'contacts' then
      v_req := private.plan_contacts_requirements(v_plan.id, r.answers);
    elsif r.editor = 'arrival' then
      v_req := private.plan_arrival_requirements(r.answers, v_venue_known, v_ceremony);
    elsif r.editor = 'preferences' then
      v_req := private.plan_preferences_requirements(r.answers, v_basics);
    elsif private.is_moment_editor(r.editor) then
      v_req := private.plan_moment_requirements(r.editor, r.answers);
    elsif private.is_music_editor(r.editor) then
      v_req := private.plan_music_requirements(r.editor, r.answers);
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

create or replace function private.plan_timeline_warnings(p_plan_id uuid)
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
        -- A grand entrance time kept while the entrance is skipped or undecided isn't on the timeline.
        v_y := case when private.plan_grand_entrance(a) = 'planned' then private.plan_minutes(a, 'entrance') end;
        if v_x is not null and v_y is not null and v_y < v_x then
          w := w || jsonb_build_array(jsonb_build_object('item_id', r.id, 'key', r.key, 'message', 'The grand entrance is before guests enter.'));
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

create or replace function private.starter_planning_items(p_starter text)
returns table (key text, parent_key text, item_position integer)
language sql
immutable
set search_path = ''
as $$
  select s.key, s.parent_key, s.item_position from (values
    ('wedding', 'basics', null, 1), ('wedding', 'contacts_vendors', null, 2), ('wedding', 'dj_preferences', null, 3),
    ('wedding', 'ceremony', null, 1), ('wedding', 'cocktail', null, 2), ('wedding', 'reception_entrance', null, 3),
    ('wedding', 'dinner', null, 4), ('wedding', 'special_dances', null, 5), ('wedding', 'party', null, 6), ('wedding', 'closing', null, 7),
    ('wedding', 'ceremony_details', 'ceremony', 1), ('wedding', 'pre_ceremony_music', 'ceremony', 2), ('wedding', 'processional', 'ceremony', 3),
    ('wedding', 'ceremony_signing', 'ceremony', 4), ('wedding', 'recessional', 'ceremony', 5),
    ('wedding', 'cocktail_details', 'cocktail', 1), ('wedding', 'cocktail_music', 'cocktail', 2),
    ('wedding', 'mc', 'reception_entrance', 1), ('wedding', 'introductions', 'reception_entrance', 2),
    ('wedding', 'dinner_details', 'dinner', 1), ('wedding', 'dinner_music', 'dinner', 2), ('wedding', 'speeches', 'dinner', 3),
    ('wedding', 'dinner_activities', 'dinner', 4), ('wedding', 'cake_cutting', 'dinner', 5),
    ('wedding', 'first_dance', 'special_dances', 1), ('wedding', 'family_dances', 'special_dances', 2), ('wedding', 'other_dances', 'special_dances', 3),
    ('wedding', 'music_preferences', 'party', 1), ('wedding', 'must_play', 'party', 2), ('wedding', 'play_if_possible', 'party', 3),
    ('wedding', 'do_not_play', 'party', 4), ('wedding', 'dedications', 'party', 5), ('wedding', 'party_activities', 'party', 6),
    ('wedding', 'last_dances', 'closing', 1), ('wedding', 'final_song', 'closing', 2), ('wedding', 'closing_instructions', 'closing', 3),
    ('simple_party', 'basics', null, 1),
    ('simple_party', 'party', null, 1),
    ('simple_party', 'must_play', 'party', 1), ('simple_party', 'do_not_play', 'party', 2)
  ) as s(starter, key, parent_key, item_position)
  where s.starter = p_starter;
$$;

create or replace function private.planning_library()
returns table (kind text, key text, parent_keys text[], default_label text, description text, editor text,
               removable boolean, library_order integer)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('general', 'basics',           null::text[], 'Event basics', 'Guest count, timing and access details for the DJ.', 'basics', false, 10),
    ('general', 'contacts_vendors', null::text[], 'Contacts and vendors', 'Day-of contacts and other vendors.', 'contacts', true, 20),
    ('general', 'dj_preferences',   null::text[], 'DJ expectations and overall preferences', 'Overall style, volume and what matters most.', 'preferences', true, 30),

    ('stage', 'arrival',            null::text[], 'Guest arrival', 'Welcome and arrival of guests.', null::text, true, 100),
    ('stage', 'ceremony',           null::text[], 'Ceremony', null::text, 'stage_ceremony', true, 110),
    ('stage', 'cocktail',           null::text[], 'Cocktail', null::text, 'stage_cocktail', true, 120),
    ('stage', 'reception_entrance', null::text[], 'Reception entrance', null::text, 'stage_entrance', true, 130),
    ('stage', 'program',            null::text[], 'Speeches and program', 'Formal part of the event.', null::text, true, 135),
    ('stage', 'dinner',             null::text[], 'Dinner', null::text, 'stage_dinner', true, 140),
    ('stage', 'special_dances',     null::text[], 'Special dances', null::text, null::text, true, 150),
    ('stage', 'party',              null::text[], 'Party', null::text, 'stage_party', true, 160),
    ('stage', 'closing',            null::text[], 'Closing', null::text, 'stage_closing', true, 170),

    ('moment', 'arrival_details',      array['arrival'], 'Arrival details', null::text, 'arrival', true, 200),
    ('moment', 'arrival_music',        array['arrival'], 'Background music', null::text, 'music_background', true, 201),
    ('moment', 'ceremony_details',     array['ceremony'], 'Ceremony details', null::text, 'stage_details', true, 210),
    ('moment', 'pre_ceremony_music',   array['ceremony'], 'Pre-ceremony music', null::text, 'music_background', true, 211),
    ('moment', 'processional',         array['ceremony'], 'Processional', 'Everyone who walks down the aisle, in order, with their music.', 'processional', true, 212),
    ('moment', 'couple_entrance',      array['ceremony'], 'Couple entrance', null::text, 'moment_songs', true, 213),
    ('moment', 'ceremony_signing',     array['ceremony'], 'Signing', null::text, 'moment_songs', true, 214),
    ('moment', 'recessional',          array['ceremony'], 'Recessional', null::text, 'moment_songs', true, 215),
    ('moment', 'cocktail_details',     array['cocktail'], 'Location and timing', null::text, 'stage_details', true, 220),
    ('moment', 'cocktail_music',       array['cocktail'], 'Background music', null::text, 'music_background', true, 221),
    ('moment', 'mc',                   array['reception_entrance'], 'MC', null::text, 'mc', true, 230),
    ('moment', 'introductions',        array['reception_entrance'], 'Grand entrance order', 'Who is introduced, in order, with how to announce them and their songs.', 'introductions', true, 231),
    ('moment', 'entrance_participants', array['reception_entrance'], 'Participants and names', null::text, 'included', true, 232),
    ('moment', 'entrance_music',       array['reception_entrance'], 'Entrance music', null::text, 'moment_songs', true, 233),
    ('moment', 'program_details',      array['program'], 'Program details', null::text, 'program', true, 235),
    ('moment', 'dinner_details',       array['dinner'], 'Timing', null::text, 'stage_details', true, 240),
    ('moment', 'dinner_music',         array['dinner'], 'Background music', null::text, 'music_background', true, 241),
    ('moment', 'speeches',             array['dinner', 'program', 'party'], 'Speeches and toasts', null::text, 'speeches', true, 242),
    ('moment', 'dinner_activities',    array['dinner'], 'Activities', null::text, 'activities', true, 243),
    ('moment', 'cake_cutting',         array['dinner', 'party'], 'Cake cutting', null::text, 'moment_songs', true, 244),
    ('moment', 'first_dance',          array['special_dances'], 'First dance', null::text, 'moment_songs', true, 250),
    ('moment', 'family_dances',        array['special_dances'], 'Family dances', 'Dances with parents or other family members.', 'moment_songs', true, 251),
    ('moment', 'other_dances',         array['special_dances'], 'Other special dances', null::text, 'moment_songs', true, 252),
    ('moment', 'music_preferences',    array['party'], 'Music preferences', null::text, 'music_style', true, 260),
    ('moment', 'must_play',            array['party'], 'Must play', null::text, 'music_requests', true, 261),
    ('moment', 'play_if_possible',     array['party'], 'Play if possible', null::text, 'music_requests', true, 262),
    ('moment', 'do_not_play',          array['party'], 'Do not play', null::text, 'music_exclusions', true, 263),
    ('moment', 'dedications',          array['party'], 'Dedications', null::text, 'dedications', true, 264),
    ('moment', 'party_activities',     array['party'], 'Optional activities', 'For example a bouquet toss.', 'activities', true, 265),
    ('moment', 'last_dances',          array['closing'], 'Last dances', null::text, 'moment_songs', true, 270),
    ('moment', 'final_song',           array['closing'], 'Final song', null::text, 'moment_songs', true, 271),
    ('moment', 'closing_instructions', array['closing'], 'Closing instructions', null::text, 'stage_details', true, 272)
  ) as l(kind, key, parent_keys, default_label, description, editor, removable, library_order);
$$;
