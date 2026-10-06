-- Participants, pronunciation guides, MC and speeches: library placement
-- and the covered placeholder; Processional people saved with its songs;
-- song links (own songs, Entrance music, shared, renamed, reordered, hidden)
-- and refused removals of linked songs; wrong-moment, cross-event and
-- unknown links; speech timing (exact time with next day, cue, undecided);
-- MC choices; completion and explicit alternatives; retries; hidden moments;
-- access, isolation and archiving; contractual records untouched.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(78);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('people-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.new_event(name text, kind text default 'wedding') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, internal_notes)
  values (tests.id(name), tests.id('tenant_a'), name, kind, '2027-09-01', 'PEOPLE SECRET NOTE');
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
  select array_agg((q ->> 'key') || ':' || (q ->> 'state') || case when (q ->> 'discuss')::boolean then ':discuss' else '' end
                   || coalesce(':' || (q ->> 'note'), '') order by o)
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
select tests.new_event(n, k) from (values ('pe_wed', 'wedding'), ('pe_party', 'private_party'), ('pe_other', 'wedding')) v(n, k);
select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select public.update_planning_template(t.id, t.version, t.name, t.description, 'wedding')
from public.planning_templates t where t.tenant_id = tests.id('tenant_a') and t.starter_key = 'wedding';
select public.setup_event_plan(tests.id('pe_party'), (select id from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'simple_party'));
select tests.su();

-- A real booking for pe_wed (signed, deposit paid): the Wedding default applies.
select tests.sent_contract('pe_wed') as contract \gset wed_
select tests.sign(:'wed_contract');
select tests.login_as(tests.id('staff_a'));
select public.record_event_payment(tests.id('pe_wed'), (select deposit_cents from public.contracts where id = :'wed_contract'),
  current_date - 1, 'PEOPLE-REF-SECRET', null, gen_random_uuid(), false);
select tests.su();
select tests.force_book(tests.id('pe_party'));
select tests.force_book(tests.id('pe_other'));
create temp table contractual as
  select (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract') as contract,
         (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('pe_wed')) as booking,
         (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('pe_wed')) as payments,
         (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')) as proposal,
         (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('pe_wed'))) as imports,
         (select structure_version from public.event_plans where event_id = tests.id('pe_wed')) as structure;

create function tests.person(name text, names text, extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('id', tests.id('person-' || name), 'names', names) || extra;
$$;
create function tests.speech(name text, speaker text, extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('id', tests.id('speech-' || name), 'speaker', speaker) || extra;
$$;
create function tests.sid(name text) returns text language sql immutable as $$ select tests.id('song-' || name)::text $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Library and views
-- ===========================================================================
select is((select array_agg(key || ':' || editor order by library_order) from private.planning_library() where editor in ('processional', 'mc', 'introductions', 'speeches', 'included')),
  array['processional:processional', 'mc:mc', 'introductions:introductions', 'entrance_participants:included', 'speeches:speeches'],
  'participant, MC and speech editors by moment key; Participants and names is covered by Introductions');
select is((select parent_keys from private.planning_library() where key = 'speeches'), array['dinner', 'program', 'party'],
  'speeches stay wherever the library allows them');
select tests.view('pe_wed') as v \gset v0_
select is((select count(*)::int from jsonb_object_keys(:'v0_v'::jsonb -> 'moments') k join public.event_plan_items i on i.id = k::uuid
            where i.key in ('processional', 'mc', 'introductions', 'speeches')), 4, 'the view carries the four visible people moments of a wedding');
select is(tests.state(:'v0_v'::jsonb, 'entrance_participants'), null, 'the covered placeholder isn''t counted');
select is(tests.save('pe_wed', 'entrance_participants', '{}') ->> 'status', 'unavailable', 'and has nothing of its own to save');
select is(tests.reqs(:'v0_v'::jsonb, 'processional'), array['songs:unanswered', 'participants:unanswered'], 'Processional needs songs and who walks in');

-- ===========================================================================
-- Processional: people saved with its songs
-- ===========================================================================
select tests.save('pe_wed', 'processional', jsonb_build_object('songs', jsonb_build_array(
  tests.song('canon', 'Canon in D', 'Pachelbel', '{"cue":"Wedding party"}'), tests.song('arrival', 'A Thousand Years', 'Christina Perri', '{"cue":"Partner"}'))));
select tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || jsonb_build_object('participants', jsonb_build_array(
  tests.person('pair', '  Sam & Jo ', jsonb_build_object('role', 'Wedding party', 'song_id', tests.sid('canon'))),
  tests.person('group', 'The flower children', jsonb_build_object('song_id', tests.sid('canon'), 'notes', 'Walk slowly')),
  tests.person('partner', 'Alex Dubois with their mother Dana', jsonb_build_object('pronunciation', 'ah-LEX doo-BWAH', 'song_id', tests.sid('arrival')))))) as s \gset p1_
select is(:'p1_s'::jsonb ->> 'status', 'saved', 'individual, pair and group entries save; no bride or groom labels needed');
select is(tests.titles(:'p1_s'::jsonb -> 'answers'), array['Canon in D', 'A Thousand Years'], 'its songs are kept when people are added');
select is((select array_agg((p ->> 'names') || '|' || coalesce(p ->> 'pronunciation', '') order by o) from jsonb_array_elements(:'p1_s'::jsonb -> 'answers' -> 'participants') with ordinality x(p, o)),
  array['Sam & Jo|', 'The flower children|', 'Alex Dubois with their mother Dana|ah-LEX doo-BWAH'], 'names (trimmed) and pronunciation guides are kept in order');
select is(tests.reqs(:'p1_s'::jsonb, 'processional'), array['songs:answered', 'participants:answered'], 'songs and people complete it; roles and guides are optional');
select is(tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || jsonb_build_object('participants', jsonb_build_array(
  tests.person('pair', 'Sam & Jo', jsonb_build_object('song_id', tests.id('song-elsewhere')))))) ->> 'message',
  'That song is no longer in Processional or Couple entrance. Choose another song or none.', 'links name Processional or Couple entrance songs only');
select is(tests.save('pe_wed', 'processional', jsonb_build_object('songs', jsonb_build_array(tests.song('arrival', 'A Thousand Years', 'Christina Perri')))
  || jsonb_build_object('participants', tests.stored('pe_wed', 'processional') -> 'participants')) ->> 'field',
  'entry:' || tests.id('person-pair') || ':song_id', 'a linked song can''t be removed from under its people');
select is(tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || '{"choice":"not_applicable"}') ->> 'field', 'choice',
  '"not applicable" is refused while people are listed');
-- Rename and reorder the songs: people keep their names and links.
select tests.save('pe_wed', 'processional', jsonb_set(tests.stored('pe_wed', 'processional'), '{songs}', jsonb_build_array(
  tests.song('arrival', 'A Thousand Years (Piano)', 'Christina Perri', '{"cue":"Partner"}'), tests.song('canon', 'Canon in D', 'Pachelbel', '{"cue":"Wedding party"}')))) as s \gset p2_
select is(array[:'p2_s'::jsonb ->> 'status', :'p2_s'::jsonb -> 'answers' -> 'participants' -> 2 ->> 'song_id', :'p2_s'::jsonb -> 'answers' -> 'participants' -> 2 ->> 'names'],
  array['saved', tests.sid('arrival'), 'Alex Dubois with their mother Dana'], 'renaming or reordering songs never rewrites people');
select is(tests.reqs(tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || '{"participants_choice":"discuss"}'), 'processional'),
  array['songs:answered', 'participants:unanswered:discuss'], '"discuss with DJ" about who walks in stays open');
select tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') - 'participants_choice');

-- The couple's entry uses its Couple entrance song: same ceremony, same plan, entered once.
select tests.save('pe_wed', 'couple_entrance', jsonb_build_object('songs', jsonb_build_array(tests.song('couple', 'At Last', 'Etta James', '{"cue":"Couple"}'))));
select tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || jsonb_build_object('participants',
  (tests.stored('pe_wed', 'processional') -> 'participants') || jsonb_build_array(tests.person('couple', 'Alex & Taylor', jsonb_build_object('song_id', tests.sid('couple')))))) as s \gset c1_
select is(:'c1_s'::jsonb ->> 'status', 'saved', 'the couple''s Processional entry links to its Couple entrance song');
select is(array[tests.titles(:'c1_s'::jsonb -> 'answers')::text, tests.titles(tests.stored('pe_wed', 'couple_entrance'))::text],
  array['{"A Thousand Years (Piano)","Canon in D"}', '{"At Last"}'], 'without copying the song into Processional');
select tests.save('pe_wed', 'first_dance', jsonb_build_object('songs', jsonb_build_array(tests.song('dance', 'Perfect', 'Ed Sheeran'))));
select is(tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || jsonb_build_object('participants', jsonb_build_array(
  tests.person('couple', 'Alex & Taylor', jsonb_build_object('song_id', tests.sid('dance')))))) ->> 'message',
  'That song is no longer in Processional or Couple entrance. Choose another song or none.', 'a song of another stage (First dance) is refused');
