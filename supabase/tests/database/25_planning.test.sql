-- Planning foundation: template ownership, starters, structure editing with
-- stable keys, duplication and archiving; plan initialization at booking
-- (template default, explicit setup before booking, Event basics fallback,
-- already-booked events, repeats), frozen imports, client access (booked,
-- unbooked, revoked, unverified, wrong event, two DJs, archived, payment
-- corrections), Event basics saves and progress, disabling and restoring,
-- non-destructive template replacement, and isolation.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(148);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('planning-test-' || name)::uuid);
$$;

create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Events in tenant A with client Y as verified signer.
create function tests.new_event(name text, kind text default 'wedding') returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, internal_notes)
  values (tests.id(name), tests.id('tenant_a'), name, kind, '2027-09-01', 'PLAN SECRET NOTE ' || name);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  return tests.id(name);
end $$;

-- Books an event through the same guarded path evaluate_booking uses, for
-- events that need no contract in a given test. The real path is covered
-- below (signing and the deposit payment).
create function tests.force_book(ev uuid) returns void language plpgsql as $$
begin
  perform set_config('flux.booking_event', ev::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = ev;
  perform set_config('flux.booking_event', '', true);
end $$;

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
declare
  v_hash text;
  v_consent text;
  v_path text;
  r jsonb;
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

create function tests.plan_of(event text) returns uuid language sql stable as $$
  select id from public.event_plans where event_id = tests.id(event);
$$;
create function tests.item(event text, item_key text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id
  where p.event_id = tests.id(event) and i.key = item_key;
$$;
create function tests.version(event text) returns int language sql stable as $$
  select structure_version from public.event_plans where event_id = tests.id(event);
$$;
create function tests.tversion(template uuid) returns int language sql stable as $$
  select version from public.planning_templates where id = template;
$$;
create function tests.titem(template uuid, item_key text) returns uuid language sql stable as $$
  select id from public.planning_template_items where template_id = template and key = item_key;
$$;
-- Keys of a client view's stages, in order, and of one stage's moments.
create function tests.stage_keys(view jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(s ->> 'key' order by o), '{}') from jsonb_array_elements(view -> 'structure' -> 'stages') with ordinality as x(s, o);
$$;
create function tests.moment_keys(view jsonb, stage text) returns text[] language sql immutable as $$
  select coalesce(array_agg(m ->> 'key' order by o), '{}')
  from jsonb_array_elements(view -> 'structure' -> 'stages') s, jsonb_array_elements(s -> 'moments') with ordinality as x(m, o)
  where s ->> 'key' = stage;
$$;
create function tests.client_view(who text, event text, slug text default 'test-bouprod') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.client_planning_view(tests.id(event), slug);
  perform tests.su();
  return r;
end $$;
create function tests.client_save(who text, event text, rev int, answers jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.client_save_plan_basics(tests.id(event), 'test-bouprod', rev, answers);
  perform tests.su();
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test', reply_to_email = 'hello@bouprod.test'
where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select tests.new_event(n, k) from (values ('pl_wed', 'wedding'), ('pl_fallback', 'other'), ('pl_early', 'private_party'),
  ('pl_legacy', 'corporate'), ('pl_unbooked', 'wedding')) v(n, k);

-- ===========================================================================
-- Privileges
-- ===========================================================================
select table_privs_are('public', t, 'authenticated', array['SELECT'], t || ': read-only for authenticated (functions write)')
from unnest(array['planning_templates', 'planning_template_items', 'event_plans', 'event_plan_items',
                  'event_plan_responses', 'event_plan_imports']) t;

-- ===========================================================================
-- Templates: starters, ownership, editing with stable keys
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select is(public.install_starter_planning_templates(tests.id('tenant_a')), '{"created":["wedding","simple_party"],"existing":[]}'::jsonb,
  'staff add the starter templates explicitly');
select is(public.install_starter_planning_templates(tests.id('tenant_a')), '{"created":[],"existing":["wedding","simple_party"]}'::jsonb,
  'adding them again changes nothing');
select is((select count(*)::int from public.planning_templates where tenant_id = tests.id('tenant_a')), 2, 'one template per starter');
select su_wed.id as wedding from public.planning_templates su_wed where starter_key = 'wedding' \gset tpl_
select id as party from public.planning_templates where starter_key = 'simple_party' and tenant_id = tests.id('tenant_a') \gset tpl_
select set_config('tests.wedding', :'tpl_wedding', true), set_config('tests.party', :'tpl_party', true);

select is((select array[count(*) filter (where kind = 'general'), count(*) filter (where kind = 'stage'), count(*) filter (where kind = 'moment')]::int[]
           from public.planning_template_items where template_id = :'tpl_wedding'), array[3, 7, 29],
  'Wedding: three general sections, seven stages, 29 moments');
select is((select array_agg(key order by position) from public.planning_template_items where template_id = :'tpl_wedding' and kind = 'stage'),
  array['ceremony', 'cocktail', 'reception_entrance', 'dinner', 'special_dances', 'party', 'closing'], 'Wedding stages follow the day');
select is((select array_agg(i.key order by i.position) from public.planning_template_items i join public.planning_template_items p on p.id = i.parent_id
           where i.template_id = :'tpl_wedding' and p.key = 'special_dances'),
  array['first_dance', 'family_dances', 'other_dances'], 'special dances use inclusive labels and keys');
select is((select label from public.planning_template_items where template_id = :'tpl_wedding' and key = 'family_dances'), 'Family dances',
  'no particular family member is required');
select is((select array_agg(key order by kind, position) from public.planning_template_items where template_id = :'tpl_party'),
  array['basics', 'must_play', 'do_not_play', 'party'], 'Simple Party: basics, a party stage, must play and do not play');
select is((select array_agg(key order by position) from public.planning_template_items where template_id = :'tpl_party' and kind = 'moment'),
  array['must_play', 'do_not_play'], 'must play comes before do not play');

select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.planning_templates where tenant_id = tests.id('tenant_a')), 0, 'other businesses see no templates');
select is((select count(*)::int from public.planning_template_items where tenant_id = tests.id('tenant_a')), 0, 'nor their items');
select throws_ok(format('select public.install_starter_planning_templates(%L)', tests.id('tenant_a')), 'P0002', 'not found', 'nor add starters to them');
select throws_ok(format('select public.rename_planning_template_item(%L, 1, %L)', tests.titem(current_setting('tests.wedding')::uuid, 'party'), 'Mine'),
  'P0002', 'not found', 'nor rename their items');
select throws_ok(format('select public.duplicate_planning_template(%L, %L)', current_setting('tests.wedding'), 'Copy'), 'P0002', 'not found',
  'nor duplicate them');
select tests.login_as(tests.id('client_x'));
select is((select count(*)::int from public.planning_templates), 0, 'clients see no templates');
select tests.login_as(tests.id('staff_a'));
select throws_ok(format('insert into public.planning_templates (tenant_id, name) values (%L, %L)', tests.id('tenant_a'), 'Direct'), '42501', null,
  'no direct inserts');
select throws_ok(format('update public.planning_template_items set label = %L where template_id = %L', 'Direct', :'tpl_wedding'), '42501', null,
  'no direct updates');

select tests.titem(:'tpl_wedding', 'party') as party_item, tests.tversion(:'tpl_wedding') as v0 \gset w_
select is(public.rename_planning_template_item(:'w_party_item', :w_v0, '  Dance party '), :w_v0 + 1, 'renaming bumps the template version');
select is((select array[key, label] from public.planning_template_items where id = :'w_party_item'), array['party', 'Dance party'],
  'the label changes (trimmed); the key and id do not');
select throws_ok(format('select public.rename_planning_template_item(%L, %s, %L)', :'w_party_item', :w_v0, 'Stale'), '40001', null,
  'a stale tab gets a conflict');
select public.move_planning_template_item(tests.titem(:'tpl_wedding', 'cocktail'), tests.tversion(:'tpl_wedding'), 'up');
select is((select array_agg(key order by position) from public.planning_template_items where template_id = :'tpl_wedding' and kind = 'stage'),
  array['cocktail', 'ceremony', 'reception_entrance', 'dinner', 'special_dances', 'party', 'closing'], 'Move up reorders stages');
select throws_like(format('select public.move_planning_template_item(%L, %s, %L)', tests.titem(:'tpl_wedding', 'cocktail'), tests.tversion(:'tpl_wedding'), 'up'),
  '%already first%', 'the first stage cannot move up');
select public.move_planning_template_item(tests.titem(:'tpl_wedding', 'cocktail'), tests.tversion(:'tpl_wedding'), 'down');
select throws_like(format('select public.remove_planning_template_item(%L, %s)', tests.titem(:'tpl_wedding', 'basics'), tests.tversion(:'tpl_wedding')),
  '%Event basics is part of every template%', 'Event basics cannot be removed');
select throws_like(format('select public.add_planning_template_item(%L, %s, %L, %L)', :'tpl_party', tests.tversion(:'tpl_party'), 'first_dance', 'party'),
  '%stage it belongs to%', 'a moment only goes under a stage it belongs to');
select lives_ok(format('select public.add_planning_template_item(%L, %s, %L, %L)', :'tpl_party', tests.tversion(:'tpl_party'), 'cake_cutting', 'party'),
  'moments that fit the stage can be added');
select throws_like(format('select public.add_planning_template_item(%L, %s, %L, null)', :'tpl_party', tests.tversion(:'tpl_party'), 'party'),
  '%already in the template%', 'an item appears once per template');
select throws_like(format('select public.add_planning_template_item(%L, %s, %L, null)', :'tpl_party', tests.tversion(:'tpl_party'), 'karaoke_machine'),
  '%from the library%', 'only library items can be added');
select public.remove_planning_template_item(tests.titem(:'tpl_party', 'cake_cutting'), tests.tversion(:'tpl_party'));

-- Duplicate and archive.
select public.duplicate_planning_template(:'tpl_wedding', 'Wedding (French)') as copy \gset tpl_
select is((select array_agg(key order by key) from public.planning_template_items where template_id = :'tpl_copy'),
          (select array_agg(key order by key) from public.planning_template_items where template_id = :'tpl_wedding'), 'a copy has the same keys');
select is((select count(*)::int from public.planning_template_items c join public.planning_template_items o on o.id = c.id
           where c.template_id = :'tpl_copy' and o.template_id = :'tpl_wedding'), 0, 'with its own item ids');
select is((select array[name, coalesce(starter_key, 'none')] from public.planning_templates where id = :'tpl_copy'), array['Wedding (French)', 'none'],
  'and is not a starter');
select is((select label from public.planning_template_items where template_id = :'tpl_copy' and key = 'party'), 'Dance party', 'labels are copied');
select public.set_planning_template_archived(:'tpl_copy', true);
select throws_like(format('select public.rename_planning_template_item(%L, %s, %L)', tests.titem(:'tpl_copy', 'party'), tests.tversion(:'tpl_copy'), 'X'),
  '%archived%', 'archived templates cannot be edited');
select public.set_planning_template_archived(:'tpl_copy', false);
select lives_ok(format('select public.rename_planning_template_item(%L, %s, %L)', tests.titem(:'tpl_copy', 'party'), tests.tversion(:'tpl_copy'), 'Soirée'),
  'unarchived templates can be edited again');

-- Explicit event-type defaults.
select public.update_planning_template(:'tpl_wedding', tests.tversion(:'tpl_wedding'), 'Wedding', 'Our wedding outline', 'wedding');
select throws_like(format('select public.update_planning_template(%L, %s, %L, null, %L)', :'tpl_copy', tests.tversion(:'tpl_copy'), 'Copy', 'wedding'),
  '%already the default for that event type%', 'one default template per event type');
select tests.su();
select throws_ok(format('insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position) values (%L, %L, %L, %L, %L, %L, 9)',
  tests.id('tenant_a'), :'tpl_wedding', 'moment', 'final_song', tests.titem(:'tpl_wedding', 'party'), 'Final song'), '23514', null,
  'the library decides where moments go, even for privileged writers');

-- ===========================================================================
-- Initialization at booking
-- ===========================================================================
-- Real booking: signed, then the deposit recorded.
select tests.sent_contract('pl_wed') as contract \gset wed_
select is(tests.sign(:'wed_contract') ->> 'status', 'signed', 'the client signs');
select is(tests.plan_of('pl_wed'), null, 'no plan before the booking');
select tests.login_as(tests.id('staff_a'));
select public.record_event_payment(tests.id('pl_wed'), (select deposit_cents from public.contracts where id = :'wed_contract'),
  current_date - 1, 'REF-PLAN-SECRET', 'staff note', gen_random_uuid(), false) ->> 'booking' as booking \gset wed_
select tests.su();
select is(:'wed_booking'::text, 'booked', 'the deposit books the event');
select isnt(tests.plan_of('pl_wed'), null, 'booking created the plan in the same transaction');
select is((select array[origin, initialized_via, source_template_id::text] from public.event_plans where event_id = tests.id('pl_wed')),
  array['template', 'booking', :'tpl_wedding'::text], 'from the template staff made the default for weddings');
select is((select array_agg(key || ':' || label order by key) from public.event_plan_items where plan_id = tests.plan_of('pl_wed')),
          (select array_agg(key || ':' || label order by key) from public.planning_template_items where template_id = :'tpl_wedding'),
  'a copy of the template''s items and labels');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('pl_wed') and action = 'planning_initialized'), 1, 'audited once');

