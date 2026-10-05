-- Phase 2 step 1: generating contract drafts from approved selections.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(60);

select table_privs_are('public', 'contracts', 'authenticated', array['SELECT'], 'contracts: read-only for authenticated');
select table_privs_are('public', 'contracts', 'anon', array[]::text[], 'anon has no access to contracts');

-- ===========================================================================
-- Deposit arithmetic: 50%, half up to the cent, balance = total - deposit
-- ===========================================================================
select results_eq(
  $$ select t, private.contract_deposit_cents(t), t - private.contract_deposit_cents(t)
     from unnest(array[0, 1, 2, 3, 99, 100, 252945, 266742, 9999999999]::bigint[]) t $$,
  $$ values (0::bigint, 0::bigint, 0::bigint), (1, 1, 0), (2, 1, 1), (3, 2, 1), (99, 50, 49), (100, 50, 50),
            (252945, 126473, 126472), (266742, 133371, 133371), (9999999999, 5000000000, 4999999999) $$,
  'deposits round half up to the cent and the balance is always the remainder');

-- ===========================================================================
-- Setup: published templates and a real approval
-- ===========================================================================
select set_config('tests.v_demo', tests.published_version('owner_a', 'tenant_a', tests.demo_sections())::text, true);
select set_config('tests.v_simple', tests.published_version('owner_a', 'tenant_a', tests.simple_sections(), 'Simple agreement')::text, true);
select set_config('tests.v_b', tests.published_version('owner_b', 'tenant_b', tests.simple_sections())::text, true);
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
create temp table access_before as select count(*) as n from public.event_access;
grant select on access_before to authenticated;

-- ===========================================================================
-- Authorization and tenant isolation
-- ===========================================================================
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_b')::uuid) $$,
  'P0002', 'not found', 'staff of another tenant cannot generate from tenant A''s approval');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid) $$,
  'P0002', 'not found', 'a client cannot generate contracts');
select tests.login_as(tests.id('stranger'));
select throws_ok($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid) $$,
  'P0002', 'not found', 'an unrelated signed-in user cannot generate contracts');
select tests.login_as_anon();
select throws_ok($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid) $$,
  '42501', null, 'anon cannot generate contracts');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_b')::uuid) $$,
  '%template version not found%', 'another tenant''s template version cannot be used');

-- An unpublished draft version cannot be used.
select set_config('tests.v_draft', public.open_contract_template_draft(
  (select template_id from public.contract_template_versions where id = current_setting('tests.v_simple')::uuid))::text, true);
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_draft')::uuid) $$,
  '%publish this template version%', 'draft template versions cannot be used');

-- ===========================================================================
-- Missing information and staff-supplied values
-- ===========================================================================
-- event_a1 has no venue, and its signer (Client X) has no phone.
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_demo')::uuid) -> 'missing',
  '[{"key":"client.phone","hint":"Client phone: add a phone number to the signer''s client record.","label":"Client phone"},
    {"key":"venue.name","hint":"Venue name: add it to the event.","label":"Venue name"},
    {"key":"venue.address","hint":"Venue address: add it to the event.","label":"Venue address"},
    {"key":"payment.balance_due_date","hint":"Balance due date: enter it when generating the contract.","label":"Balance due date"}]'::jsonb,
  'missing values are listed with what staff need to complete');
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid, '2027-05-01') $$,
  '%has no balance due date%', 'a balance due date is refused when the template does not use it');
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_demo')::uuid, '2020-01-01') $$,
  '%in the past%', 'a past balance due date is refused');
reset role;
update public.event_clients set can_sign = false where event_id = tests.id('event_a1');
select tests.login_as(tests.id('owner_a'));
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid) -> 'missing' -> 0 ->> 'key',
  'signer', 'an event without a signer cannot get a contract');
reset role;
update public.event_clients set can_sign = true where event_id = tests.id('event_a1') and client_id = tests.id('a_client_x');
select is((select count(*)::int from public.contracts where tenant_id = tests.id('tenant_a')), 0, 'incomplete attempts store nothing');

update public.clients set phone = '+1 514 555 0199' where id = tests.id('a_client_x');
update public.events set venue_name = 'Grand Hall', venue_address = '1 Main St, Montréal' where id = tests.id('event_a1');

-- ===========================================================================
-- Generation from the approved selection
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.g1', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_demo')::uuid,
  (current_date + 30))::text, true);
