-- The remaining planning editors, in their existing library places: Arrival
-- details (Guest arrival), Program details (Speeches and program), Dinner and
-- Party activities, and Dedications. Speeches, cake cutting and special dances
-- keep their own editors; Arrival music keeps its song editor.
--
-- Where answers live (one revision-checked row per moment, as before):
--   arrival_details    editor 'arrival': fields in private.planning_editor_fields
--                      (validated like stage details: local "HH:MM" times with
--                      explicit next-day marks, the end after the start)
--   program_details    editor 'program': optional overall start/end, host and
--                      pronunciation, notes, plus ordered agenda "entries"
--   dinner_activities  editor 'activities' (shared): ordered "entries"
--   party_activities   editor 'activities'
--   dedications        editor 'dedications': ordered "entries"
--
-- Arrival reuse is explicit: location_source 'ceremony' (the Ceremony's own
-- location) or 'event_venue'; time_source 'ceremony' (the Ceremony's guest
-- arrival time) or 'time'. Nothing is copied; reuse resolves when read and
-- stays open (note "ceremony_missing") while the Ceremony lacks it or is
-- hidden. "No separate arrival arrangements" is arrival_none, refused while
-- location or times are filled in.
--
-- Timed entries (program, activities, dedications): a stable lowercase UUID
-- "id"; timing 'time' ("time" + optional "next_day", the stage time model),
-- 'cue' ("cue" text), 'undecided', and for dedications also 'anytime' (any
-- time during the party). Only the chosen timing's fields are kept. Songs are
-- part of the entry itself (song_title, song_artist, song_version, song_link:
-- one source per entry, no links to other moments): a song needs both title
-- and artist; links must be safe https (private.is_https_url), never fetched.
--   program      title (needed), duration (1-240 min), presenter,
--                pronunciation, notes
--   activities   name (needed), duration, host, participants, pronunciation,
--                notes, song
--   dedications  recipient (needed), relationship, pronunciation, message,
--                notes, song
-- choice: 'none' (No formal program / No activities / No dedications, not
-- applicable, refused while entries exist) or 'discuss' (stays open).
--
-- Completion (optional text never blocks):
--   arrival      location and arrival time, each resolved; or none (both not
--                applicable)
--   program / activities   every entry has a resolved timing (time or cue);
--                otherwise open (note "entry_timing_open")
--   dedications  every entry has a song and a resolved timing (any time, a
--                time or a cue); otherwise open (note "dedication_open")
-- Every library item now has an editor except stages that only hold moments
-- (Guest arrival, Speeches and program, Special dances); progress no longer
-- reports those as "not available" sections.
--
-- Compatibility: nothing renamed; views carry these answers in "moments".
-- Deploy the app first: the deployed app (108f55d) shows these moments as
-- "Not available yet" while progress would count them.

-- ===========================================================================
-- Library and fields
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
    ('moment', 'processional',         array['ceremony'], 'Processional participants', null::text, 'processional', true, 212),
    ('moment', 'couple_entrance',      array['ceremony'], 'Couple entrance', null::text, 'moment_songs', true, 213),
    ('moment', 'ceremony_signing',     array['ceremony'], 'Signing', null::text, 'moment_songs', true, 214),
    ('moment', 'recessional',          array['ceremony'], 'Recessional', null::text, 'moment_songs', true, 215),
    ('moment', 'cocktail_details',     array['cocktail'], 'Location and timing', null::text, 'stage_details', true, 220),
    ('moment', 'cocktail_music',       array['cocktail'], 'Background music', null::text, 'music_background', true, 221),
    ('moment', 'mc',                   array['reception_entrance'], 'MC', null::text, 'mc', true, 230),
    ('moment', 'introductions',        array['reception_entrance'], 'Introductions', null::text, 'introductions', true, 231),
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

create or replace function private.is_moment_editor(p_editor text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_editor in ('processional', 'mc', 'introductions', 'speeches', 'contacts', 'preferences', 'music_style',
                               'arrival', 'program', 'activities', 'dedications'), false);
$$;

-- ===========================================================================
-- Validation
-- ===========================================================================

