-- Participants, text pronunciation guides, MC details and speeches, inside
-- the existing chronological stages. Text only: no recordings, no speech
-- synthesis, no music service.
--
-- Where answers live (one revision-checked row per moment, as before):
--   processional           songs (unchanged) + ordered "participants": who
--                          walks in, each optionally linked to a song of
--                          this moment or of Couple entrance (same ceremony,
--                          same plan). Couple entrance keeps its songs only;
--                          whoever walks in, the couple included, is listed
--                          under Processional, never twice.
--   introductions          the one reception participant editor: ordered
--                          introductions, each optionally linked to an
--                          Entrance music song by entry id (several may
--                          share one). Entrance music stays the only song
--                          source; songs are never copied.
--   entrance_participants  covered by Introductions (editor 'included'):
--                          shown as included there, not saved, not counted.
--   mc                     the DJ, someone else (name, pronunciation,
--                          contact, instructions), no MC, or discuss.
--   speeches               ordered speakers wherever the moment sits
--                          (dinner, program or party), with timing: an exact
--                          time ("HH:MM" + explicit next-day mark, local to
--                          the event like stage times), a cue ("After the
--                          main course") or not decided yet.
--
-- Song links. A participant stores only "song_id". On every save of either
-- side, in the same transaction and under the plan lock every save takes:
--   - a link must name a song of the permitted source in the same plan
--     (Processional: its own songs or Couple entrance's; Introductions:
--     Entrance music's songs);
--   - a linked song can't be removed from its list: the save is refused and
--     names the linked entries, so nothing points at nothing.
-- Titles, artists and order are read through the link, so editing or
-- reordering songs never touches participants. Hiding a source keeps its
-- songs, and the links stay valid; the app shows them as hidden.
--
-- Completion (optional pronunciation, roles, wording, contacts, durations
-- and instructions never block):
--   processional  songs (as before) and "participants": people entered;
--                 not applicable with the moment; discuss stays open
--   introductions entries; "No introductions" = not applicable; discuss open
--   mc            the DJ; someone else with a name; "No MC" = not
--                 applicable; discuss open
--   speeches      entries, each with a speaker and a resolved timing (a
--                 time, or a cue); "No speeches" = not applicable; discuss
--                 open; any undecided timing keeps it open (note
--                 "timing_open")
-- Alternatives are refused while entries exist: nothing is removed silently.
--
-- Retries: as for songs, a save identical to the stored answers counts as
-- saved even with an older revision, so a doubled add never duplicates.
--
-- Compatibility: views gain the key "moments"; nothing is renamed. Deploy
-- the app first: the deployed app (7b27023) shows these moments as "Not
-- available yet" while progress would count them, and would no longer show
-- Processional's songs.

-- ===========================================================================
-- Library
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
    ('moment', 'program_details',      array['program'], 'Program details', null::text, null::text, true, 235),
    ('moment', 'dinner_details',       array['dinner'], 'Timing', null::text, 'stage_details', true, 240),
    ('moment', 'dinner_music',         array['dinner'], 'Background music', null::text, 'music_background', true, 241),
    ('moment', 'speeches',             array['dinner', 'program', 'party'], 'Speeches and toasts', null::text, 'speeches', true, 242),
    ('moment', 'dinner_activities',    array['dinner'], 'Activities', null::text, null::text, true, 243),
    ('moment', 'cake_cutting',         array['dinner', 'party'], 'Cake cutting', null::text, 'moment_songs', true, 244),
    ('moment', 'first_dance',          array['special_dances'], 'First dance', null::text, 'moment_songs', true, 250),
    ('moment', 'family_dances',        array['special_dances'], 'Family dances', 'Dances with parents or other family members.', 'moment_songs', true, 251),
    ('moment', 'other_dances',         array['special_dances'], 'Other special dances', null::text, 'moment_songs', true, 252),
    ('moment', 'music_preferences',    array['party'], 'Music preferences', null::text, null::text, true, 260),
    ('moment', 'must_play',            array['party'], 'Must play', null::text, 'music_requests', true, 261),
    ('moment', 'play_if_possible',     array['party'], 'Play if possible', null::text, 'music_requests', true, 262),
    ('moment', 'do_not_play',          array['party'], 'Do not play', null::text, 'music_exclusions', true, 263),
    ('moment', 'dedications',          array['party'], 'Dedications', null::text, null::text, true, 264),
    ('moment', 'party_activities',     array['party'], 'Optional activities', 'For example a bouquet toss.', null::text, true, 265),
    ('moment', 'last_dances',          array['closing'], 'Last dances', null::text, 'moment_songs', true, 270),
    ('moment', 'final_song',           array['closing'], 'Final song', null::text, 'moment_songs', true, 271),
    ('moment', 'closing_instructions', array['closing'], 'Closing instructions', null::text, 'stage_details', true, 272)
  ) as l(kind, key, parent_keys, default_label, description, editor, removable, library_order);
$$;

create function private.is_moment_editor(p_editor text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_editor in ('processional', 'mc', 'introductions', 'speeches'), false);
$$;

-- ===========================================================================
-- Validation
-- ===========================================================================

-- Ordered entries with a stable lowercase UUID "id" (unique in the list).
-- p_text: text fields and their length limits; p_required: text fields that
-- must be filled; p_other: non-text fields passed through for the caller.
-- Returns {"ok":true,"entries"} or {"ok":false,"field","message"} with
-- fields named "entry:<id>:<field>".
create function private.normalize_plan_entries(p_list jsonb, p_max integer, p_text jsonb, p_required text[], p_other text[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_ids text[] := '{}'::text[];
  e jsonb;
  o jsonb;
  k text;
  v text;
  v_id text;
begin
  if p_list is null or jsonb_typeof(p_list) = 'null' then
    return jsonb_build_object('ok', true, 'entries', '[]'::jsonb);
  end if;
  if jsonb_typeof(p_list) <> 'array' then
    return jsonb_build_object('ok', false, 'field', 'entries', 'message', 'Reload the page and try again.');
  end if;
  if jsonb_array_length(p_list) > p_max then
    return jsonb_build_object('ok', false, 'field', 'entries', 'message', 'Keep this to ' || p_max || ' entries or fewer.');
  end if;
  for e in select x from jsonb_array_elements(p_list) x loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'id') is distinct from 'string'
       or (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (e ->> 'id') = any (v_ids) then
      return jsonb_build_object('ok', false, 'field', 'entries', 'message', 'Reload the page and try again.');
    end if;
    v_id := e ->> 'id';
    v_ids := v_ids || v_id;
    o := jsonb_build_object('id', v_id);
    for k in select jsonb_object_keys(e) loop
      continue when k = 'id';
      if p_text ? k then
        if jsonb_typeof(e -> k) not in ('string', 'null') then
          return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':' || k, 'message', 'Reload the page and try again.');
        end if;
        v := btrim(coalesce(e ->> k, ''));
        if length(v) > (p_text ->> k)::int then
          return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':' || k,
            'message', 'Keep this under ' || (p_text ->> k) || ' characters.');
        end if;
        if v <> '' then
          o := o || jsonb_build_object(k, v);
        end if;
      elsif k = any (p_other) then
        if jsonb_typeof(e -> k) <> 'null' then
          o := o || jsonb_build_object(k, e -> k);
        end if;
      else
        return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':' || k, 'message', 'Reload the page and try again.');
      end if;
    end loop;
    foreach k in array p_required loop
      if not o ? k then
        return jsonb_build_object('ok', false, 'field', 'entry:' || v_id || ':' || k,
          'message', case k when 'speaker' then 'Enter the speaker''s name.' else 'Enter the name or names.' end);
      end if;
    end loop;
    v_out := v_out || jsonb_build_array(o);
  end loop;
  return jsonb_build_object('ok', true, 'entries', v_out);
