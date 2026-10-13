-- Package base prices for one proposal and contract quantity wording
-- (20261109000100): override shapes, the frozen effective base price, the
-- database's submission check against it, contract totals and the
-- {{package.included}} / {{gear.extras}} wording from the frozen offer (not
-- the live catalog), compatibility with older offers, and stored contracts
-- never changing.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(30);

create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.overrides(o jsonb) returns jsonb language sql stable as $$
  select tests.base_offer() || jsonb_build_object('price_overrides', o) $$;
create function tests.pkg_price(snapshot jsonb, pkg text) returns int language sql immutable as $$
  select (p ->> 'base_price_cents')::int from jsonb_array_elements(snapshot -> 'packages') p where p ->> 'key' = pkg $$;
-- Signature at `base` with two sets of uplights at 10,000 each, taxes rounded per line and tax.
create function tests.custom_selection(pid uuid, base bigint) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pricing_version', 'flux-pricing-1', 'currency', 'CAD', 'package_key', 'signature',
    'addon_quantities', '{"uplights_4":2}'::jsonb,
    'logistics_answers', '{"ceremony_location":"same_room","needs_wireless_mic":false}'::jsonb,
    'requirements', '[]'::jsonb,
    'lines', jsonb_build_array(tests.line('package', 'signature', 'Signature', 1, base),
                               tests.line('included', 'additional_speaker', 'Additional-location speaker', 1, 0),
                               tests.line('optional', 'uplights_4', 'Uplights (pack of 4)', 2, 10000)),
    'subtotal_cents', base + 20000,
    'tax_breakdown', jsonb_build_array(
      jsonb_build_object('code','GST','label','GST','rate_ppm',50000,'taxable_cents',base + 20000,
        'amount_cents', (base * 50000 + 500000) / 1000000 + 1000),
      jsonb_build_object('code','QST','label','QST','rate_ppm',99750,'taxable_cents',base + 20000,
        'amount_cents', (base * 99750 + 500000) / 1000000 + 1995)),
    'tax_cents', (base * 50000 + 500000) / 1000000 + 1000 + (base * 99750 + 500000) / 1000000 + 1995,
    'total_cents', base + 20000 + (base * 50000 + 500000) / 1000000 + 1000 + (base * 99750 + 500000) / 1000000 + 1995,
    'offer_sha256', (select offer_sha256 from public.proposals where id = pid)) $$;
create function tests.services_sections() returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('heading', 'Services', 'body', E'{{package.name}} ({{package.price}})\n{{package.included}}\n{{gear.extras}}'),
    jsonb_build_object('heading', 'Payment', 'body', 'Total {{pricing.total}}. Deposit {{payment.deposit}}. Balance {{payment.balance}}.')) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Uplights are sold as a set of four lights.
update public.gear_items set unit_label = 'set', pieces_per_unit = 4, piece_label = 'lights' where id = tests.id('gear_a_uplights');

-- Quantity wording (the full shared case list runs in tests/integration/custom-prices.test.ts) -----------
select is(private.gear_quantity_text('{"name":"Moving Heads","unit_label":"pair","pieces_per_unit":2,"piece_label":"lights"}', 'Moving Heads', 1),
  '1 pair of Moving Heads (2 lights)', 'a pair says how many lights');
select is(private.gear_quantity_text('{"unit_label":"pair","pieces_per_unit":2,"piece_label":"lights"}', 'Moving Heads', 2),
  '2 pairs of Moving Heads (4 lights)', 'two pairs are four lights');
select is(private.gear_quantity_text('{"unit_label":"set","pieces_per_unit":4,"piece_label":"tubes"}', 'LED Tubes', 1),
  '1 set of LED Tubes (4 tubes)', 'a set of four tubes');
select is(private.gear_quantity_text('{"unit_label":"speaker"}', 'Speaker', 2), '2 × Speaker', 'single-piece gear reads as before');
select is(private.gear_quantity_text('{"unit_label":"unit","unit_price_cents":100}', 'Uplight', 3), '3 × Uplight', 'an older offer without pieces reads as before');
select is(private.gear_quantity_text(null, 'Gone', 1), '1 × Gone', 'gear missing from an offer never fails');
select ok(not has_function_privilege('authenticated', 'private.gear_quantity_text(jsonb, text, integer)', 'execute'), 'the formatter is internal');

