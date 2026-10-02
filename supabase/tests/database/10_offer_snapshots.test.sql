-- create_proposal_offer: authorization, offer validation and frozen snapshots
-- that no later catalog, template or tenant change can alter.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(52);

create function tests.create_offer(offer jsonb, event_name text default 'event_a1') returns uuid
language sql as $$ select public.create_proposal_offer(tests.id(event_name), offer) $$;
grant execute on function tests.create_offer(jsonb, text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Tax categories must resolve before anything can be frozen.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(tests.base_offer()) $$,
  '%offer_invalid: tax categories not configured for this tenant: standard%',
  'an unmapped tax category blocks offer creation (no silent zero tax)');

reset role;
select throws_ok(
  $$ update public.tenants set tax_categories = '{"standard":["GST","PST"]}' where id = tests.id('tenant_a') $$,
  '23514', null, 'tax categories may only reference configured tax codes');
update public.tenants set tax_categories = '{"standard":["GST","QST"],"exempt":[]}' where id = tests.id('tenant_a');
select throws_ok(
  $$ update public.tenants set tax_config = '[{"code":"GST","label":"GST","rate_ppm":50000}]' where id = tests.id('tenant_a') $$,
  '23514', null, 'removing a tax code still used by a category is rejected');

-- ---------------------------------------------------------------------------
-- Successful creation and snapshot contents
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('staff_a'));
select set_config('tests.p1', tests.create_offer(tests.base_offer())::text, true);
select results_eq(
  $$ select status, revision from public.proposals where id = current_setting('tests.p1')::uuid $$,
  $$ values ('draft'::text, 1) $$, 'staff create a draft proposal, revision 1');
select is(
  (select jsonb_path_query_array(offer_snapshot, '$.packages[*].key') from public.proposals where id = current_setting('tests.p1')::uuid),
  '["essential","signature","premium"]'::jsonb, 'three packages frozen in display order');
select is(
  (select jsonb_path_query_array(offer_snapshot, '$.packages[*] ? (@.is_popular == true).key') from public.proposals where id = current_setting('tests.p1')::uuid),
  '["signature"]'::jsonb, 'exactly one most-popular package frozen');
select is(
  (select offer_snapshot #> '{packages,1,included}' from public.proposals where id = current_setting('tests.p1')::uuid),
  '[{"gear_key":"additional_speaker","quantity":1}]'::jsonb, 'included gear quantities frozen');
select is(
  (select offer_snapshot #>> '{gear,additional_speaker,unit_price_cents}' from public.proposals where id = current_setting('tests.p1')::uuid),
  '15000', 'gear prices frozen');
select is(
  (select jsonb_array_length(offer_snapshot #> '{gear,additional_speaker,media}') from public.proposals where id = current_setting('tests.p1')::uuid),
  1, 'active media references frozen');
select is(
  (select jsonb_path_query_array(offer_snapshot, '$.rules[*].question_key') from public.proposals where id = current_setting('tests.p1')::uuid),
  '["ceremony_location"]'::jsonb, 'only rules of offered questions are frozen');
select is(
  (select offer_snapshot -> 'tax' from public.proposals where id = current_setting('tests.p1')::uuid),
  jsonb_build_object('rounding', 'per_line_per_tax_half_up',
    'rates', '[{"code":"GST","label":"GST","rate_ppm":50000},{"code":"QST","label":"QST","rate_ppm":99750}]'::jsonb,
    'categories', '{"standard":["GST","QST"],"exempt":[]}'::jsonb),
  'tax rates and categories frozen');
select ok(
  (select offer_sha256 = encode(sha256(convert_to(offer_snapshot::text, 'UTF8')), 'hex')
   from public.proposals where id = current_setting('tests.p1')::uuid),
  'offer hash is the SHA-256 of the frozen snapshot');
select is(
  (select created_by_membership_id from public.proposals where id = current_setting('tests.p1')::uuid),
  (select id from public.tenant_memberships where user_id = tests.id('staff_a')),
  'creator membership recorded');
select set_config('tests.p2', tests.create_offer(tests.base_offer())::text, true);
select is(
  (select revision from public.proposals where id = current_setting('tests.p2')::uuid),
  2, 'the next offer for the same event is revision 2');

-- ---------------------------------------------------------------------------
-- Offer validation
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages}', (tests.base_offer() -> 'packages') - 2)) $$,
  '%exactly three packages%', 'two packages are rejected');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages}',
    (tests.base_offer() -> 'packages') || jsonb_build_array(jsonb_build_object('package_id', tests.id('pkg_a_basic'), 'is_popular', false)))) $$,
  '%exactly three packages%', 'four packages are rejected');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages,2,package_id}', to_jsonb(tests.id('pkg_a_basic')))) $$,
  '%must be distinct%', 'duplicate packages are rejected');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages,1,is_popular}', 'false')) $$,
  '%exactly one package must be marked most popular%', 'no most-popular package is rejected');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages,0,is_popular}', 'true')) $$,
  '%exactly one package must be marked most popular%', 'two most-popular packages are rejected');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages,2,package_id}', to_jsonb(tests.id('pkg_b_basic')))) $$,
  '%packages not found or inactive%', 'another tenant''s package is rejected');
