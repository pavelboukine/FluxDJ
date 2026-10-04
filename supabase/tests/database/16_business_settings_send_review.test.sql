-- Business settings (owner only), the frozen deposit percentage and business
-- identity in contracts, and the send-review eligibility checks.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(54);

create function tests.identity_sections() returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('heading', 'Parties', 'body', E'{{business.legal_name}}\n{{business.address}}\n{{business.email}}\nClient: {{client.name}}'),
    jsonb_build_object('heading', 'Payment', 'body', 'Deposit ({{payment.deposit_percent}}): {{payment.deposit}}. Balance: {{payment.balance}}.')) $$;
grant execute on function tests.identity_sections() to authenticated, service_role;

-- ===========================================================================
-- Owner-only settings
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select lives_ok($$ select public.update_business_settings(tests.id('tenant_a'), ' BOUPROD Legal Inc. ', E'1 Main St\nMontréal, QC', 'Contact@Bouprod.Test', 50) $$,
  'the owner saves business settings');
select throws_ok($$ update public.tenants set business_name = 'X' where id = tests.id('tenant_a') $$, '42501', null,
  'even the owner cannot change the legal name directly');
select throws_ok($$ update public.tenants set deposit_percent = 10 where id = tests.id('tenant_a') $$, '42501', null,
  'nor the deposit percentage');
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'x@example.test', 10) $$, '42501', null,
  'staff who are not the owner cannot change settings');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'x@example.test', 10) $$, 'P0002', 'not found',
  'another tenant''s owner cannot change them');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'x@example.test', 10) $$, 'P0002', 'not found',
  'a client cannot change them');
select tests.login_as_anon();
select throws_ok($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'x@example.test', 10) $$, '42501', null,
  'anon cannot change them');
reset role;
select results_eq(
  $$ select business_name, business_address, contact_email, deposit_percent, display_name from public.tenants where id = tests.id('tenant_a') $$,
  $$ values ('BOUPROD Legal Inc.'::text, E'1 Main St\nMontréal, QC'::text, 'contact@bouprod.test'::text, 50, 'BOUPROD'::text) $$,
  'settings are trimmed and normalized; the display name (branding) is separate and unchanged');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'business_settings_updated'), 1,
  'the change is audited once');

