-- Configurable booking workflows (Release B): creating a contract-first event,
-- correcting the choice early, generating a contract with no proposal, the deposit
-- rule, and the whole path to booked and planning, through the real functions.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(115);

-- A contract-first event in tenant A, client Y signing with access (as an accepted invitation grants).
create function tests.cf(name text, tenant text default 'tenant_a', signer text default 'a_client_y') returns uuid language plpgsql as $$
declare v uuid := md5('wf-' || name)::uuid;
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, contract_first) values (v, tests.id(tenant), name, 'wedding', '2027-09-01', true);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id(tenant), v, tests.id(signer), true, true);
  return v;
end $$;
create function tests.ev(name text) returns uuid language sql immutable as $$ select md5('wf-' || name)::uuid $$;

-- Generates as a signed-in member; returns the function's result.
create function tests.gen(event text, version text default 'tests.none', total bigint default null, deposit bigint default null, due date default null,
                          services text default null, override boolean default false, who text default 'owner_a', replace_id uuid default null)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.generate_direct_contract_draft(tests.ev(event), current_setting(version)::uuid, total, deposit, due, services, override, replace_id);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.gen_id(event text, version text default 'tests.none', total bigint default null, deposit bigint default null, override boolean default false)
returns uuid language sql as $$ select (tests.gen(event, version, total, deposit, override => override) ->> 'contract_id')::uuid $$;

create function tests.link_hash(link uuid) returns text language sql immutable as $$
  select encode(sha256(convert_to('invite-' || link, 'UTF8')), 'hex') $$;
create function tests.send_c(contract uuid) returns uuid language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  perform tests.login_as(tests.id('owner_a'));
  perform public.send_contract(contract, v_link, tests.link_hash(v_link));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_link;
end $$;
create function tests.grant_access(event text) returns void language sql as $$
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.ev(event), tests.id('a_client_y'), tests.id('client_y'));
$$;
create function tests.sign(contract uuid, who text default 'client_y', slug text default 'test-bouprod') returns jsonb language plpgsql as $$
declare v_hash text; v_consent text; v_path text; r jsonb;
begin
  select content_sha256, consent_version, tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' into v_hash, v_consent, v_path from public.contracts where id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size": 4096, "mimetype": "image/png"}');
  perform tests.login_as_service();
  r := public.sign_contract(contract, slug, tests.id(who), 'Client Y', v_hash, v_consent, true, v_path, repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.pay(event text, cents bigint) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('staff_a'));
  r := public.record_event_payment(tests.ev(event), cents, current_date - 1, null, null, gen_random_uuid(), true);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.state(event text) returns text language sql stable as $$
  select lifecycle_status from public.events where id = tests.ev(event) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test', reply_to_email = 'hello@bouprod.test' where id = tests.id('tenant_a');
update public.tenants set business_address = '2 Other St', contact_email = 'legal@other.test' where id = tests.id('tenant_b');

-- Templates: no money; total only; total and deposit; every payment field; proposal fields; services.
select set_config('tests.none', tests.published_version('owner_a', 'tenant_a', '[{"heading":"Terms","body":"Between {{business.name}} and {{client.name}}."}]'::jsonb, 'Agreement for {{event.title}}', 'client_use')::text, true);
select set_config('tests.none_demo', tests.published_version('owner_a', 'tenant_a', '[{"heading":"Terms","body":"Between {{business.name}} and {{client.name}}."}]'::jsonb)::text, true);
select set_config('tests.total', tests.published_version('owner_a', 'tenant_a', '[{"heading":"Price","body":"Total {{pricing.total}}."}]'::jsonb, 'Agreement', 'client_use')::text, true);
select set_config('tests.priced', tests.published_version('owner_a', 'tenant_a', '[{"heading":"Price","body":"Total {{pricing.total}}. Deposit {{payment.deposit}}. Balance {{payment.balance}}."}]'::jsonb, 'Agreement', 'client_use')::text, true);
select set_config('tests.dated', tests.published_version('owner_a', 'tenant_a', '[{"heading":"Price","body":"Total {{pricing.total}}. Deposit {{payment.deposit}} ({{payment.deposit_percent}}). Due {{payment.balance_due_date}}."}]'::jsonb, 'Agreement', 'client_use')::text, true);
select set_config('tests.package', tests.published_version('owner_a', 'tenant_a', tests.demo_sections(), 'Agreement', 'client_use')::text, true);
select set_config('tests.services', tests.published_version('owner_a', 'tenant_a', '[{"heading":"Services","body":"{{contract.services}}"}]'::jsonb, 'Agreement', 'client_use')::text, true);
select set_config('tests.other', tests.published_version('owner_b', 'tenant_b', '[{"heading":"Terms","body":"Other business."}]'::jsonb, 'Agreement', 'client_use')::text, true);

