-- Gear categories, pieces per unit, package gear order, proposal-specific
-- prices and preview_proposal_draft (20261108000100): tenant isolation and
-- cross-tenant assignment, snapshots unchanged when nothing new is used, the
-- frozen effective price verified on submission, and removed staff and
-- suspended workspaces refused.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(56);

update public.tenants set tax_categories = '{"standard":["GST","QST"]}' where id = tests.id('tenant_a');

create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.attempt(sql text) returns text
language plpgsql as $$
begin
  execute sql;
  return 'ok';
exception when others then
  return 'error:' || sqlstate;
end;
$$;
create function tests.affected(sql text) returns int
language plpgsql as $$
declare n int;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end;
$$;
create function tests.cat_a() returns uuid language sql stable as $$
  select id from public.gear_categories where tenant_id = tests.id('tenant_a') and name = 'Lighting' $$;
create function tests.keys(obj jsonb) returns text[] language sql immutable as $$
  select array_agg(k order by k) from jsonb_object_keys(obj) k $$;
create function tests.included(snapshot jsonb, pkg text) returns text[] language sql immutable as $$
  select array_agg(i ->> 'gear_key' order by ord)
  from jsonb_array_elements(snapshot -> 'packages') p, jsonb_array_elements(p -> 'included') with ordinality as x(i, ord)
  where p ->> 'key' = pkg $$;
create function tests.offer_sha(pid uuid) returns text language sql stable as $$
  select offer_sha256 from public.proposals where id = pid $$;
create function tests.line(source text, item text, name text, qty int, unit bigint)
returns jsonb language sql immutable as $$
  select jsonb_build_object('source', source, 'item_key', item, 'name', name, 'description', null, 'quantity', qty,
    'unit_price_cents', unit, 'line_total_cents', qty * unit, 'required_quantity', 0, 'required_reasons', '[]'::jsonb,
    'tax_category', 'standard') $$;
-- Signature, ceremony in the same room, two packs of uplights at `unit` each.
create function tests.uplights_selection(pid uuid, unit bigint) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pricing_version', 'flux-pricing-1', 'currency', 'CAD', 'package_key', 'signature',
    'addon_quantities', '{"uplights_4":2}'::jsonb,
    'logistics_answers', '{"ceremony_location":"same_room","needs_wireless_mic":false}'::jsonb,
    'requirements', '[]'::jsonb,
    'lines', jsonb_build_array(
      tests.line('package', 'signature', 'Signature', 1, 220000),
      tests.line('included', 'additional_speaker', 'Additional-location speaker', 1, 0),
      tests.line('optional', 'uplights_4', 'Uplights (pack of 4)', 2, unit)),
    'subtotal_cents', 220000 + 2 * unit,
    'tax_breakdown', jsonb_build_array(
      jsonb_build_object('code','GST','label','GST','rate_ppm',50000,'taxable_cents',220000 + 2 * unit,
        'amount_cents', (220000::bigint * 50000 + 500000) / 1000000 + (2 * unit * 50000 + 500000) / 1000000),
      jsonb_build_object('code','QST','label','QST','rate_ppm',99750,'taxable_cents',220000 + 2 * unit,
        'amount_cents', (220000::bigint * 99750 + 500000) / 1000000 + (2 * unit * 99750 + 500000) / 1000000)),
    'tax_cents', (220000::bigint * 50000 + 500000) / 1000000 + (2 * unit * 50000 + 500000) / 1000000
               + (220000::bigint * 99750 + 500000) / 1000000 + (2 * unit * 99750 + 500000) / 1000000,
    'total_cents', 220000 + 2 * unit
               + (220000::bigint * 50000 + 500000) / 1000000 + (2 * unit * 50000 + 500000) / 1000000
               + (220000::bigint * 99750 + 500000) / 1000000 + (2 * unit * 99750 + 500000) / 1000000,
    'offer_sha256', tests.offer_sha(pid));
$$;
-- Stores a submission and runs the commit-time money and choice checks now.
create function tests.try_submit(pid uuid, selection jsonb) returns text
language plpgsql as $$
begin
  perform private.insert_selection_submission(pid, selection, null);
  set constraints all immediate;
  set constraints all deferred;
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;
create function tests.with_overrides(overrides jsonb) returns jsonb language sql stable as $$
  select tests.base_offer() || jsonb_build_object('price_overrides', overrides) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Another business's category, and a package with two items for ordering.
