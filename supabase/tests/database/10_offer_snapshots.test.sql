-- Draft lifecycle and frozen offer snapshots.
--   * One mutable draft per event; editing never freezes or adds revisions.
--   * preview_proposal_offer validates and builds the snapshot, storing nothing.
--   * freeze_proposal_offer (service_role) stores it exactly once; afterwards
--     no catalog, template, tax or branding change can alter it.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(71);

-- ---------------------------------------------------------------------------
-- Tax categories must resolve before an offer can be previewed or frozen.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(tests.base_offer()) $$,
  '%offer_invalid: tax categories not configured for this tenant: standard%',
  'an unmapped tax category blocks the offer (no silent zero tax)');
reset role;
select throws_ok(
  $$ update public.tenants set tax_categories = '{"standard":["GST","PST"]}' where id = tests.id('tenant_a') $$,
  '23514', null, 'tax categories may only reference configured tax codes');
update public.tenants set tax_categories = '{"standard":["GST","QST"],"exempt":[]}' where id = tests.id('tenant_a');
select throws_ok(
  $$ update public.tenants set tax_config = '[{"code":"GST","label":"GST","rate_ppm":50000}]' where id = tests.id('tenant_a') $$,
  '23514', null, 'removing a tax code still used by a category is rejected');

-- ---------------------------------------------------------------------------
-- Draft lifecycle: editing and previewing never freeze or multiply proposals.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('staff_a'));
select set_config('tests.p1', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select results_eq(
  $$ select status, revision, draft_version, offer_snapshot is null, offer_sha256 is null
     from public.proposals where id = current_setting('tests.p1')::uuid $$,
  $$ values ('draft'::text, 1, 0, true, true) $$, 'opening a draft creates revision 1 with no snapshot');
select is(public.open_proposal_draft(tests.id('event_a1')), current_setting('tests.p1')::uuid,
  'opening again returns the same draft instead of creating another');
select is(public.update_proposal_draft(current_setting('tests.p1')::uuid, 0, tests.base_offer()), 1,
  'saving the draft advances draft_version');
select results_eq(
  $$ select draft_offer = tests.base_offer(), offer_snapshot is null from public.proposals where id = current_setting('tests.p1')::uuid $$,
  $$ values (true, true) $$, 'the draft is stored in place and nothing is frozen');
select throws_ok($$ select public.update_proposal_draft(current_setting('tests.p1')::uuid, 0, tests.base_offer()) $$,
  '40001', null, 'a stale draft version (another tab) is rejected');
select throws_like($$ select public.update_proposal_draft(current_setting('tests.p1')::uuid, 1, '{"discount_cents": 1}') $$,
  '%invalid shape%', 'draft fields outside the offer input are rejected');
select lives_ok($$ select public.update_proposal_draft(current_setting('tests.p1')::uuid, 1, '{"packages": []}') $$,
  'an incomplete draft can be saved while building');
select throws_like($$ select public.preview_proposal_offer(current_setting('tests.p1')::uuid) $$,
  '%are required%', 'preview reports why an incomplete draft cannot be frozen');
select lives_ok($$ select public.update_proposal_draft(current_setting('tests.p1')::uuid, 2, tests.base_offer()) $$, 'draft saved again');
select set_config('tests.preview1', public.preview_proposal_offer(current_setting('tests.p1')::uuid)::text, true);
select is(public.preview_proposal_offer(current_setting('tests.p1')::uuid), current_setting('tests.preview1')::jsonb,
  'preview is deterministic');
select results_eq(
  $$ select count(*)::int, bool_and(offer_snapshot is null) from public.proposals where event_id = tests.id('event_a1') $$,
  $$ values (1, true) $$, 'saving and previewing never froze or created proposals');
select throws_ok($$ select public.freeze_proposal_offer(current_setting('tests.p1')::uuid) $$,
  '42501', null, 'staff cannot freeze an offer (only the step 6 send flow can)');
select throws_ok($$ update public.proposals set offer_snapshot = '{}' where id = current_setting('tests.p1')::uuid $$,
  '42501', null, 'staff cannot write snapshots directly');

-- Snapshot contents (from the preview).
select is(jsonb_path_query_array(current_setting('tests.preview1')::jsonb, '$.packages[*].key'),
  '["essential","signature","premium"]'::jsonb, 'three packages in display order');
select is(jsonb_path_query_array(current_setting('tests.preview1')::jsonb, '$.packages[*] ? (@.is_popular == true).key'),
  '["signature"]'::jsonb, 'exactly one most-popular package');
select is(current_setting('tests.preview1')::jsonb #> '{packages,1,included}',
  '[{"gear_key":"additional_speaker","quantity":1}]'::jsonb, 'included gear quantities');
select is(current_setting('tests.preview1')::jsonb #>> '{gear,additional_speaker,unit_price_cents}', '15000', 'gear prices');
select is(jsonb_array_length(current_setting('tests.preview1')::jsonb #> '{gear,additional_speaker,media}'), 1, 'active media references');
select is(jsonb_path_query_array(current_setting('tests.preview1')::jsonb, '$.rules[*].question_key'),
  '["ceremony_location"]'::jsonb, 'only rules of offered questions');
select is(current_setting('tests.preview1')::jsonb -> 'tax',
  jsonb_build_object('rounding', 'per_line_per_tax_half_up',
    'rates', '[{"code":"GST","label":"GST","rate_ppm":50000},{"code":"QST","label":"QST","rate_ppm":99750}]'::jsonb,
    'categories', '{"standard":["GST","QST"],"exempt":[]}'::jsonb),
  'tax rates and categories');

-- ---------------------------------------------------------------------------
-- Freezing (service role): exactly once, hash computed by the database.
-- ---------------------------------------------------------------------------
reset role;
select tests.login_as_service();
select set_config('tests.sha1', public.freeze_proposal_offer(current_setting('tests.p1')::uuid), true);
select results_eq(
  $$ select offer_snapshot = current_setting('tests.preview1')::jsonb,
            offer_sha256 = encode(sha256(convert_to(offer_snapshot::text, 'UTF8')), 'hex'),
            offer_sha256 = current_setting('tests.sha1'),
            offer_frozen_at is not null
     from public.proposals where id = current_setting('tests.p1')::uuid $$,
  $$ values (true, true, true, true) $$, 'freezing stores exactly the previewed snapshot and its SHA-256');
select is(public.freeze_proposal_offer(current_setting('tests.p1')::uuid), current_setting('tests.sha1'),
  'freezing again is idempotent');
reset role;
select tests.login_as(tests.id('staff_a'));
select throws_like($$ select public.update_proposal_draft(current_setting('tests.p1')::uuid, 3, '{}') $$,
  '%frozen%', 'a frozen draft can no longer be edited');
reset role;
select throws_ok($$ update public.proposals set draft_offer = '{}' where id = current_setting('tests.p1')::uuid $$,
  '23514', null, 'even privileged code cannot change the draft after freezing');
select throws_ok(
  $$ insert into public.proposals (tenant_id, event_id, revision, offer_snapshot) values (tests.id('tenant_a'), tests.id('event_a2'), 1, '{}') $$,
  '23514', null, 'proposals cannot be inserted already frozen');
select throws_ok(
  $$ insert into public.proposals (tenant_id, event_id, revision) values (tests.id('tenant_a'), tests.id('event_a1'), 9) $$,
  '23505', null, 'an event has at most one draft');

-- After sending (simulated; step 6), the next draft is revision 2.
update public.proposals set status = 'sent' where id = current_setting('tests.p1')::uuid;
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p2', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select is((select revision from public.proposals where id = current_setting('tests.p2')::uuid), 2,
  'the next draft for the event is revision 2');
reset role;
select throws_ok($$ update public.proposals set status = 'sent' where id = current_setting('tests.p2')::uuid $$,
  '23514', null, 'an unfrozen proposal cannot leave draft status');
select tests.login_as(tests.id('owner_a'));

-- ---------------------------------------------------------------------------
-- Offer validation (through preview of the open draft)
-- ---------------------------------------------------------------------------
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{packages}', (tests.base_offer() -> 'packages') - 2)) $$,
  '%exactly three packages%', 'two packages are rejected');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{packages,2,package_id}', to_jsonb(tests.id('pkg_a_basic')))) $$,
  '%must be distinct%', 'duplicate packages are rejected');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{packages,1,is_popular}', 'false')) $$,
  '%exactly one package must be marked most popular%', 'no most-popular package is rejected');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{packages,0,is_popular}', 'true')) $$,
  '%exactly one package must be marked most popular%', 'two most-popular packages are rejected');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{packages,2,package_id}', to_jsonb(tests.id('pkg_b_basic')))) $$,
  '%packages not found or inactive%', 'another tenant''s package is rejected');
