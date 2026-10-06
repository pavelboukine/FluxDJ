-- Music editors: the library's music moments and the single entrance-music
-- source; song validation (ids, limits, links, unknown fields, cues);
-- choices and completion (DJ's choice, no requests, nothing to exclude, not
-- applicable, discuss); order by id; idempotent retries and stale tabs;
-- hidden moments and stages; access, isolation and archiving; contractual
-- records untouched.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(66);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('music-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.new_event(name text, kind text default 'wedding') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, internal_notes)
  values (tests.id(name), tests.id('tenant_a'), name, kind, '2027-09-01', 'MUSIC SECRET NOTE');
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  return tests.id(name);
end $$;
create function tests.force_book(ev uuid) returns void language plpgsql as $$
begin
  perform set_config('flux.booking_event', ev::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = ev;
  perform set_config('flux.booking_event', '', true);
end $$;
create function tests.item(event text, item_key text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(event) and i.key = item_key;
$$;
create function tests.version(event text) returns int language sql stable as $$
  select structure_version from public.event_plans where event_id = tests.id(event);
$$;
create function tests.rev(event text, item_key text) returns int language sql stable as $$
  select coalesce((select revision from public.event_plan_responses where item_id = tests.item(event, item_key)), 0);
$$;
create function tests.stored(event text, item_key text) returns jsonb language sql stable as $$
  select answers from public.event_plan_responses where item_id = tests.item(event, item_key);
$$;
-- Client save with the current revision (or an explicit one).
create function tests.save(event text, item_key text, answers jsonb, who text default 'client_y', rev int default null) returns jsonb language plpgsql as $$
declare r jsonb; v_rev int := coalesce(rev, tests.rev(event, item_key)); v_item uuid := tests.item(event, item_key);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_save_plan_item(tests.id(event), 'test-bouprod', v_item, v_rev, answers);
  perform tests.su();
  return r;
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
create function tests.state(result jsonb, item_key text) returns text language sql immutable as $$
  select i ->> 'state' from jsonb_array_elements(result -> 'progress' -> 'items') i where i ->> 'key' = item_key;
$$;
-- A song entry with a fixed id per name.
create function tests.song(name text, title text, artist text, extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('id', tests.id('song-' || name), 'title', title, 'artist', artist) || extra;
$$;
create function tests.titles(answers jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(s ->> 'title' order by o), '{}') from jsonb_array_elements(coalesce(answers -> 'songs', '[]')) with ordinality as x(s, o);
$$;
create function tests.sent_contract(event text) returns uuid language plpgsql as $$
declare
  v_approval uuid := tests.approved(event);
  v_contract uuid;
  v_link uuid := gen_random_uuid();
begin
  perform tests.login_as(tests.id('owner_a'));
  v_contract := (public.generate_contract_draft(v_approval, current_setting('tests.v')::uuid) ->> 'contract_id')::uuid;
  perform public.send_contract(v_contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
  perform tests.su();
  return v_contract;
end $$;
create function tests.sign(contract uuid) returns jsonb language plpgsql as $$
declare v_hash text; v_consent text; v_path text; r jsonb;
begin
  select content_sha256, consent_version, tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' into v_hash, v_consent, v_path
  from public.contracts where id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size": 4096, "mimetype": "image/png"}');
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id('client_y'), 'Client Y', v_hash, v_consent, true, v_path,
    repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  perform tests.su();
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test', reply_to_email = 'hello@bouprod.test'
where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select tests.new_event(n, k) from (values ('mu_wed', 'wedding'), ('mu_party', 'private_party'), ('mu_other', 'wedding')) v(n, k);
select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select public.update_planning_template(t.id, t.version, t.name, t.description, 'wedding')
from public.planning_templates t where t.tenant_id = tests.id('tenant_a') and t.starter_key = 'wedding';
select public.setup_event_plan(tests.id('mu_party'), (select id from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'simple_party'));
select tests.su();

-- A real booking for mu_wed (signed, deposit paid): the Wedding default applies.
select tests.sent_contract('mu_wed') as contract \gset wed_
select tests.sign(:'wed_contract');
select tests.login_as(tests.id('staff_a'));
select public.record_event_payment(tests.id('mu_wed'), (select deposit_cents from public.contracts where id = :'wed_contract'),
  current_date - 1, 'MUSIC-REF-SECRET', null, gen_random_uuid(), false);
select tests.su();
select tests.force_book(tests.id('mu_party'));
select tests.force_book(tests.id('mu_other'));
create temp table contractual as
  select (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract') as contract,
         (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('mu_wed')) as booking,
         (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('mu_wed')) as payments,
         (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')) as proposal,
         (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('mu_wed'))) as imports,
         (select structure_version from public.event_plans where event_id = tests.id('mu_wed')) as structure;

-- ===========================================================================
-- Library and views
-- ===========================================================================
select is((select array_agg(key || ':' || editor order by library_order) from private.planning_library() where private.is_music_editor(editor) or editor = 'processional'),
  array['arrival_music:music_background', 'pre_ceremony_music:music_background', 'processional:processional', 'couple_entrance:moment_songs',
        'ceremony_signing:moment_songs', 'recessional:moment_songs', 'cocktail_music:music_background', 'entrance_music:moment_songs',
        'dinner_music:music_background', 'cake_cutting:moment_songs', 'first_dance:moment_songs', 'family_dances:moment_songs',
        'other_dances:moment_songs', 'must_play:music_requests', 'play_if_possible:music_requests', 'do_not_play:music_exclusions',
        'last_dances:moment_songs', 'final_song:moment_songs'],
  'music editors are keyed by moment key');
select is((select array_agg(coalesce(editor, 'none') order by library_order) from private.planning_library() where key in ('introductions', 'entrance_participants', 'entrance_music')),
  array['introductions', 'included', 'moment_songs'], 'reception entrance songs have one source: Entrance music');
select tests.view('mu_wed') as v \gset v0_
select is((select count(*)::int from jsonb_object_keys(:'v0_v'::jsonb -> 'music')), 17, 'the client view lists the 17 visible music moments of a wedding');
select is(tests.reqs(:'v0_v'::jsonb, 'must_play'), array['songs:unanswered'], 'an empty list is unanswered');
select is(tests.state(:'v0_v'::jsonb, 'must_play'), 'not_started', 'and not started');

-- ===========================================================================
-- Validation
-- ===========================================================================
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', 'One More Time', '  ')))) ->> 'field',
  'song:' || tests.id('song-a') || ':artist', 'title and artist are needed');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', 'T', 'A', '{"link":"https://user:pw@example.com/x"}')))) ->> 'field',
  'song:' || tests.id('song-a') || ':link', 'links with credentials are refused');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', 'T', 'A', '{"link":"http://example.com"}')))) ->> 'message',
  'Enter a full https:// address, or leave the link empty.', 'only https links');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', 'T', 'A', '{"link":"javascript:alert(1)"}')))) ->> 'status',
  'invalid', 'scripts are not links');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', 'T', 'A', '{"cue":"Couple"}')))) ->> 'status',
  'invalid', 'cues belong to moment songs only');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', 'T', 'A', '{"bpm":"120"}')))) ->> 'status',
  'invalid', 'unknown song fields are refused');
