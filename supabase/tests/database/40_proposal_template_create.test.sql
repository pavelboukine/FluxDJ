-- Creating a proposal template with its contents (create_proposal_template):
-- who may call it, that the template and its packages, add-ons and
-- questions are saved together or not at all, with the same checks as
-- editing them, and that a retry with the same id returns the template
-- already created.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
select plan(20);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('template-create-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.create_tpl(req text, packages text[], recommended text, questions text[] default '{}', who text default 'staff_a', tenant text default 'tenant_a', name text default 'Wedding') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.create_proposal_template(
    tests.id(tenant), tests.id(req), name, 'Welcome!', 21,
    coalesce((select jsonb_agg(tests.id(p) order by o) from unnest(packages) with ordinality u(p, o)), '[]'),
    case when recommended is null then null else tests.id(recommended) end,
    jsonb_build_array(jsonb_build_object('gear_item_id', tests.id('gear_a_uplights'), 'recommended_quantity', 1, 'max_quantity', 4)),
    coalesce((select jsonb_agg(tests.id(q) order by o) from unnest(questions) with ordinality u(q, o)), '[]'));
  perform tests.su();
  return r;
end $$;
create function tests.templates_named(n text) returns int language sql as $$
  select count(*)::int from public.proposal_templates where name = n;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select tests.su();
insert into public.packages (id, tenant_id, key, name, base_price_cents) values (tests.id('pkg_a_third'), tests.id('tenant_a'), 'premium_test', 'Premium', 300000);

-- Access ------------------------------------------------------------------------
select tests.login_as_anon();
select throws_ok($$ select public.create_proposal_template(tests.id('tenant_a'), tests.id('req_anon'), 'Anon', null, 14, '[]', null, '[]', '[]') $$,
  '42501', null, 'anon cannot create a template');
select tests.su();
select throws_ok($$ select tests.create_tpl('req_b', '{}', null, '{}', 'owner_b') $$, 'P0002', 'not found', 'another business cannot create one here');
select throws_ok($$ select tests.create_tpl('req_c', '{}', null, '{}', 'client_y') $$, 'P0002', 'not found', 'nor can a client');

-- All or nothing -----------------------------------------------------------------------
select is(tests.create_tpl('req_ok', array['pkg_a_basic', 'pkg_a_plus', 'pkg_a_third'], 'pkg_a_plus', array['q_a_mic', 'q_a_ceremony'], name => 'Full'),
  jsonb_build_object('id', tests.id('req_ok'), 'replayed', false), 'staff create a template with its contents');
select is((select name || '|' || intro || '|' || expiry_days || '|' || active from public.proposal_templates where id = tests.id('req_ok')),
  'Full|Welcome!|21|true', 'with its details, active');
select is((select array_agg(package_id order by sort_order) from public.proposal_template_packages where template_id = tests.id('req_ok')),
  array[tests.id('pkg_a_basic'), tests.id('pkg_a_plus'), tests.id('pkg_a_third')], 'its three packages in order');
select is((select default_package_id from public.proposal_templates where id = tests.id('req_ok')), tests.id('pkg_a_plus'), 'the recommended package');
select is((select array_agg(question_id order by sort_order) from public.proposal_template_questions where template_id = tests.id('req_ok')),
  array[tests.id('q_a_mic'), tests.id('q_a_ceremony')], 'its questions in the given order');
select is((select recommended_quantity || '/' || max_quantity from public.proposal_template_addons where template_id = tests.id('req_ok')), '1/4', 'and its add-on');

select throws_ok($$ select tests.create_tpl('req_dup', array['pkg_a_basic', 'pkg_a_basic'], null, name => 'Dup') $$, '23505', null, 'the same package twice is refused');
select is(tests.templates_named('Dup'), 0, 'and no template is left behind');
select throws_ok($$ select tests.create_tpl('req_rec', array['pkg_a_basic'], 'pkg_a_plus', name => 'Rec') $$, '23503', null,
  'a recommended package that is not offered is refused');
select is(tests.templates_named('Rec'), 0, 'nothing is left behind');
select throws_ok($$ select tests.create_tpl('req_foreign', array['pkg_a_basic', 'pkg_b_basic'], null, name => 'Foreign') $$, '23503', null,
  'another business''s package is refused');
select throws_ok($$ select tests.create_tpl('req_four', array['pkg_a_basic', 'pkg_a_plus', 'pkg_a_third', 'pkg_a_basic'], null, name => 'Four') $$, null, null,
  'more than three packages is refused');
select is(tests.templates_named('Foreign') + tests.templates_named('Four'), 0, 'nothing is left behind');

-- Retry after a lost response --------------------------------------------------------------
select is(tests.create_tpl('req_ok', '{}', null, name => 'Retry'), jsonb_build_object('id', tests.id('req_ok'), 'replayed', true),
  'a retry with the same id returns the template already created');
select is(tests.templates_named('Full') + tests.templates_named('Retry'), 1, 'no second template, contents unchanged');
select throws_ok($$ select tests.create_tpl('req_ok', '{}', null, '{}', 'owner_b', 'tenant_b') $$, 'P0002', 'not found', 'another business cannot claim the id');

-- Suspended workspace -------------------------------------------------------------
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select throws_like($$ select tests.create_tpl('req_suspended', '{}', null, name => 'Suspended') $$, '%workspace_suspended%', 'a suspended workspace is refused');

select * from finish();
rollback;