select is(current_setting('tests.g1')::jsonb ->> 'status', 'created', 'a complete contract draft is generated');
select set_config('tests.c1', current_setting('tests.g1')::jsonb ->> 'contract_id', true);
reset role;
select results_eq(
  $$ select c.status, c.total_cents, c.deposit_cents, c.balance_cents, c.currency, c.signer_email,
            c.selection_id = a.selection_id, c.proposal_id = a.proposal_id, c.template_version_id = current_setting('tests.v_demo')::uuid,
            c.balance_due_date = current_date + 30
     from public.contracts c join public.proposal_approvals a on a.id = c.approval_id
     where c.id = current_setting('tests.c1')::uuid $$,
  $$ values ('draft'::text, 252945::bigint, 126473::bigint, 126472::bigint, 'CAD'::text, 'client-x@example.test'::text, true, true, true, true) $$,
  'terms come from the approved selection; deposit is 50% rounded half up; provenance is recorded');
select results_eq(
  $$ select (commercial_snapshot ->> 'subtotal_cents')::bigint, (commercial_snapshot ->> 'tax_cents')::bigint,
            commercial_snapshot -> 'package' ->> 'key', jsonb_array_length(commercial_snapshot -> 'tax_breakdown'),
            commercial_snapshot -> 'source' ->> 'selection_sha256' = (select selection_sha256 from public.proposal_approvals where id = current_setting('tests.a1')::uuid),
            party_snapshot -> 'event' ->> 'venue_name', party_snapshot -> 'client' ->> 'phone'
     from public.contracts where id = current_setting('tests.c1')::uuid $$,
  $$ values (220000::bigint, 32945::bigint, 'signature'::text, 2, true, 'Grand Hall'::text, '+1 514 555 0199'::text) $$,
  'the commercial and party snapshots are copied in full');
select ok((select r -> 'sections' -> 4 ->> 'body' from (select rendered_content r from public.contracts where id = current_setting('tests.c1')::uuid) x)
    = E'Subtotal 2,200.00 CAD\n- GST (5%): 110.00 CAD\n- QST (9.975%): 219.45 CAD\nTaxes 329.45 CAD\nTotal 2,529.45 CAD (CAD)',
  'prices and the tax breakdown are rendered from the approved selection');
select ok((select rendered_content -> 'sections' -> 5 ->> 'body' from public.contracts where id = current_setting('tests.c1')::uuid)
    like E'Deposit (50%): 1,264.73 CAD\nBalance: 1,264.72 CAD, due %',
  'the deposit and balance are rendered');
select ok((select rendered_content -> 'sections' -> 3 ->> 'body' from public.contracts where id = current_setting('tests.c1')::uuid)
    = E'Signature (2,200.00 CAD)\n- 1 × Additional-location speaker\nNo additional gear.',
  'included gear is listed and an empty extras list says so explicitly');
select is((select rendered_content ->> 'title' from public.contracts where id = current_setting('tests.c1')::uuid),
  'DEMO agreement for A1 Wedding', 'the title is rendered');
select ok((select rendered_content::text !~ '\{\{' from public.contracts where id = current_setting('tests.c1')::uuid),
  'no placeholder is left unrendered');
select is((select content_sha256 from public.contracts where id = current_setting('tests.c1')::uuid),
  (select private.contract_content_sha256(rendered_content, commercial_snapshot, party_snapshot, template_version_id, template_content_sha256)
   from public.contracts where id = current_setting('tests.c1')::uuid),
  'the content hash is the documented hash of the frozen document');
select is((select content_sha256 from public.contracts where id = current_setting('tests.c1')::uuid),
  (select encode(sha256(convert_to(jsonb_build_object('schema_version', 1, 'content', rendered_content, 'commercial', commercial_snapshot,
     'parties', party_snapshot, 'template', jsonb_build_object('version_id', template_version_id, 'content_sha256', template_content_sha256))::text, 'UTF8')), 'hex')
   from public.contracts where id = current_setting('tests.c1')::uuid),
  'the hash can be recomputed from the stored columns as documented');
select results_eq(
  $$ select e.lifecycle_status, e.booking_confirmed_at is null, (select count(*) from public.event_access) = (select n from access_before),
            (select count(*)::int from public.audit_events where entity_id = current_setting('tests.c1')::uuid and action = 'draft_generated')
     from public.events e where e.id = tests.id('event_a1') $$,
  $$ values ('awaiting_signature'::text, true, true, 1) $$,
  'generating does not book the event, grants no client access, and is audited');

