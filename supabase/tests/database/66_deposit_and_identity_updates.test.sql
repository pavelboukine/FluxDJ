-- The deposit percentage and the legal identity as separate saves: each writes only
-- its own columns, both are owner-only and tenant-scoped, and contracts, the send
-- review, booking confirmation and the direct-contract requirement behave as before.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(50);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('deposit-test-' || name)::uuid);
$$;
create function tests.new_event(name text, contract_first boolean default false) returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, contract_first) values (tests.id(name), tests.id('tenant_a'), name, 'wedding', '2027-09-01', contract_first);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  return tests.id(name);
end $$;
create function tests.draft(event text) returns uuid language plpgsql as $$
declare v_approval uuid := tests.approved(event); v_contract uuid;
begin
  perform tests.login_as(tests.id('owner_a'));
  v_contract := (public.generate_contract_draft(v_approval, current_setting('tests.v')::uuid) ->> 'contract_id')::uuid;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_contract;
end $$;
create function tests.send_c(contract uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid(); r jsonb;
begin
  perform tests.login_as(tests.id('owner_a'));
  r := public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.sign(contract uuid) returns jsonb language plpgsql as $$
declare v_hash text; v_consent text; v_path text; r jsonb;
begin
  select content_sha256, consent_version, tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' into v_hash, v_consent, v_path from public.contracts where id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size": 4096, "mimetype": "image/png"}');
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id('client_y'), 'Client Y', v_hash, v_consent, true, v_path, repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.pay(event text, cents bigint) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('staff_a'));
  r := public.record_event_payment(tests.id(event), cents, current_date - 1, null, null, gen_random_uuid(), true);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.problems(contract uuid) returns text[] language sql as $$
  select coalesce(array_agg(p ->> 'code' order by p ->> 'code'), '{}')
  from jsonb_array_elements(public.review_contract_for_send(contract) -> 'problems') p $$;
-- Every column of the tenant except the ones a save may change, and the timestamp.
create function tests.tenant_except(tenant text, variadic drop_keys text[] default '{}') returns jsonb language sql stable as $$
  select to_jsonb(t) - 'updated_at' - drop_keys from public.tenants t where t.id = tests.id(tenant) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Who can call them
-- ===========================================================================
select is(has_function_privilege('anon', 'public.update_deposit_percent(uuid, integer)', 'execute'), false, 'anonymous visitors cannot change the deposit');
select is(has_function_privilege('anon', 'public.update_business_identity(uuid, text, text, text)', 'execute'), false, 'nor the legal identity');

-- As a new workspace starts: nothing confirmed yet.
update public.tenants set business_name = 'Placeholder', business_address = null, contact_email = null, deposit_percent = 50 where id = tests.id('tenant_a');
create temp table a_before as select tests.tenant_except('tenant_a', 'deposit_percent') as row_json;
create temp table b_before as select tests.tenant_except('tenant_b') as row_json;
grant select on a_before, b_before to authenticated;

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_deposit_percent(tests.id('tenant_a'), 10) $$, '42501', null, 'staff cannot change the deposit');
select throws_ok($$ select public.update_business_identity(tests.id('tenant_a'), 'X', 'Y', 'x@example.test') $$, '42501', null, 'nor the legal identity');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_deposit_percent(tests.id('tenant_a'), 10) $$, 'P0002', 'not found', 'another business''s owner cannot change the deposit');
select throws_ok($$ select public.update_business_identity(tests.id('tenant_a'), 'X', 'Y', 'x@example.test') $$, 'P0002', 'not found', 'nor the legal identity');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.update_deposit_percent(tests.id('tenant_a'), 10) $$, 'P0002', 'not found', 'a client cannot change the deposit');
select throws_ok($$ select public.update_business_identity(tests.id('tenant_a'), 'X', 'Y', 'x@example.test') $$, 'P0002', 'not found', 'nor the legal identity');
reset role; select set_config('request.jwt.claims', '', true);
select tests.login_as_anon();
select throws_ok($$ select public.update_deposit_percent(tests.id('tenant_a'), 10) $$, '42501', null, 'anon cannot change the deposit');
select throws_ok($$ select public.update_business_identity(tests.id('tenant_a'), 'X', 'Y', 'x@example.test') $$, '42501', null, 'nor the legal identity');
reset role; select set_config('request.jwt.claims', '', true);
select is((select deposit_percent from public.tenants where id = tests.id('tenant_a')), 50, 'none of those changed the deposit');
select is(tests.tenant_except('tenant_a', 'deposit_percent'), (select row_json from a_before), 'nor anything else');