select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'x@example.test', -1) $$, '%whole percentage from 0 to 100%', 'below 0% is rejected');
select throws_like($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'x@example.test', 101) $$, '%whole percentage from 0 to 100%', 'above 100% is rejected');
select throws_like($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'x@example.test', null) $$, '%whole percentage%', 'a missing percentage is rejected');
select throws_like($$ select public.update_business_settings(tests.id('tenant_a'), 'X', 'Y', 'not-an-email', 10) $$, '%valid contact email%', 'an invalid email is rejected');
select throws_like($$ select public.update_business_settings(tests.id('tenant_a'), 'X', '   ', 'x@example.test', 10) $$, '%address%', 'a blank address is rejected');
select throws_like($$ select public.update_business_settings(tests.id('tenant_a'), '', 'Y', 'x@example.test', 10) $$, '%legal business name%', 'a blank legal name is rejected');
select lives_ok($$ select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Inc.', E'1 Main St\nMontréal, QC', 'contact@bouprod.test', 0) $$, '0% is allowed');
select lives_ok($$ select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Inc.', E'1 Main St\nMontréal, QC', 'contact@bouprod.test', 100) $$, '100% is allowed');
reset role;
select throws_ok($$ update public.tenants set deposit_percent = 101 where id = tests.id('tenant_a') $$, '23514', null, 'the column constraint also bounds the percentage');

-- ===========================================================================
-- Deposit arithmetic: integer cents, half up
-- ===========================================================================
select results_eq(
  $$ select private.contract_deposit_cents(t, p) from (values (252945::bigint, 50), (252945, 30), (252945, 33), (252945, 0), (252945, 100),
       (1, 50), (5, 10), (4, 10), (15, 10), (0, 100)) v(t, p) $$,
  $$ values (126473::bigint), (75884), (83472), (0), (252945), (1), (1), (0), (2), (0) $$,
  'deposit = round half up(total × percent / 100), in integer cents');
select is((select count(*)::int from generate_series(0, 20000) t where private.contract_deposit_cents(t, 50) <> private.contract_deposit_cents(t)), 0,
  'at 50% the integer-percent formula equals the original 50% formula for every amount');

-- ===========================================================================
-- Contracts freeze the percentage, amounts and business identity
-- ===========================================================================
update public.tenants set business_address = null, contact_email = null, deposit_percent = 50 where id = tests.id('tenant_a');
select set_config('tests.v_id', tests.published_version('owner_a', 'tenant_a', tests.identity_sections())::text, true);
select set_config('tests.v_simple', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.a1', tests.approved('event_a1')::text, true);

select tests.login_as(tests.id('owner_a'));
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_id')::uuid) -> 'missing',
  '[{"key":"business.address","hint":"Business address: set it in Business settings.","label":"Business address"},
    {"key":"business.email","hint":"Business contact email: set it in Business settings.","label":"Business contact email"}]'::jsonb,
  'templates using the new placeholders need the business address and contact email');
-- A contract from a template without the new placeholders, made before settings exist.
select set_config('tests.c_old', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid) ->> 'contract_id', true);
reset role;
create temp table c_old_before as select to_jsonb(c) row_json, content_sha256 from public.contracts c where id = current_setting('tests.c_old')::uuid;
select results_eq(
  $$ select deposit_percent, deposit_cents, balance_cents, (commercial_snapshot -> 'payment' ->> 'deposit_percent')::int,
            party_snapshot -> 'business' ->> 'address' is null
     from public.contracts where id = current_setting('tests.c_old')::uuid $$,
  $$ values (50, 126473::bigint, 126472::bigint, 50, true) $$,
  'a contract freezes the 50% setting and its amounts');

select tests.login_as(tests.id('owner_a'));
select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Inc.', '9 New Ave, Québec', 'legal@bouprod.test', 30);
reset role;
select is((select to_jsonb(c) from public.contracts c where id = current_setting('tests.c_old')::uuid), (select row_json from c_old_before),
  'changing settings leaves an existing contract byte-for-byte unchanged');
select is((select private.contract_content_sha256(rendered_content, commercial_snapshot, party_snapshot, template_version_id, template_content_sha256)
           from public.contracts where id = current_setting('tests.c_old')::uuid), (select content_sha256 from c_old_before),
  'and its content hash still verifies');

select tests.login_as(tests.id('owner_a'));
select is(public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_simple')::uuid) ->> 'status', 'draft_exists',
  'new settings are not picked up silently: regeneration must be explicit');
select set_config('tests.c30', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_id')::uuid, null,
  current_setting('tests.c_old')::uuid) ->> 'contract_id', true);
reset role;
select results_eq(
  $$ select deposit_percent, deposit_cents, balance_cents, total_cents, (commercial_snapshot -> 'payment' ->> 'deposit_basis_points')::int,
            party_snapshot -> 'business' ->> 'legal_name', party_snapshot -> 'business' ->> 'address', party_snapshot -> 'business' ->> 'contact_email'
     from public.contracts where id = current_setting('tests.c30')::uuid $$,
  $$ values (30, 75884::bigint, 177061::bigint, 252945::bigint, 3000, 'BOUPROD Legal Inc.'::text, '9 New Ave, Québec'::text, 'legal@bouprod.test'::text) $$,
  'an explicitly regenerated contract freezes the new percentage, amounts and business identity');
select is((select rendered_content -> 'sections' from public.contracts where id = current_setting('tests.c30')::uuid),
  jsonb_build_array(
    jsonb_build_object('heading', 'Parties', 'body', E'BOUPROD Legal Inc.\n9 New Ave, Québec\nlegal@bouprod.test\nClient: Client X (A)'),
    jsonb_build_object('heading', 'Payment', 'body', 'Deposit (30%): 758.84 CAD. Balance: 1,770.61 CAD.')),
  'the new placeholders and the percentage are rendered');
