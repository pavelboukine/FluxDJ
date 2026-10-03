-- record_proposal_selection: service-role only, optimistic versioning,
-- immutability, and deferred re-verification of every amount against the
-- frozen offer (unit prices, line totals, subtotal, per-line tax rounding,
-- total). A tampered or buggy writer cannot store wrong money.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(43);

update public.tenants set tax_categories = '{"standard":["GST","QST"]}' where id = tests.id('tenant_a');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.pid', public.open_proposal_draft(tests.id('event_a1'), tests.base_offer())::text, true);
reset role;

-- Submissions require a frozen offer.
select tests.login_as_service();
select throws_like($$ select public.record_proposal_selection(current_setting('tests.pid')::uuid, 0, '{}') $$,
  '%not frozen%', 'a selection cannot be submitted against an unfrozen draft');
select throws_like($$ select public.save_proposal_selection_draft(current_setting('tests.pid')::uuid, 0, null, '{}', '{}') $$,
  '%not frozen%', 'a selection draft needs a frozen offer');
select public.freeze_proposal_offer(current_setting('tests.pid')::uuid);
reset role;

create function tests.pid() returns uuid language sql stable as $$ select current_setting('tests.pid')::uuid $$;
create function tests.sha() returns text language sql stable as $$
  select offer_sha256 from public.proposals where id = tests.pid() $$;

-- Signature (includes one speaker), no extras: 220000 + GST 11000 + QST 21945.
create function tests.signature_selection() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pricing_version', 'flux-pricing-1', 'currency', 'CAD', 'package_key', 'signature',
    'addon_quantities', '{}'::jsonb,
    'logistics_answers', '{"ceremony_location":"same_room","needs_wireless_mic":false}'::jsonb,
    'requirements', '[]'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('source','package','item_key','signature','name','Signature','description',null,
        'quantity',1,'unit_price_cents',220000,'line_total_cents',220000,'required_quantity',0,'required_reasons','[]'::jsonb,'tax_category','standard'),
      jsonb_build_object('source','included','item_key','additional_speaker','name','Additional-location speaker','description',null,
        'quantity',1,'unit_price_cents',0,'line_total_cents',0,'required_quantity',0,'required_reasons','[]'::jsonb,'tax_category','standard')),
    'subtotal_cents', 220000,
    'tax_breakdown', '[{"code":"GST","label":"GST","rate_ppm":50000,"taxable_cents":220000,"amount_cents":11000},
                       {"code":"QST","label":"QST","rate_ppm":99750,"taxable_cents":220000,"amount_cents":21945}]'::jsonb,
    'tax_cents', 32945, 'total_cents', 252945, 'offer_sha256', tests.sha());
$$;

-- Essential (no speaker included), separate ceremony: one required speaker.
-- QST on 150000 = 14962.5 -> 14963 (half up); on 15000 = 1496.25 -> 1496.
create function tests.essential_selection() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pricing_version', 'flux-pricing-1', 'currency', 'CAD', 'package_key', 'essential',
    'addon_quantities', '{}'::jsonb,
    'logistics_answers', '{"ceremony_location":"separate_space","needs_wireless_mic":false}'::jsonb,
    'requirements', '[]'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('source','package','item_key','essential','name','Essential','description',null,
        'quantity',1,'unit_price_cents',150000,'line_total_cents',150000,'required_quantity',0,'required_reasons','[]'::jsonb,'tax_category','standard'),
      jsonb_build_object('source','required','item_key','additional_speaker','name','Additional-location speaker','description',null,
        'quantity',1,'unit_price_cents',15000,'line_total_cents',15000,'required_quantity',1,
        'required_reasons','["A separate ceremony space needs its own speaker."]'::jsonb,'tax_category','standard')),
    'subtotal_cents', 165000,
    'tax_breakdown', '[{"code":"GST","label":"GST","rate_ppm":50000,"taxable_cents":165000,"amount_cents":8250},
                       {"code":"QST","label":"QST","rate_ppm":99750,"taxable_cents":165000,"amount_cents":16459}]'::jsonb,
    'tax_cents', 24709, 'total_cents', 189709, 'offer_sha256', tests.sha());
$$;

-- Records a selection and forces the deferred verification to run now
-- (the test transaction never commits, so deferred checks would never fire).
create function tests.record(expected int, selection jsonb) returns uuid
language plpgsql as $$
declare
  id uuid;