create function private.normalize_plan_arrival(p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  n jsonb := private.normalize_plan_stage('arrival', p_answers);
  a jsonb;
begin
  if not (n ->> 'ok')::boolean then
    return n;
  end if;
  a := n -> 'answers';
  -- Each reuse keeps only its own fields.
  if a ->> 'location_source' is distinct from 'other' then
    a := a - 'location_other';
  end if;
  if a ->> 'time_source' = 'ceremony' then
    a := a - 'start_time' - 'start_next_day' - 'end_time' - 'end_next_day';
  end if;
  if a ? 'arrival_none' and (a ?| array['location_source', 'location_other', 'location_area', 'time_source', 'start_time', 'end_time']) then
    return jsonb_build_object('ok', false, 'field', 'arrival_none',
      'message', 'Clear the location and times first, or uncheck "No separate arrival arrangements".');
  end if;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- Timed entries and their songs (see the header). Returns {"ok":true,"answers"}
-- or {"ok":false,"field","message"} with fields named "entry:<id>:<field>".
create function private.normalize_plan_timed(p_editor text, p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text jsonb := case p_editor
    when 'program' then '{"title":200,"presenter":200,"pronunciation":300,"notes":500,"cue":300}'
    when 'activities' then '{"name":200,"host":200,"participants":300,"pronunciation":300,"notes":500,"cue":300,"song_title":200,"song_artist":200,"song_version":100,"song_link":1000}'
    else '{"recipient":200,"relationship":120,"pronunciation":300,"message":1000,"notes":500,"cue":300,"song_title":200,"song_artist":200,"song_version":100,"song_link":1000}' end::jsonb;
  v_required text := case p_editor when 'program' then 'title' when 'activities' then 'name' else 'recipient' end;
  v_timings text[] := case when p_editor = 'dedications' then array['anytime', 'time', 'cue', 'undecided'] else array['time', 'cue', 'undecided'] end;
  v_extra text[] := case when p_editor = 'dedications' then array['timing', 'time', 'next_day'] else array['timing', 'time', 'next_day', 'duration'] end;
  v_top text[] := case when p_editor = 'program' then array['entries', 'choice', 'start_time', 'start_next_day', 'end_time', 'end_next_day', 'host', 'host_pronunciation', 'notes']
                       else array['entries', 'choice'] end;
  pe jsonb;
  st jsonb;
  e jsonb;
  o jsonb;
  t text;
  v_id text;
  v_out jsonb := '[]'::jsonb;
  a jsonb := '{}'::jsonb;
  k text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if not (k = any (v_top)) then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;
  if p_editor = 'program' then
    -- The program's own times and host, validated like stage details.
    st := private.normalize_plan_stage('program', p_answers - 'entries' - 'choice');
    if not (st ->> 'ok')::boolean then
      return st;
    end if;
    a := st -> 'answers';
  end if;
  pe := private.normalize_plan_entries(p_answers -> 'entries', 40, v_text, array[v_required], v_extra);
  if not (pe ->> 'ok')::boolean then
    return pe;
  end if;
  for e in select x from jsonb_array_elements(pe -> 'entries') x loop
    v_id := e ->> 'id';
    t := coalesce(e ->> 'timing', 'undecided');
    if jsonb_typeof(coalesce(e -> 'timing', '"undecided"'::jsonb)) <> 'string' or not (t = any (v_timings)) then
      return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':timing', 'message', 'Choose an option from the list.');
    end if;
    if e ? 'time' and (jsonb_typeof(e -> 'time') <> 'string' or (e ->> 'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':time', 'message', 'Enter a time such as 18:30.');
    end if;
    if e ? 'next_day' and jsonb_typeof(e -> 'next_day') <> 'boolean' then
      return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':next_day', 'message', 'Reload the page and try again.');
    end if;
    if e ? 'duration' and (jsonb_typeof(e -> 'duration') <> 'number' or (e ->> 'duration') !~ '^[0-9]{1,3}$' or (e ->> 'duration')::int not between 1 and 240) then
      return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':duration', 'message', 'Enter whole minutes from 1 to 240.');
    end if;
    if (e ? 'song_title' or e ? 'song_artist' or e ? 'song_version' or e ? 'song_link') and not (e ? 'song_title' and e ? 'song_artist') then
      return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':' || case when e ? 'song_title' then 'song_artist' else 'song_title' end,
        'message', 'Enter the song''s title and artist, or clear the song.');
    end if;
    if e ? 'song_link' and not private.is_https_url(e ->> 'song_link') then
      return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':song_link', 'message', 'Enter a full https:// address, or leave the link empty.');
    end if;
    -- Only the chosen timing's fields are kept; a next-day mark needs its time.
    o := e - 'time' - 'next_day' - 'cue' || jsonb_build_object('timing', t);
    if t = 'time' and e ? 'time' then
      o := o || jsonb_build_object('time', e ->> 'time');
      if e -> 'next_day' = 'true'::jsonb then
        o := o || jsonb_build_object('next_day', true);
      end if;
    elsif t = 'cue' and e ? 'cue' then
      o := o || jsonb_build_object('cue', e ->> 'cue');
    end if;
    v_out := v_out || jsonb_build_array(o);
  end loop;
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

