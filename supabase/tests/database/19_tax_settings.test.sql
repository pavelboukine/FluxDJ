-- Tax settings (owner only, through update_tax_settings): validation, the
-- optimistic version, explicit "no tax" versus a missing mapping, new offers
-- reading the new settings, and frozen snapshots staying unchanged.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(42);

create function tests.gst_qst() returns jsonb language sql immutable as $$
  select '[{"code":"GST","label":"GST","rate_ppm":50000},{"code":"QST","label":"QST","rate_ppm":99750}]'::jsonb $$;
grant execute on function tests.gst_qst() to authenticated;

-- ===========================================================================
-- A missing mapping is an error
-- ===========================================================================
select is((select tax_settings_version from public.tenants where id = tests.id('tenant_a')), 1, 'tax settings start at version 1');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.preview(tests.base_offer()) $$,
  '%offer_invalid: tax categories not configured for this tenant: standard%', 'an unmapped category blocks the preview');

-- ===========================================================================
-- Owner only, tenant isolated, and no direct column writes
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"standard":["GST"]}') $$,
  '42501', null, 'staff who are not the owner cannot change tax settings');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"standard":["GST"]}') $$,
  'P0002', 'not found', 'another tenant''s owner cannot change them');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"standard":["GST"]}') $$,
  'P0002', 'not found', 'a client cannot change them');
select tests.login_as_anon();
select throws_ok($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"standard":["GST"]}') $$,
  '42501', null, 'anon cannot call it');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.tenants set tax_categories = '{"standard":[]}' where id = tests.id('tenant_a') $$,
  '42501', null, 'even the owner cannot write the category mapping directly');
select throws_ok($$ update public.tenants set tax_config = '[]' where id = tests.id('tenant_a') $$,
  '42501', null, 'nor the tax list');
reset role;
select is((select tax_categories from public.tenants where id = tests.id('tenant_a')), '{}'::jsonb, 'nothing was changed by refused calls');

-- ===========================================================================
-- Validation
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, '[{"code":"GST","label":"GST","rate_ppm":0.05}]', '{}') $$,
  '%rate for GST must be from 0% to 100%%', 'a fractional ppm (float rate) is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, '[{"code":"GST","label":"GST","rate_ppm":1000001}]', '{}') $$,
  '%rate for GST%', 'a rate above 100% is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, '[{"code":"GST","label":"GST","rate_ppm":-1}]', '{}') $$,
  '%rate for GST%', 'a negative rate is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, '[{"code":"GST","label":"GST","rate_ppm":"50000"}]', '{}') $$,
  '%rate for GST%', 'a rate given as a string is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, '[{"code":"gst","label":"GST","rate_ppm":5}]', '{}') $$,
  '%invalid tax code%', 'a malformed code is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, '[{"code":"GST","label":"  ","rate_ppm":5}]', '{}') $$,
  '%name of 1 to 40%', 'a blank name is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1,
    '[{"code":"A","label":"A","rate_ppm":1},{"code":"B","label":"B","rate_ppm":1},{"code":"C","label":"C","rate_ppm":1},
      {"code":"D","label":"D","rate_ppm":1},{"code":"E","label":"E","rate_ppm":1},{"code":"F","label":"F","rate_ppm":1}]', '{}') $$,
  '%at most 5 taxes%', 'more than five taxes are rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1,
    '[{"code":"A","label":"Tax","rate_ppm":1},{"code":"B","label":" tax ","rate_ppm":2}]', '{}') $$,
  '%same name%', 'duplicate names are rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"Standard":["GST"]}') $$,
  '%invalid tax category Standard%', 'a malformed category key is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"standard":"GST"}') $$,
  '%invalid tax category standard%', 'a mapping that is not a list is rejected');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"standard":["GST","PST"]}') $$,
  '%not configured: standard (PST)%', 'a mapping to an unknown tax is rejected');
select throws_ok($$ select public.update_tax_settings(tests.id('tenant_a'), 2, tests.gst_qst(), '{"standard":["GST"]}') $$,
  '40001', null, 'a stale or future version is a conflict');

-- ===========================================================================
-- Multiple taxes on standard; a new offer uses them
-- ===========================================================================
select is(public.update_tax_settings(tests.id('tenant_a'), 1,
    '[{"code":"GST","label":" GST ","rate_ppm":50000},{"code":"QST","label":"QST","rate_ppm":99750}]',
    '{"standard":["GST","QST"]}'), 2, 'the owner saves two taxes on standard; the version increases');
