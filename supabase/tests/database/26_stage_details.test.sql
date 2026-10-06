-- Stage detail editors: the library's editors and covered moments; client
-- and staff saves with revisions; validation (times, explicit next day,
-- impossible intervals, limits, conflicting choices); completion rules
-- (partial answers, optional fields, not applicable, discuss with DJ, venue
-- and Event basics reuse); chronology warnings in staff order without
-- reordering; overnight events; hidden stages; access, isolation and
-- archiving; contractual records untouched; Event basics entry points kept.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(65);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('stage-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.new_event(name text, kind text default 'wedding') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, internal_notes)
  values (tests.id(name), tests.id('tenant_a'), name, kind, '2027-09-01', 'STAGE SECRET NOTE');
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
-- Client save (client Y) with the current revision.
create function tests.save(event text, item_key text, answers jsonb, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb; v_rev int := tests.rev(event, item_key); v_item uuid := tests.item(event, item_key);
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
-- One item's requirements (from a view or a save result), as key:state[:discuss|:note].
create function tests.reqs(result jsonb, item_key text) returns text[] language sql immutable as $$
  select array_agg((q ->> 'key') || ':' || (q ->> 'state')
                   || case when (q ->> 'discuss')::boolean then ':discuss' else '' end
                   || coalesce(':' || (q ->> 'note'), '') order by o)
  from jsonb_array_elements(result -> 'progress' -> 'items') i, jsonb_array_elements(i -> 'requirements') with ordinality as x(q, o)
  where i ->> 'key' = item_key;
$$;
create function tests.state(result jsonb, item_key text) returns text language sql immutable as $$
  select i ->> 'state' from jsonb_array_elements(result -> 'progress' -> 'items') i where i ->> 'key' = item_key;
$$;
create function tests.warnings(result jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(w ->> 'message' order by o), '{}') from jsonb_array_elements(result -> 'timeline_warnings') with ordinality as x(w, o);
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
select tests.new_event(n, k) from (values ('sd_wed', 'wedding'), ('sd_party', 'private_party'), ('sd_other', 'wedding')) v(n, k);
select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select public.update_planning_template(t.id, t.version, t.name, t.description, 'wedding')
from public.planning_templates t where t.tenant_id = tests.id('tenant_a') and t.starter_key = 'wedding';
select public.setup_event_plan(tests.id('sd_party'), (select id from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'simple_party'));
select tests.su();

-- A real booking for sd_wed (signed, deposit paid): the Wedding default applies.
select tests.sent_contract('sd_wed') as contract \gset wed_
select tests.sign(:'wed_contract');
select tests.login_as(tests.id('staff_a'));
select public.record_event_payment(tests.id('sd_wed'), (select deposit_cents from public.contracts where id = :'wed_contract'),
  current_date - 1, 'STAGE-REF-SECRET', null, gen_random_uuid(), false);
select tests.su();
select tests.force_book(tests.id('sd_party'));
select tests.force_book(tests.id('sd_other'));
create temp table contractual as
  select (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract') as contract,
         (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('sd_wed')) as booking,
         (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('sd_wed')) as payments,
         (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')) as proposal,
         (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('sd_wed'))) as imports;

-- ===========================================================================
-- Library
-- ===========================================================================
select is((select array_agg(key || ':' || editor order by library_order) from private.planning_library() where kind = 'stage' and editor is not null),
  array['ceremony:stage_ceremony', 'cocktail:stage_cocktail', 'reception_entrance:stage_entrance', 'dinner:stage_dinner', 'party:stage_party', 'closing:stage_closing'],
  'six stages have detail editors, keyed by stage key');
select is((select array_agg(key order by library_order) from private.planning_library() where editor = 'stage_details'),
  array['ceremony_details', 'cocktail_details', 'dinner_details', 'closing_instructions'], 'the moments they cover are marked as included');
select is(tests.state(tests.view('sd_wed'), 'ceremony_details'), null, 'covered moments are not counted on their own');
select is(tests.state(tests.view('sd_wed'), 'special_dances'), null, 'stages that only hold moments aren''t counted themselves');
select is(tests.state(tests.view('sd_wed'), 'ceremony'), 'not_started', 'nothing saved: not started');

-- ===========================================================================
-- Saving, validation and completion
-- ===========================================================================
select is(tests.save('sd_wed', 'ceremony', '{"start_time":"16:00","end_time":"15:30"}') ->> 'message',
  'The end must be after the start. If it ends after midnight, check "Next day".', 'an end before the start is refused, never assumed overnight');
select is(tests.save('sd_wed', 'ceremony', '{"start_time":"16:00","end_time":"16:00"}') ->> 'field', 'end_time', 'equal start and end are refused');
select is(tests.save('sd_wed', 'ceremony', '{"start_time":"4pm"}') ->> 'message', 'Enter a time such as 18:30.', 'malformed times are refused');
select is(tests.save('sd_wed', 'ceremony', '{"microphones":"maybe"}') ->> 'message', 'Choose an option from the list.', 'unknown choices are refused');
select is(tests.save('sd_wed', 'ceremony', '{"officiant_name":"x"}' ::jsonb || jsonb_build_object('instructions', repeat('a', 2001))) ->> 'field',
  'instructions', 'text limits are enforced');
select is(tests.save('sd_wed', 'ceremony', '{"songs":"x"}') ->> 'status', 'invalid', 'unknown fields are refused');
select is(tests.save('sd_wed', 'ceremony', '{"start_time":"16:00","start_next_day":"yes"}') ->> 'status', 'invalid', 'next-day marks are booleans');
select is(tests.rev('sd_wed', 'ceremony'), 0, 'nothing invalid was stored');

select tests.save('sd_wed', 'ceremony', '{"location_source":"event_venue","start_time":"16:00","guest_arrival_time":"15:30","end_next_day":true,"officiant_name":"  "}') as s \gset c1_
select is(array[:'c1_s'::jsonb ->> 'status', :'c1_s'::jsonb ->> 'revision'], array['saved', '1'], 'partial answers save');
select is(:'c1_s'::jsonb -> 'answers', '{"location_source":"event_venue","start_time":"16:00","guest_arrival_time":"15:30"}'::jsonb,
  'normalized: blank text and a next-day mark without its time are dropped');
select is(tests.reqs(:'c1_s'::jsonb, 'ceremony'), array['location:unanswered:venue_unknown', 'start_time:answered', 'microphones:unanswered'],
  '"same as the event venue" stays open while no venue is known');
select is(tests.state(:'c1_s'::jsonb, 'ceremony'), 'in_progress', 'partly answered: in progress');
-- Event basics' venue resolves it, without entering the address again.
select tests.save('sd_wed', 'basics', '{"venue_details":"Domaine du Lac, 2 Rue du Lac"}');
select is(tests.reqs(tests.view('sd_wed'), 'ceremony'), array['location:answered', 'start_time:answered', 'microphones:unanswered'],
  'Event basics'' venue satisfies "same as the event venue"');
select is(tests.reqs(tests.save('sd_wed', 'ceremony', '{"location_source":"event_venue","start_time":"16:00","microphones":"discuss"}'), 'ceremony'),
  array['location:answered', 'start_time:answered', 'microphones:unanswered:discuss'], '"discuss with DJ" stays open and is labelled as such');
select tests.save('sd_wed', 'ceremony', '{"location_source":"event_venue","start_time":"16:00","microphones":"needed"}') as s \gset c2_
select is(tests.state(:'c2_s'::jsonb, 'ceremony'), 'complete', 'location, start time and microphone needs complete the ceremony; optional fields don''t block');
select is(tests.save('sd_wed', 'ceremony', '{"start_time":"16:00"}', 'client_y') ->> 'status', 'saved', 'the same tab saves again with its revision');
select tests.item('sd_wed', 'ceremony') as ceremony, tests.item('sd_other', 'ceremony') as other_ceremony \gset it_
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('sd_wed'), 'test-bouprod', :'it_ceremony', 1, '{}') ->> 'status', 'conflict', 'a stale revision gets a conflict');
select tests.su();
select is((select answers from public.event_plan_responses where item_id = tests.item('sd_wed', 'ceremony')), '{"start_time":"16:00"}'::jsonb,
  'and overwrites nothing');

select is(tests.reqs(tests.save('sd_wed', 'cocktail', '{"location_source":"other"}'), 'cocktail'), array['location:unanswered', 'start_time:unanswered'],
  '"somewhere else" needs the place');
select is(tests.reqs(tests.save('sd_wed', 'cocktail', '{"location_source":"other","location_other":"Garden terrace","start_time":"17:00","atmosphere":"Light jazz"}'), 'cocktail'),
  array['location:answered', 'start_time:answered'], 'cocktail needs a location and a start time');

select is(tests.save('sd_wed', 'reception_entrance', '{"entrance_time":"19:00","entrance_none":true}') ->> 'field', 'entrance_time',
  'an entrance time and "no formal entrance" together are refused');
select is(tests.reqs(tests.save('sd_wed', 'reception_entrance', '{"guest_entry_time":"18:45","entrance_none":true}'), 'reception_entrance'),
  array['entrance:not_applicable'], '"no formal entrance" is not applicable, which completes it');

select is(tests.save('sd_wed', 'dinner', '{"guest_count_source":"number","guest_count":0}') ->> 'message', 'Enter a whole number from 1 to 5,000.',
  'guest counts are bounded');
select is(tests.reqs(tests.save('sd_wed', 'dinner', '{"location_source":"event_venue","start_time":"19:30","guest_count_source":"basics"}'), 'dinner'),
  array['location:answered', 'start_time:answered', 'guest_count:unanswered:basics_missing'], 'reusing Event basics'' count needs that count');
select tests.save('sd_wed', 'basics', '{"venue_details":"Domaine du Lac, 2 Rue du Lac","guest_count":140,"start_time":"15:00","end_time":"01:00"}');
select is(tests.state(tests.view('sd_wed'), 'dinner'), 'complete', 'once Event basics has it, the reused count completes dinner');

select is(tests.save('sd_wed', 'party', '{"evening_guests":-1}') ->> 'status', 'invalid', 'evening guests can''t be negative');
select is(tests.save('sd_wed', 'party', '{"location_source":"event_venue","start_time":"22:00","end_time":"01:00"}') ->> 'field', 'end_time',
  'a party ending at 01:00 without "next day" is refused');
select tests.save('sd_wed', 'party', '{"location_source":"event_venue","start_time":"22:00","end_time":"01:00","end_next_day":true,"evening_guests":0}') as s \gset p1_
select is(array[:'p1_s'::jsonb ->> 'status', tests.state(:'p1_s'::jsonb, 'party')], array['saved', 'complete'], 'with "next day" it is a valid overnight party');

select is(tests.reqs(tests.save('sd_wed', 'closing', '{"finish_source":"discuss","closing_instructions":"Lights up slowly"}'), 'closing'),
  array['finish:unanswered:discuss'], 'closing "discuss with DJ" stays open');
select is(tests.reqs(tests.save('sd_wed', 'closing', '{"finish_source":"basics_end"}'), 'closing'), array['finish:answered'],
  'the finish can reuse Event basics'' end time');

-- ===========================================================================
-- Chronology: warnings in staff order, nothing reordered
-- ===========================================================================
select tests.save('sd_wed', 'ceremony', '{"location_source":"event_venue","start_time":"16:00","end_time":"17:00","guest_arrival_time":"16:15","microphones":"not_needed"}');
select is(tests.warnings(tests.save('sd_wed', 'cocktail', '{"location_source":"event_venue","start_time":"16:30"}')),
  array['Guest arrival is after the ceremony starts.', 'Cocktail starts before Ceremony ends.'], 'conflicts are flagged, not refused');
select tests.save('sd_wed', 'ceremony', '{"location_source":"event_venue","start_time":"16:00","end_time":"17:00","guest_arrival_time":"15:30","microphones":"not_needed"}');
select tests.save('sd_wed', 'cocktail', '{"location_source":"event_venue","start_time":"17:00","end_time":"18:30"}');
select tests.save('sd_wed', 'reception_entrance', '{"guest_entry_time":"18:45","entrance_time":"19:15"}');
select is(tests.warnings(tests.view('sd_wed')), '{}'::text[], 'an ordered evening crossing midnight (party until 01:00 next day, closing at Event basics'' 01:00) has no warnings');
select tests.save('sd_wed', 'closing', '{"finish_source":"time","finish_time":"00:30","finish_next_day":true}');
select is(tests.warnings(tests.view('sd_wed')), array['The finish time is before Party ends.'], 'a finish before the party ends is flagged');
select tests.save('sd_wed', 'closing', '{"finish_source":"time","finish_time":"01:30","finish_next_day":true}');
select tests.login_as(tests.id('staff_a'));
select public.move_event_plan_item(tests.item('sd_wed', 'cocktail'), tests.version('sd_wed'), 'up');
select tests.su();
select is(tests.warnings(tests.view('sd_wed')), array['Ceremony starts before Cocktail starts.'], 'warnings follow the staff order');
select is((select array_agg(s ->> 'key' order by o) from jsonb_array_elements(tests.view('sd_wed') -> 'structure' -> 'stages') with ordinality x(s, o)),
  array['cocktail', 'ceremony', 'reception_entrance', 'dinner', 'special_dances', 'party', 'closing'], 'times never reorder the stages');
select tests.login_as(tests.id('staff_a'));
select public.move_event_plan_item(tests.item('sd_wed', 'cocktail'), tests.version('sd_wed'), 'down');
select tests.su();

-- ===========================================================================
-- Hidden stages, covered moments and the Simple Party
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('sd_wed', 'cocktail'), tests.version('sd_wed'), false);
select tests.su();
select is(tests.save('sd_wed', 'cocktail', '{"start_time":"17:15"}') ->> 'status', 'unavailable', 'a hidden stage can''t be saved');
select ok(not (tests.view('sd_wed') -> 'stage_details' ? tests.item('sd_wed', 'cocktail')::text), 'its details leave the client view');
select is(tests.state(tests.view('sd_wed'), 'cocktail'), null, 'and progress');
select is((select answers ->> 'start_time' from public.event_plan_responses where item_id = tests.item('sd_wed', 'cocktail')), '17:00', 'its answers are kept');
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('sd_wed', 'cocktail'), tests.version('sd_wed'), true);
select tests.su();
select is(tests.view('sd_wed') -> 'stage_details' -> tests.item('sd_wed', 'cocktail')::text -> 'answers' ->> 'end_time', '18:30', 'restoring brings them back');
select is(tests.save('sd_wed', 'ceremony_details', '{}') ->> 'status', 'unavailable', 'covered moments have nothing of their own to save');
select is(tests.reqs(tests.save('sd_party', 'party', '{"location_source":"event_venue","start_time":"20:00"}'), 'party'),
  array['location:unanswered:venue_unknown', 'start_time:answered'], 'a Simple Party gets the party details too');