select is(tests.save('mu_wed', 'must_play', '{"songs":[],"genre":"rock"}') ->> 'field', 'genre', 'unknown fields are refused');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', 'T', 'A'), tests.song('a', 'U', 'B')))) ->> 'status',
  'invalid', 'an entry id appears once per list');
select is(tests.save('mu_wed', 'must_play', '{"songs":[{"id":"Song-1","title":"T","artist":"A"}]}') ->> 'status', 'invalid', 'entry ids are UUIDs');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('a', repeat('x', 201), 'A')))) ->> 'message',
  'Keep this under 200 characters.', 'text limits are enforced');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs',
  (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'title', 'S' || g, 'artist', 'A')) from generate_series(1, 151) g))) ->> 'message',
  'Keep this list to 150 songs or fewer.', 'lists are bounded');
select is(tests.save('mu_wed', 'first_dance', jsonb_build_object('songs',
  (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'title', 'S' || g, 'artist', 'A')) from generate_series(1, 13) g))) ->> 'status',
  'invalid', 'moments hold at most 12 songs');
select is(tests.save('mu_wed', 'must_play', '{"choice":"dj_choice"}') ->> 'field', 'choice', 'each list offers only its own choices');
select is(tests.rev('mu_wed', 'must_play'), 0, 'nothing invalid was stored');