begin
  id := public.record_proposal_selection(tests.pid(), expected, selection);
  set constraints all immediate;
  set constraints all deferred;
  return id;
end;
$$;
create function tests.exec_checked(sql text) returns void
language plpgsql as $$
begin
  execute sql;
  set constraints all immediate;
  set constraints all deferred;
end;
$$;
grant execute on all functions in schema tests to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- Only trusted server code may record selections.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.record_proposal_selection(tests.pid(), 0, tests.signature_selection()) $$,
  '42501', null, 'staff cannot call record_proposal_selection');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.record_proposal_selection(tests.pid(), 0, tests.signature_selection()) $$,
  '42501', null, 'clients cannot call record_proposal_selection');
select throws_ok(
  $$ insert into public.proposal_selections (tenant_id, proposal_id, version, package_key, addon_quantities, logistics_answers,
       subtotal_cents, tax_cents, total_cents, currency, tax_breakdown, selection_snapshot, pricing_version, offer_sha256)
     values (tests.id('tenant_a'), tests.pid(), 1, 'signature', '{}', '{}', 0, 0, 0, 'CAD', '[]', '{}', 'x', repeat('0', 64)) $$,
  '42501', null, 'clients cannot insert selections directly');
reset role;

-- ---------------------------------------------------------------------------
-- Valid selections and optimistic versioning
-- ---------------------------------------------------------------------------
select tests.login_as_service();
select lives_ok($$ select tests.record(0, tests.signature_selection()) $$, 'a correctly priced selection is recorded');
select results_eq(
  $$ select version, total_cents, (select count(*)::int from public.proposal_selection_lines l where l.selection_id = s.id)
     from public.proposal_selections s where proposal_id = tests.pid() $$,
  $$ values (1, 252945::bigint, 2) $$, 'version 1 stored with its lines');
select is((select current_selection_version from public.proposals where id = tests.pid()), 1,
  'proposal tracks the current selection version');
select throws_ok($$ select tests.record(0, tests.signature_selection()) $$, '40001', null,
  'a stale version (another tab) is rejected');
select lives_ok($$ select tests.record(1, tests.essential_selection()) $$,
  'required gear priced with half-up tax rounding is accepted (QST 14962.5 -> 14963)');
select is((select current_selection_version from public.proposals where id = tests.pid()), 2, 'version advances to 2');

-- ---------------------------------------------------------------------------
-- Tampering is caught by the database, whatever the writer claims.
-- ---------------------------------------------------------------------------
select throws_like($$ select tests.record(2, jsonb_set(jsonb_set(jsonb_set(jsonb_set(tests.signature_selection(),
    '{lines,0,unit_price_cents}', '1'), '{lines,0,line_total_cents}', '1'), '{subtotal_cents}', '1'), '{total_cents}', '32946')) $$,
  '%does not match the frozen offer%', 'a discounted package price is rejected');
select throws_like($$ select tests.record(2, jsonb_set(jsonb_set(tests.essential_selection(),
    '{lines,1,unit_price_cents}', '1'), '{lines,1,line_total_cents}', '1')) $$,
  '%does not match the frozen offer%', 'a discounted gear price is rejected');
select throws_ok($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{lines,0,line_total_cents}', '1')) $$,
  '23514', null, 'a line total that is not quantity x unit price is rejected');
select throws_like($$ select tests.record(2, jsonb_set(jsonb_set(tests.signature_selection(), '{subtotal_cents}', '219999'), '{total_cents}', '252944')) $$,
  '%subtotal does not equal%', 'a subtotal that is not the sum of lines is rejected');
select throws_ok($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{total_cents}', '1')) $$,
  '23514', null, 'a total that is not subtotal + tax is rejected');
select throws_like($$ select tests.record(2, jsonb_set(jsonb_set(jsonb_set(tests.essential_selection(),
    '{tax_breakdown,1,amount_cents}', '16458'), '{tax_cents}', '24708'), '{total_cents}', '189708')) $$,
  '%tax breakdown does not match%', 'rounding half down instead of half up is rejected');
select throws_like($$ select tests.record(2, jsonb_set(jsonb_set(jsonb_set(jsonb_set(tests.signature_selection(),
    '{tax_breakdown,1,rate_ppm}', '0'), '{tax_breakdown,1,amount_cents}', '0'), '{tax_cents}', '11000'), '{total_cents}', '231000')) $$,
  '%tax breakdown does not match%', 'a tampered tax rate is rejected');