-- Template edits never reach an existing plan.
select tests.login_as(tests.id('owner_a'));
select public.rename_planning_template_item(tests.titem(:'tpl_wedding', 'closing'), tests.tversion(:'tpl_wedding'), 'Last call');
select public.remove_planning_template_item(tests.titem(:'tpl_wedding', 'cocktail'), tests.tversion(:'tpl_wedding'));
select tests.su();
select is((select array[label, coalesce(disabled_at::text, 'enabled')] from public.event_plan_items where id = tests.item('pl_wed', 'closing')),
  array['Closing', 'enabled'], 'renaming a template item leaves the plan alone');
select isnt(tests.item('pl_wed', 'cocktail_music'), null, 'removing a template stage leaves the plan''s stage and moments');

-- Fallback: no chosen template and no default for the event type.
select tests.force_book(tests.id('pl_fallback'));
select is((select array[origin, initialized_via] from public.event_plans where event_id = tests.id('pl_fallback')), array['fallback', 'booking'],
  'booking without a template still creates a plan');
select is((select array_agg(key) from public.event_plan_items where plan_id = tests.plan_of('pl_fallback')), array['basics'], 'with Event basics only');
select is((select count(*)::int from public.event_plan_imports where plan_id = tests.plan_of('pl_fallback')), 0,
  'no imports without a signed contract');