-- ===========================================================================
-- Creating the event
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select lives_ok($$ insert into public.events (tenant_id, title, event_type, event_date, contract_first) values (tests.id('tenant_a'), 'Direct', 'party', '2027-01-01', true) $$,
  'staff create a contract-first event for their business');
select throws_ok($$ insert into public.events (tenant_id, title, event_type, event_date, contract_first) values (tests.id('tenant_b'), 'Wrong', 'party', '2027-01-01', true) $$,
  '42501', null, 'but not for another business');
select throws_ok($$ insert into public.events (tenant_id, title, event_type, event_date, booking_source, contract_first) values (tests.id('tenant_a'), 'Bad', 'party', '2027-01-01', 'external', true) $$,
  '23514', null, 'and an event booked elsewhere cannot be contract-first');
select throws_ok($$ update public.events set contract_first = true where id = tests.id('event_a1') $$, '42501', null, 'staff have no way to update the flag directly');
reset role; select set_config('request.jwt.claims', '', true);
select is(has_column_privilege('anon', 'public.events', 'contract_first', 'insert'), false, 'anonymous visitors can''t set it');
select is(has_column_privilege('authenticated', 'public.events', 'contract_first', 'update'), false, 'no role gains an update grant');
select is(has_function_privilege('anon', 'public.generate_direct_contract_draft(uuid, uuid, bigint, bigint, date, text, boolean, uuid)', 'execute'), false, 'anonymous visitors can''t generate');
select is(has_function_privilege('anon', 'public.set_event_contract_first(uuid, boolean)', 'execute'), false, 'nor change the workflow');
select is((select count(*)::int from public.events where contract_first and tenant_id = tests.id('tenant_b')), 0, 'existing events are not contract-first');

-- ===========================================================================
-- Correcting the choice while nothing has started
-- ===========================================================================
select tests.cf('wf_switch');
select tests.login_as(tests.id('staff_a'));
select is(public.set_event_contract_first(tests.ev('wf_switch'), false) ->> 'status', 'changed', 'staff can turn the proposal back on before anything starts');
select is((select contract_first from public.events where id = tests.ev('wf_switch')), false, 'and the flag moved');
select is(public.set_event_contract_first(tests.ev('wf_switch'), false) ->> 'status', 'unchanged', 'repeating it changes nothing');
select is(public.set_event_contract_first(tests.ev('wf_switch'), true) ->> 'status', 'changed', 'and it can go back');
reset role; select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.audit_events where entity_id = tests.ev('wf_switch') and action = 'booking_steps_changed'), 2, 'each change is audited');
select throws_ok($$ update public.events set contract_first = false where id = tests.ev('wf_switch') $$, '23514', null, 'nobody can write the flag outside the function, not even the database owner');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.set_event_contract_first(tests.ev('wf_switch'), false) $$, 'P0002', null, 'another business''s owner cannot change it, or learn it exists');
reset role; select set_config('request.jwt.claims', '', true);
insert into public.events (id, tenant_id, title, event_type, event_date, booking_source) values (md5('wf-wf_ext')::uuid, tests.id('tenant_a'), 'External', 'party', '2027-01-01', 'external');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.set_event_contract_first(tests.ev('wf_ext'), true) $$, '%booked elsewhere%', 'an event booked elsewhere stays planning only');
reset role; select set_config('request.jwt.claims', '', true);
select tests.cf('wf_started');
select tests.gen('wf_started', override => true);
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.set_event_contract_first(tests.ev('wf_started'), false) $$, '%can''t change once%', 'a contract, even a draft, fixes the workflow');
reset role; select set_config('request.jwt.claims', '', true);
select tests.cf('wf_arch');
update public.events set archived_at = now() where id = tests.ev('wf_arch');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.set_event_contract_first(tests.ev('wf_arch'), false) $$, '%archived%', 'an archived event cannot change');
reset role; select set_config('request.jwt.claims', '', true);