select throws_like($$ select tests.create_offer(tests.base_offer() || '{"discount_cents": 500}') $$,
  '%unknown offer field%', 'unknown offer fields are rejected');
select throws_like($$ select tests.create_offer(tests.base_offer() || '{"expiry_days": 0}') $$,
  '%expiry_days%', 'expiry must be at least one day');
select throws_like($$ select tests.create_offer(tests.base_offer() || '{"expiry_days": 1.5}') $$,
  '%expiry_days%', 'expiry must be whole days');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{addons,0,max_quantity}', '"4; drop table x"')) $$,
  '%addons need%', 'malformed addon quantities are rejected before any cast');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages,0,package_id}', '"not-a-uuid"')) $$,
  '%package_id%', 'malformed package ids are rejected cleanly');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{packages,0}', '{"package_id":"50000000-0000-4000-8000-0000000000a1","is_popular":false,"price_cents":1}')) $$,
  '%package_id%', 'unexpected package fields (e.g. prices) are rejected');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{addons,0,recommended_quantity}', '5')) $$,
  '%addons need%', 'recommended addon quantity cannot exceed its maximum');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{addons,1,gear_item_id}', to_jsonb(tests.id('gear_a_uplights')))) $$,
  '%addons must be distinct%', 'duplicate addons are rejected');
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{question_ids}', jsonb_build_array(tests.id('q_b_ceremony')))) $$,
  '%questions not found or inactive%', 'another tenant''s question is rejected');

-- Every referenced catalog record must be active.
reset role;
update public.packages set active = false where id = tests.id('pkg_a_premium');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(tests.base_offer()) $$, '%packages not found or inactive%', 'inactive packages are rejected');
reset role;
update public.packages set active = true where id = tests.id('pkg_a_premium');
update public.gear_items set active = false where id = tests.id('gear_a_speaker');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(jsonb_set(tests.base_offer(), '{addons}', '[]')) $$,
  '%gear items not found or inactive%', 'inactive gear included in a package is rejected');
reset role;
update public.gear_items set active = true where id = tests.id('gear_a_speaker');
update public.gear_items set active = false where id = tests.id('gear_a_uplights');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(tests.base_offer()) $$, '%gear items not found or inactive%', 'inactive addon gear is rejected');
reset role;
update public.gear_items set active = true where id = tests.id('gear_a_uplights');
update public.logistics_questions set active = false where id = tests.id('q_a_mic');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(tests.base_offer()) $$, '%questions not found or inactive%', 'inactive questions are rejected');

-- A rule on an offered question that requires archived gear blocks the offer...
reset role;
update public.logistics_questions set active = true where id = tests.id('q_a_mic');
insert into public.gear_items (id, tenant_id, key, name, default_price_cents, active) values
  (tests.id('gear_a_mic'), tests.id('tenant_a'), 'wireless_mic', 'Wireless mic', 5000, false),
  (tests.id('gear_a_fog'), tests.id('tenant_a'), 'fog_machine',  'Fog machine',  9000, false);
insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason) values
  (tests.id('tenant_a'), tests.id('q_a_mic'), '{"op":"equals","value":true}', tests.id('gear_a_mic'), 1, 'Speeches need a mic.'),
  (tests.id('tenant_a'), tests.id('q_a_extras'), '{"op":"contains","value":"fog"}', tests.id('gear_a_fog'), 1, 'Fog needs a machine.');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(tests.base_offer()) $$,
  '%gear items not found or inactive%', 'a rule requiring archived gear blocks the offer');
-- ...but inactive rules and rules of questions not in the offer are ignored.
reset role;
update public.logistics_rules set active = false where gear_item_id = tests.id('gear_a_mic');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p_rules', tests.create_offer(tests.base_offer())::text, true);
select is(
  (select jsonb_path_query_array(offer_snapshot, '$.rules[*].gear_key') from public.proposals where id = current_setting('tests.p_rules')::uuid),
  '["additional_speaker"]'::jsonb, 'inactive rules and rules of unoffered questions are not frozen');

-- Package tax categories must resolve too.
reset role;
update public.packages set tax_category = 'luxury' where id = tests.id('pkg_a_premium');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(tests.base_offer()) $$,
  '%tax categories not configured for this tenant: luxury%', 'unmapped package tax category is rejected');
reset role;
update public.packages set tax_category = 'standard' where id = tests.id('pkg_a_premium');

-- Cancelled events cannot receive offers.
update public.events set lifecycle_status = 'cancelled' where id = tests.id('event_a2');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(tests.base_offer(), 'event_a2') $$, '%event is cancelled%', 'cancelled events are rejected');

