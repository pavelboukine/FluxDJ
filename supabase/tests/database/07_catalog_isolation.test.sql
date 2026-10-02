-- Catalog and template rows are visible and writable only by staff of the
-- owning tenant. Clients and anon get nothing (spec 7 and 11).
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
select plan(44);

-- Per-table helper: as the current role, how many rows of each tenant?
create function tests.tenant_counts(tbl text) returns table (tenant uuid, n int)
language plpgsql as $$
begin
  return query execute format('select tenant_id, count(*)::int from public.%I group by tenant_id order by tenant_id', tbl);
end;
$$;
grant execute on function tests.tenant_counts(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- SELECT: owner A sees only tenant A, for every catalog table.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select is_empty(format($$ select * from tests.tenant_counts(%L) where tenant <> tests.id('tenant_a') $$, t),
                'owner A sees no tenant B rows in ' || t)
from unnest(array['gear_items', 'gear_media', 'packages', 'package_items', 'logistics_questions',
                  'logistics_rules', 'proposal_templates', 'proposal_template_packages',
                  'proposal_template_addons', 'proposal_template_questions']) t;
select isnt_empty($$ select * from public.gear_items $$, 'owner A sees own gear');

select tests.login_as(tests.id('staff_a'));
select results_eq($$ select key from public.packages order by key $$,
  array['essential', 'signature'], 'staff A sees tenant A packages only');

select tests.login_as(tests.id('owner_b'));
select results_eq($$ select key from public.gear_items $$,
  array['speaker'], 'owner B sees tenant B gear only');

-- ---------------------------------------------------------------------------
-- Clients (even with event access at both DJs) and strangers see nothing.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('client_x'));
select is_empty(format($$ select * from public.%I $$, t), 'client sees no ' || t)
from unnest(array['gear_items', 'gear_media', 'packages', 'package_items', 'logistics_questions',
                  'logistics_rules', 'proposal_templates', 'proposal_template_packages',
                  'proposal_template_addons', 'proposal_template_questions']) t;

select tests.login_as(tests.id('stranger'));
select is_empty($$ select * from public.gear_items $$, 'user without membership sees no gear');
select is_empty($$ select * from public.logistics_rules $$, 'user without membership sees no rules');

-- ---------------------------------------------------------------------------
-- INSERT into tenant B is rejected for owner A.
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select throws_ok(
  $$ insert into public.gear_items (tenant_id, key, name, default_price_cents) values (tests.id('tenant_b'), 'planted', 'Planted', 1) $$,
  '42501', null, 'owner A cannot add gear to tenant B');
select throws_ok(
  $$ insert into public.packages (tenant_id, key, name, base_price_cents) values (tests.id('tenant_b'), 'planted', 'Planted', 1) $$,
  '42501', null, 'owner A cannot add a package to tenant B');
select throws_ok(
  $$ insert into public.package_items (tenant_id, package_id, gear_item_id, quantity) values (tests.id('tenant_b'), tests.id('pkg_b_basic'), tests.id('gear_b_speaker'), 5) $$,
  '42501', null, 'owner A cannot change tenant B package contents');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_b'), tests.id('q_b_ceremony'), '{"op":"equals","value":false}', tests.id('gear_b_speaker'), 9, 'x') $$,
  '42501', null, 'owner A cannot add rules to tenant B');
select throws_ok(
  $$ insert into public.proposal_templates (tenant_id, name) values (tests.id('tenant_b'), 'Planted') $$,
  '42501', null, 'owner A cannot add templates to tenant B');
select throws_ok(
  $$ insert into public.gear_media (tenant_id, gear_item_id, storage_path, kind, content_type, alt_text)
     values (tests.id('tenant_b'), tests.id('gear_b_speaker'), tests.media_path('tenant_b', 'gear_b_speaker', 'obj_a', 'png'), 'image', 'image/png', 'x') $$,
  '42501', null, 'owner A cannot register media for tenant B');

-- ---------------------------------------------------------------------------
-- UPDATE / DELETE of tenant B rows affect nothing.
-- ---------------------------------------------------------------------------
select is_empty($$ update public.gear_items set default_price_cents = 1 where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot reprice tenant B gear');
select is_empty($$ update public.packages set base_price_cents = 1 where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot reprice tenant B packages');
select is_empty($$ update public.logistics_rules set required_quantity = 9 where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot edit tenant B rules');
select is_empty($$ update public.gear_media set active = false where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot archive tenant B media');
select is_empty($$ delete from public.package_items where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot remove tenant B package contents');
select is_empty($$ delete from public.proposal_template_addons where tenant_id = tests.id('tenant_b') returning id $$,
  'owner A cannot remove tenant B template addons');

-- Own tenant works.
select isnt_empty($$ update public.gear_items set default_price_cents = 16000 where id = tests.id('gear_a_speaker') returning id $$,
  'owner A can reprice own gear');
select isnt_empty($$ delete from public.proposal_template_addons where tenant_id = tests.id('tenant_a') returning id $$,
  'owner A can edit own template addons');

-- Clients cannot write catalog rows of a DJ they work with.
select tests.login_as(tests.id('client_x'));
select throws_ok(
  $$ insert into public.gear_items (tenant_id, key, name, default_price_cents) values (tests.id('tenant_a'), 'free_stuff', 'Free', 0) $$,
  '42501', null, 'client cannot add gear');
select is_empty($$ update public.packages set base_price_cents = 0 returning id $$,
  'client cannot change package prices');

-- Anon has no access.
select tests.login_as_anon();
select throws_ok($$ select * from public.gear_items $$, '42501', null, 'anon cannot read gear');
select throws_ok($$ select * from public.proposal_templates $$, '42501', null, 'anon cannot read templates');

reset role;
select results_eq($$ select default_price_cents from public.gear_items where id = tests.id('gear_b_speaker') $$,
  array[20000::bigint], 'tenant B gear price unchanged');

select * from finish();
rollback;