-- ===========================================================================
-- Access, isolation and archiving
-- ===========================================================================
select is(tests.save('sd_wed', 'ceremony', '{"start_time":"16:00"}', 'client_x') ->> 'status', 'unavailable', 'another client can''t save');
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_item(tests.id('sd_wed'), 'test-bouprod', :'it_other_ceremony', 0, '{"start_time":"10:00"}') ->> 'status', 'unavailable',
  'an item of another event can''t be saved through this one');
select tests.su();
select is(tests.rev('sd_other', 'ceremony'), 0, 'and stays untouched');
select tests.login_as(tests.id('owner_b'));
select throws_ok(format('select public.staff_save_plan_item(%L, %L, 0, %L)', tests.id('sd_wed'), tests.item('sd_wed', 'party'), '{}'), 'P0002', 'not found',
  'other businesses can''t save');
select tests.su();
select tests.item('sd_wed', 'party') as party \gset it_
select tests.login_as_anon();
select throws_ok(format('select public.client_save_plan_item(%L, %L, %L, 0, %L)', tests.id('sd_wed'), 'test-bouprod', :'it_party', '{}'),
  '42501', null, 'anon has no access');
select tests.su();
select tests.login_as(tests.id('staff_a'));
select is(public.staff_save_plan_item(tests.id('sd_wed'), tests.item('sd_wed', 'party'), tests.rev('sd_wed', 'party'),
  '{"location_source":"other","location_other":"Barn","area":"x"}') ->> 'status', 'invalid', 'staff saves are validated too');