select tests.save('pe_other', 'couple_entrance', jsonb_build_object('songs', jsonb_build_array(tests.song('other-couple', 'Other', 'Event'))));
select is(tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || jsonb_build_object('participants', jsonb_build_array(
  tests.person('couple', 'Alex & Taylor', jsonb_build_object('song_id', tests.sid('other-couple')))))) ->> 'status', 'invalid',
  'another event''s Couple entrance song is refused');
select is(tests.save('pe_wed', 'couple_entrance', '{"songs":[]}') ->> 'message',
  '"At Last" is linked to who walks in (Alex & Taylor). Change those entries under Processional first.', 'a linked Couple entrance song can''t be removed');
select is(tests.save('pe_wed', 'couple_entrance', '{"choice":"dj_choice"}', 'client_y', 1) ->> 'status', 'invalid', 'not even from a stale tab');
select tests.rev('pe_wed', 'processional') as proc_rev \gset
select is(tests.save('pe_wed', 'couple_entrance', jsonb_build_object('songs', jsonb_build_array(tests.song('couple', 'At Last (Live)', 'Etta James', '{"cue":"Couple"}')))) ->> 'status',
  'saved', 'it can be renamed');
select is(tests.rev('pe_wed', 'processional'), :proc_rev, 'without touching Processional');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('pe_wed', 'couple_entrance'), tests.version('pe_wed'), false);
select tests.su();
select is(tests.save('pe_wed', 'processional', tests.stored('pe_wed', 'processional') || '{"participants_choice":"discuss"}') ->> 'status', 'saved',
  'a hidden Couple entrance keeps its song, and the link stays valid');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('pe_wed', 'couple_entrance'), tests.version('pe_wed'), true);
select tests.su();
select tests.save('pe_wed', 'processional', (tests.stored('pe_wed', 'processional') - 'participants_choice') || jsonb_build_object('participants',
  (select jsonb_agg(p - 'song_id' order by o) filter (where p ->> 'id' = tests.id('person-couple')::text) || jsonb_agg(p order by o) filter (where p ->> 'id' <> tests.id('person-couple')::text)
   from jsonb_array_elements(tests.stored('pe_wed', 'processional') -> 'participants') with ordinality x(p, o))));
select is(tests.save('pe_wed', 'couple_entrance', '{"choice":"dj_choice"}') ->> 'status', 'saved', 'once unlinked, it can be removed');