-- ---------------------------------------------------------------------------
-- Authorization
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select tests.create_offer(tests.base_offer()) $$, 'P0002', 'event not found',
  'another tenant''s staff cannot create an offer (and learn nothing)');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select tests.create_offer(tests.base_offer()) $$, 'P0002', 'event not found',
  'a client with event access cannot create an offer');
select tests.login_as_anon();
select throws_ok($$ select public.create_proposal_offer(tests.id('event_a1'), tests.base_offer()) $$, '42501', null,
  'anon cannot call create_proposal_offer');
select tests.login_as(tests.id('owner_a'));
select throws_ok(
  $$ insert into public.proposals (tenant_id, event_id, revision, offer_snapshot, offer_sha256)
     values (tests.id('tenant_a'), tests.id('event_a1'), 99, '{}', repeat('0', 64)) $$,
  '42501', null, 'staff cannot insert proposals directly');
select throws_ok($$ update public.proposals set status = 'approved' where id = current_setting('tests.p1')::uuid $$,
  '42501', null, 'staff cannot change proposal status directly');
select tests.login_as(tests.id('owner_b'));
select is_empty($$ select * from public.proposals $$, 'another tenant''s staff cannot read proposals');

-- ---------------------------------------------------------------------------
-- Template prefill
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.create_offer(public.proposal_offer_input_from_template(tests.id('tmpl_a'))) $$,
  '%exactly three packages%', 'a template with two packages cannot produce an offer');
reset role;
insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
  values (tests.id('tenant_a'), tests.id('tmpl_a'), tests.id('pkg_a_premium'), 3);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p_tmpl', tests.create_offer(public.proposal_offer_input_from_template(tests.id('tmpl_a')))::text, true);
select results_eq(
  $$ select source_template_id, jsonb_path_query_array(offer_snapshot, '$.packages[*] ? (@.is_popular == true).key')
     from public.proposals where id = current_setting('tests.p_tmpl')::uuid $$,
  $$ values (tests.id('tmpl_a'), '["signature"]'::jsonb) $$,
  'template prefill: provenance recorded and the default package is the most popular');
select tests.login_as(tests.id('owner_b'));
select is(public.proposal_offer_input_from_template(tests.id('tmpl_a')), null,
  'another tenant cannot read a template through the prefill helper');

-- ---------------------------------------------------------------------------
-- Snapshot independence: change everything the snapshot was copied from.
-- ---------------------------------------------------------------------------
reset role;
create temp table saved as
  select id, offer_snapshot, offer_sha256 from public.proposals where id = current_setting('tests.p1')::uuid;

update public.gear_items set default_price_cents = 99999, name = 'Renamed speaker', description = 'changed', tax_category = 'exempt'
  where id = tests.id('gear_a_speaker');
update public.gear_items set active = false where id = tests.id('gear_a_uplights');
update public.gear_media set alt_text = 'changed', active = false where id = tests.id('media_a');
update public.packages set base_price_cents = 1, name = 'Renamed', is_popular = false where id = tests.id('pkg_a_plus');
update public.package_items set quantity = 7 where package_id = tests.id('pkg_a_plus');
delete from public.package_items where package_id = tests.id('pkg_a_premium');
update public.logistics_questions set prompt = 'changed', required = false,
  options = options || '[{"value":"outdoors","label":"Outdoors"}]' where id = tests.id('q_a_ceremony');
update public.logistics_rules set required_quantity = 9, reason = 'changed' where id = tests.id('rule_a_ceremony');
update public.tenants set display_name = 'Rebranded', currency = 'USD',
  tax_categories = '{"standard":["GST"]}', tax_config = '[{"code":"GST","label":"Federal","rate_ppm":70000}]'
  where id = tests.id('tenant_a');

select is((select offer_snapshot from public.proposals where id = current_setting('tests.p1')::uuid),
  (select offer_snapshot from saved), 'catalog, rule, tax and branding changes leave the frozen snapshot unchanged');
select is((select offer_sha256 from public.proposals where id = current_setting('tests.p1')::uuid),
  (select offer_sha256 from saved), 'the offer hash is unchanged');

select throws_ok($$ update public.proposals set offer_snapshot = '{}' where id = current_setting('tests.p1')::uuid $$,
  '23514', null, 'even privileged code cannot rewrite a frozen snapshot');
select throws_ok($$ update public.proposals set offer_sha256 = repeat('a', 64) where id = current_setting('tests.p1')::uuid $$,
  '23514', null, 'the offer hash cannot be rewritten');
select throws_ok($$ delete from public.proposals where id = current_setting('tests.p1')::uuid $$,
  '23514', null, 'proposals cannot be deleted (history is preserved)');
select is(
  (select offer_sha256 from public.proposals
   where id = (select p.id from public.proposals p where p.tenant_id = tests.id('tenant_a') order by p.created_at, p.revision limit 1)),
  (select offer_sha256 from saved), 'supplied hash values are ignored; the database computes them');

select * from finish();
rollback;