-- ===========================================================================
-- Repeats and explicit replacement
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_demo')::uuid, (current_date + 30)),
  jsonb_build_object('status', 'replayed', 'contract_id', current_setting('tests.c1')),
  'a repeated click returns the same draft');
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid),
  jsonb_build_object('status', 'draft_exists', 'contract_id', current_setting('tests.c1')),
  'a different draft needs explicit replacement');
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid, null, gen_random_uuid()) ->> 'status',
  'conflict', 'replacing anything but the current draft is a conflict');
reset role;
select is((select count(*)::int from public.contracts where tenant_id = tests.id('tenant_a')), 1, 'still exactly one contract');

select tests.login_as(tests.id('owner_a'));
select set_config('tests.g2', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid,
  null, current_setting('tests.c1')::uuid)::text, true);
select set_config('tests.c2', current_setting('tests.g2')::jsonb ->> 'contract_id', true);
select is(current_setting('tests.g2')::jsonb ->> 'replaced_id', current_setting('tests.c1'), 'explicit replacement creates a new draft');
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid, null, current_setting('tests.c1')::uuid),
  jsonb_build_object('status', 'replayed', 'contract_id', current_setting('tests.c2')),
  'a repeated replace click returns the replacement instead of replacing again');
reset role;
select results_eq(
  $$ select (select status from public.contracts where id = current_setting('tests.c1')::uuid),
            (select status_changed_at is not null from public.contracts where id = current_setting('tests.c1')::uuid),
            (select replaces_id::text from public.contracts where id = current_setting('tests.c2')::uuid),
            (select count(*)::int from public.contracts where event_id = tests.id('event_a1') and status = 'draft'),
            (select count(*)::int from public.audit_events where entity_id = current_setting('tests.c1')::uuid and action = 'draft_replaced') $$,
  $$ values ('replaced'::text, true, current_setting('tests.c1'), 1, 1) $$,
  'the old draft is kept as replaced history and there is one active draft');
select throws_ok($$ insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id)
                   select tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id
                   from public.contracts where id = current_setting('tests.c2')::uuid $$,
  '23505', null, 'the database allows only one draft per event');

-- ===========================================================================
-- Snapshot independence: later edits never change a stored contract
-- ===========================================================================
create temp table c2_before as
  select rendered_content, commercial_snapshot, party_snapshot, content_sha256, total_cents, deposit_cents, signer_name
  from public.contracts where id = current_setting('tests.c2')::uuid;
update public.clients set name = 'Renamed Client', email = 'renamed@example.test', phone = null where id = tests.id('a_client_x');
update public.events set title = 'Renamed Event', event_date = '2028-01-01', venue_name = null, venue_address = null where id = tests.id('event_a1');
update public.tenants set business_name = 'Renamed Business', tax_config = '[{"code":"GST","label":"GST","rate_ppm":70000},{"code":"QST","label":"QST","rate_ppm":99750}]'
  where id = tests.id('tenant_a');
update public.packages set base_price_cents = 999900, name = 'Renamed package' where tenant_id = tests.id('tenant_a');
update public.gear_items set default_price_cents = 77700, name = 'Renamed gear' where tenant_id = tests.id('tenant_a');
update public.contract_templates set name = 'Renamed template', active = false
  where id = (select template_id from public.contract_template_versions where id = current_setting('tests.v_simple')::uuid);
select tests.login_as(tests.id('owner_a'));
select public.save_contract_template_draft(current_setting('tests.v_draft')::uuid, 0, 'Brand new text', tests.demo_sections());
select public.publish_contract_template_version(current_setting('tests.v_draft')::uuid, 1, 'demo');
reset role;
select results_eq(
  $$ select rendered_content, commercial_snapshot, party_snapshot, content_sha256, total_cents, deposit_cents, signer_name
     from public.contracts where id = current_setting('tests.c2')::uuid $$,
  $$ select * from c2_before $$,
  'client, event, business, tax, catalog and template changes do not alter the stored contract');

