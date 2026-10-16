-- Playlist links on music lists: validation (links, limits, duplicates,
-- unknown fields), list editors only (never song moments or Processional),
-- completion and exclusive choices, legacy answers, idempotent retries and
-- stale tabs, views, closed editing, archiving, isolation, suspension, staff
-- edits, and externally booked events.
begin;
\ir _fixtures.psql
select plan(59);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('playlist-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- An event of tenant A with client Y, planned from the Wedding starter.
create function tests.new_event(name text, source text default 'flux', days int default 300) returns uuid language plpgsql as $$
begin
  if source = 'external' then
    insert into public.events (id, tenant_id, title, event_type, event_date, timezone, booking_source)
    values (tests.id(name), tests.id('tenant_a'), name, 'wedding', current_date + days, 'America/Toronto', 'external');
  else
    insert into public.events (id, tenant_id, title, event_type, event_date)
    values (tests.id(name), tests.id('tenant_a'), name, 'wedding', current_date + days);
  end if;
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  perform tests.login_as(tests.id('staff_a'));
  perform public.setup_event_plan(tests.id(name), (select id from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'wedding'));
  perform tests.su();
  if source = 'flux' then
    perform set_config('flux.booking_event', tests.id(name)::text, true);
    update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id(name);
    perform set_config('flux.booking_event', '', true);
  end if;
  return tests.id(name);
end $$;
create function tests.item(event text, item_key text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(event) and i.key = item_key;
$$;
create function tests.rev(event text, item_key text) returns int language sql stable as $$
  select coalesce((select revision from public.event_plan_responses where item_id = tests.item(event, item_key)), 0);
$$;
create function tests.stored(event text, item_key text) returns jsonb language sql stable as $$
  select answers from public.event_plan_responses where item_id = tests.item(event, item_key);
$$;
create function tests.save(event text, item_key text, answers jsonb, who text default 'client_y', rev int default null) returns jsonb language plpgsql as $$
declare r jsonb; v_rev int := coalesce(rev, tests.rev(event, item_key)); v_item uuid := tests.item(event, item_key);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_save_plan_item(tests.id(event), 'test-bouprod', v_item, v_rev, answers);
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.staff_save(event text, item_key text, answers jsonb, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.staff_save_plan_item(tests.id(event), tests.item(event, item_key), tests.rev(event, item_key), answers);
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.view(event text, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.client_planning_view(tests.id(event), 'test-bouprod');
  perform tests.su();
  return r;
end $$;
create function tests.reqs(result jsonb, item_key text) returns text[] language sql immutable as $$
  select array_agg((q ->> 'key') || ':' || (q ->> 'state') || case when (q ->> 'discuss')::boolean then ':discuss' else '' end order by o)
  from jsonb_array_elements(result -> 'progress' -> 'items') i, jsonb_array_elements(i -> 'requirements') with ordinality as x(q, o)
  where i ->> 'key' = item_key;
$$;
create function tests.pl(name text, url text, extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('id', tests.id('pl-' || name), 'url', url) || extra;
$$;
create function tests.pls(variadic p jsonb[]) returns jsonb language sql immutable as $$
  select jsonb_build_object('playlists', to_jsonb(p));
$$;
create function tests.song(name text, title text, artist text) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', tests.id('song-' || name), 'title', title, 'artist', artist);
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select tests.su();
select tests.new_event('pl_wed');
select tests.new_event('pl_other');
select tests.new_event('pl_soon', 'flux', 1);
select tests.new_event('pl_ext', 'external');

\set spotify '''https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=0f2e'''
\set apple '''https://music.apple.com/ca/playlist/souper/pl.u-8aAVZ0lCNr4mD'''
\set ytm '''https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'''

-- ===========================================================================
-- Link comparison
-- ===========================================================================
select is(array[private.playlist_url_key('https://www.YouTube.com/playlist?list=PL1&si=x&utm_source=y&feature=share#top'),
                private.playlist_url_key('https://open.spotify.com/playlist/abc/'), private.playlist_url_key('http://open.spotify.com/playlist/abc')],
  array['youtube.com/playlist?list=PL1&feature=share', 'open.spotify.com/playlist/abc', null],
  'links compare without www, trailing slashes, fragments or sharing parameters; only https links have a key');

-- ===========================================================================
-- Saving and completion
-- ===========================================================================
select is(tests.reqs(tests.view('pl_wed'), 'cocktail_music'), array['songs:unanswered'], 'an empty list starts unanswered');
select tests.save('pl_wed', 'cocktail_music', tests.pls(tests.pl('c1', '  ' || :spotify || ' ', '{"label":" Cocktail Hour ","notes":"Relaxed indie"}'))) as s \gset c_
select is(:'c_s'::jsonb ->> 'status', 'saved', 'a Spotify playlist saves');
select is(:'c_s'::jsonb -> 'answers', jsonb_build_object('playlists', jsonb_build_array(
  jsonb_build_object('id', tests.id('pl-c1'), 'url', :spotify, 'label', 'Cocktail Hour', 'notes', 'Relaxed indie'))),
  'normalized: trimmed, in the list''s answers next to where songs go');
select is(tests.reqs(:'c_s'::jsonb, 'cocktail_music'), array['songs:answered'], 'one playlist and no songs answers the list');
select is(tests.reqs(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('m1', :apple, '{"label":" "}'))), 'must_play'), array['songs:answered'],
  'an Apple Music playlist answers Must play (an empty name is dropped)');
select is(tests.stored('pl_wed', 'must_play'), tests.pls(tests.pl('m1', :apple)), 'and is stored without the empty name');
select is(tests.reqs(tests.save('pl_wed', 'do_not_play', tests.pls(tests.pl('d1', :ytm))), 'do_not_play'), array['songs:answered'],
  'a YouTube Music playlist answers Do not play');
select is(tests.save('pl_wed', 'dinner_music', tests.pls(tests.pl('n1', 'https://playlists.example.org/ours'), tests.pl('n2', :spotify), tests.pl('n3', :apple)))
  -> 'answers' -> 'playlists', jsonb_build_array(tests.pl('n1', 'https://playlists.example.org/ours'), tests.pl('n2', :spotify), tests.pl('n3', :apple)),
  'any https link, several per list, kept in order');
select tests.save('pl_wed', 'play_if_possible', jsonb_build_object('songs', jsonb_build_array(tests.song('s1', 'September', 'Earth, Wind & Fire'))) || tests.pls(tests.pl('p1', :spotify))) as s \gset both_
select is(array[jsonb_array_length(:'both_s'::jsonb -> 'answers' -> 'songs'), jsonb_array_length(:'both_s'::jsonb -> 'answers' -> 'playlists')], array[1, 1],
  'songs and playlists live side by side');
select is(tests.reqs(tests.save('pl_wed', 'pre_ceremony_music', jsonb_build_object('songs', jsonb_build_array(tests.song('s2', 'La Mer', 'Charles Trenet')))), 'pre_ceremony_music'),
  array['songs:answered'], 'a list of songs alone still saves and completes as before');
select is(tests.save('pl_wed', 'cocktail_music', jsonb_build_object('playlists', '[]'::jsonb)) -> 'answers', '{}'::jsonb, 'removing the last playlist stores nothing for it');
select is(tests.reqs(tests.view('pl_wed'), 'cocktail_music'), array['songs:unanswered'], 'and the list is unanswered again');

-- ===========================================================================
-- Validation
-- ===========================================================================
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', 'http://open.spotify.com/playlist/x'))) ->> 'field', 'playlist:' || tests.id('pl-x') || ':url', 'only https links');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', 'javascript:alert(1)'))) ->> 'message', 'Enter the full playlist link, starting with https://.', 'scripts are not links');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', 'data:text/html,hi'))) ->> 'status', 'invalid', 'data: links are refused');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', 'file:///etc/passwd'))) ->> 'status', 'invalid', 'file: links are refused');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', 'https://user:pw@example.com/p'))) ->> 'status', 'invalid', 'links with credentials are refused');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', 'https://exa mple.com/p'))) ->> 'status', 'invalid', 'malformed links are refused');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', '   '))) ->> 'message', 'Paste the playlist link.', 'a blank link is refused');
select is(tests.save('pl_wed', 'must_play', tests.pls(jsonb_build_object('id', tests.id('pl-x'), 'label', 'No link'))) ->> 'field', 'playlist:' || tests.id('pl-x') || ':url', 'a playlist needs a link');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', 'https://example.com/' || repeat('p', 981)))) ->> 'message', 'Keep this under 1000 characters.', 'links are bounded');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', :spotify, jsonb_build_object('label', repeat('x', 101))))) ->> 'field', 'playlist:' || tests.id('pl-x') || ':label', 'names are bounded');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', :spotify, jsonb_build_object('notes', repeat('x', 501))))) ->> 'field', 'playlist:' || tests.id('pl-x') || ':notes', 'notes are bounded');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', :spotify, '{"tracks":[]}'))) ->> 'status', 'invalid', 'unknown playlist fields are refused');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', :spotify, '{"label":5}'))) ->> 'status', 'invalid', 'fields are text');
select is(tests.save('pl_wed', 'must_play', '{"playlists":{"url":"https://example.com"}}') ->> 'field', 'playlists', 'playlists are a list');
select is(tests.save('pl_wed', 'must_play', jsonb_build_object('playlists', (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'url', 'https://example.com/p' || g)) from generate_series(1, 6) g))) ->> 'message',
  'Keep this to 5 playlists or fewer.', 'at most 5 playlists per list');
select is(tests.save('pl_wed', 'must_play', '{"playlists":[{"id":"Playlist-1","url":"https://example.com"}]}') ->> 'field', 'playlists', 'ids are UUIDs');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', :spotify), tests.pl('x', :apple))) ->> 'field', 'playlists', 'an id appears once per list');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('x', :spotify), tests.pl('y', 'https://OPEN.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M/?utm_source=copy-link'))),
  jsonb_build_object('status', 'invalid', 'field', 'playlist:' || tests.id('pl-y') || ':url', 'message', 'This playlist is already added here.'),
  'the same playlist can''t be added twice to a list');