-- ===========================================================================
-- Introductions: links into Entrance music
-- ===========================================================================
select tests.save('pe_wed', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(
  tests.song('funk', 'Uptown Funk', 'Mark Ronson', '{"cue":"Wedding party"}'), tests.song('sealed', 'Signed, Sealed, Delivered', 'Stevie Wonder', '{"cue":"Couple"}'))));
select tests.save('pe_wed', 'introductions', jsonb_build_object('entries', jsonb_build_array(
  tests.person('i1', 'Sam and Jo', jsonb_build_object('role', 'Best friends', 'song_id', tests.sid('funk'))),
  tests.person('i2', 'The wedding party', jsonb_build_object('song_id', tests.sid('funk'))),
  tests.person('i3', 'Alex and Taylor Nguyen-Roy', jsonb_build_object('pronunciation', 'NWEN-rwah', 'wording', 'For the first time as a married couple', 'song_id', tests.sid('sealed')))))) as s \gset i1_
select is(array[:'i1_s'::jsonb ->> 'status', tests.reqs(:'i1_s'::jsonb, 'introductions')::text], array['saved', '{introductions:answered}'],
  'introductions save, two sharing one Entrance music song');
select is(tests.save('pe_wed', 'introductions', jsonb_build_object('entries', jsonb_build_array(
  tests.person('i1', 'Sam and Jo', jsonb_build_object('song_id', tests.sid('canon')))))) ->> 'message',
  'That song is no longer in Entrance music. Choose another song or none.', 'a song from another moment (Processional) is refused');
select tests.save('pe_other', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(tests.song('foreign', 'Other', 'Event'))));
select is(tests.save('pe_wed', 'introductions', jsonb_build_object('entries', jsonb_build_array(
  tests.person('i1', 'Sam and Jo', jsonb_build_object('song_id', tests.sid('foreign')))))) ->> 'status', 'invalid', 'a song of another event is refused');
select is(tests.save('pe_wed', 'introductions', jsonb_build_object('entries', jsonb_build_array(
  tests.person('i1', 'Sam and Jo', '{"song_id":"not-a-song"}')))) ->> 'message', 'Reload the page and try again.', 'malformed links are refused');
select is(jsonb_array_length(tests.stored('pe_wed', 'introductions') -> 'entries'), 3, 'nothing invalid was stored');
-- Removing a linked song from Entrance music is refused, naming who uses it.
select is(tests.save('pe_wed', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(tests.song('sealed', 'Signed, Sealed, Delivered', 'Stevie Wonder')))) ->> 'message',
  '"Uptown Funk" is linked to introductions (Sam and Jo, The wedding party). Change those introductions first.', 'a linked song can''t be removed');
select is(tests.titles(tests.stored('pe_wed', 'entrance_music')), array['Uptown Funk', 'Signed, Sealed, Delivered'], 'and stays');
-- Even from a stale tab: links are checked before the revision.
select is(tests.save('pe_wed', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(tests.song('sealed', 'x', 'y'))), 'client_y', 1) ->> 'status', 'invalid',
  'a stale removal is refused for the link, not overwritten');
-- Rename and reorder: introductions read through the link and are untouched.
select tests.rev('pe_wed', 'introductions') as intro_rev \gset
select is(tests.save('pe_wed', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(
  tests.song('sealed', 'Signed, Sealed, Delivered (Live)', 'Stevie Wonder', '{"cue":"Couple"}'), tests.song('funk', 'Uptown Funk', 'Mark Ronson', '{"cue":"Wedding party"}'),
  tests.song('extra', 'September', 'Earth, Wind & Fire')))) ->> 'status', 'saved', 'linked songs can be renamed, reordered and joined by others');
select is(tests.rev('pe_wed', 'introductions'), :intro_rev, 'without touching the introductions');
select is(tests.save('pe_wed', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(
  tests.song('sealed', 'Signed, Sealed, Delivered (Live)', 'Stevie Wonder', '{"cue":"Couple"}'), tests.song('funk', 'Uptown Funk', 'Mark Ronson', '{"cue":"Wedding party"}')))) ->> 'status',
  'saved', 'an unlinked song can be removed');