-- ===========================================================================
-- Saving, order and completion
-- ===========================================================================
select tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(
  tests.song('a', '  One More Time ', 'Daft Punk', '{"version":"","notes":"Peak of the night","link":"https://example.com/omt"}'),
  tests.song('b', 'Dancing Queen', 'ABBA')))) as s \gset m1_
select is(array[:'m1_s'::jsonb ->> 'status', :'m1_s'::jsonb ->> 'revision'], array['saved', '1'], 'songs save');
select is(:'m1_s'::jsonb -> 'answers' -> 'songs' -> 0,
  jsonb_build_object('id', tests.id('song-a'), 'title', 'One More Time', 'artist', 'Daft Punk', 'notes', 'Peak of the night', 'link', 'https://example.com/omt'),
  'normalized: trimmed, empty optional fields dropped');
select is(tests.reqs(:'m1_s'::jsonb, 'must_play'), array['songs:answered'], 'songs entered complete the list; optional fields don''t block');
select is(tests.save('mu_wed', 'must_play', '{"choice":"none"}' || jsonb_build_object('songs', :'m1_s'::jsonb -> 'answers' -> 'songs')) ->> 'field',
  'choice', '"No requests" is refused while songs exist: nothing is removed silently');
select is(tests.titles(tests.stored('mu_wed', 'must_play')), array['One More Time', 'Dancing Queen'], 'and the songs stay');
-- Reorder: the same ids in a new order.
select is(tests.titles(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(
  :'m1_s'::jsonb -> 'answers' -> 'songs' -> 1, :'m1_s'::jsonb -> 'answers' -> 'songs' -> 0))) -> 'answers'),
  array['Dancing Queen', 'One More Time'], 'the list order is saved');
select is(tests.titles(tests.view('mu_wed') -> 'music' -> tests.item('mu_wed', 'must_play')::text -> 'answers'), array['Dancing Queen', 'One More Time'],
  'and read back in that order');

select is(tests.reqs(tests.save('mu_wed', 'play_if_possible', '{"choice":"none"}'), 'play_if_possible'), array['songs:answered'], '"No requests" answers an empty list');
select is(tests.reqs(tests.save('mu_wed', 'do_not_play', '{"choice":"none"}'), 'do_not_play'), array['songs:answered'], '"Nothing to exclude" answers it too');
select is(tests.reqs(tests.save('mu_wed', 'dinner_music', '{"choice":"dj_choice"}'), 'dinner_music'), array['songs:answered'], 'background music can be the DJ''s choice');
select is(tests.reqs(tests.save('mu_wed', 'cake_cutting', '{"choice":"not_applicable"}'), 'cake_cutting'), array['songs:not_applicable'],
  'a moment that won''t happen is not applicable');
select ok((select disabled_at is null from public.event_plan_items where id = tests.item('mu_wed', 'cake_cutting'))
  and tests.version('mu_wed') = (select structure from contractual), 'without hiding it or changing the structure');
select is(tests.reqs(tests.save('mu_wed', 'final_song', '{"choice":"discuss"}'), 'final_song'), array['songs:unanswered:discuss'], '"discuss with DJ" stays open');
select is(tests.reqs(tests.save('mu_wed', 'final_song', jsonb_build_object('choice', 'discuss', 'songs', jsonb_build_array(tests.song('f', 'Time of My Life', 'Medley')))), 'final_song'),
  array['songs:unanswered:discuss'], 'even with a tentative song');

-- Several cue songs with instructions, in order.
select tests.save('mu_wed', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(
  tests.song('e1', 'Uptown Funk', 'Mark Ronson', '{"cue":"Wedding party","notes":"Start at 0:45"}'),
  tests.song('e2', 'Signed, Sealed, Delivered', 'Stevie Wonder', '{"cue":"Couple","version":"Live","notes":"Fade after the first chorus"}')))) as s \gset e1_