-- Set up before booking, with an explicit template.
select tests.login_as(tests.id('staff_a'));
select is(public.setup_event_plan(tests.id('pl_early'), :'tpl_party') ->> 'status', 'created', 'staff can set planning up before booking');
select is(public.setup_event_plan(tests.id('pl_early'), :'tpl_wedding') ->> 'status', 'exists', 'setting up again changes nothing');
select public.rename_event_plan_item(tests.item('pl_early', 'party'), tests.version('pl_early'), 'Birthday party');
select tests.su();
select is(tests.client_view('client_y', 'pl_early') ->> 'state', 'unavailable', 'clients get nothing before the booking');
select tests.force_book(tests.id('pl_early'));
select is((select count(*)::int from public.event_plans where event_id = tests.id('pl_early')), 1, 'booking keeps the existing plan');
select is((select array[p.initialized_via, i.label] from public.event_plans p join public.event_plan_items i on i.plan_id = p.id
           where p.event_id = tests.id('pl_early') and i.key = 'party'), array['staff', 'Birthday party'], 'and its edits');
select is(tests.client_view('client_y', 'pl_early') ->> 'state', 'available', 'clients get access once booked');

-- Repeated initialization and events booked before planning existed.
select is(private.ensure_event_plan(tests.id('pl_wed'), null, 'backfill'), tests.plan_of('pl_wed'), 'initializing again returns the same plan');
select is((select count(*)::int from public.event_plans where event_id = tests.id('pl_wed')), 1, 'never a second plan');
alter table public.events disable trigger events_initialize_planning;
select tests.force_book(tests.id('pl_legacy'));
alter table public.events enable trigger events_initialize_planning;
select is(tests.plan_of('pl_legacy'), null, 'an event booked before planning existed has no plan');
select isnt(private.ensure_event_plan(tests.id('pl_legacy'), null, 'backfill'), null, 'the backfill creates it');
select is((select array[origin, initialized_via] from public.event_plans where event_id = tests.id('pl_legacy')), array['fallback', 'backfill'],
  'as Event basics, recorded as a backfill');