-- After the links change, the song can go.
select tests.save('pe_wed', 'introductions', jsonb_build_object('entries', jsonb_build_array(
  tests.person('i1', 'Sam and Jo', jsonb_build_object('role', 'Best friends', 'song_id', tests.sid('sealed'))),
  tests.person('i2', 'The wedding party'),
  tests.person('i3', 'Alex and Taylor Nguyen-Roy', jsonb_build_object('pronunciation', 'NWEN-rwah', 'wording', 'For the first time as a married couple', 'song_id', tests.sid('sealed'))))));
select is(tests.save('pe_wed', 'entrance_music', jsonb_build_object('songs', jsonb_build_array(tests.song('sealed', 'Signed, Sealed, Delivered (Live)', 'Stevie Wonder', '{"cue":"Couple"}')))) ->> 'status',
  'saved', 'once unlinked, it can be removed');
-- A hidden Entrance music keeps its songs, and links to them stay valid.
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('pe_wed', 'entrance_music'), tests.version('pe_wed'), false);
select tests.su();
select ok(not (tests.view('pe_wed') -> 'music' ? tests.item('pe_wed', 'entrance_music')::text), 'a hidden Entrance music leaves the view');
select is(tests.save('pe_wed', 'introductions', tests.stored('pe_wed', 'introductions') || '{"choice":"discuss"}') ->> 'status', 'saved',
  'introductions linked to its kept songs still save');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('pe_wed', 'entrance_music'), tests.version('pe_wed'), true);
select tests.su();
select is(tests.reqs(tests.view('pe_wed'), 'introductions'), array['introductions:unanswered:discuss'], '"discuss" keeps introductions open, even with entries');
select is(tests.save('pe_wed', 'introductions', tests.stored('pe_wed', 'introductions') || '{"choice":"none"}') ->> 'field', 'choice',
  '"No introductions" is refused while entries exist');
select is(tests.reqs(tests.save('pe_other', 'introductions', '{"choice":"none"}'), 'introductions'), array['introductions:not_applicable'], '"No introductions" alone is not applicable');

-- ===========================================================================
-- MC
-- ===========================================================================
select is(tests.reqs(tests.save('pe_wed', 'mc', '{"mc":"other","pronunciation":"kee-ARR-ah"}'), 'mc'), array['mc:unanswered'], 'someone else needs a name');
select tests.save('pe_wed', 'mc', '{"mc":"other","name":"  Kiara Okafor ","pronunciation":"kee-AR-ah oh-KAH-for","contact":"kiara@example.test","notes":"Bilingual"}') as s \gset mc_
select is(array[tests.reqs(:'mc_s'::jsonb, 'mc')::text, :'mc_s'::jsonb -> 'answers' ->> 'name', :'mc_s'::jsonb -> 'answers' ->> 'contact'],
  array['{mc:answered}', 'Kiara Okafor', 'kiara@example.test'], 'with a name it is complete; pronunciation and contact are kept');
select is(tests.save('pe_wed', 'mc', '{"mc":"dj","name":"Kiara","notes":"Bilingual"}') -> 'answers', '{"mc":"dj","notes":"Bilingual"}'::jsonb,
  'when the DJ is the MC, someone else''s details aren''t stored');
select is(tests.reqs(tests.save('pe_wed', 'mc', '{"mc":"none"}'), 'mc'), array['mc:not_applicable'], '"No MC" is not applicable');
select is(tests.reqs(tests.save('pe_wed', 'mc', '{"mc":"discuss"}'), 'mc'), array['mc:unanswered:discuss'], '"discuss" stays open');
select is(tests.save('pe_wed', 'mc', '{"mc":"host"}') ->> 'field', 'mc', 'unknown choices are refused');
select is(tests.save('pe_wed', 'mc', '{"mc":"other","name":"K","phone":"1"}') ->> 'field', 'phone', 'unknown fields are refused');