select is((select status from public.contracts where id = current_setting('tests.c_old')::uuid), 'replaced', 'the earlier draft is kept as replaced history');

-- 0% and 100% boundaries through real generation.
select tests.login_as(tests.id('owner_a'));
select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Inc.', '9 New Ave, Québec', 'legal@bouprod.test', 0);
select set_config('tests.c0', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_id')::uuid, null,
  current_setting('tests.c30')::uuid) ->> 'contract_id', true);
select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Inc.', '9 New Ave, Québec', 'legal@bouprod.test', 100);
select set_config('tests.c100', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v_id')::uuid, null,
  current_setting('tests.c0')::uuid) ->> 'contract_id', true);
reset role;
select results_eq(
  $$ select deposit_percent, deposit_cents, balance_cents from public.contracts
     where id in (current_setting('tests.c0')::uuid, current_setting('tests.c100')::uuid) order by deposit_percent $$,
  $$ values (0, 0::bigint, 252945::bigint), (100, 252945::bigint, 0::bigint) $$,
  '0% means no deposit and 100% means the whole total, with balance = total - deposit');
select throws_ok($$ update public.contracts set deposit_percent = 50 where id = current_setting('tests.c100')::uuid $$, '23514', null,
  'the frozen percentage cannot change');

-- ===========================================================================
-- Review for send: authorization
-- ===========================================================================
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.review_contract_for_send(current_setting('tests.c100')::uuid) $$, 'P0002', 'not found', 'another tenant cannot review');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.review_contract_for_send(current_setting('tests.c100')::uuid) $$, 'P0002', 'not found', 'the client cannot review');
select tests.login_as_anon();
select throws_ok($$ select public.review_contract_for_send(current_setting('tests.c100')::uuid) $$, '42501', null, 'anon cannot review');

-- ===========================================================================
-- Review for send: eligibility
-- ===========================================================================
reset role;
create function tests.problems(contract text) returns text[] language sql as $$
  select coalesce(array_agg(p ->> 'code' order by p ->> 'code'), '{}')
  from jsonb_array_elements(public.review_contract_for_send(current_setting(contract)::uuid) -> 'problems') p $$;
grant execute on function tests.problems(text) to authenticated;

select tests.login_as(tests.id('staff_a'));
select results_eq(
  $$ select (r ->> 'eligible')::boolean, (r ->> 'can_send')::boolean, r -> 'signer' ->> 'email', r -> 'business' ->> 'legal_name',
            (r ->> 'deposit_percent')::int, (r ->> 'deposit_cents')::bigint, (r ->> 'balance_cents')::bigint
     from (select public.review_contract_for_send(current_setting('tests.c100')::uuid) r) x $$,
  $$ values (true, false, 'client-x@example.test'::text, 'BOUPROD Legal Inc.'::text, 100, 252945::bigint, 0::bigint) $$,
  'staff review a current draft: eligible, with the frozen signer, identity and terms; sending itself is unavailable');
select is(tests.problems('tests.c_old'), array['business_identity_missing', 'deposit_changed', 'not_current_draft']::text[],
  'a replaced draft from before the settings existed is rejected with every reason');
reset role;
select tests.login_as(tests.id('owner_a'));
select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Inc.', '9 New Ave, Québec', 'legal@bouprod.test', 60);
select is(tests.problems('tests.c100'), array['deposit_changed'], 'a changed deposit setting requires regeneration');
select ok((select string_agg(p ->> 'message', ' ') from jsonb_array_elements(public.review_contract_for_send(current_setting('tests.c100')::uuid) -> 'problems') p)
  like '%now 60%, but this contract uses 100%. Regenerate%', 'and the message explains it');