select is(tests.stored('pl_wed', 'must_play'), tests.pls(tests.pl('m1', :apple)), 'nothing invalid was stored');

-- ===========================================================================
-- Song moments take no playlists
-- ===========================================================================
select is(tests.save('pl_wed', 'first_dance', tests.pls(tests.pl('f', :spotify))) ->> 'field', 'playlists', 'a first dance refuses playlists');
select is(tests.save('pl_wed', 'first_dance', jsonb_build_object('songs', jsonb_build_array(tests.song('fd', 'At Last', 'Etta James'))) || tests.pls(tests.pl('f', :spotify))) ->> 'status', 'invalid',
  'even with a song');
select is(tests.save('pl_wed', 'processional', tests.pls(tests.pl('p', :spotify))) ->> 'status', 'invalid', 'the Processional refuses them too');
select is(tests.reqs(tests.save('pl_wed', 'first_dance', jsonb_build_object('songs', jsonb_build_array(tests.song('fd', 'At Last', 'Etta James')))), 'first_dance'), array['songs:answered'],
  'a first dance song saves and completes as before');
select is(private.plan_music_requirements('moment_songs', tests.pls(tests.pl('f', :spotify))), '[{"key":"songs","state":"unanswered"}]'::jsonb,
  'a playlist never completes a song moment');

