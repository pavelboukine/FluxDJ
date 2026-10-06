-- Manual song entry: music lists and songs for specific moments, inside the
-- existing chronological stages. No music service: title and artist are typed
-- in; an optional HTTPS link is stored as text and never fetched.
--
-- Where songs live. Each editor belongs to a library key, never a label, and
-- saves on the moment item itself (event_plan_responses: one row per item,
-- revision-checked, like stage details). Hiding a moment or its stage keeps
-- its songs; they are excluded from views and progress until restored.
--   music_background  arrival_music, pre_ceremony_music, cocktail_music,
--                     dinner_music              (choice: dj_choice)
--   music_requests    must_play, play_if_possible (choice: none = "No requests")
--   music_exclusions  do_not_play                (choice: none = "Nothing to exclude")
--   moment_songs      processional, couple_entrance, ceremony_signing,
--                     recessional, entrance_music, first_dance, family_dances,
--                     other_dances, cake_cutting, last_dances, final_song
--                     (choices: dj_choice, not_applicable, discuss)
--
-- Reception entrance: "Entrance music" is the one place its songs are
-- entered, each with an optional cue label ("Wedding party", "Couple").
-- "Introductions" and "Participants and names" stay without an editor; later
-- participant editors will point at these songs by their entry id.
--
-- Answers: {"songs": [...], "choice": "..."}; both optional, nothing else.
-- A song: id (a lowercase UUID chosen by the browser, unique in its list,
-- the only identity: never title or position), title and artist (needed),
-- version, link (private.is_https_url), notes (instructions for moments) and,
-- for moment songs only, cue. List order is the array order. Limits:
-- title/artist 200, version 100, cue 80, notes 500, link 1000 characters;
-- 150 songs per list, 12 per moment.
--
-- Completion: one requirement "songs" per editor.
--   songs entered (no choice)          answered
--   dj_choice / none, with no songs    answered
--   not_applicable, with no songs      not_applicable (the moment stays visible;
--                                      only staff change the structure)
--   discuss (songs allowed)            unanswered, "discuss": true
--   nothing                            unanswered
-- dj_choice, none and not_applicable are refused while songs exist: nothing
-- is removed silently. Optional fields never block completion.
--
-- Concurrency: a whole list is saved with the item's revision, so a stale tab
-- gets a conflict. A save whose answers already equal the stored ones counts
-- as saved, even with an older revision: a retried or doubled add or import
-- (same entry ids) can never duplicate entries.
--
-- Compatibility: no new tables or RPCs. Views only gain the key "music";
-- save results keep their shape. Deploy the app first: the deployed app shows
-- these moments as "Not available yet" while progress would count them.

-- ===========================================================================
-- Library: editors for the music moments (otherwise unchanged)
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
    ('moment', 'processional',         array['ceremony'], 'Processional participants', null::text, 'moment_songs', true, 212),
    ('moment', 'couple_entrance',      array['ceremony'], 'Couple entrance', null::text, 'moment_songs', true, 213),
    ('moment', 'ceremony_signing',     array['ceremony'], 'Signing', null::text, 'moment_songs', true, 214),
    ('moment', 'recessional',          array['ceremony'], 'Recessional', null::text, 'moment_songs', true, 215),
    ('moment', 'cocktail_details',     array['cocktail'], 'Location and timing', null::text, 'stage_details', true, 220),
    ('moment', 'cocktail_music',       array['cocktail'], 'Background music', null::text, 'music_background', true, 221),
    ('moment', 'mc',                   array['reception_entrance'], 'MC', null::text, null::text, true, 230),
    ('moment', 'introductions',        array['reception_entrance'], 'Introductions', null::text, null::text, true, 231),
    ('moment', 'entrance_participants', array['reception_entrance'], 'Participants and names', null::text, null::text, true, 232),
    ('moment', 'entrance_music',       array['reception_entrance'], 'Entrance music', null::text, 'moment_songs', true, 233),
    ('moment', 'program_details',      array['program'], 'Program details', null::text, null::text, true, 235),
    ('moment', 'dinner_details',       array['dinner'], 'Timing', null::text, 'stage_details', true, 240),
    ('moment', 'dinner_music',         array['dinner'], 'Background music', null::text, 'music_background', true, 241),
    ('moment', 'speeches',             array['dinner', 'program', 'party'], 'Speeches and toasts', null::text, null::text, true, 242),
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

