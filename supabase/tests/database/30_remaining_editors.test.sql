-- The remaining editors: Arrival details (explicit venue / ceremony reuse,
-- times with next day, "no separate arrangements"), Program details (overall
-- times and host, agenda with time / cue / undecided), Dinner and Party
-- activities (shared editor, songs on the entry) and Dedications (any time,
-- songs needed); completion and alternatives; retries and stale tabs; hidden
-- sections; access, isolation and archiving; contractual records untouched.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(56);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('remaining-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.new_event(name text, kind text default 'wedding') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, internal_notes)
  values (tests.id(name), tests.id('tenant_a'), name, kind, '2027-09-01', 'REMAINING SECRET NOTE');
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
select tests.new_event(n, k) from (values ('re_wed', 'wedding'), ('re_party', 'private_party'), ('re_other', 'wedding')) v(n, k);
select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select public.update_planning_template(t.id, t.version, t.name, t.description, 'wedding')
from public.planning_templates t where t.tenant_id = tests.id('tenant_a') and t.starter_key = 'wedding';
select public.setup_event_plan(tests.id('re_party'), (select id from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'simple_party'));
select tests.su();

-- A real booking for re_wed (signed, deposit paid): the Wedding default applies.
select tests.sent_contract('re_wed') as contract \gset wed_
select tests.sign(:'wed_contract');
select tests.login_as(tests.id('staff_a'));
select public.record_event_payment(tests.id('re_wed'), (select deposit_cents from public.contracts where id = :'wed_contract'),
  current_date - 1, 'REMAINING-REF-SECRET', null, gen_random_uuid(), false);
select tests.su();
select tests.force_book(tests.id('re_party'));
select tests.force_book(tests.id('re_other'));
create temp table contractual as
  select (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract') as contract,
         (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('re_wed')) as booking,
         (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('re_wed')) as payments,
         (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')) as proposal,
         (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('re_wed'))) as imports,
         (select structure_version from public.event_plans where event_id = tests.id('re_wed')) as structure;

create function tests.entry(name text, extra jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', tests.id('entry-' || name)) || extra;
$$;
create function tests.reqs2(result jsonb, item_key text) returns text[] language sql immutable as $$
  select array_agg((q ->> 'key') || ':' || (q ->> 'state') || case when (q ->> 'discuss')::boolean then ':discuss' else '' end
                   || coalesce(':' || (q ->> 'note'), '') order by o)
  from jsonb_array_elements(result -> 'progress' -> 'items') i, jsonb_array_elements(i -> 'requirements') with ordinality as x(q, o)
  where i ->> 'key' = item_key;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Staff add the library's Guest arrival and Speeches and program stages with their detail moments.
select tests.login_as(tests.id('staff_a'));
select public.add_event_plan_item(tests.id('re_wed'), tests.version('re_wed'), 'arrival', null);
select public.add_event_plan_item(tests.id('re_wed'), tests.version('re_wed'), 'arrival_details', 'arrival');
select public.add_event_plan_item(tests.id('re_wed'), tests.version('re_wed'), 'program', null);
select public.add_event_plan_item(tests.id('re_wed'), tests.version('re_wed'), 'program_details', 'program');
select tests.su();

-- ===========================================================================
-- Library
-- ===========================================================================
select is((select array_agg(key || ':' || editor order by library_order) from private.planning_library() where editor in ('arrival', 'program', 'activities', 'dedications')),
  array['arrival_details:arrival', 'program_details:program', 'dinner_activities:activities', 'dedications:dedications', 'party_activities:activities'],
  'the five editors sit in their library places; Dinner and Party share the activities editor');
select is((select array_agg(key order by library_order) from private.planning_library() where editor is null),
  array['arrival', 'program', 'special_dances'], 'only stages that hold moments have no editor of their own');
select tests.view('re_wed') as v0 \gset
select ok(not exists (select 1 from jsonb_array_elements(:'v0'::jsonb -> 'progress' -> 'items') i where i ->> 'state' = 'not_available'), 'nothing in the plan is "not available"');
select is(tests.reqs2(:'v0'::jsonb, 'arrival_details'), array['location:unanswered', 'arrival_time:unanswered'], 'arrival needs a location and a time');

-- ===========================================================================
-- Arrival details
-- ===========================================================================
select is(tests.save('re_wed', 'arrival_details', '{"location_source":"ceremony","time_source":"ceremony","start_time":"15:00","welcome":" Drinks on the terrace "}') -> 'answers',
  '{"location_source":"ceremony","time_source":"ceremony","welcome":"Drinks on the terrace"}'::jsonb, 'reusing the ceremony time stores no copy of a time');
select is(tests.reqs2(tests.view('re_wed'), 'arrival_details'), array['location:unanswered:ceremony_missing', 'arrival_time:unanswered:ceremony_missing'],
  'reuse stays open while the Ceremony lacks it');
select tests.save('re_wed', 'ceremony', '{"location_source":"other","location_other":"Chapel Sainte-Anne","guest_arrival_time":"15:30","start_time":"16:00"}');
select is(tests.reqs2(tests.view('re_wed'), 'arrival_details'), array['location:answered', 'arrival_time:answered'], 'and resolves once the Ceremony has them');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('re_wed', 'ceremony'), tests.version('re_wed'), false);
select tests.su();
select is(tests.reqs2(tests.view('re_wed'), 'arrival_details'), array['location:unanswered:ceremony_missing', 'arrival_time:unanswered:ceremony_missing'],
  'a hidden Ceremony can''t be reused');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('re_wed', 'ceremony'), tests.version('re_wed'), true);
select tests.su();
select is(tests.save('re_wed', 'arrival_details', '{"location_source":"other","location_other":"Garden","time_source":"time","start_time":"23:30","end_time":"00:15"}') ->> 'message',
  'The end must be after the start. If it ends after midnight, check "Next day".', 'an end before the start needs "next day"');
select is(tests.reqs2(tests.save('re_wed', 'arrival_details', '{"location_source":"other","location_other":"Garden","time_source":"time","start_time":"23:30","end_time":"00:15","end_next_day":true,"announcement":"Welcome!"}'), 'arrival_details'),
  array['location:answered', 'arrival_time:answered'], 'another place and an overnight time with next day complete it');
select is(tests.reqs2(tests.save('re_wed', 'arrival_details', '{"location_source":"event_venue","time_source":"time","start_time":"15:00"}'), 'arrival_details'),
  array['location:unanswered:venue_unknown', 'arrival_time:answered'], 'the event venue stays open while no venue is known');
select is(tests.save('re_wed', 'arrival_details', '{"arrival_none":true,"location_source":"other","location_other":"Garden"}') ->> 'field', 'arrival_none',
  '"No separate arrival arrangements" is refused while details are filled in');
select is(tests.reqs2(tests.save('re_wed', 'arrival_details', '{"arrival_none":true,"welcome":"Straight to the ceremony"}'), 'arrival_details'),
  array['location:not_applicable', 'arrival_time:not_applicable'], 'alone it completes arrival as not applicable');

-- ===========================================================================
-- Program details
-- ===========================================================================
select is(tests.save('re_wed', 'program_details', '{"start_time":"19:00","end_time":"18:00"}') ->> 'field', 'end_time', 'the program''s own times use the stage time rules');
select tests.save('re_wed', 'program_details', jsonb_build_object('start_time', '19:00', 'host', 'Kiara', 'host_pronunciation', 'kee-AR-ah', 'entries', jsonb_build_array(
  tests.entry('p1', '{"title":"Welcome","timing":"time","time":"19:00","duration":5,"presenter":"Kiara"}'),
  tests.entry('p2', '{"title":"Slideshow","timing":"cue","cue":"After the main course","time":"20:00"}'),
  tests.entry('p3', '{"title":"Late surprise","timing":"time","time":"00:30","next_day":true}'),
  tests.entry('p4', '{"title":"Video message","timing":"undecided"}')))) as s \gset pr_
select is(:'pr_s'::jsonb ->> 'status', 'saved', 'an agenda with exact, overnight, cue and undecided timings saves');
select is((select array_agg(coalesce(e ->> 'time', '') || '|' || coalesce(e ->> 'next_day', '') || '|' || coalesce(e ->> 'cue', '') order by o)
           from jsonb_array_elements(:'pr_s'::jsonb -> 'answers' -> 'entries') with ordinality x(e, o)),
  array['19:00||', '||After the main course', '00:30|true|', '||'], 'only each entry''s chosen timing is kept');
select is(tests.reqs2(:'pr_s'::jsonb, 'program_details'), array['program:unanswered:entry_timing_open'], 'an undecided timing keeps the program open');
select is(tests.reqs2(tests.save('re_wed', 'program_details', jsonb_set(tests.stored('re_wed', 'program_details'), '{entries,3}',
  tests.entry('p4', '{"title":"Video message","timing":"cue","cue":"Before dessert"}'))), 'program_details'), array['program:answered'], 'resolved timings complete it');
select is(tests.save('re_wed', 'program_details', jsonb_build_object('entries', jsonb_build_array(tests.entry('p1', '{"timing":"cue","cue":"x"}')))) ->> 'message',
  'Enter the name or names.', 'agenda items need a title');
select is(tests.save('re_wed', 'program_details', tests.stored('re_wed', 'program_details') || '{"choice":"none"}') ->> 'field', 'choice',
  '"No formal program" is refused while the agenda has entries');
select is(tests.reqs2(tests.save('re_other', 'dinner_activities', '{"choice":"discuss"}'), 'dinner_activities'), array['activities:unanswered:discuss'], '"discuss" stays open');

-- ===========================================================================
-- Activities (Dinner and Party share the editor)
-- ===========================================================================
select is(tests.save('re_wed', 'dinner_activities', jsonb_build_object('entries', jsonb_build_array(
  tests.entry('a1', '{"name":"Shoe game","timing":"cue","cue":"Between courses","song_title":"Shoe"}')))) ->> 'field',
  'entry:' || tests.id('entry-a1') || ':song_artist', 'a song needs both title and artist');
select is(tests.save('re_wed', 'dinner_activities', jsonb_build_object('entries', jsonb_build_array(
  tests.entry('a1', '{"name":"Shoe game","timing":"cue","cue":"Between courses","song_title":"Shoe","song_artist":"X","song_link":"http://example.com"}')))) ->> 'field',
  'entry:' || tests.id('entry-a1') || ':song_link', 'song links must be safe https');
select tests.save('re_wed', 'dinner_activities', jsonb_build_object('entries', jsonb_build_array(
  tests.entry('a1', '{"name":"Shoe game","timing":"cue","cue":"Between courses","host":"Kiara","participants":"The couple","duration":10}'),
  tests.entry('a2', '{"name":"Lantern blessing (family tradition)","timing":"time","time":"20:45","pronunciation":"LAN-tern","song_title":"Hallelujah","song_artist":"Jeff Buckley","song_link":"https://example.com/h"}')))) as s \gset ac_
select is(array[:'ac_s'::jsonb ->> 'status', tests.reqs2(:'ac_s'::jsonb, 'dinner_activities')::text], array['saved', '{activities:answered}'],
  'custom and suggested activities with resolved timing complete them; songs and hosts are optional');
select is(tests.reqs2(tests.save('re_wed', 'party_activities', jsonb_build_object('entries', jsonb_build_array(
  tests.entry('b1', '{"name":"Bouquet toss","timing":"undecided"}')))), 'party_activities'), array['activities:unanswered:entry_timing_open'], 'the Party''s activities are counted on their own');
select is(tests.save('re_wed', 'party_activities', '{"choice":"none"}', 'client_y', 0) ->> 'status', 'conflict', 'a stale tab''s save conflicts');
select is(jsonb_array_length(tests.stored('re_wed', 'party_activities') -> 'entries'), 1, 'and changes nothing');
select is(tests.save('re_wed', 'party_activities', '{"cutoff":"23:00"}') ->> 'field', 'cutoff', 'unknown fields are refused');

-- ===========================================================================
-- Dedications
-- ===========================================================================
select tests.save('re_wed', 'dedications', jsonb_build_object('entries', jsonb_build_array(
  tests.entry('d1', '{"recipient":"Our grandparents","relationship":"Grandparents","message":"For 60 years together","timing":"anytime"}'),
  tests.entry('d2', '{"recipient":"The Nguyen-Roy family","pronunciation":"NWEN-rwah","timing":"undecided","song_title":"Lovely Day","song_artist":"Bill Withers"}')))) as s \gset de_
select is(:'de_s'::jsonb ->> 'status', 'saved', 'unfinished dedications are kept as entered');
select is(:'de_s'::jsonb -> 'answers' -> 'entries' -> 0 ? 'song_title', false, 'no song is invented');
select is(tests.reqs2(:'de_s'::jsonb, 'dedications'), array['dedications:unanswered:dedication_open'], 'a missing song or timing keeps dedications open');
select is(tests.reqs2(tests.save('re_wed', 'dedications', jsonb_build_object('entries', jsonb_build_array(
  tests.entry('d1', '{"recipient":"Our grandparents","timing":"anytime","song_title":"Moon River","song_artist":"Andy Williams"}'),
  tests.entry('d2', '{"recipient":"The Nguyen-Roy family","timing":"time","time":"23:00","song_title":"Lovely Day","song_artist":"Bill Withers"}')))), 'dedications'),
  array['dedications:answered'], 'each with a song and a timing (any time counts) completes them');
select is(tests.save('re_wed', 'dedications', jsonb_build_object('entries', jsonb_build_array(tests.entry('d1', '{"recipient":"X","timing":"anytime","duration":3}')))) ->> 'status',
  'invalid', 'dedications have no duration');
select is(tests.reqs2(tests.save('re_other', 'dedications', '{"choice":"none"}'), 'dedications'), array['dedications:not_applicable'], '"No dedications" alone is not applicable');

-- ===========================================================================
-- Retries, stale tabs, hidden sections, access and archiving
-- ===========================================================================
select tests.rev('re_wed', 'dedications') as d_rev \gset
select tests.stored('re_wed', 'dedications') || jsonb_build_object('entries', (tests.stored('re_wed', 'dedications') -> 'entries')
  || jsonb_build_array(tests.entry('d3', '{"recipient":"Team Lee","timing":"cue","cue":"Last hour","song_title":"Jump","song_artist":"Van Halen"}'))) as added \gset
select is(tests.save('re_wed', 'dedications', :'added'::jsonb) ->> 'status', 'saved', 'a dedication is added');
select is(array[tests.save('re_wed', 'dedications', :'added'::jsonb, 'client_y', :d_rev) ->> 'status', jsonb_array_length(tests.stored('re_wed', 'dedications') -> 'entries')::text],
  array['saved', '3'], 'a retried add with the old revision is saved once');
select is(tests.save('re_wed', 'dedications', '{"choice":"discuss"}', 'client_y', :d_rev) ->> 'status', 'conflict', 'a stale different save conflicts');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('re_wed', 'program'), tests.version('re_wed'), false);
select tests.su();
select is(tests.save('re_wed', 'program_details', '{"choice":"discuss"}') ->> 'status', 'unavailable', 'a hidden stage''s moments can''t be saved');
select ok(tests.state(tests.view('re_wed'), 'program_details') is null and jsonb_array_length(tests.stored('re_wed', 'program_details') -> 'entries') = 4,
  'they leave progress and keep their answers');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('re_wed', 'program'), tests.version('re_wed'), true);