insert into public.gear_categories (id, tenant_id, name, sort_order) values
  ('a1000000-0000-4000-8000-0000000000b1', tests.id('tenant_b'), 'Audio', 10);
insert into public.package_items (tenant_id, package_id, gear_item_id, quantity) values
  (tests.id('tenant_a'), tests.id('pkg_a_premium'), tests.id('gear_a_uplights'), 1);

-- Privileges -------------------------------------------------------------------------
select table_privs_are('public', 'gear_categories', 'authenticated', array['SELECT', 'DELETE'], 'gear_categories: select and delete at table level, column-scoped writes');
select table_privs_are('public', 'gear_categories', 'anon', array[]::text[], 'gear_categories: nothing for anon');
select has_trigger('public', 'gear_categories', 'gear_categories_workspace_suspended', 'category writes are refused in a suspended workspace');
select function_privs_are('public', 'preview_proposal_draft', array['uuid', 'jsonb'], 'anon', array[]::text[], 'anon cannot preview drafts');

-- A snapshot that uses nothing new is frozen exactly as before ---------------------------
select tests.login_as(tests.id('owner_a'));
select set_config('tests.before', tests.preview(tests.base_offer())::text, true);
select is(tests.keys(current_setting('tests.before')::jsonb -> 'gear' -> 'uplights_4'),
  array['description', 'key', 'media', 'name', 'tax_category', 'unit_label', 'unit_price_cents'],
  'uncategorized single-piece gear has no new snapshot fields');
select is((current_setting('tests.before')::jsonb -> 'gear' -> 'uplights_4' ->> 'unit_price_cents')::int, 12000, 'the catalog price is frozen without a custom price');
select is(tests.included(current_setting('tests.before')::jsonb, 'premium'), array['additional_speaker', 'uplights_4'],
  'included gear without an order keeps gear-key order');

-- Categories: isolation and assignment -----------------------------------------------------
select lives_ok($$ insert into public.gear_categories (tenant_id, name, sort_order) values (tests.id('tenant_a'), 'Lighting', 20) $$,
  'staff add a category to their business');
select throws_ok($$ insert into public.gear_categories (tenant_id, name) values (tests.id('tenant_a'), 'lighting') $$,
  '23505', null, 'category names are unique per business, ignoring case');
select throws_ok($$ insert into public.gear_categories (tenant_id, name) values (tests.id('tenant_b'), 'Lighting') $$,
  '42501', null, 'staff cannot add a category to another business');
select results_eq($$ select name from public.gear_categories order by name $$, $$ values ('Lighting'::text) $$,
  'staff see only their own business''s categories');
select is(tests.affected($$ update public.gear_categories set name = 'Hijacked' where id = 'a1000000-0000-4000-8000-0000000000b1' $$),
  0, 'nor rename another business''s category');
select is(tests.affected($$ delete from public.gear_categories where id = 'a1000000-0000-4000-8000-0000000000b1' $$), 0, 'nor delete it');
select throws_ok($$ update public.gear_items set category_id = 'a1000000-0000-4000-8000-0000000000b1' where id = tests.id('gear_a_uplights') $$,
  '23503', null, 'another business''s category cannot be assigned to gear');
select throws_ok($$ insert into public.gear_items (tenant_id, key, name, default_price_cents, category_id)
  values (tests.id('tenant_a'), 'cross_tenant', 'Cross', 100, 'a1000000-0000-4000-8000-0000000000b1') $$,
  '23503', null, 'not even when creating gear');
select lives_ok($$ update public.gear_items set category_id = tests.cat_a(), pieces_per_unit = 4, piece_label = 'lights'
  where id = tests.id('gear_a_uplights') $$, 'staff categorize their gear and say what one unit holds');
select throws_ok($$ update public.gear_items set pieces_per_unit = 0 where id = tests.id('gear_a_speaker') $$, '23514', null, 'at least one piece per unit');
select tests.login_as(tests.id('owner_b'));
select is_empty($$ select id from public.gear_categories where tenant_id = tests.id('tenant_a') $$, 'another business sees none of them');
select tests.login_as_anon();
select throws_ok($$ select * from public.gear_categories $$, '42501', null, 'anon cannot read categories');

