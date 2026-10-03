-- Phase 2 step 1: contract templates and immutable published versions.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(49);

-- ===========================================================================
-- Privileges and isolation
-- ===========================================================================
select table_privs_are('public', 'contract_templates', 'authenticated', array['SELECT'], 'contract_templates: no table-wide write or delete');
select table_privs_are('public', 'contract_template_versions', 'authenticated', array['SELECT'], 'contract_template_versions: read-only for authenticated');
select table_privs_are('public', 'contract_templates', 'anon', array[]::text[], 'anon has no access to contract templates');
select table_privs_are('public', 'contract_template_versions', 'anon', array[]::text[], 'anon has no access to template versions');

select tests.login_as(tests.id('owner_a'));
select set_config('tests.t1', public.create_contract_template(tests.id('tenant_a'), 'Wedding agreement', 'Agreement for {{event.title}}', tests.demo_sections())::text, true);
select set_config('tests.v1', (select id from public.contract_template_versions where template_id = current_setting('tests.t1')::uuid)::text, true);
select results_eq(
  $$ select version_number, published_at is null, content_sha256 is null, placeholders @> array['client.phone', 'payment.balance_due_date', 'event.title']
     from public.contract_template_versions where id = current_setting('tests.v1')::uuid $$,
  $$ values (1, true, true, true) $$,
  'a new template starts as draft version 1, with the placeholders it uses recorded');

select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.create_contract_template(tests.id('tenant_a'), 'x', 'x', tests.simple_sections()) $$,
  'P0002', 'not found', 'staff of another tenant cannot create templates in tenant A');
select is((select count(*)::int from public.contract_templates where tenant_id = tests.id('tenant_a')), 0, 'tenant B staff see no tenant A templates');
select is((select count(*)::int from public.contract_template_versions where tenant_id = tests.id('tenant_a')), 0, 'tenant B staff see no tenant A versions');
select throws_ok($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'x', tests.simple_sections()) $$,
  'P0002', 'not found', 'tenant B staff cannot edit a tenant A draft');
select throws_ok($$ select public.publish_contract_template_version(current_setting('tests.v1')::uuid, 0) $$,
  'P0002', 'not found', 'tenant B staff cannot publish a tenant A draft');
select throws_ok($$ select public.open_contract_template_draft(current_setting('tests.t1')::uuid) $$,
  'P0002', 'not found', 'tenant B staff cannot open tenant A drafts');
update public.contract_templates set name = 'hijacked' where id = current_setting('tests.t1')::uuid;

select tests.login_as(tests.id('client_x'));
select is((select count(*)::int from public.contract_templates), 0, 'a client sees no templates');
select is((select count(*)::int from public.contract_template_versions), 0, 'a client sees no template versions');
select throws_ok($$ select public.create_contract_template(tests.id('tenant_a'), 'x', 'x', tests.simple_sections()) $$,
  'P0002', 'not found', 'a client cannot create templates');

select tests.login_as_anon();
select throws_ok($$ select * from public.contract_templates $$, '42501', null, 'anon cannot read templates');
select throws_ok($$ select * from public.contract_template_versions $$, '42501', null, 'anon cannot read versions');
select throws_ok($$ select * from public.contract_placeholder_catalog() $$, '42501', null, 'anon cannot read the placeholder list');
select throws_ok($$ select public.create_contract_template(tests.id('tenant_a'), 'x', 'x', '[]') $$, '42501', null, 'anon cannot create templates');

reset role;
select is((select name from public.contract_templates where id = current_setting('tests.t1')::uuid), 'Wedding agreement',
  'another tenant''s update changed nothing');

select tests.login_as(tests.id('owner_a'));
select throws_ok($$ insert into public.contract_template_versions (tenant_id, template_id, version_number, title, sections)
                   values (tests.id('tenant_a'), current_setting('tests.t1')::uuid, 9, 't', tests.simple_sections()) $$,
  '42501', null, 'staff cannot insert versions directly');
select throws_ok($$ update public.contract_template_versions set title = 'x' where id = current_setting('tests.v1')::uuid $$,
  '42501', null, 'staff cannot update versions directly');
select ok((select count(*) >= 20 from public.contract_placeholder_catalog() where key like '%.%'), 'staff can read the placeholder list');

-- ===========================================================================
-- Placeholder and structure validation
-- ===========================================================================
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'T',
                      '[{"heading":"A","body":"Dear {{client.nmae}}"}]') $$,
  '%unknown placeholder {{client.nmae}}%', 'unknown placeholders are rejected');
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'T',
                      '[{"heading":"A","body":"Dear {client.name}}"}]') $$,
  '%malformed placeholder%', 'malformed placeholders are rejected');
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, '{{ secret }}',
                      tests.simple_sections()) $$,
  '%unknown placeholder {{secret}}%', 'placeholders in the title are validated too');
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'T',
                      '[{"heading":"A","body":"{{ client.name | upper }}"}]') $$,
  '%malformed placeholder%', 'expressions or filters are not placeholders');
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'T', '[]') $$,
  '%1 to 60 sections%', 'a template needs at least one section');
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'T',
                      '[{"heading":"A","body":"x","html":"<b>"}]') $$,
  '%must have a heading and a body%', 'sections accept only a heading and a body');
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'T', '["text"]') $$,
  '%must have a heading and a body%', 'sections must be objects');