-- ===========================================================================
-- Imported information
-- ===========================================================================
select is((select array[contract_id, proposal_id, selection_id]::text[] from public.event_plan_imports where plan_id = tests.plan_of('pl_wed')),
          (select array[id, proposal_id, selection_id]::text[] from public.contracts where id = :'wed_contract'),
  'imports come from the signed contract''s exact selection');
select is((select array_agg(q ->> 'key' order by o) from public.event_plan_imports i, jsonb_array_elements(i.questions) with ordinality x(q, o)
           where i.plan_id = tests.plan_of('pl_wed')), array['ceremony_location', 'needs_wireless_mic'], 'with the frozen questions');
select is((select answers from public.event_plan_imports where plan_id = tests.plan_of('pl_wed')),
  '{"ceremony_location":"same_room","needs_wireless_mic":false}'::jsonb, 'and the submitted answers');
update public.logistics_questions set prompt = 'Changed wording after signing' where id = tests.id('q_a_ceremony');
select is((tests.client_view('client_y', 'pl_wed') -> 'imported' -> 'questions' -> 0 ->> 'prompt'), 'Where is the ceremony?',
  'catalog changes do not reach the imported wording');
select throws_ok(format('update public.event_plan_imports set answers = %L where plan_id = %L', '{}', tests.plan_of('pl_wed')), '23514', null,
  'imports are immutable');