-- A full-workflow event with a proposal draft is committed too.
select tests.login_as(tests.id('owner_a'));
select public.open_proposal_draft(tests.id('event_a2'), '{}'::jsonb);
select throws_like($$ select public.set_event_contract_first(tests.id('event_a2'), true) $$, '%can''t change once%', 'a proposal draft fixes the workflow');
reset role; select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Generating: who and where
-- ===========================================================================
insert into public.events (id, tenant_id, title, event_type, event_date) values (md5('wf-wf_full')::uuid, tests.id('tenant_a'), 'Full', 'party', '2027-01-01');
insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), md5('wf-wf_full')::uuid, tests.id('a_client_y'), true, true);
select throws_like($$ select tests.gen('wf_full', override => true) $$, '%doesn''t use contract-first%', 'an event on the full workflow cannot skip its proposal');
select throws_like($$ select tests.gen('wf_ext', override => true) $$, '%doesn''t use contract-first%', 'nor can an event booked elsewhere have a contract');
select tests.cf('wf_auth');
select throws_ok($$ select tests.gen('wf_auth', who => 'owner_b', override => true) $$, 'P0002', null, 'another business''s owner cannot generate');
select throws_ok($$ select tests.gen('wf_auth', who => 'client_y', override => true) $$, 'P0002', null, 'nor can a client');
select throws_like($$ select tests.gen('wf_auth', 'tests.other', override => true) $$, '%template version not found%', 'nor can another business''s template be used');
select throws_like($$ select tests.gen('wf_arch', override => true) $$, '%archived%', 'an archived event cannot generate');

-- ===========================================================================
-- Generating: no financial terms
-- ===========================================================================
select tests.cf('wf_none');
select set_config('tests.before_proposals', (select count(*)::text from public.proposals), true);
select is(tests.gen('wf_none') ->> 'status', 'override_required', 'an owner must ask to go without the deposit the business requires');
select is((select count(*)::int from public.contracts where event_id = tests.ev('wf_none')), 0, 'and nothing was generated');
select set_config('tests.c_none', tests.gen_id('wf_none', override => true)::text, true);
select results_eq($$ select proposal_id, selection_id, approval_id from public.contracts where id = current_setting('tests.c_none')::uuid $$,
  $$ values (null::uuid, null::uuid, null::uuid) $$, 'no proposal references');
select results_eq($$ select total_cents, deposit_cents, balance_cents, deposit_percent::bigint from public.contracts where id = current_setting('tests.c_none')::uuid $$,
  $$ values (null::bigint, null::bigint, null::bigint, null::bigint) $$, 'no invented money: every amount is null');
select is((select booking_policy from public.contracts where id = current_setting('tests.c_none')::uuid), 'on_signature', 'booked on signature');
select is((select commercial_snapshot from public.contracts where id = current_setting('tests.c_none')::uuid), '{"schema_version":2,"financial_terms":"none"}'::jsonb, 'a snapshot saying so, and nothing else');
select is((select consent_version from public.contracts where id = current_setting('tests.c_none')::uuid), 'client-no-terms-v1', 'with its own consent version');
select is((select count(*)::text from public.proposals), current_setting('tests.before_proposals'), 'no proposal was created');
select is(tests.state('wf_none'), 'awaiting_signature', 'the event now waits for a signature');
select is((select content_sha256 = private.contract_content_sha256(rendered_content, commercial_snapshot, party_snapshot, template_version_id, template_content_sha256) from public.contracts where id = current_setting('tests.c_none')::uuid), true, 'the content hash covers what was frozen');
select is((select count(*)::int from public.audit_events where entity_id = current_setting('tests.c_none')::uuid and action = 'deposit_requirement_overridden'), 1, 'the override is audited');
select is((select (metadata ->> 'deposit_percent')::int from public.audit_events where entity_id = current_setting('tests.c_none')::uuid and action = 'deposit_requirement_overridden'), 50, 'with the requirement it went below');

