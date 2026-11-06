-- Contract-first compatibility: the schema can represent a direct contract, with
-- stated terms or none, and every access, delivery, booking and archive path
-- treats it correctly. These contracts are inserted as the database owner, through
-- the real triggers and constraints, so every invalid shape can be tried (the
-- generator is tested in 64_configurable_booking_workflows). A real proposal-backed
-- contract runs alongside them throughout.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(128);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('contract-first-test-' || name)::uuid);
$$;

-- A contract-first event in tenant A (client Y signs), ready for a contract.
create function tests.cf_event(name text) returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, contract_first)
  values (tests.id(name), tests.id('tenant_a'), name, 'wedding', '2027-09-01', true);
  update public.events set lifecycle_status = 'awaiting_signature' where id = tests.id(name);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  return tests.id(name);
end $$;

-- The commercial snapshot a direct contract freezes.
create function tests.snapshot(total bigint, deposit bigint) returns jsonb language sql immutable as $$
  select case when total is null then '{"schema_version":2,"financial_terms":"none"}'::jsonb
    else jsonb_build_object('schema_version', 2, 'financial_terms', 'stated', 'currency', 'CAD', 'total_cents', total,
      'payment', jsonb_build_object('deposit_cents', deposit, 'balance_cents', total - deposit)) end
$$;

-- Inserts a direct contract as the future generator would: the author is the
-- signed-in user, unless the test is already signed in as someone else or asks
-- for no user at all. Everything can be overridden to test the constraints.
create function tests.direct(event text, total bigint default null, deposit bigint default null, policy text default 'on_signature',
                             version text default 'tests.v', author text default 'owner_a', balance bigint default null, percent integer default null,
                             commercial jsonb default null, due date default null, tenant text default 'tenant_a', signer text default 'a_client_y',
                             no_user boolean default false)
returns uuid language plpgsql as $$
declare
  v public.contract_template_versions%rowtype;
  t public.tenants%rowtype;
  c public.clients%rowtype;
  v_id uuid;
  v_sign_in boolean := not no_user and nullif(current_setting('request.jwt.claims', true), '') is null;
begin
  if v_sign_in then
    perform set_config('request.jwt.claims', json_build_object('sub', tests.id(author), 'role', 'authenticated')::text, true);
  end if;
  select * into v from public.contract_template_versions where id = current_setting(version)::uuid;
  select * into t from public.tenants where id = tests.id(tenant);
  select * into c from public.clients where id = tests.id(signer);
  insert into public.contracts (tenant_id, event_id, template_id, template_version_id, template_content_sha256, signer_client_id, signer_name, signer_email,
    currency, total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, booking_policy, rendered_content, commercial_snapshot, party_snapshot,
    content_sha256, generated_by_user_id)
  values (t.id, tests.id(event), v.template_id, v.id, v.content_sha256, c.id, c.name, c.email,
    'CAD', total, percent, deposit, coalesce(balance, total - deposit), due, policy,
    -- The agreement states the money the contract records (sending checks it).
    jsonb_build_object('schema_version', 1, 'title', 'Direct agreement', 'sections', jsonb_build_array(jsonb_build_object('heading', 'Terms', 'body',
      'We agree.' || case when total is null then '' else ' Total ' || private.format_cents(total, 'CAD') || '. Deposit ' || private.format_cents(coalesce(deposit, 0), 'CAD') || '.' end))),
    coalesce(commercial, tests.snapshot(total, deposit)),
    jsonb_build_object('business', jsonb_build_object('name', t.business_name, 'display_name', t.display_name, 'legal_name', t.business_name,
        'address', t.business_address, 'contact_email', t.contact_email),
      'client', jsonb_build_object('client_id', c.id, 'name', c.name, 'email', c.email),
      'event', jsonb_build_object('title', event, 'date', '2027-09-01', 'timezone', 'America/Toronto')),
    repeat('0', 64), tests.id(author))
  returning id into v_id;
  if v_sign_in then
    perform set_config('request.jwt.claims', '', true);
  end if;
  return v_id;
end $$;

create function tests.link_hash(link uuid) returns text language sql immutable as $$
  select encode(sha256(convert_to('invite-' || link, 'UTF8')), 'hex') $$;

-- Sends as the owner; returns the invitation link id.
create function tests.send_c(contract uuid) returns uuid language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  perform tests.login_as(tests.id('owner_a'));
  perform public.send_contract(contract, v_link, tests.link_hash(v_link));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_link;
end $$;

create function tests.sign(contract uuid, who text default 'client_y') returns jsonb language plpgsql as $$
declare
  v_hash text;
  v_consent text;
  v_path text;
  r jsonb;
