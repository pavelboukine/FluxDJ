-- Ceremony planning (Batch 4B).
--
-- 1. A Ceremony needs its guest arrival time: a new "guest_arrival"
--    requirement for stage_ceremony, between location and start time. It
--    counts only where a visible Ceremony stage exists (events without one,
--    and hidden Ceremony stages, are unaffected) and never assumes a time.
--    Saved answers are unchanged; plans that lack the time show it as open.
-- 2. The Wedding starter outline no longer has a separate Couple entrance:
--    everyone who walks in, either partner included, is one ordered
--    Processional list with their songs. This only shapes templates created
--    from the starter from now on. Business templates already installed, event
--    plans already set up and their Couple entrance answers are untouched, and
--    Couple entrance stays in the library for templates that want it.
-- 3. The Processional's default label for new templates is "Processional".
--
-- Same signatures; privileges are kept by create or replace.

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
    ('wedding', 'entrance_participants', 'reception_entrance', 3), ('wedding', 'entrance_music', 'reception_entrance', 4),
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