-- ===========================================================================
-- Client access
-- ===========================================================================
select tests.client_view('client_y', 'pl_wed') as v \gset wed_
select is(:'wed_v'::jsonb ->> 'state', 'available', 'the booked event''s verified client opens planning');
select is(tests.stage_keys(:'wed_v'::jsonb), array['ceremony', 'cocktail', 'reception_entrance', 'dinner', 'special_dances', 'party', 'closing'],
  'stages in event order');
select unalike(:'wed_v'::text, '%PLAN SECRET NOTE%', 'no internal notes');
select unalike(:'wed_v'::text, '%REF-PLAN-SECRET%', 'no payment references');
select unalike(:'wed_v'::text, '%' || tests.id('owner_a') || '%', 'no staff identities');
select unalike(:'wed_v'::text, '%signature%', 'no signing evidence');
select is(tests.client_view('client_y', 'pl_unbooked') ->> 'state', 'unavailable', 'unbooked events have no planning');
select is(tests.client_view('client_x', 'pl_wed') ->> 'state', 'unavailable', 'another client gets nothing');
select is(tests.client_view('stranger', 'pl_wed') ->> 'state', 'unavailable', 'nor does a stranger');
select is(tests.client_view('client_y', 'pl_wed', 'test-other-dj') ->> 'state', 'unavailable', 'the wrong business slug gets nothing');
select tests.force_book(tests.id('event_a1'));
select is(tests.client_view('client_x', 'event_a1') ->> 'state', 'available', 'client X has access to A1');
select is(tests.client_view('client_y', 'event_a1') ->> 'state', 'unavailable', 'revoked access gets nothing');
select is(tests.client_view('client_u', 'event_a1') ->> 'state', 'unavailable', 'an unverified email gets nothing');
select tests.force_book(tests.id('event_b1'));
select tests.login_as(tests.id('client_x'));
select is((select array_agg(tenant_slug || '/' || event_title order by tenant_slug) from public.my_plans()),
  array['test-bouprod/A1 Wedding', 'test-other-dj/B1 Party'], 'a client of two DJs sees both plans, each under its DJ');
select is((select count(*)::int from public.event_plans), 0, 'clients cannot read planning tables');
select throws_ok(format('select public.staff_planning_view(%L)', tests.id('event_a1')), 'P0002', 'not found', 'nor the staff view');
select throws_ok(format('select public.set_event_plan_item_enabled(%L, 1, false)', tests.item('event_a1', 'basics')), 'P0002', 'not found',
  'clients cannot change the structure');
select throws_ok(format('select public.apply_event_plan_template(%L, %L, 1, true)', tests.id('event_a1'), current_setting('tests.party')), 'P0002',
  'not found', 'nor the template');
select throws_ok(format('select public.move_event_plan_item(%L, 1, %L)', tests.item('event_a1', 'basics'), 'down'), 'P0002', 'not found', 'nor the order');
select tests.login_as_anon();
select throws_ok(format('select public.client_planning_view(%L, %L)', tests.id('event_a1'), 'test-bouprod'), '42501', null, 'anon has no access');
select tests.su();

-- Archiving blocks clients; unarchiving restores access.
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('pl_wed'), true);
select tests.su();
select is(tests.client_view('client_y', 'pl_wed') ->> 'state', 'unavailable', 'archived events block client planning');
select is(tests.client_save('client_y', 'pl_wed', 0, '{"guest_count":10}') ->> 'status', 'unavailable', 'and saving');
select tests.login_as(tests.id('staff_a'));
select throws_like(format('select public.set_event_plan_item_enabled(%L, %s, false)', tests.item('pl_wed', 'dinner'), tests.version('pl_wed')),
  '%archived%', 'staff structure changes wait for unarchiving too');
select public.set_event_archived(tests.id('pl_wed'), false);
select tests.su();
select is(tests.client_view('client_y', 'pl_wed') ->> 'state', 'available', 'unarchiving restores access');

-- ===========================================================================
-- Event basics and progress
-- ===========================================================================
select is((tests.client_view('client_y', 'pl_wed') -> 'progress' -> 'items' -> 0 -> 'requirements' -> 4 ->> 'state'), 'unanswered',
  'nothing saved: access details are unanswered');