select is(public.staff_save_plan_item(tests.id('sd_wed'), tests.item('sd_wed', 'party'), tests.rev('sd_wed', 'party'),
  '{"location_source":"other","location_other":"Barn","location_area":"Loft","start_time":"22:00","end_time":"01:00","end_next_day":true}') ->> 'status',
  'saved', 'staff can edit stage details');
select public.set_event_archived(tests.id('sd_wed'), true);
select throws_like(format('select public.staff_save_plan_item(%L, %L, %s, %L)', tests.id('sd_wed'), tests.item('sd_wed', 'party'), tests.rev('sd_wed', 'party'), '{}'),
  '%archived%', 'archived events refuse staff edits');
select tests.su();
select is(tests.save('sd_wed', 'party', '{}') ->> 'status', 'unavailable', 'and client edits');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('sd_wed'), false);
select tests.su();
select tests.view('sd_wed') as v \gset final_
select unalike(:'final_v'::text, '%' || tests.id('staff_a') || '%', 'the client view has no staff identities');
select unalike(:'final_v'::text, '%STAGE-REF-SECRET%', 'no payment references');
select unalike(:'final_v'::text, '%STAGE SECRET NOTE%', 'no internal notes');

-- ===========================================================================
-- Contractual records and compatibility
-- ===========================================================================
select is((select contract from contractual), (select array[content_sha256, signed_at::text, status, total_cents::text] from public.contracts where id = :'wed_contract'),
  'the contract is untouched');
select is((select booking from contractual), (select array[booking_confirmed_at::text, lifecycle_status] from public.events where id = tests.id('sd_wed')),
  'the booking is untouched');
select is((select payments from contractual), (select array_agg(amount_cents::text order by id) from public.event_payments where event_id = tests.id('sd_wed')),
  'payments are untouched');
select is((select proposal from contractual),
  (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')), 'the proposal is untouched');
select is((select imports from contractual),
  (select array_agg(id::text || answers::text order by id) from public.event_plan_imports where plan_id = (select id from public.event_plans where event_id = tests.id('sd_wed'))),
  'imported answers are untouched');
select tests.rev('sd_wed', 'basics') as rev \gset basics_
select tests.login_as(tests.id('client_y'));
select is(public.client_save_plan_basics(tests.id('sd_wed'), 'test-bouprod', :basics_rev, '{"guest_count":145}') ->> 'status', 'saved',
  'the Event basics entry point the deployed app calls still works');
select tests.su();

select * from finish();
rollback;