-- Removal is checked, not just the role.
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_deposit_percent(tests.id('tenant_a'), 10) $$, 'P0002', 'not found', 'a removed member is refused');
reset role; select set_config('request.jwt.claims', '', true);
update public.tenant_memberships set removed_at = null, removed_by = null where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');

-- ===========================================================================
-- The deposit save writes only the deposit
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is(public.update_deposit_percent(tests.id('tenant_a'), 30), 30, 'the owner sets the deposit, before any legal details exist');
select throws_like($$ select public.update_deposit_percent(tests.id('tenant_a'), -1) $$, '%whole percentage from 0 to 100%', 'below 0% is rejected');
select throws_like($$ select public.update_deposit_percent(tests.id('tenant_a'), 101) $$, '%whole percentage from 0 to 100%', 'above 100% is rejected');
select throws_like($$ select public.update_deposit_percent(tests.id('tenant_a'), null) $$, '%whole percentage from 0 to 100%', 'a missing percentage is rejected');
select throws_ok($$ update public.tenants set deposit_percent = 10 where id = tests.id('tenant_a') $$, '42501', null, 'the column still can''t be updated directly');
reset role; select set_config('request.jwt.claims', '', true);
select is((select deposit_percent from public.tenants where id = tests.id('tenant_a')), 30, 'the refused values changed nothing');
select is(tests.tenant_except('tenant_a', 'deposit_percent'), (select row_json from a_before), 'no other column of the business changed: the legal name stays a placeholder, address and email stay empty');
select is((select business_address is not null and contact_email is not null from public.tenants where id = tests.id('tenant_a')), false,
  'so saving a deposit doesn''t mark the legal details as saved');
select is(tests.tenant_except('tenant_b'), (select row_json from b_before), 'and another business is untouched');
select results_eq(
  $$ select metadata ->> 'from', metadata ->> 'to' from public.audit_events where entity_id = tests.id('tenant_a') and action = 'deposit_percent_changed' $$,
  $$ values ('50'::text, '30'::text) $$, 'the change is audited once, from and to');

select tests.login_as(tests.id('owner_a'));
select is(public.update_deposit_percent(tests.id('tenant_a'), 30), 30, 'saving the same percentage succeeds');
select is(public.update_deposit_percent(tests.id('tenant_a'), 0), 0, '0% is allowed');
select is(public.update_deposit_percent(tests.id('tenant_a'), 100), 100, '100% is allowed');
reset role; select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'deposit_percent_changed'), 3, 'an unchanged save adds no audit entry');

-- ===========================================================================
-- The identity save writes only the identity
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select public.update_deposit_percent(tests.id('tenant_a'), 35);
select lives_ok($$ select public.update_business_identity(tests.id('tenant_a'), ' BOUPROD Legal Inc. ', E'1 Main St\nMontréal, QC', 'Legal@Bouprod.Test') $$, 'the owner saves the legal identity');
select throws_like($$ select public.update_business_identity(tests.id('tenant_a'), '', 'Y', 'x@example.test') $$, '%legal business name%', 'a blank legal name is rejected');
select throws_like($$ select public.update_business_identity(tests.id('tenant_a'), 'X', '   ', 'x@example.test') $$, '%address%', 'a blank address is rejected');
select throws_like($$ select public.update_business_identity(tests.id('tenant_a'), 'X', 'Y', 'not-an-email') $$, '%valid contact email%', 'an invalid email is rejected');
reset role; select set_config('request.jwt.claims', '', true);
select results_eq(
  $$ select business_name, business_address, contact_email, deposit_percent, display_name from public.tenants where id = tests.id('tenant_a') $$,
  $$ values ('BOUPROD Legal Inc.'::text, E'1 Main St\nMontréal, QC'::text, 'legal@bouprod.test'::text, 35, 'BOUPROD'::text) $$,
  'values are trimmed and normalized; the deposit and display name are unchanged');
select is(tests.tenant_except('tenant_a', 'deposit_percent', 'business_name', 'business_address', 'contact_email'),
  (select row_json - 'business_name' - 'business_address' - 'contact_email' from a_before), 'and so is everything else');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'business_settings_updated'), 1, 'the change is audited once');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('tenant_a') and action = 'deposit_percent_changed'), 4, 'with no deposit change recorded');