-- ===========================================================================
-- Frozen content: no role can edit or delete it
-- ===========================================================================
select throws_ok($$ update public.contracts set rendered_content = jsonb_set(rendered_content, '{title}', '"Edited"') where id = current_setting('tests.c2')::uuid $$,
  '23514', null, 'rendered content cannot change, even for postgres');
select throws_ok($$ update public.contracts set total_cents = 1, deposit_cents = 1, balance_cents = 0 where id = current_setting('tests.c2')::uuid $$,
  '23514', null, 'commercial terms cannot change');
select throws_ok($$ update public.contracts set content_sha256 = repeat('0', 64) where id = current_setting('tests.c2')::uuid $$,
  '23514', null, 'the content hash cannot change');
select throws_ok($$ update public.contracts set template_version_id = current_setting('tests.v_demo')::uuid where id = current_setting('tests.c2')::uuid $$,
  '23514', null, 'provenance cannot change');
select throws_ok($$ update public.contracts set status = 'sent' where id = current_setting('tests.c2')::uuid $$,
  '23514', null, 'no code path can mark a draft sent in this step');
select throws_ok($$ update public.contracts set status = 'draft' where id = current_setting('tests.c1')::uuid $$,
  '23514', null, 'a replaced draft cannot become active again');
select throws_ok($$ delete from public.contracts where id = current_setting('tests.c1')::uuid $$,
  '23514', null, 'contracts are never deleted');
select tests.login_as_service();
select throws_ok($$ update public.contracts set party_snapshot = '{}' where id = current_setting('tests.c2')::uuid $$,
  '23514', null, 'service_role cannot change a contract either');

-- ===========================================================================
-- Read access: staff of the tenant only
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.contracts), 2, 'tenant A staff see their contracts');
select throws_ok($$ update public.contracts set status = 'replaced' where id = current_setting('tests.c2')::uuid $$,
  '42501', null, 'staff cannot write contracts directly');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.contracts), 0, 'tenant B staff see no tenant A contracts');
select tests.login_as(tests.id('client_x'));
select is((select count(*)::int from public.contracts), 0, 'a client sees no draft contracts, even for their own event');
select tests.login_as_anon();
select throws_ok($$ select * from public.contracts $$, '42501', null, 'anon cannot read contracts');

-- ===========================================================================
-- Database protections behind the function
-- ===========================================================================
reset role;
select throws_like($$ insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id, status)
                   select tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id, 'sent'
                   from public.contracts where id = current_setting('tests.c1')::uuid $$,
  '%created as drafts%', 'contracts cannot be inserted as sent');
insert into public.contract_template_versions (id, tenant_id, template_id, version_number, title, sections)
  select '82000000-0000-4000-8000-0000000000a1', tenant_id, template_id, 9, 'Unpublished', tests.simple_sections()
  from public.contract_template_versions where id = current_setting('tests.v_demo')::uuid;
select throws_like($$ insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id)
                   select c.tenant_id, c.event_id, c.proposal_id, c.selection_id, c.approval_id, c.template_id, '82000000-0000-4000-8000-0000000000a1',
                     repeat('a', 64), c.signer_client_id, c.signer_name, c.signer_email, c.currency, c.total_cents, c.deposit_percent, c.deposit_cents, c.balance_cents,
                     c.rendered_content, c.commercial_snapshot, c.party_snapshot, c.content_sha256, c.generated_by_user_id
                   from public.contracts c where c.id = current_setting('tests.c1')::uuid $$,
  '%published template version%', 'contracts cannot reference an unpublished template version');
-- With the guard trigger disabled, composite foreign keys still block cross-tenant
-- references. Probe rows are non-drafts so the one-draft index is not what fails.
alter table public.contracts disable trigger contracts_before_insert;
select throws_ok($$ insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id, status)
                   select c.tenant_id, c.event_id, c.proposal_id, c.selection_id, c.approval_id, v.template_id, v.id,
                     v.content_sha256, c.signer_client_id, c.signer_name, c.signer_email, c.currency, c.total_cents, c.deposit_percent, c.deposit_cents, c.balance_cents,
                     c.rendered_content, c.commercial_snapshot, c.party_snapshot, c.content_sha256, c.generated_by_user_id, 'replaced'
                   from public.contracts c, public.contract_template_versions v
                   where c.id = current_setting('tests.c1')::uuid and v.id = current_setting('tests.v_b')::uuid $$,
  '23503', null, 'a contract cannot use another tenant''s template version');