-- One draft: replay, explicit replacement, conflict.
select is(tests.gen('wf_none', override => true) ->> 'status', 'replayed', 'the same request returns the same draft');
select is(tests.gen('wf_none', 'tests.none_demo', override => true) ->> 'status', 'draft_exists', 'a different one needs an explicit replacement');
select set_config('tests.c_none2', (tests.gen('wf_none', 'tests.none_demo', override => true, replace_id => current_setting('tests.c_none')::uuid) ->> 'contract_id'), true);
select is((select status from public.contracts where id = current_setting('tests.c_none')::uuid), 'replaced', 'the old draft is kept, marked replaced');
select is((select replaces_id from public.contracts where id = current_setting('tests.c_none2')::uuid), current_setting('tests.c_none')::uuid, 'and the new one points at it');
select is(tests.gen('wf_none', 'tests.none', override => true, replace_id => gen_random_uuid()) ->> 'status', 'conflict', 'replacing the wrong draft is refused');

-- ===========================================================================
-- Generating: the deposit rule
-- ===========================================================================
select tests.cf('wf_dep');
select throws_ok($$ select tests.gen('wf_dep', who => 'staff_a', override => true) $$, '42501', null, 'staff cannot go without terms, even asking for the override');
select throws_ok($$ select tests.gen('wf_dep', 'tests.priced', 100000, 0, who => 'staff_a', override => true) $$, '42501', null, 'nor with a price and no deposit');
select throws_ok($$ select tests.gen('wf_dep', 'tests.priced', 100000, 49999, who => 'staff_a', override => true) $$, '42501', null, 'nor one cent below the business''s percentage');
select throws_ok($$ select tests.gen('wf_dep', 'tests.priced', 0, 0, who => 'staff_a', override => true) $$, '42501', null, 'nor by stating a total of $0');
select is(tests.gen('wf_dep', 'tests.priced', 0, 0) ->> 'status', 'override_required', 'an owner must ask for a $0 total too');
select is(tests.gen('wf_dep', 'tests.priced', 100000, 25000) ->> 'required_deposit_cents', '50000', 'and is told what the requirement is');
select is(tests.gen('wf_dep', 'tests.priced', 100000, 50000, who => 'staff_a') ->> 'status', 'created', 'staff can meet the requirement');
select results_eq($$ select total_cents, deposit_cents, balance_cents, deposit_percent::bigint, booking_policy from public.contracts where event_id = tests.ev('wf_dep') and status = 'draft' $$,
  $$ values (100000::bigint, 50000::bigint, 50000::bigint, 50::bigint, 'on_deposit'::text) $$, 'freezing the terms and the deposit policy');
select is((select commercial_snapshot ->> 'financial_terms' from public.contracts where event_id = tests.ev('wf_dep') and status = 'draft'), 'stated', 'as stated terms');
select tests.cf('wf_dep2');
select is(tests.gen('wf_dep2', 'tests.priced', 100000, 25000, override => true) ->> 'status', 'created', 'an owner may go below it explicitly');
select results_eq($$ select deposit_percent, booking_policy from public.contracts where event_id = tests.ev('wf_dep2') and status = 'draft' $$,
  $$ values (null::integer, 'on_deposit'::text) $$, 'a deposit that isn''t the business''s percentage states no percentage');
select tests.cf('wf_zero');
select is(tests.gen('wf_zero', 'tests.priced', 0, 0, override => true) ->> 'status', 'created', 'and may state a genuine $0');
select results_eq($$ select total_cents, deposit_cents, balance_cents from public.contracts where event_id = tests.ev('wf_zero') $$,
  $$ values (0::bigint, 0::bigint, 0::bigint) $$, 'which stays a real zero, not null');