select tests.su();
select is(tests.state(tests.view('re_wed'), 'program_details'), 'complete', 'restoring brings them back');
select is(tests.save('re_wed', 'dedications', '{"choice":"none"}', 'client_x') ->> 'status', 'unavailable', 'another client can''t save');
select tests.item('re_other', 'dedications') as other_ded \gset it_
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('re_wed'), 'test-bouprod', :'it_other_ded', 1, '{"choice":"discuss"}') ->> 'status', 'unavailable',
  'a moment of another event can''t be saved through this one');
select tests.su();
select tests.login_as(tests.id('owner_b'));
select throws_ok(format('select public.staff_save_plan_item(%L, %L, 0, %L)', tests.id('re_wed'), tests.item('re_wed', 'dinner_activities'), '{}'), 'P0002', 'not found',
  'other businesses can''t save');
select tests.su();
select tests.item('re_wed', 'arrival_details') as arr \gset it_
select tests.login_as_anon();
select throws_ok(format('select public.client_save_plan_item(%L, %L, %L, 0, %L)', tests.id('re_wed'), 'test-bouprod', :'it_arr', '{}'), '42501', null, 'anon has no access');
select tests.su();
select tests.login_as(tests.id('staff_a'));
select is(public.staff_save_plan_item(tests.id('re_wed'), tests.item('re_wed', 'arrival_details'), tests.rev('re_wed', 'arrival_details'),
  '{"arrival_none":true}') ->> 'status', 'saved', 'staff can edit');