-- ===========================================================================
-- Contracts: snapshots and the send review
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select public.update_deposit_percent(tests.id('tenant_a'), 30);
reset role; select set_config('request.jwt.claims', '', true);
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select tests.new_event('ev_frozen');
select set_config('tests.c', tests.draft('ev_frozen')::text, true);
select results_eq($$ select deposit_percent, booking_policy from public.contracts where id = current_setting('tests.c')::uuid $$, $$ values (30, 'on_deposit'::text) $$, 'a new contract freezes the deposit percentage');

select tests.login_as(tests.id('owner_a'));
select is(tests.problems(current_setting('tests.c')::uuid), '{}'::text[], 'the draft is ready to send');
select public.update_business_identity(tests.id('tenant_a'), 'BOUPROD Legal Inc.', E'1 Main St\nMontréal, QC', 'legal@bouprod.test');
select is(tests.problems(current_setting('tests.c')::uuid), '{}'::text[], 'saving the same legal details doesn''t disturb the deposit check');
select public.update_deposit_percent(tests.id('tenant_a'), 60);
select is(tests.problems(current_setting('tests.c')::uuid), array['deposit_changed'], 'a new percentage still blocks a draft until it is regenerated');
select public.update_deposit_percent(tests.id('tenant_a'), 30);
select is(tests.problems(current_setting('tests.c')::uuid), '{}'::text[], 'and going back clears it');
reset role; select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Booking confirmation follows the contract's frozen figures
-- ===========================================================================
select tests.send_c(current_setting('tests.c')::uuid);
create temp table c_before as select to_jsonb(c) row_json from public.contracts c where id = current_setting('tests.c')::uuid;
select tests.login_as(tests.id('owner_a'));
select public.update_deposit_percent(tests.id('tenant_a'), 60);
select public.update_business_identity(tests.id('tenant_a'), 'BOUPROD Renamed Inc.', '2 New Ave', 'new@bouprod.test');
reset role; select set_config('request.jwt.claims', '', true);
select is((select to_jsonb(c) from public.contracts c where id = current_setting('tests.c')::uuid), (select row_json from c_before),
  'neither save changes a sent contract');
select is(tests.sign(current_setting('tests.c')::uuid) ->> 'status', 'signed', 'the client signs it');
select is((select lifecycle_status from public.events where id = tests.id('ev_frozen')), 'awaiting_deposit', 'signed, it waits for the deposit');
select tests.pay('ev_frozen', (select deposit_cents from public.contracts where id = current_setting('tests.c')::uuid));
select is((select lifecycle_status from public.events where id = tests.id('ev_frozen')), 'booked',
  'the contract''s own 30% books it, though the business now asks for 60%');

-- ===========================================================================
-- A direct contract reads the current requirement
-- ===========================================================================
select set_config('tests.priced', tests.published_version('owner_a', 'tenant_a', '[{"heading":"Price","body":"Total {{pricing.total}}. Deposit {{payment.deposit}}. Balance {{payment.balance}}."}]'::jsonb, 'Agreement', 'client_use')::text, true);
select tests.new_event('ev_direct', true);
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.generate_direct_contract_draft(tests.id('ev_direct'), current_setting('tests.priced')::uuid, 100000::bigint, 59999::bigint, null, null, true, null) $$,
  '42501', null, 'staff can''t go one cent below the percentage just saved');
select is(public.generate_direct_contract_draft(tests.id('ev_direct'), current_setting('tests.priced')::uuid, 100000::bigint, 60000::bigint, null, null, false, null) ->> 'status', 'created',
  'and can meet it');
reset role; select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Suspended and archived businesses
-- ===========================================================================
-- Set directly (suspend_workspace needs a platform administrator; its own file covers it).
set local session_replication_role = replica;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.update_deposit_percent(tests.id('tenant_a'), 10) $$, 'PT423', null, 'a suspended workspace refuses the deposit');
select throws_ok($$ select public.update_business_identity(tests.id('tenant_a'), 'X', 'Y', 'x@example.test') $$, 'PT423', null, 'and the legal identity');
reset role; select set_config('request.jwt.claims', '', true);
update public.tenants set archived_at = now() where id = tests.id('tenant_b');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_deposit_percent(tests.id('tenant_b'), 10) $$, 'P0002', 'not found', 'an archived business refuses the deposit');
select throws_ok($$ select public.update_business_identity(tests.id('tenant_b'), 'X', 'Y', 'x@example.test') $$, 'P0002', 'not found', 'and the legal identity');

select * from finish();
rollback;