-- ===========================================================================
-- Choices
-- ===========================================================================
select is(tests.save('pl_wed', 'must_play', '{"choice":"none"}'::jsonb || tests.pls(tests.pl('m1', :apple))) ->> 'field', 'choice', '"No requests" is refused while playlists exist');
select is(tests.save('pl_wed', 'dinner_music', '{"choice":"dj_choice"}'::jsonb || tests.pls(tests.pl('n1', :apple))) ->> 'message',
  'Remove the songs and playlists first, or keep them and choose to add songs or playlists.', 'and DJ''s choice too: nothing is removed silently');
select is(tests.reqs(tests.save('pl_wed', 'cocktail_music', '{"choice":"dj_choice"}'), 'cocktail_music'), array['songs:answered'], 'DJ''s choice alone still answers a list');
select is(tests.reqs(tests.save('pl_other', 'do_not_play', '{"choice":"none"}'), 'do_not_play'), array['songs:answered'], '"Nothing to exclude" alone still answers it');

-- ===========================================================================
-- Retries, stale tabs and views
-- ===========================================================================
select tests.rev('pl_wed', 'must_play') as before \gset
select tests.pls(tests.pl('m1', :apple), tests.pl('m2', :spotify, '{"label":"Dance floor"}')) as two \gset
select is(tests.save('pl_wed', 'must_play', :'two'::jsonb) ->> 'status', 'saved', 'a second playlist saves');
select is(tests.save('pl_wed', 'must_play', :'two'::jsonb, 'client_y', :before) ->> 'status', 'saved', 'the same save retried with the old revision counts as saved');
select is(tests.save('pl_wed', 'must_play', tests.pls(tests.pl('m3', 'https://example.com/other')), 'client_y', :before) ->> 'status', 'conflict',
  'a stale tab with different playlists gets a conflict');
