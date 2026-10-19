-- Proposal discounts (20261119000100): the draft discount's shape, freezing
-- it with the offer (percentage, fixed amount up to the lowest package price,
-- default label, zero = none), the database's check of a submitted
-- selection's discount, allocation and taxes, contract terms and placeholders
-- from the discounted total, revisions with a new discount while sent offers
-- keep theirs, and who may set one.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(59);

create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.discounted(d jsonb) returns jsonb language sql stable as $$
  select tests.base_offer() || jsonb_build_object('discount', d) $$;
-- Signature (220,000) in the same room, priced with a discount of `disc`
-- whose share on the package line is `share` (the included speaker line is
-- free), and taxes on `taxable` per line. With 10% off: 22,000 off,
-- GST 9,900 and QST 19,751 on 198,000, total 227,651.
create function tests.selection(pid uuid, disc bigint, share bigint, taxable bigint, with_details boolean default true) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'pricing_version', 'flux-pricing-1', 'currency', 'CAD', 'package_key', 'signature',
    'addon_quantities', '{}'::jsonb,
    'logistics_answers', '{"ceremony_location":"same_room","needs_wireless_mic":false}'::jsonb,
    'requirements', '[]'::jsonb,
    'lines', jsonb_build_array(tests.line('package','signature','Signature',1,220000) || jsonb_build_object('discount_cents', share),
                               tests.line('included','additional_speaker','Additional-location speaker',1,0) || jsonb_build_object('discount_cents', 0)),
    'subtotal_cents', 220000,
    'tax_breakdown', jsonb_build_array(
      jsonb_build_object('code','GST','label','GST','rate_ppm',50000,'taxable_cents',taxable,'amount_cents',(taxable * 50000 + 500000) / 1000000),
      jsonb_build_object('code','QST','label','QST','rate_ppm',99750,'taxable_cents',taxable,'amount_cents',(taxable * 99750 + 500000) / 1000000)),
    'tax_cents', (taxable * 50000 + 500000) / 1000000 + (taxable * 99750 + 500000) / 1000000,
    'total_cents', 220000 - disc + (taxable * 50000 + 500000) / 1000000 + (taxable * 99750 + 500000) / 1000000,
    'offer_sha256', (select offer_sha256 from public.proposals where id = pid))
  || case when with_details then jsonb_build_object(
       'discount', jsonb_build_object('type', 'percent', 'label', 'Wedding Special', 'percent_basis_points', 1000), 'discount_cents', disc)
     else '{}'::jsonb end $$;
create function tests.submit(pid uuid, sess text, key text, selection jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as_service();
  r := public.client_submit_selection(sess, pid, 'test-bouprod', 1, key, selection);
  set constraints public.proposal_selections_verify, public.proposal_selection_lines_verify deferred;
  return r;
end $$;
create function tests.sections() returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('heading', 'Price', 'body',
    E'Before discount {{pricing.subtotal_before_discount}}\n{{pricing.discount}}\nSubtotal {{pricing.subtotal}}\nTotal {{pricing.total}}. Deposit {{payment.deposit}}. Balance {{payment.balance}}.')) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Draft discount shape ---------------------------------------------------------------------------------------------
select ok(private.is_valid_discount('{"type":"percent","percent_basis_points":1000,"label":"Wedding Special"}'), 'a percentage with a label is valid');
select ok(private.is_valid_discount('{"type":"percent","percent_basis_points":10000,"label":null}'), '100% without a label is valid');
select ok(private.is_valid_discount('{"type":"fixed","amount_cents":0}'), 'a zero amount is valid (it means none)');
select ok(not private.is_valid_discount('{"type":"percent","percent_basis_points":10001}'), 'more than 100% is rejected');
select ok(not private.is_valid_discount('{"type":"percent","percent_basis_points":-1}'), 'a negative percentage is rejected');
select ok(not private.is_valid_discount('{"type":"fixed","amount_cents":-100}'), 'a negative amount is rejected');
select ok(not private.is_valid_discount('{"type":"fixed","amount_cents":12.5}'), 'a fractional amount of cents is rejected');
select ok(not private.is_valid_discount('{"type":"fixed","amount_cents":100000001}'), 'an amount above the money limit is rejected');
select ok(not private.is_valid_discount('{"type":"fixed","amount_cents":100,"code":"SAVE10"}'), 'unknown fields (like a coupon code) are rejected');
select ok(not private.is_valid_discount(jsonb_build_object('type', 'percent', 'percent_basis_points', 100, 'label', repeat('x', 81))), 'a description over 80 characters is rejected');
select ok(not private.is_valid_discount('{"type":"loyalty","percent_basis_points":100}'), 'only percentage and fixed discounts exist');