-- New snapshot fields, only when set ---------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select set_config('tests.after', tests.preview(tests.base_offer())::text, true);
select is(current_setting('tests.after')::jsonb -> 'gear' -> 'uplights_4' -> 'category', '{"name":"Lighting","sort_order":20}'::jsonb,
  'the category is frozen with its order');
select is((current_setting('tests.after')::jsonb -> 'gear' -> 'uplights_4') - array['category', 'pieces_per_unit', 'piece_label']
          || '{}'::jsonb,
  (current_setting('tests.before')::jsonb -> 'gear' -> 'uplights_4'), 'and nothing else about the gear changes');
select is(current_setting('tests.after')::jsonb #> '{gear,uplights_4,pieces_per_unit}', '4'::jsonb, 'pieces per unit are frozen');
select is(current_setting('tests.after')::jsonb #>> '{gear,uplights_4,piece_label}', 'lights', 'with their label');
select is(tests.keys(current_setting('tests.after')::jsonb -> 'gear' -> 'additional_speaker'),
  array['description', 'key', 'media', 'name', 'tax_category', 'unit_label', 'unit_price_cents'], 'other gear is frozen as before');

-- Package gear order ---------------------------------------------------------------------------
select lives_ok(format($q$ select public.set_package_items(%L, %L) $q$, tests.id('pkg_a_premium'),
  jsonb_build_array(
    jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'quantity', 1, 'sort_order', 0),
    jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 2, 'sort_order', 1))),
  'staff save the order of a package''s gear');
select is(tests.included(tests.preview(tests.base_offer()), 'premium'), array['uplights_4', 'additional_speaker'], 'offers freeze the chosen order');
select lives_ok(format($q$ select public.set_package_items(%L, %L) $q$, tests.id('pkg_a_premium'),
  jsonb_build_array(
    jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'quantity', 1),
    jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 2))),
  'items without an order (the previous app) are still accepted');
select is(tests.included(tests.preview(tests.base_offer()), 'premium'), array['additional_speaker', 'uplights_4'], 'and keep gear-key order');
select throws_ok(format($q$ select public.set_package_items(%L, %L) $q$, tests.id('pkg_a_premium'),
  jsonb_build_array(jsonb_build_object('gear_item_id', tests.id('gear_a_speaker'), 'quantity', 2, 'sort_order', -1))),
  '22023', null, 'the order must be a whole number');

-- Proposal-specific prices --------------------------------------------------------------------------
select ok(private.is_valid_draft_offer(tests.with_overrides(jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 10000)))), 'a custom price is a valid draft field');
select ok(not private.is_valid_draft_offer(tests.with_overrides(jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', -1)))), 'negative prices are rejected');
select ok(not private.is_valid_draft_offer(tests.with_overrides(jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 99.5)))), 'fractional cents are rejected');
select ok(not private.is_valid_draft_offer(tests.with_overrides(jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 100),
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 200)))), 'one price per item');
select ok(not private.is_valid_draft_offer(tests.with_overrides(jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 100, 'note', 'x')))), 'no other fields');

select set_config('tests.custom', tests.preview(tests.with_overrides(jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 10000),
  -- Another business's gear: not part of this offer, so it has no effect.
  jsonb_build_object('gear_item_id', tests.id('gear_b_speaker'), 'unit_price_cents', 1))))::text, true);