-- Override shapes -----------------------------------------------------------------------------------------
select ok(private.is_valid_price_overrides(jsonb_build_array(
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'unit_price_cents', 200000),
  jsonb_build_object('package_id', tests.id('pkg_a_basic'), 'unit_price_cents', 0),
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 10000))), 'package and gear prices, including zero, are valid');
select ok(not private.is_valid_price_overrides(jsonb_build_array(
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'unit_price_cents', -1))), 'negative package prices are rejected');
select ok(not private.is_valid_price_overrides(jsonb_build_array(
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'unit_price_cents', 100000001))), 'prices above the money limit are rejected');
select ok(not private.is_valid_price_overrides(jsonb_build_array(
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'unit_price_cents', 1),
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'unit_price_cents', 2))), 'one price per package');
select ok(not private.is_valid_price_overrides(jsonb_build_array(
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 1))),
  'an entry is either a package or a gear item');
select ok(not private.is_valid_price_overrides(jsonb_build_array(jsonb_build_object('package_id', 'Signature', 'unit_price_cents', 1))),
  'packages are matched by id, never by name');

-- Frozen effective base prices ------------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select set_config('tests.snap', tests.preview(tests.overrides(jsonb_build_array(
  jsonb_build_object('package_id', tests.id('pkg_a_basic'), 'unit_price_cents', 140000),
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'unit_price_cents', 200000),
  jsonb_build_object('package_id', tests.id('pkg_a_premium'), 'unit_price_cents', 285000),
  -- Another business's package: not offered here, so it has no effect.
  jsonb_build_object('package_id', tests.id('pkg_b_basic'), 'unit_price_cents', 1))), 'event_a2')::text, true);
select results_eq(
  $$ select tests.pkg_price(current_setting('tests.snap')::jsonb, k) from unnest(array['essential', 'signature', 'premium']) k $$,
  $$ values (140000), (200000), (285000) $$, 'each offered package freezes its own price for this proposal');
select is((select array_agg(k order by k) from jsonb_object_keys(current_setting('tests.snap')::jsonb -> 'packages' -> 1) k),
  array['base_price_cents', 'description', 'included', 'is_popular', 'key', 'name', 'tax_category'],
  'no snapshot field is added (the previous app reads it as before)');
select results_eq($$ select base_price_cents::int from public.packages where tenant_id = tests.id('tenant_a') order by key $$,
  $$ values (150000), (300000), (220000) $$, 'the catalog prices never change');

-- Send, submit and approve with custom prices --------------------------------------------------------------------
select set_config('tests.pid', public.open_proposal_draft(tests.id('event_a1'), tests.overrides(jsonb_build_array(
  jsonb_build_object('package_id', tests.id('pkg_a_plus'), 'unit_price_cents', 200000),
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 10000))))::text, true);
select is(tests.send(current_setting('tests.pid')::uuid) ->> 'status', 'sent', 'a proposal with a custom package price is sent');
select set_config('tests.link', current_setting('tests.last_link_id'), true);
select tests.login_as_service();
select public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link')), tests.hex('s-custom'), 'test-bouprod', 3600);
select is(public.client_save_selection_draft(tests.hex('s-custom'), current_setting('tests.pid')::uuid, 'test-bouprod', 0, 'signature',
  '{"uplights_4":2}', '{"ceremony_location":"same_room","needs_wireless_mic":false}') ->> 'status', 'ok', 'the client chooses Signature and two sets of uplights');
select is(public.client_submit_selection(tests.hex('s-custom'), current_setting('tests.pid')::uuid, 'test-bouprod', 1, 'key-catalog-package-price',
  tests.custom_selection(current_setting('tests.pid')::uuid, 220000)) ->> 'message',
  'invalid priced selection: line 1 (signature) does not match the frozen offer', 'a selection at the catalog package price is rejected');