select is(tests.client_save('client_y', 'pl_wed', 0, '{"guest_count":"abc"}') -> 'field', '"guest_count"', 'invalid values are refused');
select is(tests.client_save('client_y', 'pl_wed', 0, '{"budget":5}') ->> 'status', 'invalid', 'unknown fields are refused');
select is(tests.client_save('client_y', 'pl_wed', 0, '{"start_time":"20:00","end_time":"20:00"}') ->> 'message',
  'The end time must differ from the start time.', 'equal start and end times are refused');
select is(tests.client_save('client_y', 'pl_wed', 0, '{"access_notes":"Ramp","access_notes_none":true}') -> 'field', '"access_notes"',
  'details and "no special instructions" together are refused');
select tests.client_save('client_y', 'pl_wed', 0, '{"guest_count":120,"start_time":"18:00","end_time":"01:00","access_notes_none":true,"venue_room":"  "}') as s \gset save1_
select is(array[:'save1_s'::jsonb ->> 'status', :'save1_s'::jsonb ->> 'revision'], array['saved', '1'], 'the first save creates revision 1');
select is(:'save1_s'::jsonb -> 'answers', '{"guest_count":120,"start_time":"18:00","end_time":"01:00","access_notes_none":true}'::jsonb,
  'answers are normalized (blank text dropped)');
select is(tests.client_save('client_y', 'pl_wed', 0, '{"guest_count":90}') ->> 'status', 'conflict', 'a stale tab gets a conflict');
select is((select answers ->> 'guest_count' from public.event_plan_responses where item_id = tests.item('pl_wed', 'basics')), '120',
  'and overwrites nothing');
select is((:'save1_s'::jsonb -> 'progress' -> 'items' -> 0 -> 'requirements'),
  '[{"key":"guest_count","state":"answered"},{"key":"start_time","state":"answered"},{"key":"end_time","state":"answered"},{"key":"venue","state":"unanswered"},{"key":"access","state":"not_applicable"}]'::jsonb,
  '"no special instructions" is recorded as not applicable, distinct from unanswered');
select is(array[(:'save1_s'::jsonb -> 'progress' ->> 'requirements_met'), (:'save1_s'::jsonb -> 'progress' ->> 'requirements_total'),
                (:'save1_s'::jsonb -> 'progress' ->> 'percent')], array['4', '46', '8'],
  'progress counts validated saved answers (Event basics 4 of 5; the six stage editors, 12; the 17 song moments; who walks in, MC, introductions and speeches; contacts 2, preferences 4, music styles 2, unanswered)');
select is(:'save1_s'::jsonb -> 'progress' ->> 'scope', 'available_sections_only', 'and says it covers available sections only');
select is((:'save1_s'::jsonb -> 'progress' ->> 'unavailable_sections')::int, 4, 'sections without an editor are reported as not available');
select is((select count(*)::int from jsonb_array_elements(:'save1_s'::jsonb -> 'progress' -> 'items') x
           where x ->> 'state' = 'not_available' and (x ->> 'total')::int = 0), (:'save1_s'::jsonb -> 'progress' ->> 'unavailable_sections')::int,
  'and excluded from the percentage');
update public.events set venue_name = 'Château Montebello' where id = tests.id('pl_wed');
select is((tests.client_view('client_y', 'pl_wed') -> 'progress' -> 'items' -> 0 ->> 'state'), 'complete',
  'the staff-entered venue satisfies the venue requirement');
select is((tests.client_view('client_y', 'pl_wed') -> 'progress' -> 'items' -> 0 -> 'requirements' -> 3 ->> 'state'), 'imported',
  'shown as provided, not answered by the client');

select tests.login_as(tests.id('staff_a'));
select is(public.staff_save_plan_basics(tests.id('pl_wed'), 0, '{"guest_count":100}') ->> 'status', 'conflict', 'staff saves check the revision too');
select is(public.staff_save_plan_basics(tests.id('pl_wed'), 1, '{"guest_count":125,"start_time":"18:00","end_time":"01:00","access_notes_none":true}') ->> 'revision',
  '2', 'staff can edit Event basics');
select is(public.staff_planning_view(tests.id('pl_wed')) -> 'basics' ->> 'updated_by', 'staff', 'staff see who saved last');
select tests.su();
select unalike(tests.client_view('client_y', 'pl_wed')::text, '%updated_by%', 'clients do not');
select unalike(tests.client_view('client_y', 'pl_wed')::text, '%' || tests.id('staff_a') || '%', 'nor the staff member''s identity');
select tests.login_as(tests.id('owner_b'));
select throws_ok(format('select public.staff_save_plan_basics(%L, 2, %L)', tests.id('pl_wed'), '{}'), 'P0002', 'not found',
  'other businesses cannot save');