select throws_ok($$ insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id, status)
                   select c.tenant_id, tests.id('event_a2'), c.proposal_id, c.selection_id, c.approval_id, c.template_id, c.template_version_id,
                     c.template_content_sha256, c.signer_client_id, c.signer_name, c.signer_email, c.currency, c.total_cents, c.deposit_percent, c.deposit_cents, c.balance_cents,
                     c.rendered_content, c.commercial_snapshot, c.party_snapshot, c.content_sha256, c.generated_by_user_id, 'replaced'
                   from public.contracts c where c.id = current_setting('tests.c1')::uuid $$,
  '23503', null, 'a contract cannot pair an approval with a different event');
select throws_ok($$ insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id, status)
                   select c.tenant_id, c.event_id, c.proposal_id, c.selection_id, c.approval_id, c.template_id, c.template_version_id,
                     c.template_content_sha256, tests.id('b_client_x'), c.signer_name, c.signer_email, c.currency, c.total_cents, c.deposit_percent, c.deposit_cents, c.balance_cents,
                     c.rendered_content, c.commercial_snapshot, c.party_snapshot, c.content_sha256, c.generated_by_user_id, 'replaced'
                   from public.contracts c where c.id = current_setting('tests.c1')::uuid $$,
  '23503', null, 'a contract cannot name another tenant''s client as signer');
select throws_ok($$ insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
                     template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents,
                     rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id, status)
                   select c.tenant_id, c.event_id, c.proposal_id, c.selection_id, c.approval_id, c.template_id, c.template_version_id,
                     c.template_content_sha256, c.signer_client_id, c.signer_name, c.signer_email, c.currency, c.total_cents, c.deposit_percent, 1, c.balance_cents,
                     c.rendered_content, c.commercial_snapshot, c.party_snapshot, c.content_sha256, c.generated_by_user_id, 'replaced'
                   from public.contracts c where c.id = current_setting('tests.c1')::uuid $$,
  '23514', null, 'deposit plus balance must equal the total');
alter table public.contracts enable trigger contracts_before_insert;

-- ===========================================================================
-- Safe rendering: client-provided values are inserted literally, once
-- ===========================================================================
update public.clients set name = '{{pricing.total}} <script>alert(1)</script>' where id = tests.id('a_client_y');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c3', (public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v_demo')::uuid) ->> 'status'), true);
select is(current_setting('tests.c3'), 'incomplete', 'event A2 also needs its missing details first');
reset role;
update public.tenants set tax_config = '[{"code":"GST","label":"GST","rate_ppm":50000},{"code":"QST","label":"QST","rate_ppm":99750}]' where id = tests.id('tenant_a');
update public.contract_templates set active = true
  where id = (select template_id from public.contract_template_versions where id = current_setting('tests.v_simple')::uuid);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c3', (public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v_simple')::uuid) ->> 'contract_id'), true);
reset role;
select is((select rendered_content -> 'sections' -> 0 ->> 'body' from public.contracts where id = current_setting('tests.c3')::uuid),
  'Between Renamed Business and {{pricing.total}} <script>alert(1)</script>.',
  'a client value containing placeholder syntax or markup is stored literally, never re-rendered or interpreted');

-- ===========================================================================
-- Stale approvals: a revised offer supersedes the draft
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.a1_p', (select proposal_id::text from public.proposal_approvals where id = current_setting('tests.a1')::uuid), true);
select tests.send(public.open_proposal_draft(tests.id('event_a1')));
reset role;
select results_eq(
  $$ select status from public.contracts where event_id = tests.id('event_a1') order by replaces_id is not null $$,
  $$ values ('replaced'::text), ('superseded'::text) $$,
  'sending a revised offer supersedes the draft built from the old approval');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid) $$,
  '%no longer current%', 'a superseded approval cannot be used to generate a contract');
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid, null,
                      (select id from public.contracts where event_id = tests.id('event_a1') and status = 'superseded')) $$,
  '%no longer current%', 'nor to replace its superseded draft');
reset role;
select throws_ok($$ update public.contracts set status = 'draft' where event_id = tests.id('event_a1') and status = 'superseded' $$,
  '23514', null, 'a superseded draft can never become usable again');
select is((select count(*)::int from public.contracts where event_id = tests.id('event_a1') and status = 'draft'), 0,
  'the event has no usable draft after the revision');

select * from finish();
rollback;