select throws_like($$ select tests.preview(tests.base_offer() || '{"expiry_days": 0}') $$,
  '%expiry_days%', 'expiry must be at least one day');
select throws_like($$ select tests.preview(tests.base_offer() || '{"expiry_days": 1.5}') $$,
  '%expiry_days%', 'expiry must be whole days');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{addons,0,recommended_quantity}', '5')) $$,
  '%addons need%', 'recommended addon quantity cannot exceed its maximum');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{addons,0,max_quantity}', '"4; drop table x"')) $$,
  '%addons need%', 'malformed addon quantities are rejected before any cast');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{addons,1,gear_item_id}', to_jsonb(tests.id('gear_a_uplights')))) $$,
  '%addons must be distinct%', 'duplicate addons are rejected');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{packages,0,package_id}', '"not-a-uuid"')) $$,
  '%package_id%', 'malformed package ids are rejected cleanly');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{packages,0}', '{"package_id":"50000000-0000-4000-8000-0000000000a1","is_popular":false,"price_cents":1}')) $$,
  '%package_id%', 'unexpected package fields (e.g. prices) are rejected');
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{question_ids}', jsonb_build_array(tests.id('q_b_ceremony')))) $$,
  '%questions not found or inactive%', 'another tenant''s question is rejected');

-- Every referenced catalog record must be active.
reset role;
update public.packages set active = false where id = tests.id('pkg_a_premium');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(tests.base_offer()) $$, '%packages not found or inactive%', 'inactive packages are rejected');
reset role;
update public.packages set active = true where id = tests.id('pkg_a_premium');
update public.gear_items set active = false where id = tests.id('gear_a_speaker');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(jsonb_set(tests.base_offer(), '{addons}', '[]')) $$,
  '%gear items not found or inactive%', 'inactive gear included in a package is rejected');