select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Corp.', '9 New Ave, Québec', 'other@bouprod.test', 100);
select is(tests.problems('tests.c100'), array['business_changed'], 'a changed legal name or contact email requires regeneration');
select ok((select p ->> 'message' from jsonb_array_elements(public.review_contract_for_send(current_setting('tests.c100')::uuid) -> 'problems') p)
  like '%(legal name, contact email)%', 'naming what changed');
select public.update_business_settings(tests.id('tenant_a'), 'BOUPROD Legal Inc.', '9 New Ave, Québec', 'legal@bouprod.test', 100);
select is(tests.problems('tests.c100'), '{}'::text[], 'restoring the settings makes it eligible again');
reset role;
update public.tenants set business_address = null where id = tests.id('tenant_a');
select tests.login_as(tests.id('owner_a'));
select is(tests.problems('tests.c100'), array['business_changed', 'business_settings_incomplete'], 'incomplete current business settings are rejected');
reset role;
update public.tenants set business_address = '9 New Ave, Québec' where id = tests.id('tenant_a');
select tests.login_as(tests.id('owner_a'));

reset role;
update public.clients set email = 'client-x-new@example.test' where id = tests.id('a_client_x');
select tests.login_as(tests.id('owner_a'));
select is(tests.problems('tests.c100'), array['signer_changed'], 'a changed signer email is rejected');
reset role;
update public.clients set email = 'client-x@example.test', name = 'Client X Renamed' where id = tests.id('a_client_x');
select tests.login_as(tests.id('owner_a'));
select is(tests.problems('tests.c100'), array['signer_changed'], 'a changed signer name is rejected');
reset role;
update public.clients set name = 'Client X (A)' where id = tests.id('a_client_x');
update public.event_clients set can_sign = false where event_id = tests.id('event_a1');
update public.event_clients set can_sign = true where event_id = tests.id('event_a1') and client_id = tests.id('a_client_y');
select tests.login_as(tests.id('owner_a'));
select is(tests.problems('tests.c100'), array['signer_changed'], 'a different contact marked as signer is rejected');
reset role;
update public.event_clients set can_sign = false where event_id = tests.id('event_a1');
select tests.login_as(tests.id('owner_a'));
select is(tests.problems('tests.c100'), array['signer_missing'], 'an event with no signer is rejected');
reset role;
update public.event_clients set can_sign = true where event_id = tests.id('event_a1') and client_id = tests.id('a_client_x');

select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a1'), true);
select is(tests.problems('tests.c100'), array['event_archived'], 'an archived event is rejected');
select public.set_event_archived(tests.id('event_a1'), false);
select is(tests.problems('tests.c100'), '{}'::text[], 'unarchiving restores eligibility of the frozen draft');

-- A revised offer supersedes the approval (and the draft).
select tests.send(public.open_proposal_draft(tests.id('event_a1')));
select is(tests.problems('tests.c100'), array['approval_superseded', 'not_current_draft'], 'a superseded approval and draft are rejected');

-- ===========================================================================
-- Sending stays unavailable
-- ===========================================================================
reset role;
select is((select count(*)::int from public.contracts where tenant_id = tests.id('tenant_a') and status = 'sent'), 0, 'no contract is marked sent');
select throws_ok($$ update public.contracts set status = 'sent' where id = current_setting('tests.c100')::uuid $$, '23514', null,
  'the database still refuses to mark any contract sent');
select is((select count(*)::int from public.email_outbox where entity_id in (select id from public.contracts where tenant_id = tests.id('tenant_a'))), 0,
  'no contract email is queued');
select is((select count(*)::int from public.access_links where purpose <> 'proposal'), 0, 'no signing links exist');
select ok(not exists (select 1 from pg_proc where proname in ('send_contract', 'contract_send')), 'there is no send function yet');
select is((select count(*)::int from public.contract_template_versions where tenant_id = tests.id('tenant_a') and published_at is null), 0,
  'published versions were untouched by the work above');

select * from finish();
rollback;