-- Freezing -----------------------------------------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select is(tests.preview(tests.discounted('{"type":"percent","percent_basis_points":1000,"label":"  Wedding Special "}')) -> 'discount',
  '{"type":"percent","percent_basis_points":1000,"label":"Wedding Special"}'::jsonb, 'a percentage is frozen with its trimmed description');
select is(tests.preview(tests.discounted('{"type":"fixed","amount_cents":20000,"label":""}')) -> 'discount',
  '{"type":"fixed","amount_cents":20000,"label":"Discount"}'::jsonb, 'an empty description reads "Discount"');
select ok(not tests.preview(tests.discounted('{"type":"percent","percent_basis_points":0,"label":"Nothing"}')) ? 'discount', 'a zero discount freezes nothing');
select is(tests.preview(tests.discounted('{"type":"fixed","amount_cents":150000}')) -> 'discount' ->> 'amount_cents', '150000',
  'a fixed amount may equal the lowest possible subtotal (here the cheapest package: every charge can be avoided)');
select throws_like($$ select tests.preview(tests.discounted('{"type":"fixed","amount_cents":150001}')) $$,
  '%can''t be more than the lowest possible subtotal of this proposal (1,500.00 CAD)%', 'but not exceed the lowest possible subtotal');
select throws_like($$ select tests.preview(tests.discounted('{"type":"percent","percent_basis_points":-5}')) $$,
  '%invalid shape%', 'an invalid discount cannot even be saved in a draft');
select ok(not tests.preview(tests.base_offer()) ? 'discount', 'an offer without a discount is frozen exactly as before');
select tests.su();

-- Send, submit and verify -------------------------------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select set_config('tests.pid', public.open_proposal_draft(tests.id('event_a2'),
  tests.discounted('{"type":"percent","percent_basis_points":1000,"label":"Wedding Special"}'))::text, true);
select is(tests.send(current_setting('tests.pid')::uuid) ->> 'status', 'sent', 'a discounted proposal is sent');
select is((select offer_snapshot -> 'discount' from public.proposals where id = current_setting('tests.pid')::uuid),
  '{"type":"percent","percent_basis_points":1000,"label":"Wedding Special"}'::jsonb, 'its discount is frozen in the offer');
select set_config('tests.link', current_setting('tests.last_link_id'), true);
select tests.login_as_service();
select public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link')), tests.hex('s-disc'), 'test-bouprod', 3600);
select public.client_save_selection_draft(tests.hex('s-disc'), current_setting('tests.pid')::uuid, 'test-bouprod', 0, 'signature', '{}',
  '{"ceremony_location":"same_room","needs_wireless_mic":false}');
select tests.su();

select is(tests.submit(current_setting('tests.pid')::uuid, tests.hex('s-disc'), 'key-disc-none-applied',
  tests.selection(current_setting('tests.pid')::uuid, 0, 0, 220000)) ->> 'message',
  'invalid priced selection: discount does not match the frozen offer', 'a selection that ignores the discount is rejected');
select is(tests.submit(current_setting('tests.pid')::uuid, tests.hex('s-disc'), 'key-disc-too-much',
  tests.selection(current_setting('tests.pid')::uuid, 44000, 44000, 176000)) ->> 'message',
  'invalid priced selection: discount does not match the frozen offer', 'a larger discount is rejected');
select is(tests.submit(current_setting('tests.pid')::uuid, tests.hex('s-disc'), 'key-disc-bad-share',
  tests.selection(current_setting('tests.pid')::uuid, 22000, 0, 220000)) ->> 'message',
  'invalid priced selection: line 1 has the wrong share of the discount', 'a discount not allocated to the lines is rejected');
select is(tests.submit(current_setting('tests.pid')::uuid, tests.hex('s-disc'), 'key-disc-pre-tax',
  tests.selection(current_setting('tests.pid')::uuid, 22000, 22000, 220000)) ->> 'status',
  'invalid_selection', 'taxes on the undiscounted amount are rejected (the total check fails first)');