select is((select array_agg((s ->> 'cue') || '|' || (s ->> 'notes') order by o) from jsonb_array_elements(:'e1_s'::jsonb -> 'answers' -> 'songs') with ordinality x(s, o)),
  array['Wedding party|Start at 0:45', 'Couple|Fade after the first chorus'], 'cue songs keep their labels, instructions and order');

-- ===========================================================================
-- Retries, doubled imports and stale tabs
-- ===========================================================================
select tests.stored('mu_wed', 'must_play') || jsonb_build_object('songs', (tests.stored('mu_wed', 'must_play') -> 'songs') || jsonb_build_array(
  tests.song('c', 'September', 'Earth, Wind & Fire'), tests.song('d', 'Le Freak', 'Chic'))) as imp \gset
select tests.rev('mu_wed', 'must_play') as before \gset
select is(tests.save('mu_wed', 'must_play', :'imp'::jsonb) ->> 'status', 'saved', 'an import saves');
select is(tests.save('mu_wed', 'must_play', :'imp'::jsonb, 'client_y', :before) ->> 'status', 'saved',
  'the same import retried with the old revision counts as saved');
select is(array[jsonb_array_length(tests.stored('mu_wed', 'must_play') -> 'songs'), tests.rev('mu_wed', 'must_play')], array[4, :before + 1],
  'and adds nothing twice');
select is(tests.save('mu_wed', 'must_play', jsonb_build_object('songs', jsonb_build_array(tests.song('z', 'Other', 'Tab'))), 'client_y', :before) ->> 'status',
  'conflict', 'a stale tab with a different list gets a conflict');
select is(tests.titles(tests.stored('mu_wed', 'must_play')), array['Dancing Queen', 'One More Time', 'September', 'Le Freak'], 'and overwrites nothing');
select is(tests.save('mu_wed', 'first_dance', jsonb_build_object('songs', jsonb_build_array(tests.song('fd', 'At Last', 'Etta James'))), 'client_y', 0) ->> 'revision', '1',
  'a first save creates the answers');
select is(tests.save('mu_wed', 'first_dance', jsonb_build_object('songs', jsonb_build_array(tests.song('fd', 'At Last', 'Etta James'))), 'client_y', 0) ->> 'revision', '1',
  'a concurrent identical first save is the same save');
select is(tests.save('mu_wed', 'first_dance', jsonb_build_object('songs', jsonb_build_array(tests.song('fx', 'Other', 'Song'))), 'client_y', 0) ->> 'status', 'conflict',
  'a different concurrent first save conflicts');
-- Other editors keep their behaviour: a stale identical save still conflicts.
select tests.save('mu_wed', 'ceremony', '{"start_time":"16:00"}');
select tests.save('mu_wed', 'ceremony', '{"start_time":"16:30"}');
select is(tests.save('mu_wed', 'ceremony', '{"start_time":"16:30"}', 'client_y', 1) ->> 'status', 'conflict', 'stage details keep strict revisions');

-- ===========================================================================
-- Hidden moments and stages
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('mu_wed', 'must_play'), tests.version('mu_wed'), false);
select tests.su();
select is(tests.save('mu_wed', 'must_play', '{"choice":"none"}') ->> 'status', 'unavailable', 'a hidden list can''t be saved');
select ok(not (tests.view('mu_wed') -> 'music' ? tests.item('mu_wed', 'must_play')::text) and tests.state(tests.view('mu_wed'), 'must_play') is null,
  'it leaves the view and progress');
select is(jsonb_array_length(tests.stored('mu_wed', 'must_play') -> 'songs'), 4, 'its songs are kept');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('mu_wed', 'must_play'), tests.version('mu_wed'), true);
select public.set_event_plan_item_enabled(tests.item('mu_wed', 'special_dances'), tests.version('mu_wed'), false);
select tests.su();
select is(tests.titles(tests.view('mu_wed') -> 'music' -> tests.item('mu_wed', 'must_play')::text -> 'answers'),
  array['Dancing Queen', 'One More Time', 'September', 'Le Freak'], 'restoring brings them back in order');
