-- Contacts and vendors, DJ expectations and the Party's music preferences:
-- library placement; the event's client-safe contacts; day-of contact by
-- reference (this event's contacts only, never other events or businesses)
-- or entered, with a phone; contacts leaving the event; vendors with roles,
-- names, checked phones and emails; announcement language read from Event
-- basics, never copied; styles and slow songs; explicit alternatives;
-- retries; hidden sections; access, isolation and archiving; clients and
-- contractual records untouched.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(69);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('contacts-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.new_event(name text, kind text default 'wedding') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, internal_notes)
  values (tests.id(name), tests.id('tenant_a'), name, kind, '2027-09-01', 'CONTACTS SECRET NOTE');
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
select tests.new_event(n, k) from (values ('co_wed', 'wedding'), ('co_party', 'private_party'), ('co_other', 'wedding')) v(n, k);
select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select public.update_planning_template(t.id, t.version, t.name, t.description, 'wedding')
from public.planning_templates t where t.tenant_id = tests.id('tenant_a') and t.starter_key = 'wedding';
select public.setup_event_plan(tests.id('co_party'), (select id from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'simple_party'));
select tests.su();

-- A real booking for co_wed (signed, deposit paid): the Wedding default applies.
select tests.sent_contract('co_wed') as contract \gset wed_
select tests.sign(:'wed_contract');
select tests.login_as(tests.id('staff_a'));
select public.record_event_payment(tests.id('co_wed'), (select deposit_cents from public.contracts where id = :'wed_contract'),
  current_date - 1, 'CONTACTS-REF-SECRET', null, gen_random_uuid(), false);
select tests.su();
select tests.force_book(tests.id('co_party'));
select tests.force_book(tests.id('co_other'));
create temp table contractual as
  select (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract') as contract,
         (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('co_wed')) as booking,
         (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('co_wed')) as payments,
         (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')) as proposal,
         (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('co_wed'))) as imports,
         (select structure_version from public.event_plans where event_id = tests.id('co_wed')) as structure;

create function tests.vendor(name text, extra jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', tests.id('vendor-' || name)) || extra;
$$;
create function tests.reqs2(result jsonb, item_key text) returns text[] language sql immutable as $$
  select array_agg((q ->> 'key') || ':' || (q ->> 'state') || case when (q ->> 'discuss')::boolean then ':discuss' else '' end
                   || coalesce(':' || (q ->> 'note'), '') order by o)
  from jsonb_array_elements(result -> 'progress' -> 'items') i, jsonb_array_elements(i -> 'requirements') with ordinality as x(q, o)
  where i ->> 'key' = item_key;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- A second contact on the wedding, with a phone; Client Y has none on file.
insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id('co_wed'), tests.id('a_client_u'), false, false);
update public.clients set phone = '514 555-0199' where id = tests.id('a_client_u');
create temp table client_rows as select id, name, email, phone, archived_at from public.clients order by id;
create temp table event_client_rows as select * from public.event_clients order by id;

-- ===========================================================================
-- Library and views
-- ===========================================================================
select is((select array_agg(key || ':' || editor order by library_order) from private.planning_library() where editor in ('contacts', 'preferences', 'music_style')),
  array['contacts_vendors:contacts', 'dj_preferences:preferences', 'music_preferences:music_style'], 'the three editors sit on their existing sections');
select tests.view('co_wed') as v \gset v0_
select is((select array_agg((c ->> 'name') || '|' || coalesce(c ->> 'phone', '') order by o) from jsonb_array_elements(:'v0_v'::jsonb -> 'event_contacts') with ordinality x(c, o)),
  array['Client Y (A)|', 'Client U (A)|514 555-0199'], 'the view lists this event''s contacts with name and phone only');
select unalike(:'v0_v'::jsonb ->> 'event_contacts', '%@example.test%', 'without emails');
select is(tests.reqs2(:'v0_v'::jsonb, 'contacts_vendors'), array['day_of:unanswered', 'vendors:unanswered'], 'contacts start unanswered');
select is(tests.reqs2(:'v0_v'::jsonb, 'dj_preferences'), array['interaction:unanswered', 'language:unanswered:basics_missing', 'lyrics:unanswered', 'requests:unanswered'],
  'preferences need interaction, language (from Event basics), lyrics and requests');
select is(tests.reqs2(:'v0_v'::jsonb, 'music_preferences'), array['style:unanswered', 'slow_songs:unanswered'], 'music preferences need styles and slow songs');

-- ===========================================================================
-- Day-of contact
-- ===========================================================================
select is(tests.reqs2(tests.save('co_wed', 'contacts_vendors', '{"day_of_source":"undecided"}'), 'contacts_vendors'),
  array['day_of:unanswered:not_decided', 'vendors:unanswered'], '"not decided" is explicit and stays open');
select is(tests.reqs2(tests.save('co_wed', 'contacts_vendors', '{"day_of_source":"other","day_of_name":" Morgan Lee "}'), 'contacts_vendors'),
  array['day_of:unanswered:phone_missing', 'vendors:unanswered'], 'someone else needs a phone');
select is(tests.save('co_wed', 'contacts_vendors', '{"day_of_source":"other","day_of_name":"Morgan","day_of_phone":"call me"}') ->> 'field', 'day_of_phone',
  'phones are checked');
select tests.save('co_wed', 'contacts_vendors', '{"day_of_source":"other","day_of_name":" Morgan Lee ","day_of_phone":"+1 (514) 555-0142","day_of_role":"Maid of honour"}') as s \gset d1_
select is(array[tests.reqs2(:'d1_s'::jsonb, 'contacts_vendors')::text, :'d1_s'::jsonb -> 'answers' ->> 'day_of_name'],
  array['{day_of:answered,vendors:unanswered}', 'Morgan Lee'], 'a named contact with a phone answers it');
select is(tests.reqs2(tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_u'))), 'contacts_vendors'),
  array['day_of:answered', 'vendors:unanswered'], 'an event contact with a phone on file answers it');
select is(tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_u'), 'day_of_name', 'Ignored')) -> 'answers',
  jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_u')), 'a reference stores only the id, never a copy of the person');
select is(tests.reqs2(tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_y'))), 'contacts_vendors'),
  array['day_of:unanswered:phone_missing', 'vendors:unanswered'], 'an event contact without a phone on file stays open');
select is(tests.reqs2(tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_y'), 'day_of_phone', '514-555-0111')), 'contacts_vendors'),
  array['day_of:answered', 'vendors:unanswered'], 'a phone for the day completes it');
select is((select phone from public.clients where id = tests.id('a_client_y')), null, 'without changing the client''s own details');
select is(tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_x'))) ->> 'message',
  'That contact isn''t on this event any more. Choose another contact or enter someone.', 'a contact of another event of the same business is refused');
select is(tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('b_client_x'))) ->> 'field',
  'day_of_client_id', 'a contact of another business is refused');
select is(tests.save('co_wed', 'contacts_vendors', '{"day_of_source":"event_contact","day_of_client_id":"Client U"}') ->> 'status', 'invalid', 'names are never matched: only ids');
select is(tests.stored('co_wed', 'contacts_vendors') ->> 'day_of_client_id', tests.id('a_client_y')::text, 'nothing invalid was stored');
-- The referenced contact leaves the event (archived by staff): kept, shown as unavailable, not resaved.
select tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_u')));
update public.clients set archived_at = now() where id = tests.id('a_client_u');
select is(tests.reqs2(tests.view('co_wed'), 'contacts_vendors'), array['day_of:unanswered:contact_unavailable', 'vendors:unanswered'],
  'a contact who is no longer available leaves the requirement open, labelled');
select ok(not (tests.view('co_wed') -> 'event_contacts') @> jsonb_build_array(jsonb_build_object('id', tests.id('a_client_u'))), 'and leaves the contact list');
select is(tests.stored('co_wed', 'contacts_vendors') ->> 'day_of_client_id', tests.id('a_client_u')::text, 'the stored choice is kept');
select is(tests.save('co_wed', 'contacts_vendors', jsonb_build_object('day_of_source', 'event_contact', 'day_of_client_id', tests.id('a_client_u'), 'vendors_choice', 'none')) ->> 'field',
  'day_of_client_id', 'and can''t be saved again until another choice is made');
update public.clients set archived_at = null where id = tests.id('a_client_u');
select tests.save('co_wed', 'contacts_vendors', '{"day_of_source":"other","day_of_name":"Morgan Lee","day_of_phone":"+1 (514) 555-0142"}');

-- ===========================================================================
-- Vendors
-- ===========================================================================
select is(tests.save('co_wed', 'contacts_vendors', tests.stored('co_wed', 'contacts_vendors') || jsonb_build_object('vendors', jsonb_build_array(
  tests.vendor('v1', '{"role":"photographer"}')))) ->> 'message', 'Enter a person''s name or a business name.', 'a vendor needs a name or a business');
select is(tests.save('co_wed', 'contacts_vendors', tests.stored('co_wed', 'contacts_vendors') || jsonb_build_object('vendors', jsonb_build_array(
  tests.vendor('v1', '{"role":"florist","name":"Jo"}')))) ->> 'message', 'Choose a role.', 'roles come from the list');
select is(tests.save('co_wed', 'contacts_vendors', tests.stored('co_wed', 'contacts_vendors') || jsonb_build_object('vendors', jsonb_build_array(
  tests.vendor('v1', '{"role":"photographer","name":"Jo","phone":"12"}')))) ->> 'field', 'entry:' || tests.id('vendor-v1') || ':phone', 'vendor phones are checked when given');
select is(tests.save('co_wed', 'contacts_vendors', tests.stored('co_wed', 'contacts_vendors') || jsonb_build_object('vendors', jsonb_build_array(
  tests.vendor('v1', '{"role":"photographer","name":"Jo","email":"jo@"}')))) ->> 'field', 'entry:' || tests.id('vendor-v1') || ':email', 'and emails');
select tests.save('co_wed', 'contacts_vendors', tests.stored('co_wed', 'contacts_vendors') || jsonb_build_object('vendors', jsonb_build_array(
  tests.vendor('v1', '{"role":"planner","name":" Sasha Roy ","business":"Day-Of Co.","phone":"514 555 0123","email":"sasha@dayof.test","notes":"Cue the DJ for the entrance"}'),
  tests.vendor('v2', '{"role":"photographer","business":"Lumière Photo"}'),
  tests.vendor('v3', '{"role":"musician","name":"String quartet","phone":"","email":""}')))) as s \gset v1_
select is(array[:'v1_s'::jsonb ->> 'status', tests.reqs2(:'v1_s'::jsonb, 'contacts_vendors')::text], array['saved', '{day_of:answered,vendors:answered}'],
  'vendors save; missing optional phones and emails never block');
select is((select array_agg((v ->> 'role') || '|' || coalesce(v ->> 'name', '') || '|' || coalesce(v ->> 'business', '') order by o)
           from jsonb_array_elements(:'v1_s'::jsonb -> 'answers' -> 'vendors') with ordinality x(v, o)),
  array['planner|Sasha Roy|Day-Of Co.', 'photographer||Lumière Photo', 'musician|String quartet|'], 'in order, trimmed, empty fields dropped');
select is(tests.save('co_wed', 'contacts_vendors', tests.stored('co_wed', 'contacts_vendors') || '{"vendors_choice":"none"}') ->> 'field', 'vendors_choice',
  '"No additional vendor contacts" is refused while vendors are listed');
select is(tests.reqs2(tests.save('co_party', 'contacts_vendors', '{"vendors_choice":"none","day_of_source":"undecided"}'), 'contacts_vendors'), null,
  'a Simple Party has no contacts section unless staff add it');
select tests.rev('co_wed', 'contacts_vendors') as c_rev \gset
select tests.stored('co_wed', 'contacts_vendors') || jsonb_build_object('vendors', (tests.stored('co_wed', 'contacts_vendors') -> 'vendors')
  || jsonb_build_array(tests.vendor('v4', '{"role":"caterer","business":"Bouchée"}'))) as added \gset
select is(tests.save('co_wed', 'contacts_vendors', :'added'::jsonb) ->> 'status', 'saved', 'a vendor is added');
select is(array[tests.save('co_wed', 'contacts_vendors', :'added'::jsonb, 'client_y', :c_rev) ->> 'status', jsonb_array_length(tests.stored('co_wed', 'contacts_vendors') -> 'vendors')::text],
  array['saved', '4'], 'a retried add with the old revision is saved once');
select is(tests.save('co_wed', 'contacts_vendors', '{"vendors_choice":"none"}', 'client_y', :c_rev) ->> 'status', 'conflict', 'a stale different save conflicts');

-- ===========================================================================
-- DJ expectations: language from Event basics only
-- ===========================================================================
select is(tests.save('co_wed', 'dj_preferences', '{"interaction":"interactive","language":"english"}') ->> 'field', 'language',
  'no copy of the announcement language is stored here');
select tests.save('co_wed', 'dj_preferences', '{"interaction":"interactive","lyrics":"clean","requests":"welcome","atmosphere":"  Elegant, then a full dance floor ","notes":""}') as s \gset p1_
select is(array[tests.reqs2(:'p1_s'::jsonb, 'dj_preferences')::text, :'p1_s'::jsonb -> 'answers' ->> 'atmosphere'],
  array['{interaction:answered,language:unanswered:basics_missing,lyrics:answered,requests:answered}', 'Elegant, then a full dance floor'],
  'interaction, lyrics and requests answered; the language waits for Event basics');
select tests.save('co_wed', 'basics', '{"announcement_language":"bilingual"}');
select is(tests.state(tests.view('co_wed'), 'dj_preferences'), 'complete', 'once Event basics has the language, preferences are complete');
select is(tests.reqs2(tests.save('co_wed', 'dj_preferences', '{"interaction":"discuss","lyrics":"discuss","requests":"discuss"}'), 'dj_preferences'),
  array['interaction:unanswered:discuss', 'language:answered', 'lyrics:unanswered:discuss', 'requests:unanswered:discuss'], '"discuss" stays open');
select is(tests.save('co_wed', 'dj_preferences', '{"lyrics":"sometimes"}') ->> 'message', 'Choose an option from the list.', 'choices come from the lists');
select is(tests.save('co_wed', 'dj_preferences', '{"age_range":"30s"}') ->> 'field', 'age_range', 'no other questions are accepted');

-- ===========================================================================
-- Party music preferences
-- ===========================================================================
select is(tests.save('co_wed', 'music_preferences', '{"genres":["pop","rock","pop"],"other_style":" Afrobeats ","slow_songs":"a_few","favorite_artists":"Daft Punk"}') -> 'answers',
  '{"genres":["pop","rock"],"other_style":"Afrobeats","slow_songs":"a_few","favorite_artists":"Daft Punk"}'::jsonb, 'styles are kept once, in the list order');
select is(tests.state(tests.view('co_wed'), 'music_preferences'), 'complete', 'styles and a slow-song choice complete it');
select is(tests.save('co_wed', 'music_preferences', '{"genres":["polka"]}') ->> 'message', 'Choose styles from the list.', 'unknown styles are refused');
select is(tests.save('co_wed', 'music_preferences', '{"genres":["pop"],"style_choice":"dj_choice"}') ->> 'field', 'style_choice',
  '"DJ''s choice" is refused while styles are picked');
select is(tests.reqs2(tests.save('co_wed', 'music_preferences', '{"style_choice":"dj_choice","slow_songs":"discuss"}'), 'music_preferences'),
  array['style:answered', 'slow_songs:unanswered:discuss'], '"DJ''s choice" needs no styles; slow songs to discuss stay open');
select is(tests.reqs2(tests.save('co_wed', 'music_preferences', '{"other_style":"Afrobeats","slow_songs":"none"}'), 'music_preferences'),
  array['style:answered', 'slow_songs:answered'], 'another style alone answers it');
select is(tests.save('co_wed', 'music_preferences', '{"songs":[]}') ->> 'field', 'songs', 'specific songs stay in Must play and Do not play');

-- ===========================================================================
-- Hidden sections, access and archiving
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('co_wed', 'contacts_vendors'), tests.version('co_wed'), false);
select tests.su();
select is(tests.save('co_wed', 'contacts_vendors', '{"vendors_choice":"none"}') ->> 'status', 'unavailable', 'a hidden section can''t be saved');
select ok(tests.state(tests.view('co_wed'), 'contacts_vendors') is null and not (tests.view('co_wed') -> 'moments' ? tests.item('co_wed', 'contacts_vendors')::text),
  'it leaves progress and the view');
select is(jsonb_array_length(tests.stored('co_wed', 'contacts_vendors') -> 'vendors'), 4, 'its vendors are kept');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('co_wed', 'contacts_vendors'), tests.version('co_wed'), true);
select tests.su();
select is(tests.state(tests.view('co_wed'), 'contacts_vendors'), 'complete', 'restoring brings it back, complete');
select is(tests.save('co_wed', 'dj_preferences', '{"interaction":"interactive"}', 'client_x') ->> 'status', 'unavailable', 'another client can''t save');
select tests.item('co_other', 'contacts_vendors') as other_contacts \gset it_
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('co_wed'), 'test-bouprod', :'it_other_contacts', 0, '{"vendors_choice":"none"}') ->> 'status', 'unavailable',
  'a section of another event can''t be saved through this one');
select tests.su();
select tests.login_as(tests.id('owner_b'));
select throws_ok(format('select public.staff_save_plan_item(%L, %L, 0, %L)', tests.id('co_wed'), tests.item('co_wed', 'dj_preferences'), '{}'), 'P0002', 'not found',
  'other businesses can''t save');
select tests.su();
select tests.item('co_wed', 'music_preferences') as mp \gset it_
select tests.login_as_anon();
select throws_ok(format('select public.client_save_plan_item(%L, %L, %L, 0, %L)', tests.id('co_wed'), 'test-bouprod', :'it_mp', '{}'), '42501', null, 'anon has no access');
select tests.su();
select tests.login_as(tests.id('staff_a'));
select is(public.staff_save_plan_item(tests.id('co_wed'), tests.item('co_wed', 'dj_preferences'), tests.rev('co_wed', 'dj_preferences'),
  '{"interaction":"occasional","lyrics":"clean","requests":"not_welcome"}') ->> 'status', 'saved', 'staff can edit');
select public.set_event_archived(tests.id('co_wed'), true);
select throws_like(format('select public.staff_save_plan_item(%L, %L, %s, %L)', tests.id('co_wed'), tests.item('co_wed', 'dj_preferences'), tests.rev('co_wed', 'dj_preferences'), '{}'),
  '%archived%', 'archived events refuse staff edits');
select tests.su();
select is(tests.save('co_wed', 'contacts_vendors', '{}') ->> 'status', 'unavailable', 'and client edits');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('co_wed'), false);
select tests.su();
select tests.view('co_wed') as v \gset final_
select unalike(:'final_v'::text, '%' || tests.id('staff_a') || '%', 'the client view has no staff identities');
select unalike(:'final_v'::text, '%CONTACTS SECRET NOTE%', 'no internal notes');
select unalike(:'final_v'::text, '%CONTACTS-REF-SECRET%', 'no payment references');
select unalike(:'final_v'::text, '%Test Browser%', 'no signing evidence');

-- ===========================================================================
-- Clients and contractual records
-- ===========================================================================
select is((select array_agg(id::text || coalesce(name, '') || coalesce(email, '') || coalesce(phone, '') order by id) from public.clients),
  (select array_agg(id::text || coalesce(name, '') || coalesce(email, '') || coalesce(phone, '') order by id) from client_rows), 'clients are untouched');
select is((select count(*)::int from public.event_clients), (select count(*)::int from event_client_rows), 'event contacts are untouched');
select is((select contract from contractual), (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract'),
  'the contract is untouched');
select is((select booking from contractual), (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('co_wed')),
  'the booking is untouched');
select is((select payments from contractual), (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('co_wed')),
  'payments are untouched');
select is((select proposal from contractual),
  (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')), 'the proposal is untouched');
select is((select imports from contractual),
  (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('co_wed'))),
  'imported answers are untouched');

select * from finish();
rollback;