set constraints public.proposal_selections_verify, public.proposal_selection_lines_verify deferred;
select set_config('tests.sub', public.client_submit_selection(tests.hex('s-custom'), current_setting('tests.pid')::uuid, 'test-bouprod', 1,
  'key-custom-package-price', tests.custom_selection(current_setting('tests.pid')::uuid, 200000))::text, true);
set constraints public.proposal_selections_verify, public.proposal_selection_lines_verify deferred;
select is(current_setting('tests.sub')::jsonb ->> 'status', 'submitted', 'the selection at this proposal''s prices is submitted');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.approval', (public.approve_proposal_selection(current_setting('tests.pid')::uuid,
  (current_setting('tests.sub')::jsonb ->> 'selection_id')::uuid) ->> 'approval_id'), true);
select tests.su();

-- The catalog changes after approval; the contract uses the approved terms --------------------------------------
update public.gear_items set pieces_per_unit = 2, piece_label = 'cans', unit_label = 'pair', name = 'Renamed uplights' where id = tests.id('gear_a_uplights');
update public.packages set base_price_cents = 999900 where id = tests.id('pkg_a_plus');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.services_sections(), 'Agreement')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.gen', public.generate_contract_draft(current_setting('tests.approval')::uuid, current_setting('tests.v')::uuid)::text, true);
select is(current_setting('tests.gen')::jsonb ->> 'status', 'created', 'the contract draft is generated');
select tests.su();
select set_config('tests.c', current_setting('tests.gen')::jsonb ->> 'contract_id', true);
select is((select rendered_content -> 'sections' -> 0 ->> 'body' from public.contracts where id = current_setting('tests.c')::uuid),
  E'Signature (2,000.00 CAD)\n- 1 × Additional-location speaker\n- 2 sets of Uplights (pack of 4) (8 lights): 200.00 CAD',
  'the custom package price, and both lists worded as on the approved proposal, from its frozen gear');
select results_eq(
  $$ select total_cents::int, deposit_cents::int, balance_cents::int, (commercial_snapshot -> 'package' ->> 'base_price_cents')::int,
            (commercial_snapshot ->> 'subtotal_cents')::int, (commercial_snapshot ->> 'tax_cents')::int
     from public.contracts where id = current_setting('tests.c')::uuid $$,
  $$ values (252945, 126473, 126472, 200000, 220000, 32945) $$,
  'contract totals, deposit and balance use the approved custom prices');
select is((select rendered_content -> 'sections' -> 1 ->> 'body' from public.contracts where id = current_setting('tests.c')::uuid),
  'Total 2,529.45 CAD. Deposit 1,264.73 CAD. Balance 1,264.72 CAD.', 'and are rendered');
select is((select tests.pkg_price(offer_snapshot, 'signature') from public.proposals where id = current_setting('tests.pid')::uuid), 200000,
  'the sent offer keeps the custom price after the catalog changes');

-- Stored contracts never change ----------------------------------------------------------------------------------------
select throws_ok($$ update public.contracts set rendered_content = '{}'::jsonb where id = current_setting('tests.c')::uuid $$, '23514', null,
  'a generated contract''s text cannot be rewritten');
select throws_ok($$ update public.contracts set total_cents = 1 where id = current_setting('tests.c')::uuid $$, '23514', null,
  'nor its totals');
select tests.login_as(tests.id('owner_a'));
select is(public.generate_contract_draft(current_setting('tests.approval')::uuid, current_setting('tests.v')::uuid) ->> 'status', 'replayed',
  'generating again returns the same stored draft');

-- Who may set prices -----------------------------------------------------------------------------------------------------------
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.preview_proposal_draft(current_setting('tests.pid')::uuid, tests.base_offer()) $$, 'P0002', 'not found',
  'another business cannot preview or price another''s proposal');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.update_proposal_draft(current_setting('tests.pid')::uuid, 0, tests.base_offer()) $$, '%frozen%',
  'a sent offer''s prices cannot be edited');

select * from finish();
rollback;