select throws_like($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{tax_breakdown}', '[]')) $$,
  '%tax breakdown does not match%', 'dropping taxes is rejected');
select throws_like($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{offer_sha256}', to_jsonb(repeat('a', 64)))) $$,
  '%different offer%', 'a selection priced against another offer is rejected');
select throws_like($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{package_key}', '"platinum"')) $$,
  '%package is not part of the offer%', 'a package outside the offer is rejected');
select throws_like($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{currency}', '"USD"')) $$,
  '%currency%', 'a different currency is rejected');
select throws_like($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{lines,1,quantity}', '3')) $$,
  '%does not match the frozen offer%', 'misstated included quantities are rejected');
select throws_like($$ select tests.record(2, jsonb_set(tests.signature_selection(), '{lines}', (tests.signature_selection() -> 'lines') - 0)) $$,
  '%exactly one package line%', 'a selection without its package line is rejected');
select throws_like($$ select tests.record(2, jsonb_set(tests.essential_selection(), '{lines,1,tax_category}', '"exempt"')) $$,
  '%does not match the frozen offer%', 'a tampered tax category is rejected');
select is((select current_selection_version from public.proposals where id = tests.pid()), 2,
  'no rejected attempt advanced the version');

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.proposal_selections set total_cents = 1 where proposal_id = tests.pid() $$,
  '23514', null, 'stored selection amounts cannot change');
select throws_ok($$ update public.proposal_selection_lines set unit_price_cents = 0 $$,
  '23514', null, 'selection lines cannot change');
select throws_ok($$ delete from public.proposal_selection_lines $$, '23514', null, 'selection lines cannot be deleted');
select throws_ok($$ delete from public.proposal_selections $$, '23514', null, 'selections cannot be deleted');
select throws_like(
  $$ select tests.exec_checked(format(
       'insert into public.proposal_selection_lines (tenant_id, selection_id, line_no, source, item_key, name, quantity, unit_price_cents, line_total_cents, tax_category)
        values (%L, %L, 9, %L, %L, %L, 1, 12000, 12000, %L)',
       tests.id('tenant_a'), (select id from public.proposal_selections where proposal_id = tests.pid() and version = 1),
       'optional', 'uplights_4', 'Sneaked in', 'standard')) $$,
  '%subtotal does not equal%', 'a line cannot be appended to an existing selection');
select ok((select bool_and(submitted_at is not null) from public.proposal_selections where proposal_id = tests.pid()),
  'every immutable selection is a submission stamped by the database');
select throws_ok($$ update public.proposal_selections set submitted_at = null where proposal_id = tests.pid() and version = 2 $$,
  '23514', null, 'submitted_at cannot be cleared or changed');

-- ---------------------------------------------------------------------------
-- The single mutable selection draft (client autosave, step 6)
-- ---------------------------------------------------------------------------
select is(public.save_proposal_selection_draft(tests.pid(), 0, 'signature', '{"uplights_4":1}', '{}'), 1,
  'first selection draft save creates version 1');
select is(public.save_proposal_selection_draft(tests.pid(), 1, 'essential', '{}', '{"ceremony_location":"same_room"}'), 2,
  'later saves update the same row');
select results_eq($$ select count(*)::int, max(version), max(package_key) from public.proposal_selection_drafts where proposal_id = tests.pid() $$,
  $$ values (1, 2, 'essential'::text) $$, 'one mutable draft per proposal, edited in place');
select throws_ok($$ select public.save_proposal_selection_draft(tests.pid(), 1, 'premium', '{}', '{}') $$,
  '40001', null, 'a stale selection draft version is rejected');
select is((select count(*)::int from public.proposal_selections where proposal_id = tests.pid()), 2,
  'autosaving the draft created no immutable selection versions');

-- ---------------------------------------------------------------------------
-- Visibility
-- ---------------------------------------------------------------------------
reset role;
select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.proposal_selections), 2, 'tenant staff can read selections');
select throws_ok($$ select public.save_proposal_selection_draft(tests.pid(), 2, 'premium', '{}', '{}') $$,
  '42501', null, 'staff cannot write the client selection draft');
select is((select count(*)::int from public.proposal_selection_drafts), 1, 'tenant staff can read the selection draft');
select tests.login_as(tests.id('owner_b'));
select is_empty($$ select * from public.proposal_selection_lines $$, 'another tenant cannot read selection lines');
select is_empty($$ select * from public.proposal_selection_drafts $$, 'another tenant cannot read selection drafts');

select * from finish();
rollback;