select throws_ok($$ select public.update_tax_settings(tests.id('tenant_a'), 1, tests.gst_qst(), '{"standard":["GST"]}') $$,
  '40001', null, 'the old version is now stale (a second tab cannot overwrite)');
reset role;
select is((select tax_config from public.tenants where id = tests.id('tenant_a')), tests.gst_qst(), 'labels are stored trimmed, exactly in ppm');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.preview1', tests.preview(tests.base_offer())::text, true);
select is(current_setting('tests.preview1')::jsonb -> 'tax',
  jsonb_build_object('rounding', 'per_line_per_tax_half_up', 'rates', tests.gst_qst(), 'categories', '{"standard":["GST","QST"]}'::jsonb),
  'the preview carries both taxes for standard');
select set_config('tests.p1', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select lives_ok($$ select tests.send(current_setting('tests.p1')::uuid) $$, 'the offer can now be sent');
reset role;
create temp table saved as select offer_snapshot, offer_sha256 from public.proposals where id = current_setting('tests.p1')::uuid;
grant select on saved to authenticated;

-- ===========================================================================
-- Removal rules
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 2,
    '[{"code":"GST","label":"GST","rate_ppm":50000}]', '{"standard":["GST","QST"]}') $$,
  '%not configured: standard (QST)%', 'a tax cannot be removed while a category uses it');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 2, tests.gst_qst(), '{}') $$,
  '%must stay configured: standard%', 'a category used by active gear and packages cannot be unmapped');
select is(public.update_tax_settings(tests.id('tenant_a'), 2, tests.gst_qst(), '{"standard":["GST","QST"],"exempt":[]}'), 3,
  'an unused category can be added');
select is(public.update_tax_settings(tests.id('tenant_a'), 3, tests.gst_qst(), '{"standard":["GST","QST"]}'), 4,
  'and removed again while unused');

-- ===========================================================================
-- Explicit no tax is valid and differs from missing
-- ===========================================================================
select is(public.update_tax_settings(tests.id('tenant_a'), 4, '[{"code":"GST","label":"Federal","rate_ppm":55000}]', '{"standard":[]}'), 5,
  'standard can be explicitly configured with no taxes, and QST removed with it');
select set_config('tests.preview2', tests.preview(tests.base_offer(), 'event_a2')::text, true);
select is(current_setting('tests.preview2')::jsonb #> '{tax,categories}', '{"standard":[]}'::jsonb,
  'a new offer freezes the explicit empty mapping (no tax)');
select is(current_setting('tests.preview2')::jsonb #> '{tax,rates}', '[{"code":"GST","label":"Federal","rate_ppm":55000}]'::jsonb,
  'and the updated rate');

-- ===========================================================================
-- Existing snapshots are independent
-- ===========================================================================
reset role;
select is((select offer_snapshot from public.proposals where id = current_setting('tests.p1')::uuid), (select offer_snapshot from saved),
  'the sent offer keeps its frozen taxes');
select is((select offer_sha256 from public.proposals where id = current_setting('tests.p1')::uuid), (select offer_sha256 from saved),
  'and its hash');
select is((select offer_snapshot #> '{tax,categories}' from public.proposals where id = current_setting('tests.p1')::uuid),
  '{"standard":["GST","QST"]}'::jsonb, 'the frozen mapping is still GST + QST');

-- ===========================================================================
-- Audit and isolation
-- ===========================================================================
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'tax_settings_updated'), 4,
  'every saved change is audited');
select is((select array_agg(distinct actor_id) from public.audit_events where entity_id = tests.id('tenant_a') and action = 'tax_settings_updated'),
  array[tests.id('owner_a')], 'with the owner as actor');
select results_eq($$ select tax_config, tax_categories, tax_settings_version from public.tenants where id = tests.id('tenant_b') $$,
  $$ values ('[]'::jsonb, '{}'::jsonb, 1) $$, 'tenant B is untouched');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.tenants where id = tests.id('tenant_a')), 0, 'tenant B''s owner cannot read tenant A''s settings');
select tests.login_as(tests.id('staff_a'));
select is((select tax_categories from public.tenants where id = tests.id('tenant_a')), '{"standard":[]}'::jsonb,
  'staff can read the settings (read-only view)');
select throws_like($$ select public.update_tax_settings(tests.id('tenant_a'), 5, tests.gst_qst(), '{"standard":["GST"]}') $$,
  '%only the owner%', 'but still cannot change them with the current version');

select * from finish();
rollback;
