-- Contacts and vendors, DJ expectations and overall preferences, and the
-- Party's music preferences, inside the existing planning structure.
--
-- Where answers live (one revision-checked row per item, as before):
--   contacts_vendors   editor 'contacts': the day-of contact and ordered vendors
--   dj_preferences     editor 'preferences'
--   music_preferences  editor 'music_style' (a Party moment)
--
-- Day-of contact (planning only; never changes clients or event contacts):
--   day_of_source = 'event_contact': day_of_client_id names one of THIS
--     event's contacts (event_clients, not archived), checked on every save;
--     an optional day_of_phone is a phone for the day only.
--   day_of_source = 'other': day_of_name, day_of_phone, day_of_role.
--   day_of_source = 'undecided': explicitly not decided yet.
-- People are never matched or merged by name. A referenced contact that
-- leaves the event (or is archived) stays stored, shows as unavailable and
-- leaves the requirement open (note "contact_unavailable").
-- The MC and the officiant stay in their own editors (shown, not re-entered).
--
-- Vendors: {id, role, name, business, phone, email, notes}; role is one of
-- planner, venue, photographer, videographer, caterer, musician, other; a
-- name or a business is needed; phone and email are checked when given;
-- notes are shared with the client. "No additional vendor contacts" is
-- vendors_choice = 'none'.
--
-- Announcement language has one source: Event basics. Preferences read it
-- there and store no copy.
--
-- Completion (optional text never blocks):
--   contacts     day_of: a named contact with a phone (an event contact's own
--                phone or a day-of phone); undecided stays open
--                ("not_decided"); vendors: entries, or none (not applicable)
--   preferences  interaction, language (Event basics), lyrics, requests;
--                "discuss" stays open
--   music_style  style: genres or another style, or DJ's choice; slow_songs:
--                DJ's choice, none or a few; "discuss" stays open
--
-- Compatibility: views gain the key "event_contacts"; nothing renamed.
-- Deploy the app first: the deployed app (3cb8ba3) shows these sections as
-- "Not available yet" while progress would count them.

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
    ('moment', 'music_preferences',    array['party'], 'Music preferences', null::text, 'music_style', true, 260),
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


create or replace function private.is_moment_editor(p_editor text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_editor in ('processional', 'mc', 'introductions', 'speeches', 'contacts', 'preferences', 'music_style'), false);
$$;

-- ===========================================================================
-- Validation
-- ===========================================================================