begin
  select content_sha256, consent_version, tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' into v_hash, v_consent, v_path
  from public.contracts where id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size": 4096, "mimetype": "image/png"}');
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id(who), 'Client Y', v_hash, v_consent, true, v_path,
    repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
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

create function tests.state(event text) returns text language sql stable as $$
  select lifecycle_status || case when booking_confirmed_at is null then '' else ' (confirmed)' end from public.events where id = tests.id(event);
$$;
create function tests.deliverable(contract uuid) returns boolean language plpgsql as $$
declare r boolean;
begin
  -- Claiming needs an eligible row: put the invitation email back in the queue.
  update public.email_outbox set status = 'pending', locked_until = null, next_attempt_at = now(), attempts = 0
    where entity_id = contract and event_type = 'contract_sent';
  select bool_and(contract_deliverable) into r from public.claim_email_outbox(50, 60, tests.id('tenant_a')) where contract_id = contract and event_type = 'contract_sent';
  return r;
end $$;
create function tests.usable(link uuid) returns boolean language sql stable as $$
  select usable from private.contract_invitation(link, null, 'test-bouprod');
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test', reply_to_email = 'hello@bouprod.test'
where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.client_v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections(), 'Agreement for {{event.title}}', 'client_use')::text, true);

-- ===========================================================================
-- events.contract_first
-- ===========================================================================
select is((select contract_first from public.events where id = tests.id('event_a1')), false, 'an event is not contract-first by default');
select is((select count(*)::int from public.events where contract_first and tenant_id in (tests.id('tenant_a'), tests.id('tenant_b'))), 0, 'no ordinary event is contract-first');
select throws_ok($$ insert into public.events (tenant_id, title, event_type, event_date, booking_source, contract_first)
    values (tests.id('tenant_a'), 'Bad', 'party', '2027-01-01', 'external', true) $$,
  '23514', null, 'an event booked elsewhere cannot be contract-first');
select tests.login_as(tests.id('owner_a'));
select lives_ok($$ insert into public.events (tenant_id, title, event_type, event_date, contract_first)
    values (tests.id('tenant_a'), 'Direct', 'party', '2027-01-01', true) $$, 'staff create one when the event is created (Release B grants this insert)');
select throws_ok($$ update public.events set contract_first = true where id = tests.id('event_a1') $$, '42501', null, 'nor switch an event');
select lives_ok($$ insert into public.events (tenant_id, title, event_type, event_date) values (tests.id('tenant_a'), 'Normal', 'party', '2027-01-01') $$,
  'creating an ordinary event is unchanged');
reset role;
select set_config('request.jwt.claims', '', true);
select tests.cf_event('cf_flag');
select throws_ok($$ update public.events set contract_first = false where id = tests.id('cf_flag') $$, '23514', null, 'the flag is immutable for every role');
select throws_ok($$ update public.events set contract_first = true where id = tests.id('event_a2') $$, '23514', null, 'in both directions');

-- A contract-first event has no proposal.
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.open_proposal_draft(tests.id('cf_flag'), '{}'::jsonb) $$, '%contract_first:%', 'a contract-first event cannot start a proposal');
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('tests.approval2', tests.approved('event_a2')::text, true);
select throws_ok($$ insert into public.events (tenant_id, title, event_type, event_date, contract_first, active_proposal_id)
    values (tests.id('tenant_a'), 'Bad', 'party', '2027-01-01', true, (select active_proposal_id from public.events where id = tests.id('event_a2'))) $$,
  '23514', null, 'nor have an active proposal');

-- ===========================================================================
-- Contract shape: every invalid combination is refused
-- ===========================================================================
select tests.cf_event('cf_shape');
select throws_ok($$ select tests.direct('cf_shape', 100000) $$, '23514', null, 'a total without a deposit');
select throws_ok($$ select tests.direct('cf_shape', null, 5000, 'on_deposit', balance => 0) $$, '23514', null, 'a deposit without a total');
select throws_ok($$ select tests.direct('cf_shape', 100000, 30000, balance => 80000) $$, '23514', null, 'a deposit and balance that do not add up');
select throws_ok($$ select tests.direct('cf_shape', null, null, 'on_deposit') $$, '23514', null, 'on_deposit with no financial terms');
select throws_ok($$ select tests.direct('cf_shape', 100000, 0, 'on_deposit') $$, '23514', null, 'on_deposit with a zero deposit');
select throws_like($$ select tests.direct('cf_shape', null, null, null) $$, '%choose when this booking is confirmed%', 'no booking policy at all');
select throws_ok($$ select tests.direct('cf_shape', null, null, percent => 50) $$, '23514', null, 'a deposit percentage with no terms');
select throws_ok($$ select tests.direct('cf_shape', null, null, due => '2027-01-01') $$, '23514', null, 'a balance date with no terms');
select throws_ok($$ select tests.direct('cf_shape', null, null, commercial => '{"financial_terms":"none","total_cents":0}') $$, '23514', null, 'a zero total hiding in a no-terms snapshot');
select throws_ok($$ select tests.direct('cf_shape', null, null, commercial => '{"schema_version":2}') $$, '23514', null, 'a no-terms contract must say so in its snapshot');
select throws_ok($$ select tests.direct('cf_shape', 100000, 0, commercial => tests.snapshot(90000, 0)) $$, '23514', null, 'a snapshot total that differs from the column');
select throws_ok($$ select tests.direct('cf_shape', 100000, 0, commercial => '{"financial_terms":"none"}') $$, '23514', null, 'a priced contract cannot claim no terms');

