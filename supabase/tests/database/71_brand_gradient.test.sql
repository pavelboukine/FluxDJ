-- Gradient branding: an accent colour and an explicit preference inside
-- brand_colors. Opt-in only (an accent alone is never a gradient), owner-only,
-- versioned, frozen with a sent proposal, and optional so the deployed app
-- keeps working.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(31);

create function tests.brand(tenant text, version int, color text, accent text default null, gradient boolean default null) returns int language plpgsql as $$
begin
  return public.update_tenant_branding(tests.id(tenant), version, null, color, null, accent, gradient);
end $$;
create function tests.colors(tenant text) returns jsonb language sql as $$
  select brand_colors from public.tenants where id = tests.id(tenant);
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- The validator: the preference is "on" or absent, and always has its accent.
select ok(private.is_valid_brand_colors('{"primary":"#111827","accent":"#E11D48"}'), 'an accent alone stays valid');
select ok(private.is_valid_brand_colors('{"primary":"#111827","accent":"#e11d48","gradient":"on"}'), 'a gradient with its accent is valid');
select ok(not private.is_valid_brand_colors('{"primary":"#111827","gradient":"on"}'), 'a gradient without an accent is not');
select ok(not private.is_valid_brand_colors('{"accent":"#e11d48","gradient":"off"}'), 'the preference is never stored as off');
select ok(not private.is_valid_brand_colors('{"accent":"#e11d48","gradient":true}'), 'nor as a boolean');
select ok(not private.is_valid_brand_colors('{"accent":"#e11d48","gradient":"#e11d48"}'), 'nor as a colour');
select ok(not private.is_valid_brand_colors('{"primary":"on"}'), 'a colour is still a hex value');
select ok(not private.is_valid_brand_colors('{"angle":"#111827"}'), 'unknown keys are still refused');
select throws_ok($$ update public.tenants set brand_colors = '{"gradient":"on"}' where id = tests.id('tenant_a') $$, '23514', null, 'the column constraint enforces it');

-- Existing businesses: an accent from before gradients (the local seed has one) means nothing.
update public.tenants set brand_colors = '{"accent":"#e11d48"}', tax_categories = '{"standard": ["GST", "QST"]}' where id = tests.id('tenant_a');
select is(tests.colors('tenant_a') ? 'accent', true, 'a business can already hold an accent');
select is(tests.colors('tenant_a') ? 'gradient', false, 'and it is not a gradient until its owner chooses one');
select is(has_function_privilege('anon', 'public.update_tenant_branding(uuid, integer, uuid, text, integer, text, boolean, uuid, boolean)', 'execute'), false, 'anonymous visitors can''t change branding');

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select tests.brand('tenant_a', 0, '#1e3a8a', '#7c3aed', true) $$, '42501', null, 'staff cannot turn it on');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select tests.brand('tenant_a', 0, '#1e3a8a', '#7c3aed', true) $$, 'P0002', 'not found', 'another business''s owner cannot');
reset role; select set_config('request.jwt.claims', '', true);

select tests.login_as(tests.id('owner_a'));
-- Five named arguments: how the deployed app calls it until this release ships.
select is(public.update_tenant_branding(p_tenant_id => tests.id('tenant_a'), p_expected_version => 0, p_logo_id => null, p_primary_color => '#1e3a8a', p_logo_size_percent => 110), 1, 'the earlier call still works');
select is(tests.colors('tenant_a'), '{"primary":"#1e3a8a","accent":"#e11d48"}'::jsonb, 'and changes neither the accent nor the preference');

-- A proposal sent before the owner opts in.
select set_config('tests.before', public.open_proposal_draft(tests.id('event_a1'), tests.base_offer())::text, true);
select tests.send(current_setting('tests.before')::uuid);

select throws_like($$ select tests.brand('tenant_a', 1, '#1e3a8a', 'purple', true) $$, '%accent colour must be a hex value%', 'an accent that is not a colour is refused');
select is(tests.brand('tenant_a', 1, '#1e3a8a', ' #7C3AED ', true), 2, 'the owner turns the gradient on with an accent');
select is(tests.colors('tenant_a'), '{"primary":"#1e3a8a","accent":"#7c3aed","gradient":"on"}'::jsonb, 'both are stored, the accent normalized');
select throws_ok($$ select tests.brand('tenant_a', 1, '#1e3a8a', '#000000', false) $$, 'PT409', null, 'a stale tab cannot overwrite it');
select is(tests.brand('tenant_a', 2, null, null, null), 3, 'a save that says nothing about the gradient');
select is(tests.colors('tenant_a'), '{"accent":"#7c3aed","gradient":"on"}'::jsonb, 'keeps it, with the default primary colour');
select is(tests.brand('tenant_a', 3, '#1e3a8a', null, false), 4, 'the owner turns the gradient off');
select is(tests.colors('tenant_a'), '{"primary":"#1e3a8a","accent":"#7c3aed"}'::jsonb, 'which keeps the accent for later');
select is(tests.brand('tenant_a', 4, '#1e3a8a', null, true), 5, 'and can turn it back on with the remembered accent');
reset role; select set_config('request.jwt.claims', '', true);

select is((select offer_snapshot -> 'branding' -> 'brand_colors' from public.proposals where id = current_setting('tests.before')::uuid),
  '{"primary":"#1e3a8a","accent":"#e11d48"}'::jsonb, 'a proposal sent before the gradient keeps its solid branding');
select results_eq(
  $$ select metadata ->> 'accent_color', (metadata ->> 'gradient')::boolean from public.audit_events
     where entity_id = tests.id('tenant_a') and action = 'branding_updated' and (metadata ->> 'version')::int = 2 $$,
  $$ values ('#7c3aed'::text, true) $$, 'the change is audited');
select is(tests.colors('tenant_b') ? 'gradient', false, 'another business is untouched');

select tests.login_as_service();
select is(public.public_tenant_brand('test-bouprod') -> 'brand_colors' ->> 'gradient', 'on', 'client pages can read the preference');
reset role; select set_config('request.jwt.claims', '', true);

-- A business with no accent at all can't have a gradient without one.
update public.tenants set brand_colors = '{}' where id = tests.id('tenant_b');
select tests.login_as(tests.id('owner_b'));
select throws_like($$ select tests.brand('tenant_b', 0, '#0f172a', null, true) $$, '%choose an accent colour%', 'a gradient needs an accent');
reset role; select set_config('request.jwt.claims', '', true);
select is(tests.colors('tenant_b'), '{}'::jsonb, 'and nothing changed');

select * from finish();
rollback;