create or replace function private.normalize_plan_answers(p_editor text, p_answers jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p_editor = 'basics' then private.normalize_plan_basics(p_answers)
              when p_editor = 'processional' then private.normalize_plan_processional(p_answers)
              when p_editor in ('introductions', 'speeches') then private.normalize_plan_entry_list(p_editor, p_answers)
              when p_editor = 'mc' then private.normalize_plan_mc(p_answers)
              when p_editor = 'contacts' then private.normalize_plan_contacts(p_answers)
              when p_editor = 'preferences' then private.normalize_plan_preferences(p_answers)
              when p_editor = 'music_style' then private.normalize_plan_music_style(p_answers)
              when p_editor = 'arrival' then private.normalize_plan_arrival(p_answers)
              when p_editor in ('program', 'activities', 'dedications') then private.normalize_plan_timed(p_editor, p_answers)
              when private.is_music_editor(p_editor) then private.normalize_plan_music(p_editor, p_answers)
              else private.normalize_plan_stage(p_editor, p_answers) end;
$$;

-- ===========================================================================
-- Completion
-- ===========================================================================

-- p_ceremony: the visible Ceremony's details (null when hidden or absent).
create function private.plan_arrival_requirements(p_answers jsonb, p_venue_known boolean, p_ceremony jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with input as (select coalesce(p_answers, '{}'::jsonb) as a, coalesce(p_ceremony, '{}'::jsonb) as c)
  select case when a ? 'arrival_none' then jsonb_build_array(
      jsonb_build_object('key', 'location', 'state', 'not_applicable'), jsonb_build_object('key', 'arrival_time', 'state', 'not_applicable'))
    else jsonb_build_array(
      case
        when a ->> 'location_source' = 'event_venue' and p_venue_known then jsonb_build_object('key', 'location', 'state', 'answered')
        when a ->> 'location_source' = 'event_venue' then jsonb_build_object('key', 'location', 'state', 'unanswered', 'note', 'venue_unknown')
        when a ->> 'location_source' = 'other' and a ? 'location_other' then jsonb_build_object('key', 'location', 'state', 'answered')
        when a ->> 'location_source' = 'ceremony' and ((c ->> 'location_source' = 'event_venue' and p_venue_known) or (c ->> 'location_source' = 'other' and c ? 'location_other'))
          then jsonb_build_object('key', 'location', 'state', 'answered')
        when a ->> 'location_source' = 'ceremony' then jsonb_build_object('key', 'location', 'state', 'unanswered', 'note', 'ceremony_missing')
        else jsonb_build_object('key', 'location', 'state', 'unanswered') end,
      case
        when a ->> 'time_source' = 'ceremony' and c ? 'guest_arrival_time' then jsonb_build_object('key', 'arrival_time', 'state', 'answered')
        when a ->> 'time_source' = 'ceremony' then jsonb_build_object('key', 'arrival_time', 'state', 'unanswered', 'note', 'ceremony_missing')
        when a ? 'start_time' then jsonb_build_object('key', 'arrival_time', 'state', 'answered')
        else jsonb_build_object('key', 'arrival_time', 'state', 'unanswered') end) end
  from input;
$$;

-- One requirement per timed editor, keyed by p_key; p_song: entries need a song.
create function private.plan_timed_requirements(p_key text, p_answers jsonb, p_song boolean)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with input as (select coalesce(p_answers, '{}'::jsonb) as a)
  select jsonb_build_array(case
    when a ->> 'choice' = 'discuss' then jsonb_build_object('key', p_key, 'state', 'unanswered', 'discuss', true)
    when jsonb_array_length(coalesce(a -> 'entries', '[]'::jsonb)) > 0 then
      case when exists (select 1 from jsonb_array_elements(a -> 'entries') e
                        where not ((e ->> 'timing' = 'time' and e ? 'time') or (e ->> 'timing' = 'cue' and e ? 'cue') or e ->> 'timing' = 'anytime')
                           or (p_song and not e ? 'song_title'))
           then jsonb_build_object('key', p_key, 'state', 'unanswered', 'note', case when p_song then 'dedication_open' else 'entry_timing_open' end)
           else jsonb_build_object('key', p_key, 'state', 'answered') end
    when a ->> 'choice' = 'none' then jsonb_build_object('key', p_key, 'state', 'not_applicable')
    else jsonb_build_object('key', p_key, 'state', 'unanswered') end)
  from input;
$$;

create or replace function private.plan_moment_requirements(p_editor text, p_answers jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with input as (select coalesce(p_answers, '{}'::jsonb) as a)
  select case p_editor
    when 'music_style' then jsonb_build_array(
      case when a ->> 'style_choice' = 'dj_choice' or jsonb_array_length(coalesce(a -> 'genres', '[]'::jsonb)) > 0 or a ? 'other_style'
           then jsonb_build_object('key', 'style', 'state', 'answered')
           else jsonb_build_object('key', 'style', 'state', 'unanswered') end,
      case when a ->> 'slow_songs' = 'discuss' then jsonb_build_object('key', 'slow_songs', 'state', 'unanswered', 'discuss', true)
           when a ? 'slow_songs' then jsonb_build_object('key', 'slow_songs', 'state', 'answered')
           else jsonb_build_object('key', 'slow_songs', 'state', 'unanswered') end)
    when 'program' then private.plan_timed_requirements('program', a, false)
    when 'activities' then private.plan_timed_requirements('activities', a, false)
    when 'dedications' then private.plan_timed_requirements('dedications', a, true)
    else private.plan_people_requirements(p_editor, a) end
  from input;
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

grant execute on function private.normalize_plan_arrival(jsonb), private.normalize_plan_timed(text, jsonb),
  private.plan_arrival_requirements(jsonb, boolean, jsonb), private.plan_timed_requirements(text, jsonb, boolean)
  to authenticated, service_role;