end;
$$;

-- A "song_id" on each entry, when present, is a UUID naming one of p_song_ids.
create function private.check_song_links(p_entries jsonb, p_song_ids text[], p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':song_id', 'message',
             case when jsonb_typeof(e -> 'song_id') = 'string' and (e ->> 'song_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then p_message else 'Reload the page and try again.' end)
    from jsonb_array_elements(p_entries) with ordinality as x(e, o)
    where e ? 'song_id' and not (jsonb_typeof(e -> 'song_id') = 'string' and (e ->> 'song_id') = any (p_song_ids))
    order by o limit 1), jsonb_build_object('ok', true));
$$;

create function private.normalize_plan_processional(p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  m jsonb;
  pe jsonb;
  r jsonb;
  a jsonb;
  k text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if k not in ('songs', 'choice', 'participants', 'participants_choice') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;
  m := private.normalize_plan_music('moment_songs', p_answers - 'participants' - 'participants_choice');
  if not (m ->> 'ok')::boolean then
    return m;
  end if;
  a := m -> 'answers';
  pe := private.normalize_plan_entries(p_answers -> 'participants', 30,
    '{"names":300,"role":120,"pronunciation":300,"notes":500}'::jsonb, array['names'], array['song_id']);
  if not (pe ->> 'ok')::boolean then
    return pe;
  end if;
  -- Well-formed links here; which songs they may name is checked with the
  -- plan (private.check_plan_song_links), since Couple entrance is another row.
  r := private.check_song_links(pe -> 'entries',
    array(select e ->> 'song_id' from jsonb_array_elements(pe -> 'entries') e
          where e ->> 'song_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    'Reload the page and try again.');
  if not (r ->> 'ok')::boolean then
    return r;
  end if;
  if jsonb_array_length(pe -> 'entries') > 0 then
    if a ->> 'choice' = 'not_applicable' then
      return jsonb_build_object('ok', false, 'field', 'choice',
        'message', 'Remove the people walking in first, or keep them and choose "I''ll list the songs".');
    end if;
    a := a || jsonb_build_object('participants', pe -> 'entries');
  end if;
  if p_answers ? 'participants_choice' and jsonb_typeof(p_answers -> 'participants_choice') <> 'null' then
    if p_answers -> 'participants_choice' <> '"discuss"'::jsonb then
      return jsonb_build_object('ok', false, 'field', 'participants_choice', 'message', 'Choose an option from the list.');
    end if;
    a := a || jsonb_build_object('participants_choice', 'discuss');
  end if;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- Introductions and speeches: {"entries": [...], "choice": "none" | "discuss"}.
create function private.normalize_plan_entry_list(p_editor text, p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  pe jsonb;
  e jsonb;
  o jsonb;
  v_out jsonb := '[]'::jsonb;
  v_t text;
  a jsonb := '{}'::jsonb;
  k text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if k not in ('entries', 'choice') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;
  if p_editor = 'introductions' then
    pe := private.normalize_plan_entries(p_answers -> 'entries', 40,
      '{"names":300,"role":120,"pronunciation":300,"wording":500,"notes":500}'::jsonb, array['names'], array['song_id']);
    if not (pe ->> 'ok')::boolean then
      return pe;
    end if;
    v_out := pe -> 'entries';
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

create function private.normalize_plan_mc(p_answers jsonb)
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
    if (p_answers ->> 'mc') not in ('dj', 'other', 'none', 'discuss') then
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
    -- Someone else's details are kept only when someone else is the MC.
    if v <> '' and (k = 'notes' or a ->> 'mc' = 'other') then
      a := a || jsonb_build_object(k, v);
    end if;
  end loop;
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
              when private.is_music_editor(p_editor) then private.normalize_plan_music(p_editor, p_answers)
              else private.normalize_plan_stage(p_editor, p_answers) end;
$$;

-- ===========================================================================
-- Completion
-- ===========================================================================

create function private.plan_moment_requirements(p_editor text, p_answers jsonb)
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
      when 'none' then jsonb_build_object('key', 'mc', 'state', 'not_applicable')
      when 'discuss' then jsonb_build_object('key', 'mc', 'state', 'unanswered', 'discuss', true)
      else jsonb_build_object('key', 'mc', 'state', 'unanswered') end)
    when 'introductions' then jsonb_build_array(case
      when a ->> 'choice' = 'discuss' then jsonb_build_object('key', 'introductions', 'state', 'unanswered', 'discuss', true)
      when jsonb_array_length(coalesce(a -> 'entries', '[]'::jsonb)) > 0 then jsonb_build_object('key', 'introductions', 'state', 'answered')
      when a ->> 'choice' = 'none' then jsonb_build_object('key', 'introductions', 'state', 'not_applicable')
      else jsonb_build_object('key', 'introductions', 'state', 'unanswered') end)
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

grant execute on function private.is_moment_editor(text),
  private.normalize_plan_entries(jsonb, integer, jsonb, text[], text[]), private.check_song_links(jsonb, text[], text),
  private.normalize_plan_processional(jsonb), private.normalize_plan_entry_list(text, jsonb), private.normalize_plan_mc(jsonb),
  private.plan_moment_requirements(text, jsonb)
  to authenticated, service_role;

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
    -- Covered by another editor: nothing of its own to count.
    continue when r.editor in ('stage_details', 'included');
    if r.editor = 'basics' then
      v_req := private.plan_basics_requirements(r.answers, v_venue);
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

-- ===========================================================================
-- Saving: song links checked across rows, under the plan lock
-- ===========================================================================

-- Song links into another moment of the same plan, checked when either side
-- saves. The callers hold the plan row lock (every plan save takes it), so a
-- link and a removal can't pass each other. Returns null when fine, or an
-- "invalid" result.
create function private.check_plan_song_links(p_plan_id uuid, p_item_key text, p_old jsonb, p_new jsonb)
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
    select resp.answers into v_other from public.event_plan_items i
      join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
      where i.plan_id = p_plan_id and i.key = 'entrance_music';
    r := private.check_song_links(coalesce(p_new -> 'entries', '[]'::jsonb),
      array(select s ->> 'id' from jsonb_array_elements(coalesce(v_other -> 'songs', '[]'::jsonb)) s),
      'That song is no longer in Entrance music. Choose another song or none.');
    if not (r ->> 'ok')::boolean then
      return jsonb_build_object('status', 'invalid', 'field', r -> 'field', 'message', r ->> 'message');
    end if;
  elsif p_item_key = 'entrance_music' then
    select resp.answers into v_other from public.event_plan_items i
      join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
      where i.plan_id = p_plan_id and i.key = 'introductions';
    select e ->> 'song_id' as song_id, string_agg(e ->> 'names', ', ' order by o) as names into v_link
    from jsonb_array_elements(coalesce(v_other -> 'entries', '[]'::jsonb)) with ordinality as x(e, o)
    where e ? 'song_id'
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

create or replace function private.save_plan_item(p_plan_id uuid, p_item_id uuid, p_expected_revision integer, p_answers jsonb, p_actor text, p_user_id uuid)
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
  v_links jsonb;
  v_replay_safe boolean;
begin
  select * into v_item from public.event_plan_items where plan_id = p_plan_id and id = p_item_id;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select l.editor into v_editor from private.planning_library() l where l.key = v_item.key;
  if v_editor is null or v_editor in ('stage_details', 'included') or v_item.disabled_at is not null
     or exists (select 1 from public.event_plan_items p where p.id = v_item.parent_id and p.disabled_at is not null) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  v_norm := private.normalize_plan_answers(v_editor, p_answers);
  if not (v_norm ->> 'ok')::boolean then
    return jsonb_build_object('status', 'invalid', 'field', v_norm -> 'field', 'message', v_norm ->> 'message');
  end if;
  v_replay_safe := private.is_music_editor(v_editor) or private.is_moment_editor(v_editor);
  select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
  v_links := private.check_plan_song_links(p_plan_id, v_item.key, v_resp.answers, v_norm -> 'answers');
  if v_links is not null then
    return v_links;
  end if;
  if v_resp.id is null then
    if p_expected_revision is distinct from 0 then
      return jsonb_build_object('status', 'conflict');
    end if;
    insert into public.event_plan_responses (tenant_id, plan_id, item_id, answers, updated_by_actor, updated_by_user_id)
    values (v_item.tenant_id, p_plan_id, v_item.id, v_norm -> 'answers', p_actor, p_user_id)
    on conflict (item_id) do nothing
    returning * into v_resp;
    if v_resp.id is null then
      -- A concurrent first save won: the same answers are this save, already stored.
      select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
      if not (v_replay_safe and v_resp.answers = v_norm -> 'answers') then
        return jsonb_build_object('status', 'conflict');
      end if;
    end if;
  elsif p_expected_revision is distinct from v_resp.revision then
    -- A retried or doubled save (same entry ids) is already stored.
    if not (v_replay_safe and v_resp.answers = v_norm -> 'answers') then
      return jsonb_build_object('status', 'conflict');
    end if;
  elsif v_resp.answers is distinct from v_norm -> 'answers' or not v_replay_safe then
    update public.event_plan_responses
      set answers = v_norm -> 'answers', revision = revision + 1, updated_by_actor = p_actor, updated_by_user_id = p_user_id
      where id = v_resp.id returning * into v_resp;
  end if;
  return jsonb_build_object('status', 'saved', 'revision', v_resp.revision, 'answers', v_resp.answers,
                            'progress', private.plan_progress(p_plan_id), 'timeline_warnings', private.plan_timeline_warnings(p_plan_id));
end;
$$;

-- ===========================================================================
-- Views gain the answers of visible participant, MC and speech moments
-- ===========================================================================

-- Processional also stays in "music" (its songs count for play / do-not-play warnings).
create or replace function private.plan_music(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(i.id, jsonb_build_object('answers', coalesce(r.answers, '{}'::jsonb), 'revision', coalesce(r.revision, 0))), '{}'::jsonb)
  from public.event_plan_items i
  join private.planning_library() l on l.key = i.key
  left join public.event_plan_items p on p.tenant_id = i.tenant_id and p.plan_id = i.plan_id and p.id = i.parent_id
  left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = p_plan_id and i.disabled_at is null and (p.id is null or p.disabled_at is null)
    and (private.is_music_editor(l.editor) or l.editor = 'processional');
$$;

create function private.plan_moment_answers(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(i.id, jsonb_build_object('answers', coalesce(r.answers, '{}'::jsonb), 'revision', coalesce(r.revision, 0))), '{}'::jsonb)
  from public.event_plan_items i
  join private.planning_library() l on l.key = i.key
  left join public.event_plan_items p on p.tenant_id = i.tenant_id and p.plan_id = i.plan_id and p.id = i.parent_id
  left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = p_plan_id and i.disabled_at is null and (p.id is null or p.disabled_at is null)
    and private.is_moment_editor(l.editor);
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
    'music', private.plan_music(v_plan.id),
    'moments', private.plan_moment_answers(v_plan.id),
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
    'music', private.plan_music(v_plan.id),
    'moments', private.plan_moment_answers(v_plan.id),
    'timeline_warnings', private.plan_timeline_warnings(v_plan.id),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

revoke execute on function private.plan_moment_answers(uuid), private.check_plan_song_links(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