select public.set_event_archived(tests.id('re_wed'), true);
select throws_like(format('select public.staff_save_plan_item(%L, %L, %s, %L)', tests.id('re_wed'), tests.item('re_wed', 'arrival_details'), tests.rev('re_wed', 'arrival_details'), '{}'),
  '%archived%', 'archived events refuse staff edits');
select tests.su();
select is(tests.save('re_wed', 'dedications', '{"choice":"discuss"}') ->> 'status', 'unavailable', 'and client edits');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('re_wed'), false);
select tests.su();
select tests.view('re_wed') as v \gset final_
select unalike(:'final_v'::text, '%' || tests.id('staff_a') || '%', 'the client view has no staff identities');
select unalike(:'final_v'::text, '%REMAINING SECRET NOTE%', 'no internal notes');
select unalike(:'final_v'::text, '%REMAINING-REF-SECRET%', 'no payment references');
select is((select array_agg(s ->> 'key' order by o) from jsonb_array_elements(:'final_v'::jsonb -> 'structure' -> 'stages') with ordinality x(s, o)),
  array['ceremony', 'cocktail', 'reception_entrance', 'dinner', 'special_dances', 'party', 'closing', 'arrival', 'program'], 'times never reorder the stages');

-- ===========================================================================
-- Contractual records
-- ===========================================================================
select is((select contract from contractual), (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract'),
  'the contract is untouched');
select is((select booking from contractual), (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('re_wed')),
  'the booking is untouched');
select is((select payments from contractual), (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('re_wed')),
  'payments are untouched');
select is((select proposal from contractual),
  (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')), 'the proposal is untouched');
select is((select imports from contractual),
  (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('re_wed'))),
  'imported answers are untouched');

select * from finish();
rollback;
