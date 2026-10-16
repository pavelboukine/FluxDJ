-- Playlist attachments on music lists: a client shares a playlist they
-- already made in Spotify, Apple Music, YouTube Music or any other service by
-- pasting its link. Links only: nothing is fetched, expanded or verified, and
-- no provider is called. Provider names are recognized in the app, for
-- display only.
--
-- Where they live. An optional "playlists" array next to "songs" in the
-- answers of the list editors only:
--   music_background  arrival_music, pre_ceremony_music, cocktail_music, dinner_music
--   music_requests    must_play, play_if_possible
--   music_exclusions  do_not_play
-- Song moments (moment_songs, and the Processional and grand entrance songs
-- that reuse its validation) refuse the key like any other unknown field.
--
-- A playlist: id (a lowercase UUID chosen by the browser, unique in its list,
-- the only identity), url (needed, private.is_https_url, 1000 characters, as
-- for song links), label (100) and notes (500), both optional. At most 5 per
-- list, in array order. The same playlist can't be listed twice in one list:
-- links are compared by private.playlist_url_key (host without "www.", no
-- trailing slash, no fragment, no "si" or "utm_" sharing parameters).
--
-- Completion: a list with playlists is answered, as with songs. Exclusive
-- choices (dj_choice, none) are refused while playlists exist, as with songs:
-- nothing is removed silently.
--
-- Compatibility: no new tables, columns or RPCs; signatures and grants are
-- unchanged. Stored answers stay valid (the key is optional) and nothing is
-- rewritten. Database first: the deployed app never sends "playlists", so it
-- keeps working unchanged.

-- ===========================================================================
-- Comparing playlist links
-- ===========================================================================