-- ===========================================================================
-- Speeches and toasts
-- ===========================================================================
select tests.save('pe_wed', 'speeches', jsonb_build_object('entries', jsonb_build_array(
  tests.speech('s1', 'Dana Dubois', '{"role":"Mother","timing":"time","time":"20:15","duration":5,"av_notes":"Handheld mic"}'),
  tests.speech('s2', 'Priya Raman', '{"pronunciation":"PREE-yah rah-MAHN","timing":"cue","cue":"After the main course","time":"21:00"}'),
  tests.speech('s3', 'Late toast', '{"timing":"time","time":"00:30","next_day":true}'),
  tests.speech('s4', 'Uncle Leo', '{"timing":"undecided"}')))) as s \gset sp_
select is(:'sp_s'::jsonb ->> 'status', 'saved', 'speeches with exact times, cues and undecided timing save');
select is((select array_agg(coalesce(e ->> 'time', '') || '|' || coalesce(e ->> 'next_day', '') || '|' || coalesce(e ->> 'cue', '') order by o)
           from jsonb_array_elements(:'sp_s'::jsonb -> 'answers' -> 'entries') with ordinality x(e, o)),
  array['20:15||', '||After the main course', '00:30|true|', '||'], 'only the chosen timing is kept; after midnight is an explicit next day');
select is(tests.reqs(:'sp_s'::jsonb, 'speeches'), array['speeches:unanswered:timing_open'], 'an undecided timing keeps speeches open');
select is(tests.reqs(tests.save('pe_wed', 'speeches', jsonb_build_object('entries', jsonb_build_array(tests.speech('s1', 'Dana', '{"timing":"cue"}')))), 'speeches'),
  array['speeches:unanswered:timing_open'], 'a cue without its text is saved but stays open');
select is(tests.reqs(tests.save('pe_wed', 'speeches', jsonb_build_object('entries', jsonb_build_array(
  tests.speech('s1', 'Dana Dubois', '{"timing":"time","time":"20:15"}'), tests.speech('s2', 'Priya Raman', '{"timing":"cue","cue":"After the main course"}')))), 'speeches'),
  array['speeches:answered'], 'a speaker and a time or cue each complete them; durations and notes are optional');
select is(tests.save('pe_wed', 'speeches', jsonb_build_object('entries', jsonb_build_array(tests.speech('s1', 'Dana', '{"timing":"time","time":"8pm"}')))) ->> 'message',
  'Enter a time such as 18:30.', 'times use the stage time format');
select is(tests.save('pe_wed', 'speeches', jsonb_build_object('entries', jsonb_build_array(tests.speech('s1', 'Dana', '{"timing":"cue","cue":"x","duration":0}')))) ->> 'message',
  'Enter whole minutes from 1 to 240.', 'durations are bounded');
select is(tests.save('pe_wed', 'speeches', jsonb_build_object('entries', jsonb_build_array(tests.speech('s1', '  ', '{"timing":"undecided"}')))) ->> 'message',
  'Enter the speaker''s name.', 'a speaker is needed');
select is(tests.save('pe_wed', 'speeches', jsonb_build_object('entries', jsonb_build_array(tests.speech('s1', 'Dana', '{"timing":"later"}')))) ->> 'field',
  'entry:' || tests.id('speech-s1') || ':timing', 'unknown timings are refused');
select is(tests.reqs(tests.save('pe_other', 'speeches', '{"choice":"none"}'), 'speeches'), array['speeches:not_applicable'], '"No speeches" is not applicable');
select ok((select disabled_at is null from public.event_plan_items where id = tests.item('pe_other', 'speeches')), 'and the moment stays in the plan');