reset role;
select throws_ok($$ update public.contract_template_versions set sections = '[{"heading":"A","body":"{{nope}}"}]'
                   where id = current_setting('tests.v1')::uuid $$,
  '23514', null, 'the CHECK constraint rejects unknown placeholders even for privileged writers');

-- ===========================================================================
-- Drafts, optimistic versions and publishing
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 5, 'T', tests.demo_sections()) $$,
  '40001', null, 'a stale draft version is a conflict');
select is(public.save_contract_template_draft(current_setting('tests.v1')::uuid, 0, 'Agreement for {{ event.title }}', tests.demo_sections()), 1,
  'saving the draft advances its version');
select throws_ok($$ select public.publish_contract_template_version(current_setting('tests.v1')::uuid, 0) $$,
  '40001', null, 'publishing requires the latest saved version (no surprise edits from another tab)');
select is(public.publish_contract_template_version(current_setting('tests.v1')::uuid, 1) ->> 'replayed', 'false', 'staff publish the draft');
select is(public.publish_contract_template_version(current_setting('tests.v1')::uuid, 1) ->> 'replayed', 'true', 'publishing again is a no-op');
reset role;
select results_eq(
  $$ select published_at is not null,
            content_sha256 = encode(sha256(convert_to(jsonb_build_object('title', title, 'sections', sections)::text, 'UTF8')), 'hex'),
            (select count(*)::int from public.audit_events where entity_id = current_setting('tests.t1')::uuid and action = 'version_published')
     from public.contract_template_versions where id = current_setting('tests.v1')::uuid $$,
  $$ values (true, true, 1) $$,
  'the database stamps, hashes and audits the published version');

-- ===========================================================================
-- Published versions are immutable for every role
-- ===========================================================================
create temp table v1_before as select title, sections, content_sha256, published_at from public.contract_template_versions where id = current_setting('tests.v1')::uuid;
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.save_contract_template_draft(current_setting('tests.v1')::uuid, 1, 'Changed', tests.simple_sections()) $$,
  '%published and cannot be edited%', 'the edit function refuses published versions');
reset role;
select throws_ok($$ update public.contract_template_versions set title = 'Changed' where id = current_setting('tests.v1')::uuid $$,
  '23514', null, 'postgres cannot change a published title');
select throws_ok($$ update public.contract_template_versions set published_at = null where id = current_setting('tests.v1')::uuid $$,
  '23514', null, 'a published version cannot be unpublished');
select throws_ok($$ delete from public.contract_template_versions where id = current_setting('tests.v1')::uuid $$,
  '23514', null, 'versions are never deleted');
select throws_ok($$ delete from public.contract_templates where id = current_setting('tests.t1')::uuid $$,
  '23514', null, 'templates are never deleted');
select tests.login_as_service();
select throws_ok($$ update public.contract_template_versions set sections = tests.simple_sections() where id = current_setting('tests.v1')::uuid $$,
  '23514', null, 'service_role cannot change a published version either');
reset role;
select throws_ok($$ insert into public.contract_template_versions (tenant_id, template_id, version_number, title, sections, published_at)
                   values (tests.id('tenant_a'), current_setting('tests.t1')::uuid, 7, 'T', tests.simple_sections(), now()) $$,
  '23514', null, 'versions cannot be inserted already published');
select throws_ok($$ update public.contract_templates set tenant_id = tests.id('tenant_b') where id = current_setting('tests.t1')::uuid $$,
  '23514', null, 'a template cannot move to another tenant');

-- ===========================================================================
-- Editing a published template opens a new draft version
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.v2', public.open_contract_template_draft(current_setting('tests.t1')::uuid)::text, true);
select is(public.open_contract_template_draft(current_setting('tests.t1')::uuid)::text, current_setting('tests.v2'),
  'opening again returns the same draft (one draft per template)');
select is(public.save_contract_template_draft(current_setting('tests.v2')::uuid, 0, 'Revised title', tests.simple_sections()), 1,
  'the new draft can be edited');
reset role;
select results_eq(
  $$ select v2.version_number, v1.title = (select title from v1_before), v1.sections = (select sections from v1_before),
            v1.content_sha256 = (select content_sha256 from v1_before)
     from public.contract_template_versions v1, public.contract_template_versions v2
     where v1.id = current_setting('tests.v1')::uuid and v2.id = current_setting('tests.v2')::uuid $$,
  $$ values (2, true, true, true) $$,
  'the draft is version 2 and version 1 is untouched');
select throws_ok($$ insert into public.contract_template_versions (tenant_id, template_id, version_number, title, sections)
                   values (tests.id('tenant_a'), current_setting('tests.t1')::uuid, 3, 'T', tests.simple_sections()) $$,
  '23505', null, 'a template cannot have two drafts');
insert into public.contract_templates (id, tenant_id, name) values ('81000000-0000-4000-8000-0000000000a1', tests.id('tenant_a'), 'Empty');
select throws_ok($$ insert into public.contract_template_versions (tenant_id, template_id, version_number, title, sections)
                   values (tests.id('tenant_b'), '81000000-0000-4000-8000-0000000000a1', 1, 'T', tests.simple_sections()) $$,
  '23503', null, 'a version cannot reference another tenant''s template');

select * from finish();
rollback;
