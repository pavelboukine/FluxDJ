-- Creating a contract template in one retry-safe step (create_contract_template_once):
-- who may call it, the same checks as create_contract_template, a draft
-- version 1, and that the same id returns the template already created.
-- Concurrency is covered by tests/integration/contract-template-create.test.ts.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(16);

create function tests.req(name text) returns uuid language sql immutable as $$
  select md5('contract-create-once-' || name)::uuid;
$$;
grant execute on function tests.req(text) to anon, authenticated, service_role;

-- Access ------------------------------------------------------------------------
select tests.login_as_anon();
select throws_ok($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('anon'), 'Anon', 'T', tests.simple_sections()) $$,
  '42501', null, 'anon cannot create a template');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('b'), 'Theirs', 'T', tests.simple_sections()) $$,
  'P0002', 'not found', 'another business cannot create one here');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('c'), 'Mine', 'T', tests.simple_sections()) $$,
  'P0002', 'not found', 'nor can a client');

-- The same checks as before ---------------------------------------------------------
select tests.login_as(tests.id('staff_a'));
select throws_like($$ select public.create_contract_template_once(tests.id('tenant_a'), null, 'No id', 'T', tests.simple_sections()) $$,
  '%a request id is required%', 'a request id is required');
select throws_like($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('unknown'), 'Bad', 'T',
  '[{"heading": "Extra", "body": "Dear {{client.nickname}}"}]'::jsonb) $$, '%unknown placeholder {{client.nickname}}%', 'unknown placeholders are refused');
select throws_like($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('empty'), 'Bad', 'T', '[]'::jsonb) $$,
  '%1 to 60 sections%', 'content is validated as before');
select throws_like($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('noname'), '  ', 'T', tests.simple_sections()) $$,
  '%name must be 1 to 200%', 'a name is required');
select is((select count(*)::int from public.contract_templates where tenant_id = tests.id('tenant_a')), 0, 'refused requests leave nothing behind');

-- Creating ------------------------------------------------------------------------
select is(public.create_contract_template_once(tests.id('tenant_a'), tests.req('ok'), ' Wedding agreement ', 'Agreement for {{event.title}}', tests.demo_sections()),
  jsonb_build_object('id', tests.req('ok'), 'replayed', false), 'staff create a template');
select results_eq(
  $$ select t.name, t.active, v.version_number, v.published_at is null, v.placeholders @> array['event.title', 'client.phone'], v.created_by_membership_id is not null
     from public.contract_templates t join public.contract_template_versions v on v.template_id = t.id where t.id = tests.req('ok') $$,
  $$ values ('Wedding agreement', true, 1, true, true, true) $$,
  'an active template with draft version 1 and its placeholders recorded');

-- The same request again --------------------------------------------------------------
select is(public.create_contract_template_once(tests.id('tenant_a'), tests.req('ok'), 'Other', 'Other title', tests.simple_sections()),
  jsonb_build_object('id', tests.req('ok'), 'replayed', true), 'the same id, even with other inputs, returns the template already created');
select results_eq(
  $$ select t.name, v.title, count(*) over () from public.contract_templates t join public.contract_template_versions v on v.template_id = t.id
     where t.tenant_id = tests.id('tenant_a') $$,
  $$ values ('Wedding agreement', 'Agreement for {{event.title}}', 1::bigint) $$,
  'and changes nothing: one template, one version');
select lives_ok($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('ok2'), 'Wedding agreement', 'T', tests.simple_sections()) $$,
  'a new id creates another template, even with the same name');

select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.create_contract_template_once(tests.id('tenant_b'), tests.req('ok'), 'Claim', 'T', tests.simple_sections()) $$,
  'P0002', 'not found', 'another business cannot claim the id');

-- Suspended workspace -------------------------------------------------------------
select tests.login_as(tests.id('staff_a'));
reset role;
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select tests.login_as(tests.id('staff_a'));
select throws_like($$ select public.create_contract_template_once(tests.id('tenant_a'), tests.req('suspended'), 'S', 'T', tests.simple_sections()) $$,
  '%workspace_suspended%', 'a suspended workspace cannot create templates');
select is((select count(*)::int from public.contract_templates where id = tests.req('suspended')), 0, 'and nothing is created');

select * from finish();
rollback;