-- A phone number as people write it: digits with optional +, spaces, dots,
-- dashes or brackets, 7 to 20 digits. Not a reachability check.
create function private.is_phone(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value ~ '^\+?[0-9 ().-]{7,30}$' and length(regexp_replace(p_value, '[^0-9]', '', 'g')) between 7 and 20;
$$;

create function private.is_email(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select length(p_value) <= 254 and p_value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
$$;

create function private.normalize_plan_contacts(p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  a jsonb := '{}'::jsonb;
  k text;
  v text;
  v_src text;
  v_limit int;
  pe jsonb;
  e jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if k not in ('day_of_source', 'day_of_client_id', 'day_of_name', 'day_of_phone', 'day_of_role', 'vendors', 'vendors_choice') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
    if k <> 'vendors' and jsonb_typeof(p_answers -> k) not in ('string', 'null') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;

  v_src := nullif(p_answers ->> 'day_of_source', '');
  if v_src is not null then
    if v_src not in ('event_contact', 'other', 'undecided') then
      return jsonb_build_object('ok', false, 'field', 'day_of_source', 'message', 'Choose an option from the list.');
    end if;
    a := a || jsonb_build_object('day_of_source', v_src);
  end if;
  if v_src = 'event_contact' and nullif(p_answers ->> 'day_of_client_id', '') is not null then
    if (p_answers ->> 'day_of_client_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('ok', false, 'field', 'day_of_client_id', 'message', 'Reload the page and try again.');
    end if;
    a := a || jsonb_build_object('day_of_client_id', p_answers ->> 'day_of_client_id');
  end if;
  v := btrim(coalesce(p_answers ->> 'day_of_phone', ''));
  if v <> '' and v_src in ('event_contact', 'other') then
    if not private.is_phone(v) then
      return jsonb_build_object('ok', false, 'field', 'day_of_phone', 'message', 'Enter a phone number with 7 to 20 digits, such as 514 555-0100.');
    end if;
    a := a || jsonb_build_object('day_of_phone', v);
  end if;
  foreach k in array array['day_of_name', 'day_of_role'] loop
    v := btrim(coalesce(p_answers ->> k, ''));
    v_limit := case k when 'day_of_name' then 200 else 120 end;
    if length(v) > v_limit then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Keep this under ' || v_limit || ' characters.');
    end if;
    if v <> '' and v_src = 'other' then
      a := a || jsonb_build_object(k, v);
    end if;
  end loop;

  pe := private.normalize_plan_entries(p_answers -> 'vendors', 30,
    '{"name":200,"business":200,"phone":30,"email":254,"notes":500}'::jsonb, '{}'::text[], array['role']);
  if not (pe ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'field', replace(pe ->> 'field', 'entries', 'vendors'), 'message', pe ->> 'message');
  end if;
  for e in select x from jsonb_array_elements(pe -> 'entries') x loop
    if jsonb_typeof(e -> 'role') is distinct from 'string'
       or (e ->> 'role') not in ('planner', 'venue', 'photographer', 'videographer', 'caterer', 'musician', 'other') then
      return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':role', 'message', 'Choose a role.');
    end if;
    if not (e ? 'name' or e ? 'business') then
      return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':name', 'message', 'Enter a person''s name or a business name.');
    end if;
    if e ? 'phone' and not private.is_phone(e ->> 'phone') then
      return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':phone', 'message', 'Enter a phone number with 7 to 20 digits, such as 514 555-0100.');
    end if;
    if e ? 'email' and not private.is_email(e ->> 'email') then
      return jsonb_build_object('ok', false, 'field', 'entry:' || (e ->> 'id') || ':email', 'message', 'Enter an email address such as name@example.com.');
    end if;
    v_out := v_out || jsonb_build_array(e);
  end loop;
  if nullif(p_answers ->> 'vendors_choice', '') is not null then
    if p_answers ->> 'vendors_choice' <> 'none' then
      return jsonb_build_object('ok', false, 'field', 'vendors_choice', 'message', 'Choose an option from the list.');
    end if;
    if jsonb_array_length(v_out) > 0 then
      return jsonb_build_object('ok', false, 'field', 'vendors_choice',
        'message', 'Remove the vendors first, or keep them and choose "I''ll list them".');
    end if;
    a := a || jsonb_build_object('vendors_choice', 'none');
  end if;
  if jsonb_array_length(v_out) > 0 then
    a := a || jsonb_build_object('vendors', v_out);
  end if;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- Fixed choices and text fields of the preference editors.
create function private.normalize_plan_choices(p_answers jsonb, p_choices jsonb, p_text jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  a jsonb := '{}'::jsonb;
  k text;
  v text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if not (p_choices ? k or p_text ? k) then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
    if jsonb_typeof(p_answers -> k) not in ('string', 'null') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
    v := btrim(coalesce(p_answers ->> k, ''));
    continue when v = '';
    if p_choices ? k then
      if not (p_choices -> k) ? v then
        return jsonb_build_object('ok', false, 'field', k, 'message', 'Choose an option from the list.');
      end if;
    elsif length(v) > (p_text ->> k)::int then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Keep this under ' || to_char((p_text ->> k)::int, 'FM9,999') || ' characters.');
    end if;
    a := a || jsonb_build_object(k, v);
  end loop;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

create function private.normalize_plan_preferences(p_answers jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.normalize_plan_choices(p_answers,
    '{"interaction":["music_mostly","occasional","interactive","discuss"],"lyrics":["clean","explicit_ok","discuss"],"requests":["welcome","not_welcome","discuss"]}'::jsonb,
    '{"atmosphere":1000,"notes":1000}'::jsonb);
$$;

create function private.normalize_plan_music_style(p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  r jsonb;
  g jsonb := '[]'::jsonb;
  x jsonb;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  r := private.normalize_plan_choices(p_answers - 'genres',
    '{"style_choice":["dj_choice"],"slow_songs":["dj_choice","none","a_few","discuss"]}'::jsonb,
    '{"other_style":300,"favorite_artists":500,"dance_floor":1000}'::jsonb);
  if not (r ->> 'ok')::boolean then
    return r;
  end if;
  if p_answers ? 'genres' and jsonb_typeof(p_answers -> 'genres') <> 'null' then
    if jsonb_typeof(p_answers -> 'genres') <> 'array' then
      return jsonb_build_object('ok', false, 'field', 'genres', 'message', 'Reload the page and try again.');
    end if;
    -- Kept in the list's own order, once each.
    for x in select to_jsonb(v) from unnest(array['pop', 'dance', 'hiphop_rnb', 'rock', 'disco_funk', 'country', 'latin', 'house_electronic', 'throwbacks']) v loop
      if p_answers -> 'genres' @> jsonb_build_array(x) then
        g := g || jsonb_build_array(x);
      end if;
    end loop;
    if exists (select 1 from jsonb_array_elements(p_answers -> 'genres') e
               where not (jsonb_typeof(e) = 'string' and (e #>> '{}') in ('pop', 'dance', 'hiphop_rnb', 'rock', 'disco_funk', 'country', 'latin', 'house_electronic', 'throwbacks'))) then
      return jsonb_build_object('ok', false, 'field', 'genres', 'message', 'Choose styles from the list.');
    end if;
  end if;
  if r -> 'answers' ->> 'style_choice' = 'dj_choice' and (jsonb_array_length(g) > 0 or r -> 'answers' ? 'other_style') then
    return jsonb_build_object('ok', false, 'field', 'style_choice',
      'message', 'Clear the styles first, or keep them and choose "I''ll pick styles".');
  end if;
  return jsonb_build_object('ok', true, 'answers', r -> 'answers' || case when jsonb_array_length(g) > 0 then jsonb_build_object('genres', g) else '{}'::jsonb end);
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
              when private.is_music_editor(p_editor) then private.normalize_plan_music(p_editor, p_answers)
              else private.normalize_plan_stage(p_editor, p_answers) end;
$$;

create function private.plan_people_requirements(p_editor text, p_answers jsonb)
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

-- ===========================================================================
-- Completion
-- ===========================================================================

-- This event's contacts that planning may show and reference (client-safe:
-- name and phone), keyed by client id.
create function private.plan_event_contacts(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'primary', ec.is_primary)
                            order by ec.is_primary desc, c.name, c.id), '[]'::jsonb)
  from public.event_plans p
  join public.event_clients ec on ec.tenant_id = p.tenant_id and ec.event_id = p.event_id
  join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where p.id = p_plan_id and c.archived_at is null;
$$;

create function private.plan_contacts_requirements(p_plan_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a jsonb := coalesce(p_answers, '{}'::jsonb);
  v_contact jsonb;
  v_day jsonb;
begin
  if a ->> 'day_of_source' = 'event_contact' then
    select c into v_contact from jsonb_array_elements(private.plan_event_contacts(p_plan_id)) c where c ->> 'id' = a ->> 'day_of_client_id';
    v_day := case
      when v_contact is null and a ? 'day_of_client_id' then jsonb_build_object('key', 'day_of', 'state', 'unanswered', 'note', 'contact_unavailable')
      when v_contact is null then jsonb_build_object('key', 'day_of', 'state', 'unanswered')
      when a ? 'day_of_phone' or nullif(btrim(coalesce(v_contact ->> 'phone', '')), '') is not null then jsonb_build_object('key', 'day_of', 'state', 'answered')
      else jsonb_build_object('key', 'day_of', 'state', 'unanswered', 'note', 'phone_missing') end;
  elsif a ->> 'day_of_source' = 'other' then
    v_day := case
      when a ? 'day_of_name' and a ? 'day_of_phone' then jsonb_build_object('key', 'day_of', 'state', 'answered')
      when a ? 'day_of_name' then jsonb_build_object('key', 'day_of', 'state', 'unanswered', 'note', 'phone_missing')
      else jsonb_build_object('key', 'day_of', 'state', 'unanswered') end;
  elsif a ->> 'day_of_source' = 'undecided' then
    v_day := jsonb_build_object('key', 'day_of', 'state', 'unanswered', 'note', 'not_decided');
  else
    v_day := jsonb_build_object('key', 'day_of', 'state', 'unanswered');
  end if;
  return jsonb_build_array(v_day, case
    when jsonb_array_length(coalesce(a -> 'vendors', '[]'::jsonb)) > 0 then jsonb_build_object('key', 'vendors', 'state', 'answered')
    when a ->> 'vendors_choice' = 'none' then jsonb_build_object('key', 'vendors', 'state', 'not_applicable')
    else jsonb_build_object('key', 'vendors', 'state', 'unanswered') end);
end;
$$;

-- p_basics: Event basics' answers, the one source of the announcement language.
create function private.plan_preferences_requirements(p_answers jsonb, p_basics jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with input as (select coalesce(p_answers, '{}'::jsonb) as a)
  select jsonb_build_array(
    case when a ->> 'interaction' = 'discuss' then jsonb_build_object('key', 'interaction', 'state', 'unanswered', 'discuss', true)
         when a ? 'interaction' then jsonb_build_object('key', 'interaction', 'state', 'answered')
         else jsonb_build_object('key', 'interaction', 'state', 'unanswered') end,
    case when coalesce(p_basics, '{}'::jsonb) ? 'announcement_language' then jsonb_build_object('key', 'language', 'state', 'answered')
         else jsonb_build_object('key', 'language', 'state', 'unanswered', 'note', 'basics_missing') end,
    case when a ->> 'lyrics' = 'discuss' then jsonb_build_object('key', 'lyrics', 'state', 'unanswered', 'discuss', true)
         when a ? 'lyrics' then jsonb_build_object('key', 'lyrics', 'state', 'answered')
         else jsonb_build_object('key', 'lyrics', 'state', 'unanswered') end,
    case when a ->> 'requests' = 'discuss' then jsonb_build_object('key', 'requests', 'state', 'unanswered', 'discuss', true)
         when a ? 'requests' then jsonb_build_object('key', 'requests', 'state', 'answered')
         else jsonb_build_object('key', 'requests', 'state', 'unanswered') end)
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
    elsif r.editor = 'contacts' then
      v_req := private.plan_contacts_requirements(v_plan.id, r.answers);
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

-- ===========================================================================
-- Saving: the day-of contact must be one of this event's contacts
-- ===========================================================================

-- Checked on every save under the plan lock (like song links). A stored
-- reference to a contact who has since left the event is kept and shown as
-- unavailable; saving it again is refused until another choice is made.
create function private.check_plan_contact_refs(p_plan_id uuid, p_editor text, p_new jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_editor = 'contacts' and p_new ? 'day_of_client_id'
              and not exists (select 1 from jsonb_array_elements(private.plan_event_contacts(p_plan_id)) c where c ->> 'id' = p_new ->> 'day_of_client_id')
         then jsonb_build_object('status', 'invalid', 'field', 'day_of_client_id',
                'message', 'That contact isn''t on this event any more. Choose another contact or enter someone.')
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
  v_links := coalesce(private.check_plan_song_links(p_plan_id, v_item.key, v_resp.answers, v_norm -> 'answers'),
                      private.check_plan_contact_refs(p_plan_id, v_editor, v_norm -> 'answers'));
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
-- Views gain the event's client-safe contacts
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
    'music', private.plan_music(v_plan.id),
    'moments', private.plan_moment_answers(v_plan.id),
    'event_contacts', private.plan_event_contacts(v_plan.id),
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
    'event_contacts', private.plan_event_contacts(v_plan.id),
    'timeline_warnings', private.plan_timeline_warnings(v_plan.id),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

grant execute on function private.is_phone(text), private.is_email(text), private.normalize_plan_contacts(jsonb),
  private.normalize_plan_choices(jsonb, jsonb, jsonb), private.normalize_plan_preferences(jsonb), private.normalize_plan_music_style(jsonb),
  private.plan_preferences_requirements(jsonb, jsonb), private.plan_people_requirements(text, jsonb)
  to authenticated, service_role;
revoke execute on function private.plan_event_contacts(uuid), private.plan_contacts_requirements(uuid, jsonb), private.check_plan_contact_refs(uuid, text, jsonb)
  from public, anon, authenticated;