select ok(not (tests.view('mu_wed') -> 'music' ? tests.item('mu_wed', 'first_dance')::text) and tests.state(tests.view('mu_wed'), 'first_dance') is null,
  'hiding a stage hides its song moments');
select is(tests.save('mu_wed', 'first_dance', '{}') ->> 'status', 'unavailable', 'and they can''t be saved');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('mu_wed', 'special_dances'), tests.version('mu_wed'), true);
select tests.su();
select is(tests.titles(tests.view('mu_wed') -> 'music' -> tests.item('mu_wed', 'first_dance')::text -> 'answers'), array['At Last'], 'restoring the stage keeps its songs');
select is(tests.reqs(tests.save('mu_party', 'do_not_play', jsonb_build_object('songs', jsonb_build_array(tests.song('p', 'Macarena', 'Los del Rio')))), 'do_not_play'),
  array['songs:answered'], 'a Simple Party gets its lists too');

-- ===========================================================================
-- Access, isolation and archiving
-- ===========================================================================
select is(tests.save('mu_wed', 'must_play', '{"choice":"none"}', 'client_x') ->> 'status', 'unavailable', 'another client can''t save');
select tests.item('mu_other', 'must_play') as other_must \gset it_
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('mu_wed'), 'test-bouprod', :'it_other_must', 0, '{"choice":"none"}') ->> 'status', 'unavailable',
  'a list of another event can''t be saved through this one');
select tests.su();
select is(tests.rev('mu_other', 'must_play'), 0, 'and stays untouched');
select tests.login_as(tests.id('owner_b'));
select throws_ok(format('select public.staff_save_plan_item(%L, %L, 0, %L)', tests.id('mu_wed'), tests.item('mu_wed', 'do_not_play'), '{}'), 'P0002', 'not found',
  'other businesses can''t save');
select tests.su();
select tests.item('mu_wed', 'do_not_play') as dnp \gset it_
select tests.login_as_anon();
select throws_ok(format('select public.client_save_plan_item(%L, %L, %L, 0, %L)', tests.id('mu_wed'), 'test-bouprod', :'it_dnp', '{}'), '42501', null, 'anon has no access');
select tests.su();
select tests.login_as(tests.id('staff_a'));
select is(public.staff_save_plan_item(tests.id('mu_wed'), tests.item('mu_wed', 'do_not_play'), tests.rev('mu_wed', 'do_not_play'),
  jsonb_build_object('songs', jsonb_build_array(tests.song('x', 'Macarena', 'Los del Rio')))) ->> 'status', 'saved', 'staff can edit songs');
select public.set_event_archived(tests.id('mu_wed'), true);
select throws_like(format('select public.staff_save_plan_item(%L, %L, %s, %L)', tests.id('mu_wed'), tests.item('mu_wed', 'do_not_play'), tests.rev('mu_wed', 'do_not_play'), '{}'),
  '%archived%', 'archived events refuse staff edits');
select tests.su();
select is(tests.save('mu_wed', 'do_not_play', '{"choice":"none"}') ->> 'status', 'unavailable', 'and client edits');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('mu_wed'), false);
select tests.su();
select tests.view('mu_wed') as v \gset final_
select unalike(:'final_v'::text, '%' || tests.id('staff_a') || '%', 'the client view has no staff identities');
select unalike(:'final_v'::text, '%MUSIC-REF-SECRET%', 'no payment references');

-- ===========================================================================
-- Contractual records
-- ===========================================================================
select is((select contract from contractual), (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract'),
  'the contract is untouched');
select is((select booking from contractual), (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('mu_wed')),
  'the booking is untouched');
select is((select payments from contractual), (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('mu_wed')),
  'payments are untouched');
select is((select proposal from contractual),
  (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')), 'the proposal is untouched');
select is((select imports from contractual),
  (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('mu_wed'))),
  'imported answers are untouched');

select * from finish();
rollback;