reset role;
update public.gear_items set active = true where id = tests.id('gear_a_speaker');
update public.gear_items set active = false where id = tests.id('gear_a_uplights');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(tests.base_offer()) $$, '%gear items not found or inactive%', 'inactive addon gear is rejected');
reset role;
update public.gear_items set active = true where id = tests.id('gear_a_uplights');
update public.logistics_questions set active = false where id = tests.id('q_a_mic');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(tests.base_offer()) $$, '%questions not found or inactive%', 'inactive questions are rejected');

reset role;
update public.logistics_questions set active = true where id = tests.id('q_a_mic');
insert into public.gear_items (id, tenant_id, key, name, default_price_cents, active) values
  (tests.id('gear_a_mic'), tests.id('tenant_a'), 'wireless_mic', 'Wireless mic', 5000, false),
  (tests.id('gear_a_fog'), tests.id('tenant_a'), 'fog_machine',  'Fog machine',  9000, false);
insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason) values
  (tests.id('tenant_a'), tests.id('q_a_mic'), '{"op":"equals","value":true}', tests.id('gear_a_mic'), 1, 'Speeches need a mic.'),
  (tests.id('tenant_a'), tests.id('q_a_extras'), '{"op":"contains","value":"fog"}', tests.id('gear_a_fog'), 1, 'Fog needs a machine.');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(tests.base_offer()) $$,
  '%gear items not found or inactive%', 'a rule requiring archived gear blocks the offer');
reset role;
update public.logistics_rules set active = false where gear_item_id = tests.id('gear_a_mic');
select tests.login_as(tests.id('owner_a'));
select is(jsonb_path_query_array(tests.preview(tests.base_offer()), '$.rules[*].gear_key'),
  '["additional_speaker"]'::jsonb, 'inactive rules and rules of unoffered questions are excluded');

reset role;
update public.packages set tax_category = 'luxury' where id = tests.id('pkg_a_premium');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(tests.base_offer()) $$,
  '%tax categories not configured for this tenant: luxury%', 'unmapped package tax category is rejected');
reset role;
update public.packages set tax_category = 'standard' where id = tests.id('pkg_a_premium');

update public.events set lifecycle_status = 'cancelled' where id = tests.id('event_a2');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.open_proposal_draft(tests.id('event_a2')) $$, '%event is cancelled%',
  'cancelled events cannot get a new draft');