-- ===========================================================================
-- Validation
-- ===========================================================================

create function private.is_music_editor(p_editor text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_editor in ('music_background', 'music_requests', 'music_exclusions', 'moment_songs'), false);
$$;

-- Validates and normalizes a music editor's answers (see the header).
-- Returns {"ok":true,"answers"} or {"ok":false,"field","message"}; a song's
-- field is named "song:<id>:<field>".
create function private.normalize_plan_music(p_editor text, p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_choices text[] := case p_editor
    when 'music_background' then array['dj_choice']
    when 'music_requests' then array['none']
    when 'music_exclusions' then array['none']
    when 'moment_songs' then array['dj_choice', 'not_applicable', 'discuss'] end;
  v_max int := case when p_editor = 'moment_songs' then 12 else 150 end;
  v_fields text[] := case when p_editor = 'moment_songs'
    then array['id', 'title', 'artist', 'version', 'link', 'notes', 'cue']
    else array['id', 'title', 'artist', 'version', 'link', 'notes'] end;
  v_songs jsonb := '[]'::jsonb;
  v_ids text[] := '{}'::text[];
  v_choice text;
  s jsonb;
  out jsonb;
  k text;
  v text;
  v_id text;
  v_limit int;
  a jsonb := '{}'::jsonb;
begin
  if v_choices is null or p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if k not in ('songs', 'choice') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;

  if p_answers ? 'songs' and jsonb_typeof(p_answers -> 'songs') <> 'null' then
    if jsonb_typeof(p_answers -> 'songs') <> 'array' then
      return jsonb_build_object('ok', false, 'field', 'songs', 'message', 'Reload the page and try again.');
    end if;
    if jsonb_array_length(p_answers -> 'songs') > v_max then
      return jsonb_build_object('ok', false, 'field', 'songs', 'message', 'Keep this list to ' || v_max || ' songs or fewer.');
    end if;
    for s in select x from jsonb_array_elements(p_answers -> 'songs') x loop
      if jsonb_typeof(s) <> 'object' or jsonb_typeof(s -> 'id') is distinct from 'string'
         or (s ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or (s ->> 'id') = any (v_ids) then
        return jsonb_build_object('ok', false, 'field', 'songs', 'message', 'Reload the page and try again.');
      end if;
      v_id := s ->> 'id';
      v_ids := v_ids || v_id;
      out := jsonb_build_object('id', v_id);
      for k in select jsonb_object_keys(s) loop
        continue when k = 'id';
        if not (k = any (v_fields)) or jsonb_typeof(s -> k) not in ('string', 'null') then
          return jsonb_build_object('ok', false, 'field', 'song:' || v_id || ':' || k, 'message', 'Reload the page and try again.');
        end if;
        v := btrim(coalesce(s ->> k, ''));
        v_limit := case k when 'title' then 200 when 'artist' then 200 when 'version' then 100 when 'cue' then 80
                          when 'notes' then 500 when 'link' then 1000 end;
        if length(v) > v_limit then
          return jsonb_build_object('ok', false, 'field', 'song:' || v_id || ':' || k,
            'message', 'Keep this under ' || v_limit || ' characters.');
        end if;
        if k = 'link' and v <> '' and not private.is_https_url(v) then
          return jsonb_build_object('ok', false, 'field', 'song:' || v_id || ':link',
            'message', 'Enter a full https:// address, or leave the link empty.');
        end if;
        if v <> '' then
          out := out || jsonb_build_object(k, v);
        end if;
      end loop;
      if not out ? 'title' then
        return jsonb_build_object('ok', false, 'field', 'song:' || v_id || ':title', 'message', 'Enter the song title.');
      end if;
      if not out ? 'artist' then
        return jsonb_build_object('ok', false, 'field', 'song:' || v_id || ':artist', 'message', 'Enter the artist.');
      end if;
      v_songs := v_songs || jsonb_build_array(out);
    end loop;
  end if;

  if p_answers ? 'choice' and jsonb_typeof(p_answers -> 'choice') <> 'null' then
    v_choice := p_answers ->> 'choice';
    if jsonb_typeof(p_answers -> 'choice') <> 'string' or not (v_choice = any (v_choices)) then
      return jsonb_build_object('ok', false, 'field', 'choice', 'message', 'Choose an option from the list.');
    end if;
    -- Nothing is removed silently: an exclusive choice needs an empty list.
    if v_choice <> 'discuss' and jsonb_array_length(v_songs) > 0 then
      return jsonb_build_object('ok', false, 'field', 'choice',
        'message', 'Remove the songs first, or keep them and choose "I''ll list the songs".');
    end if;
    a := a || jsonb_build_object('choice', v_choice);
  end if;
  if jsonb_array_length(v_songs) > 0 then
    a := a || jsonb_build_object('songs', v_songs);
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
              when private.is_music_editor(p_editor) then private.normalize_plan_music(p_editor, p_answers)
              else private.normalize_plan_stage(p_editor, p_answers) end;
$$;

-- What a music editor needs to be complete (see the header).
create function private.plan_music_requirements(p_editor text, p_answers jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_array(case
    when coalesce(p_answers, '{}'::jsonb) ->> 'choice' = 'discuss' then jsonb_build_object('key', 'songs', 'state', 'unanswered', 'discuss', true)
    when jsonb_array_length(coalesce(p_answers -> 'songs', '[]'::jsonb)) > 0 then jsonb_build_object('key', 'songs', 'state', 'answered')
    when p_answers ->> 'choice' in ('dj_choice', 'none') then jsonb_build_object('key', 'songs', 'state', 'answered')
    when p_answers ->> 'choice' = 'not_applicable' then jsonb_build_object('key', 'songs', 'state', 'not_applicable')
    else jsonb_build_object('key', 'songs', 'state', 'unanswered') end);
$$;

grant execute on function private.is_music_editor(text), private.normalize_plan_music(text, jsonb),
  private.plan_music_requirements(text, jsonb)
  to authenticated, service_role;

-- ===========================================================================
-- Progress: music moments count like stage details
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
-- Saving: identical retries are saved, never duplicated or refused
-- ===========================================================================

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
      -- A concurrent first save won: the same list is this save, already stored.
      select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
      if not (private.is_music_editor(v_editor) and v_resp.answers = v_norm -> 'answers') then
        return jsonb_build_object('status', 'conflict');
      end if;
    end if;
  elsif p_expected_revision is distinct from v_resp.revision then
    -- A retried or doubled music save (same entry ids) is already stored.
    if not (private.is_music_editor(v_editor) and v_resp.answers = v_norm -> 'answers') then
      return jsonb_build_object('status', 'conflict');
    end if;
  elsif v_resp.answers is distinct from v_norm -> 'answers' or not private.is_music_editor(v_editor) then
    update public.event_plan_responses
      set answers = v_norm -> 'answers', revision = revision + 1, updated_by_actor = p_actor, updated_by_user_id = p_user_id
      where id = v_resp.id returning * into v_resp;
  end if;
  return jsonb_build_object('status', 'saved', 'revision', v_resp.revision, 'answers', v_resp.answers,
                            'progress', private.plan_progress(p_plan_id), 'timeline_warnings', private.plan_timeline_warnings(p_plan_id));
end;
$$;

-- ===========================================================================
-- Views gain the songs of visible music moments
-- ===========================================================================

-- Answers of enabled music moments whose stage is enabled, keyed by item id.
create function private.plan_music(p_plan_id uuid)
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
    and private.is_music_editor(l.editor);
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
    'timeline_warnings', private.plan_timeline_warnings(v_plan.id),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

revoke execute on function private.plan_music(uuid) from public, anon, authenticated;
