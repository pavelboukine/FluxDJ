-- Reception entrance refinements (Batch 4C, before release).
--
-- 1. Guest entry is needed: a "guest_entry" requirement for every visible
--    Reception entrance, whatever the grand entrance decision (yes, no or not
--    sure). No time is ever assumed; saved answers are unchanged, so existing
--    plans with that stage show one more open requirement until answered.
-- 2. Each entry of the grand entrance order (Introductions) decides its music
--    explicitly: a linked song (song_id), or "music": "dj_choice". Neither
--    means "not decided yet"; an entry without a song is never read as the
--    DJ's choice, and the two are never stored together. Introductions with
--    entries gain an "entry_music" requirement, answered once every entry has
--    a song or the DJ's choice ("music_open" otherwise). It counts only where
--    the order counts at all: private.plan_progress (20261112000100) still
--    leaves the order out while the grand entrance is skipped or undecided.
--    Processional entries are unchanged ("music" isn't accepted there).
--
-- Same signatures; privileges kept by create or replace. Nothing is written.

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
    -- Guest entry is needed whatever the decision; then the decision, then
    -- (only while planned) its time.
    r := r || jsonb_build_array(jsonb_build_object('key', 'guest_entry', 'state', case when a ? 'guest_entry_time' then 'answered' else 'unanswered' end));
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
      '{"names":300,"role":120,"pronunciation":300,"wording":500,"notes":500}'::jsonb, array['names'], array['song_id', 'music']);
    if not (pe ->> 'ok')::boolean then
      return pe;
    end if;
    -- An entry's music: a linked song, or the explicit "DJ's choice" (never both).
    -- Neither is "not decided yet"; an empty song is never read as DJ's choice.
    select x into o from jsonb_array_elements(pe -> 'entries') x
      where x ? 'music' and (x -> 'music' <> '"dj_choice"'::jsonb or x ? 'song_id') limit 1;
    if o is not null then
      return jsonb_build_object('ok', false, 'field', 'entry:' || (o ->> 'id') || ':music', 'message', 'Reload the page and try again.');
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