-- Partial references, and the proposal-backed shape.
select set_config('tests.approval', tests.approved('event_a1')::text, true);
create function tests.backed(total bigint, deposit bigint, percent integer, policy text default null) returns uuid language plpgsql as $$
declare
  a public.proposal_approvals%rowtype;
  v public.contract_template_versions%rowtype;
  v_id uuid;
begin
  select * into a from public.proposal_approvals where id = current_setting('tests.approval')::uuid;
  select * into v from public.contract_template_versions where id = current_setting('tests.v')::uuid;
  insert into public.contracts (tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id, template_content_sha256,
    signer_client_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents, booking_policy,
    rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id)
  values (a.tenant_id, tests.id('event_a1'), a.proposal_id, a.selection_id, a.id, v.template_id, v.id, v.content_sha256,
    tests.id('a_client_x'), 'Client X (A)', 'client-x@example.test', 'CAD', total, percent, deposit, total - deposit, policy,
    '{"schema_version":1,"title":"Backed","sections":[]}', jsonb_build_object('payment', jsonb_build_object('deposit_basis_points', percent * 100)), '{}', repeat('0', 64), tests.id('owner_a'))
  returning id into v_id;
  return v_id;
end $$;
select throws_ok($$ select tests.backed(null, null, null) $$, '23514', null, 'a proposal-backed contract cannot drop its money');
select throws_ok($$ select tests.backed(100000, 50000, null) $$, '23514', null, 'nor its deposit percentage');
select throws_ok($$ insert into public.contracts (tenant_id, event_id, proposal_id, template_id, template_version_id, template_content_sha256, signer_client_id, signer_name, signer_email,
      currency, rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_user_id, booking_policy)
    select a.tenant_id, tests.id('event_a1'), a.proposal_id, v.template_id, v.id, v.content_sha256, tests.id('a_client_x'), 'X', 'client-x@example.test', 'CAD',
      '{"title":"x","sections":[]}', '{}', '{}', repeat('0', 64), tests.id('owner_a'), 'on_signature'
    from public.proposal_approvals a, public.contract_template_versions v
    where a.id = current_setting('tests.approval')::uuid and v.id = current_setting('tests.v')::uuid $$,
  '23514', null, 'partial proposal references are refused');
select set_config('tests.backed', tests.backed(100000, 50000, 50, 'on_signature')::text, true);
select is((select booking_policy from public.contracts where id = current_setting('tests.backed')::uuid), 'on_deposit',
  'a proposal-backed contract still takes the tenant''s policy, whatever is asked for');

-- A direct contract needs a contract-first event: missing references grant nothing.
select throws_like($$ select tests.direct('event_a2') $$, '%needs a contract-first event%', 'an ordinary event cannot have a contract without a proposal');
select tests.cf_event('cf_done');
update public.events set lifecycle_status = 'cancelled' where id = tests.id('cf_done');
select throws_like($$ select tests.direct('cf_done') $$, '%still being booked%', 'nor a contract-first event that has ended');