select is(tests.submit(current_setting('tests.pid')::uuid, tests.hex('s-disc'), 'key-disc-no-details',
  tests.selection(current_setting('tests.pid')::uuid, 22000, 22000, 198000, false)) ->> 'status',
  'invalid_selection', 'a record without the discount details is rejected');
select set_config('tests.sub', tests.submit(current_setting('tests.pid')::uuid, tests.hex('s-disc'), 'key-disc-correct-selection',
  tests.selection(current_setting('tests.pid')::uuid, 22000, 22000, 198000))::text, true);
select is(current_setting('tests.sub')::jsonb ->> 'status', 'submitted', 'the correctly discounted selection is submitted');
select results_eq(
  $$ select subtotal_cents::int, discount_cents::int, tax_cents::int, total_cents::int from public.proposal_selections
     where id = (current_setting('tests.sub')::jsonb ->> 'selection_id')::uuid $$,
  $$ values (220000, 22000, 29651, 227651) $$, 'it stores subtotal, discount, taxes on the discounted amount and the total');
select throws_ok($$ update public.proposal_selections set discount_cents = 0
                    where id = (current_setting('tests.sub')::jsonb ->> 'selection_id')::uuid $$, '23514', null,
  'a stored selection''s discount cannot change');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ insert into public.proposal_selections (tenant_id, proposal_id, version, package_key, addon_quantities, logistics_answers,
                      subtotal_cents, discount_cents, tax_cents, total_cents, currency, tax_breakdown, selection_snapshot, pricing_version, offer_sha256)
                    values (tests.id('tenant_a'), current_setting('tests.pid')::uuid, 9, 'signature', '{}', '{}', 220000, 220000, 0, 0, 'CAD', '[]', '{}',
                      'flux-pricing-1', repeat('0', 64)) $$, '42501', null, 'staff cannot write a discounted selection directly');

-- Approval and contract ----------------------------------------------------------------------------------------------------
select set_config('tests.approval', (public.approve_proposal_selection(current_setting('tests.pid')::uuid,
  (current_setting('tests.sub')::jsonb ->> 'selection_id')::uuid) ->> 'approval_id'), true);
select tests.su();
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.sections(), 'Agreement')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.gen', public.generate_contract_draft(current_setting('tests.approval')::uuid, current_setting('tests.v')::uuid)::text, true);
select is(current_setting('tests.gen')::jsonb ->> 'status', 'created', 'a contract is generated from the discounted approval');
select tests.su();
select set_config('tests.c', current_setting('tests.gen')::jsonb ->> 'contract_id', true);
select results_eq(
  $$ select total_cents::int, deposit_cents::int, balance_cents::int from public.contracts where id = current_setting('tests.c')::uuid $$,
  $$ values (227651, 113826, 113825) $$, 'total, deposit (50%, half up) and balance come from the discounted total');
select is((select rendered_content -> 'sections' -> 0 ->> 'body' from public.contracts where id = current_setting('tests.c')::uuid),
  E'Before discount 2,200.00 CAD\nWedding Special (10%): -220.00 CAD\nSubtotal 1,980.00 CAD\nTotal 2,276.51 CAD. Deposit 1,138.26 CAD. Balance 1,138.25 CAD.',
  'the placeholders show the discount and the agreed amounts');
select is((select commercial_snapshot -> 'discount' from public.contracts where id = current_setting('tests.c')::uuid),
  '{"type":"percent","label":"Wedding Special","percent_basis_points":1000,"amount_cents":22000}'::jsonb, 'the commercial snapshot records the discount');
select results_eq(
  $$ select (commercial_snapshot ->> 'subtotal_cents')::int, (commercial_snapshot ->> 'discounted_subtotal_cents')::int,
            (commercial_snapshot ->> 'total_cents')::int, (commercial_snapshot -> 'lines' -> 0 ->> 'discount_cents')::int
     from public.contracts where id = current_setting('tests.c')::uuid $$,
  $$ values (220000, 198000, 227651, 22000) $$, 'with the subtotal before and after it, and each line''s share');
select tests.login_as(tests.id('owner_a'));
select is(public.generate_contract_draft(current_setting('tests.approval')::uuid, current_setting('tests.v')::uuid) ->> 'status', 'replayed',
  'generating again returns the same stored draft');
select tests.su();