select is((current_setting('tests.custom')::jsonb #>> '{gear,uplights_4,unit_price_cents}')::int, 10000, 'the custom price is frozen as the unit price');
select is((current_setting('tests.custom')::jsonb #>> '{gear,additional_speaker,unit_price_cents}')::int, 15000, 'other gear keeps its catalog price');
select ok(not (current_setting('tests.custom')::jsonb -> 'gear') ? 'speaker', 'a price for gear outside the offer is ignored, not frozen');
select is((select default_price_cents from public.gear_items where id = tests.id('gear_a_uplights'))::int, 12000, 'the catalog price never changes');

-- Previewing unsaved edits ------------------------------------------------------------------------------
select set_config('tests.p1', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select set_config('tests.v1', (select draft_version::text from public.proposals where id = current_setting('tests.p1')::uuid), true);
select is((public.preview_proposal_draft(current_setting('tests.p1')::uuid, tests.with_overrides(jsonb_build_array(
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 9000)))) #>> '{gear,uplights_4,unit_price_cents}')::int,
  9000, 'the preview shows unsaved edits');
select is((select draft_version::text || (draft_offer -> 'price_overrides' -> 0 ->> 'unit_price_cents')
           from public.proposals where id = current_setting('tests.p1')::uuid),
  current_setting('tests.v1') || '10000', 'and saves nothing');
select throws_like($$ select public.preview_proposal_draft(current_setting('tests.p1')::uuid, '{"surprise":1}') $$,
  '%invalid shape%', 'an invalid draft is refused');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.preview_proposal_draft(current_setting('tests.p1')::uuid, tests.base_offer()) $$,
  'P0002', 'not found', 'another business cannot preview it');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.preview_proposal_draft(current_setting('tests.p1')::uuid, tests.base_offer()) $$,
  'P0002', 'not found', 'nor a client');

-- Sending freezes the custom price; the database verifies submissions against it -----------------------------
select tests.login_as(tests.id('owner_a'));
select is((tests.send(current_setting('tests.p1')::uuid) ->> 'status'), 'sent', 'a proposal with a custom price is sent');
select throws_like($$ select public.preview_proposal_draft(current_setting('tests.p1')::uuid, tests.base_offer()) $$,
  '%frozen%', 'a sent proposal cannot be previewed as a draft');
select tests.su();
select is((select (offer_snapshot #>> '{gear,uplights_4,unit_price_cents}')::int from public.proposals where id = current_setting('tests.p1')::uuid),
  10000, 'the frozen offer carries the custom price');
select is(tests.try_submit(current_setting('tests.p1')::uuid, tests.uplights_selection(current_setting('tests.p1')::uuid, 12000)),
  'invalid priced selection: line 3 (uplights_4) does not match the frozen offer', 'a selection priced at the catalog price is rejected');
select is(tests.try_submit(current_setting('tests.p1')::uuid, tests.uplights_selection(current_setting('tests.p1')::uuid, 10000)),
  'ok', 'a selection priced at the custom price, with exact taxes, is accepted');

-- Catalog edits after sending change nothing the client was sent.
select set_config('tests.frozen', (select offer_snapshot::text from public.proposals where id = current_setting('tests.p1')::uuid), true);
update public.gear_items set default_price_cents = 50000, pieces_per_unit = 1, piece_label = null, category_id = null where id = tests.id('gear_a_uplights');
delete from public.gear_categories where id = tests.cat_a();
select is((select offer_snapshot::text from public.proposals where id = current_setting('tests.p1')::uuid), current_setting('tests.frozen'),
  'the sent offer keeps its prices, category, pieces and order');

-- A revision starts with the same custom prices.
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p2', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select is((select draft_offer -> 'price_overrides' from public.proposals where id = current_setting('tests.p2')::uuid),
  (select draft_offer -> 'price_overrides' from public.proposals where id = current_setting('tests.p1')::uuid),
  'a revision carries the custom prices forward');
select is((select draft_offer #> '{price_overrides,0}' from public.proposals where id = current_setting('tests.p2')::uuid),
  jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'unit_price_cents', 10000), 'including the uplights price');

-- Removed staff and suspended workspaces --------------------------------------------------------------------------
select tests.su();
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select tests.login_as(tests.id('staff_a'));
select is_empty($$ select id from public.gear_categories $$, 'removed staff see no categories');
select throws_ok($$ insert into public.gear_categories (tenant_id, name) values (tests.id('tenant_a'), 'Effects') $$, '42501', null, 'nor add one');
select throws_ok($$ select public.preview_proposal_draft(current_setting('tests.p2')::uuid, tests.base_offer()) $$, 'P0002', 'not found', 'nor preview drafts');

select tests.su();
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select tests.login_as(tests.id('owner_a'));
select is(tests.attempt($$ insert into public.gear_categories (tenant_id, name) values (tests.id('tenant_a'), 'Effects') $$), 'error:PT423',
  'a suspended workspace cannot add categories');
select throws_ok($$ select public.preview_proposal_draft(current_setting('tests.p2')::uuid, tests.base_offer()) $$, 'PT423', null,
  'nor preview drafts');

select * from finish();
rollback;