-- ===========================================================================
-- Deposit authorization: the business's required deposit needs an owner to override
-- ===========================================================================
select tests.cf_event('cf_auth');
select throws_ok($$ select tests.direct('cf_auth', author => 'staff_a') $$, '42501', null, 'staff cannot drop the required deposit with no terms');
select throws_ok($$ select tests.direct('cf_auth', 100000, 0, author => 'staff_a') $$, '42501', null, 'nor with a price and no deposit');
select throws_ok($$ select tests.direct('cf_auth', 100000, 49999, 'on_deposit', author => 'staff_a') $$, '42501', null, 'nor with a deposit below the business''s percentage');
select throws_ok($$ select tests.direct('cf_auth', 100000, 50000, 'on_signature', author => 'staff_a') $$, '42501', null, 'nor by keeping the deposit but booking on signature');
-- The signed-in actor decides, not the author recorded on the row.
select set_config('request.jwt.claims', json_build_object('sub', tests.id('staff_a'), 'role', 'authenticated')::text, true);
select throws_ok($$ select tests.direct('cf_auth', author => 'owner_a') $$, '42501', null, 'naming the owner as the author does not help staff');
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select tests.direct('cf_auth', author => 'owner_a', no_user => true) $$, '42501', null, 'nor does it help with no signed-in user, such as the service role');
select throws_ok($$ select tests.direct('cf_auth', author => 'owner_b') $$, '42501', null, 'another business''s owner cannot override this one''s deposit');
select lives_ok($$ select tests.direct('cf_auth', 200000, 100000, 'on_deposit', author => 'staff_a') $$, 'staff may meet the required deposit');
select tests.cf_event('cf_auth2');
select throws_ok($$ select tests.direct('cf_auth2', 0, 0, author => 'staff_a') $$, '42501', null, 'nor by stating a total of $0 (Release B closes this)');
select lives_ok($$ select tests.direct('cf_auth2', 0, 0) $$, 'an owner may: a genuine $0 contract');
select tests.cf_event('cf_auth3');
select lives_ok($$ select tests.direct('cf_auth3') $$, 'an owner may override: no terms');
select tests.cf_event('cf_auth4');
select lives_ok($$ select tests.direct('cf_auth4', 100000, 100, 'on_deposit') $$, 'an owner may override: a smaller deposit');
select tests.login_as(tests.id('owner_a'));
select public.update_booking_policy(tests.id('tenant_a'), 'on_signature', 0);
reset role;
select set_config('request.jwt.claims', '', true);
select tests.cf_event('cf_auth5');
select lives_ok($$ select tests.direct('cf_auth5', author => 'staff_a') $$, 'a business that requires no deposit lets staff go without');
select tests.login_as(tests.id('owner_a'));
select public.update_booking_policy(tests.id('tenant_a'), 'on_deposit', 1);
reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Consent: the wording that mentions payment terms never goes on a contract without any
-- ===========================================================================
-- Until wording exists for a version (its own migration can be held back), a contract frozen with it fails closed.
create or replace function private.contract_signing_consent(p_version text) returns text language sql immutable set search_path = '' as $$
  select case p_version when 'client-v1' then 'Old wording.' when 'demo-v1' then 'Demo.' end $$;
select tests.cf_event('cf_consent');
select set_config('tests.c_consent', tests.direct('cf_consent', version => 'tests.client_v')::text, true);
select is((select consent_version from public.contracts where id = current_setting('tests.c_consent')::uuid), 'client-no-terms-v1', 'a client-use contract with no terms freezes its own consent version');
select is(private.contract_signing_consent('client-no-terms-v1'), null, 'which has no wording until it is approved');
select tests.cf_event('cf_consent2');
select set_config('tests.c_consent2', tests.direct('cf_consent2', 100000, 100000, 'on_deposit', version => 'tests.client_v')::text, true);
select is((select consent_version from public.contracts where id = current_setting('tests.c_consent2')::uuid), 'client-v1', 'a client-use contract with stated terms keeps client-v1');
select tests.login_as(tests.id('owner_a'));
select is(public.review_contract_for_send(current_setting('tests.c_consent')::uuid) -> 'problems' -> 0 ->> 'code', 'consent_unavailable', 'it cannot be sent yet');
select throws_like($$ select tests.send_c(current_setting('tests.c_consent')::uuid) $$, '%contract_not_sendable%', 'and send refuses it');
reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Direct contract, no terms (DEMO signing): the whole path to booked
-- ===========================================================================
select tests.cf_event('cf_none');
select set_config('tests.c', tests.direct('cf_none')::text, true);
select tests.login_as(tests.id('owner_a'));
select results_eq($$ select (r ->> 'eligible')::boolean, r ->> 'source', r -> 'total_cents', r -> 'deposit_percent'
    from (select public.review_contract_for_send(current_setting('tests.c')::uuid) as r) x $$,
  $$ values (true, 'direct'::text, 'null'::jsonb, 'null'::jsonb) $$, 'a no-terms draft is eligible to send, and reads as direct');
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('tests.link', tests.send_c(current_setting('tests.c')::uuid)::text, true);
select is((select proposal_id from public.access_links where id = current_setting('tests.link')::uuid), null, 'its invitation has no proposal');
select ok(tests.usable(current_setting('tests.link')::uuid), 'and is usable');
select ok(tests.deliverable(current_setting('tests.c')::uuid), 'its email is deliverable');
select results_eq($$ select payload -> 'deposit_cents', payload -> 'deposit_percent' from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_sent' $$,
  $$ values ('null'::jsonb, 'null'::jsonb) $$, 'with no deposit figures invented');