-- An undiscounted contract is generated exactly as before ------------------------------------------------------------------
select set_config('tests.plain', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.gen2', public.generate_contract_draft(current_setting('tests.plain')::uuid, current_setting('tests.v')::uuid)::text, true);
select tests.su();
select is((select rendered_content -> 'sections' -> 0 ->> 'body' from public.contracts where id = (current_setting('tests.gen2')::jsonb ->> 'contract_id')::uuid),
  E'Before discount 2,200.00 CAD\nNo discount.\nSubtotal 2,200.00 CAD\nTotal 2,529.45 CAD. Deposit 1,264.73 CAD. Balance 1,264.72 CAD.',
  'without a discount the new placeholders still have values, and nothing changes');
select ok((select not (commercial_snapshot ? 'discount') and not (commercial_snapshot -> 'lines' -> 0 ? 'discount_cents')
           from public.contracts where id = (current_setting('tests.gen2')::jsonb ->> 'contract_id')::uuid),
  'and its commercial snapshot has no discount fields');
select is((select discount_cents::int from public.proposal_selections s join public.proposal_approvals a on a.selection_id = s.id
           where a.id = current_setting('tests.plain')::uuid), 0, 'its selection records no discount');

-- Revising the discount; sent offers keep theirs ----------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select set_config('tests.rev', public.open_proposal_draft(tests.id('event_a2'))::text, true);
select is((select draft_offer -> 'discount' ->> 'percent_basis_points' from public.proposals where id = current_setting('tests.rev')::uuid), '1000',
  'a revision starts from the current discount');
select lives_ok($$ select public.update_proposal_draft(current_setting('tests.rev')::uuid,
  (select draft_version from public.proposals where id = current_setting('tests.rev')::uuid),
  tests.discounted('{"type":"fixed","amount_cents":5000,"label":"Courtesy Discount"}')) $$, 'staff change it in the revision');
select is(tests.send(current_setting('tests.rev')::uuid) ->> 'status', 'sent', 'and send the revision');
select is((select offer_snapshot -> 'discount' from public.proposals where id = current_setting('tests.rev')::uuid),
  '{"type":"fixed","amount_cents":5000,"label":"Courtesy Discount"}'::jsonb, 'the revision freezes its new discount');
select is((select offer_snapshot -> 'discount' ->> 'label' from public.proposals where id = current_setting('tests.pid')::uuid), 'Wedding Special',
  'the earlier proposal keeps its own');
select tests.su();
select results_eq(
  $$ select total_cents::int, discount_cents::int from public.proposal_selections where id = (current_setting('tests.sub')::jsonb ->> 'selection_id')::uuid $$,
  $$ values (227651, 22000) $$, 'and its submitted selection keeps its amounts');

-- Who may set a discount --------------------------------------------------------------------------------------------------------
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.preview_proposal_draft(current_setting('tests.rev')::uuid,
  tests.discounted('{"type":"percent","percent_basis_points":5000}')) $$, 'P0002', 'not found', 'another business cannot discount this proposal');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.update_proposal_draft(current_setting('tests.rev')::uuid, 0,
  tests.discounted('{"type":"percent","percent_basis_points":5000}')) $$, 'P0002', null, 'a client cannot set a discount');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.update_proposal_draft(current_setting('tests.rev')::uuid, 0,
  tests.discounted('{"type":"percent","percent_basis_points":5000}')) $$, '%frozen%', 'a sent offer''s discount cannot be edited');
select tests.su();

-- Archived events ------------------------------------------------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select is(public.set_event_archived(tests.id('event_a2'), true) ->> 'status', 'archived', 'staff archive the event');
select throws_like($$ select tests.send(public.open_proposal_draft(tests.id('event_a2'),
  tests.discounted('{"type":"percent","percent_basis_points":2000}'))) $$, '%archived%', 'a discounted proposal cannot be sent for an archived event');
select tests.su();
select is((select discount_cents::int from public.proposal_selections where id = (current_setting('tests.sub')::jsonb ->> 'selection_id')::uuid), 22000,
  'and archiving changes no stored discount');