-- The form of a link used to spot the same playlist pasted twice. Mirrored
-- by playlistUrlKey in src/lib/planning/music.ts.
create function private.playlist_url_key(p_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text[] := regexp_match(btrim(coalesce(p_url, '')), '^https://([^/?#]*)([^?#]*)(\?[^#]*)?');
  v_host text;
  v_param text;
  v_name text;
  v_query text := '';
begin
  if m is null then
    return null;
  end if;
  v_host := lower(m[1]);
  if v_host like 'www.%' then
    v_host := substr(v_host, 5);
  end if;
  if m[3] is not null then
    foreach v_param in array string_to_array(substr(m[3], 2), '&') loop
      v_name := lower(split_part(v_param, '=', 1));
      continue when v_param = '' or v_name = 'si' or v_name like 'utm\_%';
      v_query := v_query || case when v_query = '' then '?' else '&' end || v_param;
    end loop;
  end if;
  return v_host || regexp_replace(m[2], '/+$', '') || v_query;
end;
$$;

-- ===========================================================================
-- Validation (unchanged for songs and choices, plus playlists)
-- ===========================================================================

create or replace function private.normalize_plan_music(p_editor text, p_answers jsonb)
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
  -- Playlists belong to the list editors only.
  v_lists boolean := p_editor in ('music_background', 'music_requests', 'music_exclusions');
  v_songs jsonb := '[]'::jsonb;
  v_ids text[] := '{}'::text[];
  v_playlists jsonb := '[]'::jsonb;
  v_playlist_ids text[] := '{}'::text[];
  v_url_keys text[] := '{}'::text[];
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
    if k not in ('songs', 'choice') and not (k = 'playlists' and v_lists) then
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

  if v_lists and p_answers ? 'playlists' and jsonb_typeof(p_answers -> 'playlists') <> 'null' then
    if jsonb_typeof(p_answers -> 'playlists') <> 'array' then
      return jsonb_build_object('ok', false, 'field', 'playlists', 'message', 'Reload the page and try again.');
    end if;
    if jsonb_array_length(p_answers -> 'playlists') > 5 then
      return jsonb_build_object('ok', false, 'field', 'playlists', 'message', 'Keep this to 5 playlists or fewer.');
    end if;
    for s in select x from jsonb_array_elements(p_answers -> 'playlists') x loop
      if jsonb_typeof(s) <> 'object' or jsonb_typeof(s -> 'id') is distinct from 'string'
         or (s ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or (s ->> 'id') = any (v_playlist_ids) then
        return jsonb_build_object('ok', false, 'field', 'playlists', 'message', 'Reload the page and try again.');
      end if;
      v_id := s ->> 'id';
      v_playlist_ids := v_playlist_ids || v_id;
      out := jsonb_build_object('id', v_id);
      for k in select jsonb_object_keys(s) loop
        continue when k = 'id';
        if k not in ('url', 'label', 'notes') or jsonb_typeof(s -> k) not in ('string', 'null') then
          return jsonb_build_object('ok', false, 'field', 'playlist:' || v_id || ':' || k, 'message', 'Reload the page and try again.');
        end if;
        v := btrim(coalesce(s ->> k, ''));
        v_limit := case k when 'url' then 1000 when 'label' then 100 when 'notes' then 500 end;
        if length(v) > v_limit then
          return jsonb_build_object('ok', false, 'field', 'playlist:' || v_id || ':' || k,
            'message', 'Keep this under ' || v_limit || ' characters.');
        end if;
        if k = 'url' and v <> '' and not private.is_https_url(v) then
          return jsonb_build_object('ok', false, 'field', 'playlist:' || v_id || ':url',
            'message', 'Enter the full playlist link, starting with https://.');
        end if;
        if v <> '' then
          out := out || jsonb_build_object(k, v);
        end if;
      end loop;
      if not out ? 'url' then
        return jsonb_build_object('ok', false, 'field', 'playlist:' || v_id || ':url', 'message', 'Paste the playlist link.');
      end if;
      if private.playlist_url_key(out ->> 'url') = any (v_url_keys) then
        return jsonb_build_object('ok', false, 'field', 'playlist:' || v_id || ':url', 'message', 'This playlist is already added here.');
      end if;
      v_url_keys := v_url_keys || private.playlist_url_key(out ->> 'url');
      v_playlists := v_playlists || jsonb_build_array(out);
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
        'message', case when v_lists then 'Remove the songs and playlists first, or keep them and choose to add songs or playlists.'
                        else 'Remove the songs first, or keep them and choose "I''ll list the songs".' end);
    end if;
    if v_choice <> 'discuss' and jsonb_array_length(v_playlists) > 0 then
      return jsonb_build_object('ok', false, 'field', 'choice',
        'message', 'Remove the songs and playlists first, or keep them and choose to add songs or playlists.');
    end if;
    a := a || jsonb_build_object('choice', v_choice);
  end if;
  if jsonb_array_length(v_songs) > 0 then
    a := a || jsonb_build_object('songs', v_songs);
  end if;
  if jsonb_array_length(v_playlists) > 0 then
    a := a || jsonb_build_object('playlists', v_playlists);
  end if;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- ===========================================================================
-- Completion: playlists answer a list like songs do
-- ===========================================================================

create or replace function private.plan_music_requirements(p_editor text, p_answers jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_array(case
    when coalesce(p_answers, '{}'::jsonb) ->> 'choice' = 'discuss' then jsonb_build_object('key', 'songs', 'state', 'unanswered', 'discuss', true)
    when jsonb_array_length(coalesce(p_answers -> 'songs', '[]'::jsonb)) > 0 then jsonb_build_object('key', 'songs', 'state', 'answered')
    -- Only list editors can hold playlists (normalize_plan_music).
    when p_editor in ('music_background', 'music_requests', 'music_exclusions')
         and jsonb_typeof(p_answers -> 'playlists') = 'array' and jsonb_array_length(p_answers -> 'playlists') > 0
      then jsonb_build_object('key', 'songs', 'state', 'answered')
    when p_answers ->> 'choice' in ('dj_choice', 'none') then jsonb_build_object('key', 'songs', 'state', 'answered')
    when p_answers ->> 'choice' = 'not_applicable' then jsonb_build_object('key', 'songs', 'state', 'not_applicable')
    else jsonb_build_object('key', 'songs', 'state', 'unanswered') end);
$$;

revoke execute on function private.playlist_url_key(text) from public, anon;
grant execute on function private.playlist_url_key(text) to authenticated, service_role;