-- Signer scope.
select ok(private.signer_can_access_contract(current_setting('tests.c')::uuid, tests.id('client_y')), 'the signer can open it');
select ok(not private.signer_can_access_contract(current_setting('tests.c')::uuid, tests.id('client_x')), 'another client cannot');
select ok(not private.signer_can_access_contract(current_setting('tests.c')::uuid, tests.id('stranger')), 'nor a stranger');
select ok(not private.signer_can_access_contract(current_setting('tests.c')::uuid, null), 'nor nobody');
select tests.login_as(tests.id('client_y'));
select results_eq($$ select v ->> 'state', v -> 'contract' ->> 'source', v -> 'contract' -> 'total_cents', (v -> 'signing' ->> 'enabled')::boolean
    from (select public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') as v) x $$,
  $$ values ('available'::text, 'direct'::text, 'null'::jsonb, true) $$, 'the signer reads a direct contract with no amounts');
select is(public.client_approved_offer(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'and there is no approved proposal to read');
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-other-dj') ->> 'state', 'unavailable', 'under another business''s address it does not exist');
select tests.login_as(tests.id('client_x'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'another client gets nothing');
select is((select count(*)::int from public.my_contracts() where contract_id = current_setting('tests.c')::uuid), 0, 'nor sees it listed');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.review_contract_for_send(current_setting('tests.c')::uuid) $$, 'P0002', null, 'another business''s owner cannot review it');
select throws_ok($$ select public.void_contract(current_setting('tests.c')::uuid, 'no') $$, 'P0002', null, 'nor void it');
select is((select count(*)::int from public.contracts where id = current_setting('tests.c')::uuid), 0, 'nor read it');
reset role;
select set_config('request.jwt.claims', '', true);
select is(tests.sign(current_setting('tests.c')::uuid, 'client_x') ->> 'code', 'unavailable', 'another client cannot sign');
select is(tests.state('cf_none'), 'awaiting_signature', 'so nothing is booked');

-- Before signing, the summary has no money.
select results_eq($$ select s -> 'terms', (s ->> 'no_financial_terms')::boolean, s -> 'remaining_balance_cents', s -> 'deposit_outstanding_cents', s -> 'credit_cents'
    from (select private.event_payment_summary(tests.id('cf_none')) as s) x $$,
  $$ values ('null'::jsonb, true, 'null'::jsonb, 'null'::jsonb, 'null'::jsonb) $$, 'no total, no balance, no deposit, no credit: not zero');

select is(tests.sign(current_setting('tests.c')::uuid) ->> 'status', 'signed', 'the signer signs');
select is(tests.state('cf_none'), 'booked (confirmed)', 'signing books the event, with no deposit invented');
select is((select count(*)::int from public.event_payments where event_id = tests.id('cf_none')), 0, 'and no payment recorded');
select ok(exists (select 1 from public.event_plans where event_id = tests.id('cf_none')), 'booking creates the plan as usual');
select ok(private.event_booked_for_planning((select e from public.events e where id = tests.id('cf_none'))), 'and the event is booked for planning');
select tests.login_as(tests.id('client_y'));
select results_eq($$ select s -> 'total_cents', s -> 'remaining_balance_cents', (s ->> 'no_financial_terms')::boolean, s ->> 'booking_status'
    from (select public.client_payment_summary(current_setting('tests.c')::uuid, 'test-bouprod') as s) x $$,
  $$ values ('null'::jsonb, 'null'::jsonb, true, 'booked'::text) $$, 'the client summary says booked, with no figures');
reset role;
select set_config('request.jwt.claims', '', true);
select results_eq($$ select (s -> 'booking' ->> 'policy'), (s -> 'booking' ->> 'legacy_signed')::boolean, (s -> 'booking' ->> 'deposit_no_longer_met')::boolean
    from (select private.event_payment_summary(tests.id('cf_none')) as s) x $$,
  $$ values ('on_signature'::text, false, false) $$, 'staff see the frozen policy, and no deposit warning');
select results_eq($$ select payload -> 'total_cents', payload -> 'deposit_cents', payload -> 'remaining_cents', payload -> 'credit_cents' from public.email_outbox
    where entity_id = current_setting('tests.c')::uuid and event_type = 'booking_confirmed' $$,
  $$ values ('null'::jsonb, 'null'::jsonb, 'null'::jsonb, 'null'::jsonb) $$, 'the booking email has no figures, so it cannot say nothing is owed');

-- A later payment is real money, but no terms appear.
select is(tests.pay('cf_none', 5000) ->> 'status', 'recorded', 'a payment can still be recorded');
select results_eq($$ select s -> 'terms', (s ->> 'received_cents')::bigint, s -> 'remaining_balance_cents', s -> 'credit_cents'
    from (select private.event_payment_summary(tests.id('cf_none')) as s) x $$,
  $$ values ('null'::jsonb, 5000::bigint, 'null'::jsonb, 'null'::jsonb) $$, 'and is shown as received, with no balance or credit derived');

-- ===========================================================================
-- Immutability: nulls don't make a signed contract editable
-- ===========================================================================
select throws_ok($$ update public.contracts set total_cents = 100 where id = current_setting('tests.c')::uuid $$, '23514', null, 'a null total cannot be filled in');
select throws_ok($$ update public.contracts set proposal_id = (select id from public.proposals limit 1) where id = current_setting('tests.c')::uuid $$, '23514', null, 'nor a null proposal');
select throws_ok($$ update public.contracts set commercial_snapshot = '{"financial_terms":"none","x":1}' where id = current_setting('tests.c')::uuid $$, '23514', null, 'nor the snapshot changed');
select throws_ok($$ update public.contracts set booking_policy = 'on_deposit' where id = current_setting('tests.c')::uuid $$, '23514', null, 'nor the policy');
select throws_ok($$ update public.contracts set status = 'void', void_reason = 'x' where id = current_setting('tests.c')::uuid $$, '23514', null, 'nor the status moved back');
select throws_ok($$ delete from public.contracts where id = current_setting('tests.c')::uuid $$, null, null, 'nor the row deleted');
select is((select content_sha256 from public.contracts where id = current_setting('tests.c')::uuid),
  (select private.contract_content_sha256(rendered_content, commercial_snapshot, party_snapshot, template_version_id, template_content_sha256) from public.contracts where id = current_setting('tests.c')::uuid),
  'its hash covers what was frozen');
select is((select content_sha256 from public.contract_signatures where contract_id = current_setting('tests.c')::uuid),
  (select content_sha256 from public.contracts where id = current_setting('tests.c')::uuid), 'and the signature records that hash');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.contracts set total_cents = 100 where id = current_setting('tests.c')::uuid $$, '42501', null, 'staff have no write access at all');
reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Direct contract with a required deposit
-- ===========================================================================
select tests.cf_event('cf_dep');
select set_config('tests.c_dep', tests.direct('cf_dep', 100000, 50000, 'on_deposit')::text, true);
select tests.send_c(current_setting('tests.c_dep')::uuid);
select is(tests.sign(current_setting('tests.c_dep')::uuid) ->> 'status', 'signed', 'signed');
select is(tests.state('cf_dep'), 'awaiting_deposit', 'signing alone does not book: the deposit is required');
select ok(not exists (select 1 from public.event_plans where event_id = tests.id('cf_dep')), 'and there is no plan yet');
select is(tests.pay('cf_dep', 49999) ->> 'booking', 'awaiting_deposit', 'a partial payment does not book');
select is((private.event_payment_summary(tests.id('cf_dep')) ->> 'deposit_outstanding_cents')::bigint, 1::bigint, 'one cent is still due');
select is(tests.pay('cf_dep', 1) ->> 'booking', 'booked', 'the payment that reaches the deposit books');
select is(tests.state('cf_dep'), 'booked (confirmed)', 'confirmed');
select is(private.event_payment_summary(tests.id('cf_dep')) ->> 'no_financial_terms', null, 'a priced contract never carries the no-terms key');
-- Invalidating keeps the existing rule: the booking stands, with a warning.
select tests.login_as(tests.id('staff_a'));
select public.invalidate_event_payment((select id from public.event_payments where event_id = tests.id('cf_dep') and amount_cents = 1), 'Entered by mistake');
reset role;
select set_config('request.jwt.claims', '', true);
select results_eq($$ select tests.state('cf_dep'), (private.event_payment_summary(tests.id('cf_dep')) -> 'booking' ->> 'deposit_no_longer_met')::boolean $$,
  $$ values ('booked (confirmed)'::text, true) $$, 'invalidating a payment leaves the booking standing, with the warning');

-- ===========================================================================
-- Direct contract with a price and no deposit; and a genuine $0 contract
-- ===========================================================================
select tests.cf_event('cf_price');
select set_config('tests.c_price', tests.direct('cf_price', 100000, 0)::text, true);
select tests.send_c(current_setting('tests.c_price')::uuid);
select tests.sign(current_setting('tests.c_price')::uuid);
select is(tests.state('cf_price'), 'booked (confirmed)', 'a price with no deposit books on signature');
select results_eq($$ select (s ->> 'remaining_balance_cents')::bigint, (s ->> 'deposit_outstanding_cents')::bigint from (select private.event_payment_summary(tests.id('cf_price')) as s) x $$,
  $$ values (100000::bigint, 0::bigint) $$, 'and the whole price remains due');

select tests.cf_event('cf_zero');
select set_config('tests.c_zero', tests.direct('cf_zero', 0, 0)::text, true);
select tests.send_c(current_setting('tests.c_zero')::uuid);
select tests.sign(current_setting('tests.c_zero')::uuid);
select is(tests.state('cf_zero'), 'booked (confirmed)', 'a genuine $0 contract books on signature');
select results_eq($$ select s -> 'terms' -> 'total_cents', (s ->> 'remaining_balance_cents')::bigint, s ->> 'no_financial_terms' from (select private.event_payment_summary(tests.id('cf_zero')) as s) x $$,
  $$ values ('0'::jsonb, 0::bigint, null::text) $$, 'and stays a real zero, unlike a contract with no terms');
select results_eq($$ select payload -> 'total_cents', payload -> 'remaining_cents' from public.email_outbox where entity_id = current_setting('tests.c_zero')::uuid and event_type = 'booking_confirmed' $$,
  $$ values ('0'::jsonb, '0'::jsonb) $$, 'its booking email states the real zero');

-- ===========================================================================
-- Proposal-backed contracts: responses are exactly as before
-- ===========================================================================
select set_config('tests.c_backed', (select (public.generate_contract_draft(current_setting('tests.approval2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id')
  from (select tests.login_as(tests.id('owner_a'))) x), true);
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('tests.link_backed', tests.send_c(current_setting('tests.c_backed')::uuid)::text, true);
select ok((select proposal_id is not null from public.access_links where id = current_setting('tests.link_backed')::uuid), 'a proposal-backed invitation still names its proposal');
select ok(tests.usable(current_setting('tests.link_backed')::uuid), 'and is usable');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c_backed')::uuid, 'test-bouprod') -> 'contract' -> 'source', null, 'its view has no new key');
reset role;
select set_config('request.jwt.claims', '', true);
select is(private.event_payment_summary(tests.id('event_a2')) -> 'no_financial_terms', null, 'nor its summary');
-- Its approval requirement still decides: losing the approved proposal stops it.
alter table public.proposals disable trigger proposals_status_transition;
alter table public.proposals disable trigger proposals_protect_signed_terms;
alter table public.proposals disable trigger proposals_supersede_contract_drafts;
update public.proposals set status = 'superseded' where id = (select proposal_id from public.contracts where id = current_setting('tests.c_backed')::uuid);
alter table public.proposals enable trigger proposals_status_transition;
alter table public.proposals enable trigger proposals_protect_signed_terms;
alter table public.proposals enable trigger proposals_supersede_contract_drafts;
select ok(not tests.usable(current_setting('tests.link_backed')::uuid), 'without its approved proposal the invitation stops working');
select ok(not private.signer_can_access_contract(current_setting('tests.c_backed')::uuid, tests.id('client_y')), 'and the signer loses it');
select is(tests.sign(current_setting('tests.c_backed')::uuid) ->> 'code', 'unavailable', 'and cannot sign');

-- ===========================================================================
-- Archiving revokes direct invitations; unarchiving does not bring them back
-- ===========================================================================
select tests.cf_event('cf_arch');
select set_config('tests.c_arch', tests.direct('cf_arch')::text, true);
select set_config('tests.link_arch', tests.send_c(current_setting('tests.c_arch')::uuid)::text, true);
select tests.login_as(tests.id('owner_a'));
select is(public.set_event_archived(tests.id('cf_arch'), true) ->> 'links_revoked', '1', 'archiving revokes the direct invitation');
reset role;
select set_config('request.jwt.claims', '', true);
select ok((select revoked_at is not null from public.access_links where id = current_setting('tests.link_arch')::uuid), 'it is revoked');
select ok(not tests.usable(current_setting('tests.link_arch')::uuid), 'and unusable');
select ok(not private.signer_can_access_contract(current_setting('tests.c_arch')::uuid, tests.id('client_y')), 'the signer has no access while archived');
select is(tests.sign(current_setting('tests.c_arch')::uuid) ->> 'code', 'unavailable', 'and cannot sign');
select ok(not tests.deliverable(current_setting('tests.c_arch')::uuid), 'and its email is not deliverable');
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('cf_arch'), false);
reset role;
select set_config('request.jwt.claims', '', true);
select ok(not tests.usable(current_setting('tests.link_arch')::uuid), 'unarchiving does not bring the invitation back');

-- ===========================================================================
-- No longer contract-first: missing references alone never grant anything
-- ===========================================================================
select tests.cf_event('cf_gone');
select set_config('tests.c_gone', tests.direct('cf_gone')::text, true);
select set_config('tests.link_gone', tests.send_c(current_setting('tests.c_gone')::uuid)::text, true);
set constraints all immediate;
alter table public.events disable trigger events_contract_first_guard;
update public.events set contract_first = false where id = tests.id('cf_gone');
alter table public.events enable trigger events_contract_first_guard;
set constraints all deferred;
select ok(not tests.usable(current_setting('tests.link_gone')::uuid), 'the invitation stops working');
select ok(not private.signer_can_access_contract(current_setting('tests.c_gone')::uuid, tests.id('client_y')), 'the signer loses access');
select ok(not tests.deliverable(current_setting('tests.c_gone')::uuid), 'the email is not deliverable');
select is(tests.sign(current_setting('tests.c_gone')::uuid) ->> 'code', 'unavailable', 'and it cannot be signed');
select is(private.contract_send_problems(current_setting('tests.c_gone')::uuid) -> 0 ->> 'code', 'event_not_contract_first', 'and the send review says why');

-- ===========================================================================
-- Invitation scope
-- ===========================================================================
select tests.cf_event('cf_link');
select set_config('tests.c_link', tests.direct('cf_link')::text, true);
select throws_ok($$ insert into public.access_links (id, tenant_id, purpose, intended_client_id, token_hash, expires_at)
    values (gen_random_uuid(), tests.id('tenant_a'), 'proposal', tests.id('a_client_y'), repeat('a', 64), now() + interval '1 day') $$,
  '23514', null, 'a proposal link still needs its proposal');
select throws_like($$ insert into public.access_links (id, tenant_id, purpose, contract_id, intended_client_id, token_hash, expires_at)
    values (gen_random_uuid(), tests.id('tenant_a'), 'contract', current_setting('tests.c_link')::uuid, tests.id('a_client_x'), repeat('c', 64), now() + interval '1 day') $$,
  '%must match%', 'an invitation must be for the contract''s signer');
select throws_like($$ insert into public.access_links (id, tenant_id, purpose, proposal_id, contract_id, intended_client_id, token_hash, expires_at)
    values (gen_random_uuid(), tests.id('tenant_a'), 'contract', (select proposal_id from public.contracts where id = current_setting('tests.c_backed')::uuid),
      current_setting('tests.c_link')::uuid, tests.id('a_client_y'), repeat('d', 64), now() + interval '1 day') $$,
  '%must match%', 'and cannot name a proposal the contract does not have');
select throws_like($$ insert into public.access_links (id, tenant_id, purpose, contract_id, intended_client_id, token_hash, expires_at)
    values (gen_random_uuid(), tests.id('tenant_a'), 'contract', current_setting('tests.c_backed')::uuid, tests.id('a_client_y'), repeat('e', 64), now() + interval '1 day') $$,
  '%must match%', 'and a proposal-backed contract''s invitation cannot leave its proposal out');

-- ===========================================================================
-- A null deposit can never count as met, even if the constraint were gone
-- ===========================================================================
select tests.cf_event('cf_broken');
set constraints all immediate;
alter table public.contracts drop constraint contracts_direct_booking_policy;
set constraints all deferred;
select set_config('tests.c_broken', tests.direct('cf_broken', null, null, 'on_deposit')::text, true);
select tests.send_c(current_setting('tests.c_broken')::uuid);
select is(tests.sign(current_setting('tests.c_broken')::uuid) ->> 'status', 'signed', 'with the constraint removed, the broken contract can be signed');
select is(tests.state('cf_broken'), 'awaiting_signature', 'but the event is not booked');
select is(private.evaluate_booking(tests.id('cf_broken'), 'staff', null, true) ->> 'status', 'terms_invalid', 'and booking evaluation says the terms are invalid');

-- ===========================================================================
-- With wording approved later, a client-use no-terms contract signs and books
-- ===========================================================================
create or replace function private.contract_signing_consent(p_version text) returns text language sql immutable set search_path = '' as $$
  select case p_version when 'client-no-terms-v1' then 'Wording under test.' when 'client-v1' then 'Old wording.' when 'demo-v1' then 'Demo.' end $$;
select tests.cf_event('cf_later');
select set_config('tests.c_later', tests.direct('cf_later', version => 'tests.client_v')::text, true);
select tests.send_c(current_setting('tests.c_later')::uuid);
select is(tests.sign(current_setting('tests.c_later')::uuid) ->> 'status', 'signed', 'signs in client-use mode');
select results_eq($$ select consent_version, consent_text from public.contract_signatures where contract_id = current_setting('tests.c_later')::uuid $$,
  $$ values ('client-no-terms-v1'::text, 'Wording under test.'::text) $$, 'recording that exact wording');
select is(tests.state('cf_later'), 'booked (confirmed)', 'and books');

select * from finish();
rollback;