-- The client's payment summary ----------------------------------------------------------------------------------------------------------
-- Both contracts as if sent to their signers (client Y signs A2, client X signs A1); A2 restored first.
select tests.login_as(tests.id('owner_a'));
select is(public.set_event_archived(tests.id('event_a2'), false) ->> 'status', 'active', 'staff restore the event');
select tests.su();
set local session_replication_role = replica;
update public.contracts set status = 'sent', sent_at = now() where id in (current_setting('tests.c')::uuid, (current_setting('tests.gen2')::jsonb ->> 'contract_id')::uuid);
set local session_replication_role = origin;
-- (A discounted contract's breakdown is checked on a live, signed contract in tests/integration/proposal-discounts.test.ts;
-- A2's contract here was superseded by the revision above, so its signer no longer reads it.)
select tests.login_as(tests.id('client_x'));
select ok(not (public.client_payment_summary((current_setting('tests.gen2')::jsonb ->> 'contract_id')::uuid, 'test-bouprod') ? 'pricing'),
  'and nothing extra for a contract without a discount');
select is(public.client_payment_summary(current_setting('tests.c')::uuid, 'test-bouprod'), null, 'another client sees nothing of the discounted contract');
select tests.su();

-- An older template (Subtotal, taxes, total) still adds up -------------------------------------------------------------------------------
select is(private.render_contract_text(
  E'Subtotal: {{pricing.subtotal}}\nTaxes:\n{{pricing.taxes}}\nTotal taxes: {{pricing.tax_total}}\nTotal: {{pricing.total}}',
  (select jsonb_build_object('pricing.subtotal', '1,980.00 CAD', 'pricing.taxes', E'- GST (5%): 99.00 CAD\n- QST (9.975%): 197.51 CAD',
     'pricing.tax_total', '296.51 CAD', 'pricing.total', '2,276.51 CAD'))),
  E'Subtotal: 1,980.00 CAD\nTaxes:\n- GST (5%): 99.00 CAD\n- QST (9.975%): 197.51 CAD\nTotal taxes: 296.51 CAD\nTotal: 2,276.51 CAD',
  'an older template shows the agreed subtotal, taxes and total, which add up (1,980.00 + 296.51 = 2,276.51)');

-- The fixed discount's limit: the lowest possible subtotal --------------------------------------------------------------------------------
-- Every answer to the (required) microphone question now needs uplights (120.00), which Essential doesn't include.
insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason) values
  (tests.id('tenant_a'), tests.id('q_a_mic'), '{"op":"equals","value":true}', tests.id('gear_a_uplights'), 1, 'Speeches need uplights.'),
  (tests.id('tenant_a'), tests.id('q_a_mic'), '{"op":"equals","value":false}', tests.id('gear_a_uplights'), 1, 'No speeches still need uplights.');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.minsnap', tests.preview(tests.base_offer())::text, true);
select tests.su();
select is(private.offer_min_subtotal(current_setting('tests.minsnap')::jsonb), 162000::bigint, 'required gear every answer needs counts: 1,500.00 + 120.00');
select tests.login_as(tests.id('owner_a'));
select is(tests.preview(tests.discounted('{"type":"fixed","amount_cents":162000}')) -> 'discount' ->> 'amount_cents', '162000',
  'so a fixed discount of 1,620.00 is allowed');
select throws_like($$ select tests.preview(tests.discounted('{"type":"fixed","amount_cents":162001}')) $$,
  '%(1,620.00 CAD)%', 'but not a cent more');
select set_config('tests.customsnap', tests.preview(tests.base_offer() || jsonb_build_object('price_overrides', jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 5000),
  jsonb_build_object('package_id', tests.id('pkg_a_basic'), 'unit_price_cents', 140000))))::text, true);
select tests.su();
select is(private.offer_min_subtotal(current_setting('tests.customsnap')::jsonb), 145000::bigint, 'custom prices count: 1,400.00 + 50.00');
select is(private.offer_min_subtotal(jsonb_set(jsonb_set(current_setting('tests.minsnap')::jsonb,
    '{questions}', (current_setting('tests.minsnap')::jsonb -> 'questions')
       || (select jsonb_agg(jsonb_build_object('key', 'q' || i, 'prompt', 'Q?', 'answer_type', 'boolean', 'options', '[]'::jsonb, 'required', true)) from generate_series(1, 13) i)),
    '{rules}', (current_setting('tests.minsnap')::jsonb -> 'rules')
       || (select jsonb_agg(jsonb_build_object('question_key', 'q' || i, 'condition', jsonb_build_object('op', 'equals', 'value', b), 'gear_key', 'uplights_4',
                                               'required_quantity', 1, 'reason', 'x')) from generate_series(1, 13) i, unnest(array[true, false]) b))),
  150000::bigint, 'past 4,096 answer combinations it falls back to the lowest package price');

select * from finish();
rollback;