select is(array[jsonb_array_length(tests.stored('pl_wed', 'must_play') -> 'playlists'), tests.rev('pl_wed', 'must_play')], array[2, :before + 1],
  'and overwrites nothing; the retry added nothing twice');
select is(tests.view('pl_wed') -> 'music' -> tests.item('pl_wed', 'must_play')::text -> 'answers', :'two'::jsonb, 'the client view reads the playlists back, in order');
select tests.login_as(tests.id('staff_a'));
select is(public.staff_planning_view(tests.id('pl_wed')) -> 'music' -> tests.item('pl_wed', 'must_play')::text -> 'answers', :'two'::jsonb, 'staff see the same playlists');
select tests.su();
select is(tests.staff_save('pl_wed', 'do_not_play', tests.pls(tests.pl('d1', :ytm, '{"notes":"Checked with the couple"}'))) ->> 'status', 'saved', 'staff can edit playlists');

-- Legacy answers stay valid as stored.
select is(private.normalize_plan_music('music_requests', '{"songs":[{"id":"00000000-0000-4000-8000-000000000001","title":"T","artist":"A","link":"https://example.com"}],"choice":null}'),
  '{"ok":true,"answers":{"songs":[{"id":"00000000-0000-4000-8000-000000000001","title":"T","artist":"A","link":"https://example.com"}]}}'::jsonb,
  'answers saved before playlists normalize exactly as before');

-- ===========================================================================
-- Externally booked events
-- ===========================================================================
select is(tests.reqs(tests.save('pl_ext', 'must_play', tests.pls(tests.pl('e1', :spotify))), 'must_play'), array['songs:answered'],
  'a client of an event booked elsewhere attaches playlists the same way');

-- ===========================================================================
-- Closed editing, archiving, isolation and suspension
-- ===========================================================================
select is(tests.save('pl_soon', 'must_play', tests.pls(tests.pl('l1', :spotify))) ->> 'status', 'locked', 'past the planning deadline the client can''t attach playlists');
select is(tests.rev('pl_soon', 'must_play'), 0, 'and nothing is stored');
select is(tests.save('pl_wed', 'cocktail_music', tests.pls(tests.pl('o1', :spotify)), 'client_x') ->> 'status', 'unavailable', 'another client can''t save');
select tests.item('pl_other', 'must_play') as other_must \gset it_
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('pl_wed'), 'test-bouprod', :'it_other_must', 0, tests.pls(tests.pl('o2', :spotify))) ->> 'status', 'unavailable',
  'another event''s list can''t be saved through this one');
select tests.su();
select is(tests.rev('pl_other', 'must_play'), 0, 'and stays untouched');
select throws_ok(format('select tests.staff_save(%L, %L, %L, %L)', 'pl_wed', 'must_play', tests.pls(tests.pl('o3', :spotify)), 'owner_b'), 'P0002', 'not found',
  'another business can''t save');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('pl_wed'), true);
select tests.su();
select is(tests.save('pl_wed', 'cocktail_music', tests.pls(tests.pl('a1', :spotify))) ->> 'status', 'unavailable', 'an archived event refuses client changes');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('pl_wed'), false);
select tests.su();
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select is(tests.save('pl_wed', 'cocktail_music', tests.pls(tests.pl('s9', :spotify))) ->> 'status', 'unavailable', 'a suspended workspace refuses changes');
select is(tests.stored('pl_wed', 'cocktail_music'), '{"choice":"dj_choice"}'::jsonb, 'and keeps what was saved');

select * from finish();
rollback;