-- ===========================================================================
-- Retries, hidden moments, access and archiving
-- ===========================================================================
select tests.rev('pe_wed', 'speeches') as sp_rev \gset
select tests.stored('pe_wed', 'speeches') || jsonb_build_object('entries', (tests.stored('pe_wed', 'speeches') -> 'entries') || jsonb_build_array(tests.speech('s9', 'Robin', '{"timing":"cue","cue":"Dessert"}'))) as added \gset
select is(tests.save('pe_wed', 'speeches', :'added'::jsonb) ->> 'status', 'saved', 'a speech is added');
select is(array[tests.save('pe_wed', 'speeches', :'added'::jsonb, 'client_y', :sp_rev) ->> 'status', jsonb_array_length(tests.stored('pe_wed', 'speeches') -> 'entries')::text],
  array['saved', '3'], 'a retried add with the old revision is saved once');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('pe_wed', 'mc'), tests.version('pe_wed'), false);
select tests.su();
select is(tests.save('pe_wed', 'mc', '{"mc":"dj"}') ->> 'status', 'unavailable', 'a hidden MC moment can''t be saved');
select ok(tests.state(tests.view('pe_wed'), 'mc') is null and tests.stored('pe_wed', 'mc') ->> 'mc' = 'discuss', 'it leaves progress and keeps its answer');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('pe_wed', 'mc'), tests.version('pe_wed'), true);
select tests.su();
select is(tests.save('pe_wed', 'speeches', '{"choice":"none"}', 'client_x') ->> 'status', 'unavailable', 'another client can''t save');
select tests.item('pe_other', 'introductions') as other_intro \gset it_
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('pe_wed'), 'test-bouprod', :'it_other_intro', 1, '{"choice":"discuss"}') ->> 'status', 'unavailable',
  'a moment of another event can''t be saved through this one');
select tests.su();
select tests.login_as(tests.id('owner_b'));
select throws_ok(format('select public.staff_save_plan_item(%L, %L, 0, %L)', tests.id('pe_wed'), tests.item('pe_wed', 'speeches'), '{}'), 'P0002', 'not found',
  'other businesses can''t save');
select tests.su();
select tests.item('pe_wed', 'mc') as mc_item \gset it_
select tests.login_as_anon();
select throws_ok(format('select public.client_save_plan_item(%L, %L, %L, 0, %L)', tests.id('pe_wed'), 'test-bouprod', :'it_mc_item', '{}'), '42501', null, 'anon has no access');
select tests.su();
select tests.login_as(tests.id('staff_a'));
select is(public.staff_save_plan_item(tests.id('pe_wed'), tests.item('pe_wed', 'mc'), tests.rev('pe_wed', 'mc'), '{"mc":"dj"}') ->> 'status', 'saved', 'staff can edit');
select public.set_event_archived(tests.id('pe_wed'), true);
select throws_like(format('select public.staff_save_plan_item(%L, %L, %s, %L)', tests.id('pe_wed'), tests.item('pe_wed', 'mc'), tests.rev('pe_wed', 'mc'), '{}'),
  '%archived%', 'archived events refuse staff edits');
select tests.su();
select is(tests.save('pe_wed', 'speeches', '{"choice":"discuss"}') ->> 'status', 'unavailable', 'and client edits');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('pe_wed'), false);
select tests.su();
select tests.view('pe_wed') as v \gset final_
select unalike(:'final_v'::text, '%' || tests.id('staff_a') || '%', 'the client view has no staff identities');
select unalike(:'final_v'::text, '%PEOPLE-REF-SECRET%', 'no payment references');

-- ===========================================================================
-- Contractual records
-- ===========================================================================
select is((select contract from contractual), (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract'),
  'the contract is untouched');
select is((select booking from contractual), (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('pe_wed')),
  'the booking is untouched');
select is((select payments from contractual), (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('pe_wed')),
  'payments are untouched');
select is((select proposal from contractual),
  (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')), 'the proposal is untouched');
select is((select imports from contractual),
  (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('pe_wed'))),
  'imported answers are untouched');

select * from finish();
rollback;