select throws_ok(format('select public.staff_planning_view(%L)', tests.id('pl_wed')), 'P0002', 'not found', 'or read');
select tests.su();

-- ===========================================================================
-- Disabling and restoring; nothing contractual changes
-- ===========================================================================
create temp table contractual as
  select (select array[content_sha256, signed_at::text, status] from public.contracts where id = :'wed_contract') as contract,
         (select booking_confirmed_at from public.events where id = tests.id('pl_wed')) as booked_at,
         (select array_agg(amount_cents::text || coalesce(invalidated_at::text, '') order by id) from public.event_payments where event_id = tests.id('pl_wed')) as payments,
         (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')) as proposal;
-- A saved answer on a moment, as the next editors will write them.
insert into public.event_plan_responses (tenant_id, plan_id, item_id, answers, updated_by_actor)
values (tests.id('tenant_a'), tests.plan_of('pl_wed'), tests.item('pl_wed', 'speeches'), '{"note":"Two toasts"}', 'client');
select tests.moment_keys(tests.client_view('client_y', 'pl_wed'), 'dinner') as before \gset dinner_
select tests.login_as(tests.id('staff_a'));
select public.set_event_plan_item_enabled(tests.item('pl_wed', 'dinner'), tests.version('pl_wed'), false);
select throws_like(format('select public.set_event_plan_item_enabled(%L, %s, false)', tests.item('pl_wed', 'basics'), tests.version('pl_wed')),
  '%Event basics is part of every plan%', 'Event basics cannot be disabled');
select is((select count(*)::int from jsonb_array_elements(public.staff_planning_view(tests.id('pl_wed')) -> 'structure' -> 'stages') s
           where s ->> 'key' = 'dinner' and (s ->> 'disabled')::boolean), 1, 'staff still see the disabled stage');
select tests.su();
select tests.client_view('client_y', 'pl_wed') as v \gset off_
select ok(not ('dinner' = any (tests.stage_keys(:'off_v'::jsonb))), 'a disabled stage is hidden from the client');
select unalike(:'off_v'::text, '%"speeches"%', 'and so are its moments');
select is((select count(*)::int from jsonb_array_elements(:'off_v'::jsonb -> 'progress' -> 'items') x where x ->> 'key' in ('dinner', 'speeches', 'cake_cutting')),
  0, 'and they leave progress');
select is((select disabled_at from public.event_plan_items where id = tests.item('pl_wed', 'speeches')), null, 'the moments keep their own state');
select is((select answers from public.event_plan_responses where item_id = tests.item('pl_wed', 'speeches')), '{"note":"Two toasts"}'::jsonb,
  'saved answers are kept');
select tests.login_as(tests.id('staff_a'));
select throws_ok(format('select public.set_event_plan_item_enabled(%L, %s, true)', tests.item('pl_wed', 'dinner'), tests.version('pl_wed') - 1), '40001', null,
  'structure changes check the version');
select public.set_event_plan_item_enabled(tests.item('pl_wed', 'dinner'), tests.version('pl_wed'), true);
select tests.su();
select is(tests.moment_keys(tests.client_view('client_y', 'pl_wed'), 'dinner'), :'dinner_before'::text[], 'restoring shows its moments in their order');
select is((select contract from contractual), (select array[content_sha256, signed_at::text, status] from public.contracts where id = :'wed_contract'),
  'the contract, its hash and signature time are untouched');
select is((select booked_at from contractual), (select booking_confirmed_at from public.events where id = tests.id('pl_wed')), 'the booking time too');
select is((select proposal from contractual),
  (select array[offer_sha256, status] from public.proposals where id = (select proposal_id from public.contracts where id = :'wed_contract')), 'and the proposal');

-- Payment corrections after booking keep planning open.
select tests.login_as(tests.id('staff_a'));
select public.invalidate_event_payment((select id from public.event_payments where event_id = tests.id('pl_wed') limit 1), 'Bounced');
select tests.su();
select is(tests.client_view('client_y', 'pl_wed') ->> 'state', 'available', 'invalidating the deposit after booking keeps planning access');
select is((select lifecycle_status from public.events where id = tests.id('pl_wed')), 'booked', 'and the booking');

-- ===========================================================================
-- Event-specific structure and template replacement
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select public.add_event_plan_item(tests.id('pl_fallback'), tests.version('pl_fallback'), 'party', null);
select public.add_event_plan_item(tests.id('pl_fallback'), tests.version('pl_fallback'), 'must_play', 'party');
select throws_like(format('select public.add_event_plan_item(%L, %s, %L, null)', tests.id('pl_fallback'), tests.version('pl_fallback'), 'party'),
  '%already in the plan%', 'an item appears once per plan');
select public.rename_event_plan_item(tests.item('pl_fallback', 'party'), tests.version('pl_fallback'), 'Retirement party');
select is((select label from public.event_plan_items where id = tests.item('pl_fallback', 'party')), 'Retirement party', 'staff rename plan items');
select is((select count(*)::int from public.planning_template_items where label = 'Retirement party'), 0, 'without touching any template');
select public.set_event_plan_item_enabled(tests.item('pl_fallback', 'party'), tests.version('pl_fallback'), false);
select public.add_event_plan_item(tests.id('pl_fallback'), tests.version('pl_fallback'), 'party', null);
select is((select array[label, coalesce(disabled_at::text, 'enabled')] from public.event_plan_items where id = tests.item('pl_fallback', 'party')),
  array['Retirement party', 'enabled'], 'adding a disabled item restores it as it was');

select tests.item('pl_wed', 'basics') as basics, tests.item('pl_wed', 'party') as party, tests.version('pl_wed') as v \gset rep_
select throws_like(format('select public.apply_event_plan_template(%L, %L, %s, false)', tests.id('pl_wed'), :'tpl_party', :rep_v),
  '%confirm%', 'replacing the template needs explicit confirmation');
select throws_ok(format('select public.apply_event_plan_template(%L, %L, %s, true)', tests.id('pl_wed'), :'tpl_party', :rep_v - 1), '40001', null,
  'and the current structure version');
select is(public.apply_event_plan_template(tests.id('pl_wed'), :'tpl_party', :rep_v, true) - 'structure_version',
  '{"status":"applied","kept":4,"added":0,"hidden":35}'::jsonb, 'applying Simple Party keeps four items and hides the rest');
select is(array[tests.item('pl_wed', 'basics'), tests.item('pl_wed', 'party')], array[:'rep_basics', :'rep_party']::uuid[], 'kept items keep their ids');
select is((select array[revision::text, answers ->> 'guest_count'] from public.event_plan_responses where item_id = :'rep_basics'), array['2', '125'],
  'Event basics answers are untouched');
select is((select answers from public.event_plan_responses where item_id = tests.item('pl_wed', 'speeches')), '{"note":"Two toasts"}'::jsonb,
  'answers of hidden items are kept');
select is((select label from public.event_plan_items where id = :'rep_party'), 'Party', 'kept items take the template''s labels');
select tests.su();
select is(tests.stage_keys(tests.client_view('client_y', 'pl_wed')), array['party'], 'the client now sees the Simple Party structure');
select tests.login_as(tests.id('staff_a'));
select public.apply_event_plan_template(tests.id('pl_wed'), :'tpl_wedding', tests.version('pl_wed'), true);
select tests.su();
select is(tests.stage_keys(tests.client_view('client_y', 'pl_wed')),
  array['ceremony', 'reception_entrance', 'dinner', 'special_dances', 'party', 'closing'], 'applying the Wedding template again restores its stages');
select is((select disabled_at is not null from public.event_plan_items where id = tests.item('pl_wed', 'cocktail')), true,
  'items no longer in that template stay hidden, not deleted');
select is((select array[label, source_template_name] from public.event_plan_items i join public.event_plans p on p.id = i.plan_id
           where i.id = tests.item('pl_wed', 'closing')), array['Last call', 'Wedding'], 'with the template''s current labels and provenance');

-- ===========================================================================
-- Integrity
-- ===========================================================================
select throws_ok(format('insert into public.event_plan_items (tenant_id, plan_id, kind, key, label, position) values (%L, %L, %L, %L, %L, 1)',
  tests.id('tenant_b'), tests.plan_of('pl_wed'), 'stage', 'arrival', 'X'), '23503', null, 'plan items cannot cross businesses');
select throws_ok(format('delete from public.event_plan_items where id = %L', tests.item('pl_wed', 'cocktail')), '23514', null,
  'plan items are never deleted');
select throws_ok(format('update public.event_plan_items set key = %L where id = %L', 'dinner_music', tests.item('pl_wed', 'cocktail_music')), '23514', null,
  'keys are immutable');

select * from finish();
rollback;