select is((select consent_version from public.contracts where event_id = tests.ev('wf_zero')), 'client-v1', 'and keeps client-v1');
select tests.login_as(tests.id('owner_a'));
select public.update_booking_policy(tests.id('tenant_a'), 'on_signature', 0);
reset role; select set_config('request.jwt.claims', '', true);
select tests.cf('wf_relaxed');
select is(tests.gen('wf_relaxed', who => 'staff_a') ->> 'status', 'created', 'a business that requires no deposit lets staff go without terms');
select tests.cf('wf_relaxed2');
select is(tests.gen('wf_relaxed2', 'tests.priced', 0, 0, who => 'staff_a') ->> 'status', 'created', 'or state $0');
select is((select count(*)::int from public.audit_events where entity_id = (select id from public.contracts where event_id = tests.ev('wf_relaxed')) and action = 'deposit_requirement_overridden'), 0, 'and nothing is recorded as an override');
select tests.login_as(tests.id('owner_a'));
select public.update_booking_policy(tests.id('tenant_a'), 'on_deposit', 1);
reset role; select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Generating: inputs and placeholders
-- ===========================================================================
select tests.cf('wf_input');
select throws_like($$ select tests.gen('wf_input', 'tests.priced', null, 5000, override => true) $$, '%a deposit needs a total%', 'a deposit needs a total');
select throws_like($$ select tests.gen('wf_input', 'tests.priced', 1000, 5000, override => true) $$, '%more than the total%', 'and can''t exceed it');
select throws_like($$ select tests.gen('wf_input', 'tests.priced', -1, null, override => true) $$, '%negative%', 'amounts can''t be negative');
select throws_like($$ select tests.gen('wf_input', 'tests.none', null, null, '2099-01-01', override => true) $$, '%needs a total%', 'a due date needs a total');
select throws_like($$ select tests.gen('wf_input', 'tests.priced', 100000, 50000, '2099-01-01') $$, '%no balance due date%', 'and a template with that field');
select throws_like($$ select tests.gen('wf_input', 'tests.dated', 100000, 50000, '2001-01-01') $$, '%in the past%', 'and not in the past');
select throws_like($$ select tests.gen('wf_input', 'tests.none', services => 'DJ', override => true) $$, '%no services field%', 'services need a field to appear in');
select is(tests.gen('wf_input', 'tests.package', override => true) ->> 'status', 'incomplete', 'a template with proposal fields is refused, never filled with fake values');
select ok((tests.gen('wf_input', 'tests.package', override => true) -> 'missing')::text like '%approved proposal%', 'and says why');
select is(tests.gen('wf_input', 'tests.priced', override => true) ->> 'status', 'incomplete', 'a template stating payment needs a total');
select ok((tests.gen('wf_input', 'tests.priced', override => true) -> 'missing')::text like '%enter a total%', 'and says so');
select is(tests.gen('wf_input', 'tests.none', 100000, 50000) ->> 'status', 'incomplete', 'terms the template doesn''t state are refused');
select ok((tests.gen('wf_input', 'tests.none', 100000, 50000) -> 'missing')::text like '%terms.total%', 'naming the total');
select ok((tests.gen('wf_input', 'tests.total', 100000, 50000) -> 'missing')::text like '%terms.deposit%', 'or the deposit');
select is(tests.gen('wf_input', 'tests.services', override => true) ->> 'status', 'incomplete', 'a services field needs services');
select ok((tests.gen('wf_input', 'tests.dated', 100000, 25000, '2099-01-01', override => true) -> 'missing')::text like '%payment.deposit_percent%', 'a percentage field needs the business''s own percentage');
select is(tests.gen('wf_input', 'tests.dated', 100000, 50000) ->> 'status', 'incomplete', 'a template with a due date needs it');
select is((select count(*)::int from public.contracts where event_id = tests.ev('wf_input')), 0, 'none of that stored anything');
select tests.cf('wf_serv');
select set_config('tests.c_serv', (tests.gen('wf_serv', 'tests.services', services => '  DJ for 6 hours  ', override => true) ->> 'contract_id'), true);
select is((select rendered_content -> 'sections' -> 0 ->> 'body' from public.contracts where id = current_setting('tests.c_serv')::uuid), 'DJ for 6 hours', 'services are printed in the agreement');
select is((select commercial_snapshot ->> 'services' from public.contracts where id = current_setting('tests.c_serv')::uuid), 'DJ for 6 hours', 'and frozen in its snapshot');
select tests.cf('wf_nosigner', signer => 'a_client_x');
delete from public.event_clients where event_id = tests.ev('wf_nosigner');
select ok((tests.gen('wf_nosigner', override => true) -> 'missing')::text like '%signer%', 'a contract needs a signer');
-- A proposal-backed contract can't use the services field.
select set_config('tests.services_backed', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select is(public.generate_contract_draft(current_setting('tests.services_backed')::uuid, current_setting('tests.services')::uuid) ->> 'status', 'incomplete', 'the services field stays unavailable from a proposal');
select is(public.generate_contract_draft(current_setting('tests.services_backed')::uuid, current_setting('tests.priced')::uuid) ->> 'status', 'created', 'and proposal-backed generation works as before');
reset role; select set_config('request.jwt.claims', '', true);
select is((select booking_policy from public.contracts where event_id = tests.id('event_a1') and status = 'draft'), 'on_deposit', 'still taking the business''s policy');

-- Sending rechecks the rendered agreement: this one was forced in without its money.
select tests.cf('wf_hidden');
select set_config('request.jwt.claims', json_build_object('sub', tests.id('owner_a'), 'role', 'authenticated')::text, true);
insert into public.contracts (id, tenant_id, event_id, template_id, template_version_id, template_content_sha256, signer_client_id, signer_name, signer_email, currency, total_cents, deposit_cents, balance_cents, booking_policy, rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id)
select md5('wf-hidden')::uuid, v.tenant_id, tests.ev('wf_hidden'), v.template_id, v.id, v.content_sha256, c.id, c.name, c.email, 'CAD', 100000, 50000, 50000, 'on_deposit',
  '{"schema_version":1,"title":"Agreement","sections":[{"heading":"Terms","body":"Nothing about money."}]}',
  '{"schema_version":2,"financial_terms":"stated","total_cents":100000,"payment":{"deposit_cents":50000,"balance_cents":50000}}',
  jsonb_build_object('business', jsonb_build_object('name', t.business_name, 'legal_name', t.business_name, 'address', t.business_address, 'contact_email', t.contact_email), 'event', jsonb_build_object('title', 'x')), repeat('0', 64), tests.id('owner_a')
from public.contract_template_versions v, public.clients c, public.tenants t
where v.id = current_setting('tests.none')::uuid and c.id = tests.id('a_client_y') and t.id = tests.id('tenant_a');
select set_config('request.jwt.claims', '', true);
select ok(private.contract_send_problems(md5('wf-hidden')::uuid)::text like '%terms_not_in_agreement%', 'an agreement that doesn''t state its money cannot be sent');

-- ===========================================================================
-- Consent
-- ===========================================================================
select is(private.contract_signing_consent('client-no-terms-v1'),
  'I have read the entire agreement shown above. I agree to sign it electronically. I agree that my typed name and drawn signature are my signature on this agreement and that they bind me to it as a handwritten signature would. I can download a copy of the signed agreement here, and a copy will be emailed to me.',
  'the proposed wording for a contract without payment terms');
select ok(private.contract_signing_consent('client-no-terms-v1') not like '%payment%', 'it says nothing about payment terms');
select is(private.contract_signing_consent('client-v1'),
  'I have read the entire agreement shown above, including its payment terms. I agree to sign it electronically. I agree that my typed name and drawn signature are my signature on this agreement and that they bind me to it as a handwritten signature would. I can download a copy of the signed agreement here, and a copy will be emailed to me.',
  'client-v1 is unchanged');

-- ===========================================================================
-- No financial terms: send, sign, booked, planning
-- ===========================================================================
select tests.cf('wf_sign');
select set_config('tests.c', tests.gen_id('wf_sign', override => true)::text, true);
select set_config('tests.link', tests.send_c(current_setting('tests.c')::uuid)::text, true);
select is((select usable from private.contract_invitation(current_setting('tests.link')::uuid, null, 'test-bouprod')), true, 'the invitation works with no proposal');
select tests.login_as(tests.id('client_y'));
select is(public.accept_contract_invitation(current_setting('tests.link')::uuid, 'test-bouprod') ->> 'state', 'accepted', 'the signer accepts it');
reset role; select set_config('request.jwt.claims', '', true);
select is((tests.sign(current_setting('tests.c')::uuid, 'client_x')) ->> 'code', 'unavailable', 'the wrong signer is refused');
select is((tests.sign(current_setting('tests.c')::uuid, 'client_y', 'test-other-dj')) ->> 'code', 'unavailable', 'and under the wrong business');
select is(tests.sign(current_setting('tests.c')::uuid) ->> 'status', 'signed', 'the signer signs');
select is(tests.state('wf_sign'), 'booked', 'and the event is booked at once');
select is((select booking_confirmed_at is not null from public.events where id = tests.ev('wf_sign')), true, 'with its confirmation set');
select is((select count(*)::int from public.event_payments where event_id = tests.ev('wf_sign')), 0, 'no fake payment');
select is((select count(*)::int from public.event_plans where event_id = tests.ev('wf_sign')), 1, 'planning is initialized by the usual trigger');
select is((select consent_text from public.contract_signatures where contract_id = current_setting('tests.c')::uuid), private.contract_signing_consent('client-no-terms-v1'), 'the signature records the wording shown');
select results_eq($$ select payload -> 'total_cents', payload -> 'remaining_cents' from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'booking_confirmed' $$,
  $$ values ('null'::jsonb, 'null'::jsonb) $$, 'the confirmation email is queued with no invented amounts');
select throws_ok($$ update public.contracts set total_cents = 0 where id = current_setting('tests.c')::uuid $$, '23514', null, 'a signed contract''s terms cannot change');
select throws_ok($$ delete from public.contracts where id = current_setting('tests.c')::uuid $$, null, null, 'nor can it be deleted');

-- ===========================================================================
-- With a deposit: signature, then enough payment
-- ===========================================================================
select tests.cf('wf_pay');
select set_config('tests.p', (tests.gen('wf_pay', 'tests.priced', 100000, 50000) ->> 'contract_id'), true);
select tests.send_c(current_setting('tests.p')::uuid);
select tests.grant_access('wf_pay');
select is(tests.sign(current_setting('tests.p')::uuid) ->> 'status', 'signed', 'a priced contract signs under client-v1');
select is(tests.state('wf_pay'), 'awaiting_deposit', 'and waits for its deposit');
select tests.pay('wf_pay', 49999);
select is(tests.state('wf_pay'), 'awaiting_deposit', 'a partial payment doesn''t book it');
select tests.pay('wf_pay', 1);
select is(tests.state('wf_pay'), 'booked', 'reaching the deposit does');
select is((select count(*)::int from public.event_plans where event_id = tests.ev('wf_pay')), 1, 'and planning follows');

-- A stated price with no deposit books on signature.
select tests.cf('wf_nodep');
select set_config('tests.n', (tests.gen('wf_nodep', 'tests.priced', 100000, null, override => true) ->> 'contract_id'), true);
select tests.send_c(current_setting('tests.n')::uuid);
select tests.grant_access('wf_nodep');
select tests.sign(current_setting('tests.n')::uuid);
select is(tests.state('wf_nodep'), 'booked', 'a price with no deposit books on signature');

-- ===========================================================================
-- Access: voided, replaced, revoked, expired, archived
-- ===========================================================================
select tests.cf('wf_void');
select set_config('tests.v1', tests.gen_id('wf_void', override => true)::text, true);
select set_config('tests.vlink', tests.send_c(current_setting('tests.v1')::uuid)::text, true);
select tests.grant_access('wf_void');
select tests.login_as(tests.id('owner_a'));
select public.void_contract(current_setting('tests.v1')::uuid, 'Wrong terms');
reset role; select set_config('request.jwt.claims', '', true);
select is((select usable from private.contract_invitation(current_setting('tests.vlink')::uuid, null, 'test-bouprod')), false, 'a voided contract''s invitation stops working');
select is(tests.sign(current_setting('tests.v1')::uuid) ->> 'code', 'unavailable', 'and it cannot be signed');
select is(tests.gen('wf_void', override => true) ->> 'status', 'created', 'a replacement can be generated');
select is(tests.state('wf_void'), 'awaiting_signature', 'on the same event');

select tests.cf('wf_gone');
select set_config('tests.g', tests.gen_id('wf_gone', override => true)::text, true);
select set_config('tests.glink', tests.send_c(current_setting('tests.g')::uuid)::text, true);
select tests.grant_access('wf_gone');
select private.set_event_archived(tests.ev('wf_gone'), true, 'staff', tests.id('owner_a'));
select is((select usable from private.contract_invitation(current_setting('tests.glink')::uuid, null, 'test-bouprod')), false, 'archiving stops the invitation');
select is(tests.sign(current_setting('tests.g')::uuid) ->> 'code', 'unavailable', 'and signing');
select private.set_event_archived(tests.ev('wf_gone'), false, 'staff', tests.id('owner_a'));
select is((select usable from private.contract_invitation(current_setting('tests.glink')::uuid, null, 'test-bouprod')), false, 'unarchiving does not restore it');

select tests.cf('wf_exp');
select set_config('tests.e', tests.gen_id('wf_exp', override => true)::text, true);
select set_config('tests.elink', tests.send_c(current_setting('tests.e')::uuid)::text, true);
alter table public.access_links disable trigger access_links_immutable;
update public.access_links set expires_at = now() - interval '1 minute' where id = current_setting('tests.elink')::uuid;
alter table public.access_links enable trigger access_links_immutable;
select is((select usable from private.contract_invitation(current_setting('tests.elink')::uuid, null, 'test-bouprod')), false, 'an expired invitation stops working');

select * from finish();
rollback;