-- ---------------------------------------------------------------------------
-- Authorization
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.open_proposal_draft(tests.id('event_a1')) $$, 'P0002', 'not found',
  'another tenant''s staff cannot open a draft (and learn nothing)');
select throws_ok($$ select public.preview_proposal_offer(current_setting('tests.p2')::uuid) $$, 'P0002', 'not found',
  'another tenant''s staff cannot preview a draft');
select throws_ok($$ select public.update_proposal_draft(current_setting('tests.p2')::uuid, 0, '{}') $$, 'P0002', 'not found',
  'another tenant''s staff cannot edit a draft');
select is_empty($$ select * from public.proposals $$, 'another tenant''s staff cannot read proposals');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.open_proposal_draft(tests.id('event_a1')) $$, 'P0002', 'not found',
  'a client with event access cannot open a draft');
select throws_ok($$ select public.preview_proposal_offer(current_setting('tests.p1')::uuid) $$, 'P0002', 'not found',
  'a client cannot preview proposals through the staff function');
select tests.login_as_anon();
select throws_ok($$ select public.open_proposal_draft(tests.id('event_a1')) $$, '42501', null, 'anon cannot open drafts');
select throws_ok($$ select public.preview_proposal_offer(current_setting('tests.p1')::uuid) $$, '42501', null, 'anon cannot preview');
select tests.login_as(tests.id('owner_a'));
select throws_ok(
  $$ insert into public.proposals (tenant_id, event_id, revision) values (tests.id('tenant_a'), tests.id('event_a2'), 1) $$,
  '42501', null, 'staff cannot insert proposals directly');

-- ---------------------------------------------------------------------------
-- Template prefill
-- ---------------------------------------------------------------------------
select throws_like($$ select tests.preview(public.proposal_offer_input_from_template(tests.id('tmpl_a'))) $$,
  '%exactly three packages%', 'a template with two packages cannot produce an offer');
reset role;
insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
  values (tests.id('tenant_a'), tests.id('tmpl_a'), tests.id('pkg_a_premium'), 3);
select tests.login_as(tests.id('owner_a'));
select is(jsonb_path_query_array(tests.preview(public.proposal_offer_input_from_template(tests.id('tmpl_a'))),
    '$.packages[*] ? (@.is_popular == true).key'),
  '["signature"]'::jsonb, 'template prefill makes the default package the most popular');
select is((select source_template_id from public.proposals where id = current_setting('tests.p2')::uuid), tests.id('tmpl_a'),
  'the draft records its source template');
select tests.login_as(tests.id('owner_b'));
select is(public.proposal_offer_input_from_template(tests.id('tmpl_a')), null,
  'another tenant cannot read a template through the prefill helper');

-- ---------------------------------------------------------------------------
-- Snapshot independence for the frozen proposal p1
-- ---------------------------------------------------------------------------
reset role;
create temp table saved as
  select offer_snapshot, offer_sha256 from public.proposals where id = current_setting('tests.p1')::uuid;

update public.gear_items set default_price_cents = 99999, name = 'Renamed speaker', description = 'changed', tax_category = 'exempt'
  where id = tests.id('gear_a_speaker');
update public.gear_media set alt_text = 'changed', active = false where id = tests.id('media_a');
update public.packages set base_price_cents = 1, name = 'Renamed', is_popular = false where id = tests.id('pkg_a_plus');
update public.package_items set quantity = 7 where package_id = tests.id('pkg_a_plus');
delete from public.package_items where package_id = tests.id('pkg_a_premium');
update public.logistics_questions set prompt = 'changed', required = false,
  options = options || '[{"value":"outdoors","label":"Outdoors"}]' where id = tests.id('q_a_ceremony');
update public.logistics_rules set required_quantity = 9, reason = 'changed' where id = tests.id('rule_a_ceremony');
update public.tenants set display_name = 'Rebranded', currency = 'USD',
  tax_categories = '{"standard":["GST"],"exempt":[]}', tax_config = '[{"code":"GST","label":"Federal","rate_ppm":70000}]'
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
select tests.login_as(tests.id('owner_a'));
select is(tests.preview(tests.base_offer() || '{"addons": []}') #>> '{gear,additional_speaker,unit_price_cents}', '99999',
  'an unfrozen draft previews the current catalog');

select * from finish();
rollback;
