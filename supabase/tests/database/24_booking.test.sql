-- Booking policy and confirmation: the owner-only setting, the policy frozen
-- into contracts, automatic booking on signing and on payment changes
-- (payments before signing, partial, zero deposit, overpayment), corrections
-- after booking, archived events, legacy contracts and the explicit check,
-- the guards on events, tenant isolation and the booking email.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(62);

-- Extra events in tenant A (client Y signs each), addressable by name.
alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('booking-test-' || name)::uuid);
$$;
create function tests.new_event(name text) returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date) values (tests.id(name), tests.id('tenant_a'), name, 'wedding', '2027-09-01');
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  return tests.id(name);
end $$;

create function tests.send_c(contract uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  return public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;

-- Approves, generates (freezing the current policy) and sends a contract.
create function tests.sent_contract(event text) returns uuid language plpgsql as $$
declare
  v_approval uuid := tests.approved(event);
  v_contract uuid;
begin
  perform tests.login_as(tests.id('owner_a'));
  v_contract := (public.generate_contract_draft(v_approval, current_setting('tests.v')::uuid) ->> 'contract_id')::uuid;
  perform tests.send_c(v_contract);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_contract;
end $$;

create function tests.sign(contract uuid) returns jsonb language plpgsql as $$
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
  r := public.sign_contract(contract, 'test-bouprod', tests.id('client_y'), 'Client Y', v_hash, v_consent, true, v_path,
    repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create function tests.pay(event text, cents bigint, paid date default current_date - 1) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('staff_a'));
  r := public.record_event_payment(tests.id(event), cents, paid, null, null, gen_random_uuid(), true);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create function tests.check(event text, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.check_event_booking(tests.id(event));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create function tests.state(event text) returns text language sql stable as $$
  select lifecycle_status || case when booking_confirmed_at is null then '' else ' (confirmed)' end from public.events where id = tests.id(event);
$$;
create function tests.bookings(event text) returns int language sql stable as $$
  select count(*)::int from public.audit_events where entity_id = tests.id(event) and action = 'booking_confirmed';
$$;
create function tests.booking_emails(event text) returns int language sql stable as $$
  select count(*)::int from public.email_outbox o join public.contracts k on k.id = o.entity_id
  where o.event_type = 'booking_confirmed' and k.event_id = tests.id(event);
$$;
create function tests.deposit(contract uuid) returns bigint language sql stable as $$
  select deposit_cents from public.contracts where id = contract;
$$;
create function tests.total(contract uuid) returns bigint language sql stable as $$
  select total_cents from public.contracts where id = contract;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test', reply_to_email = 'hello@bouprod.test'
where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select tests.new_event(n) from unnest(array['ev_sig', 'ev_pre', 'ev_part', 'ev_zero', 'ev_legacy_paid', 'ev_legacy_part', 'ev_arch', 'ev_iso']) n;

-- ===========================================================================
-- The policy setting
-- ===========================================================================
select is((select booking_confirmation_policy from public.tenants where id = tests.id('tenant_a')), 'on_deposit',
  'businesses default to signature plus deposit');
select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_booking_policy(tests.id('tenant_a'), 'on_signature', 0) $$, '42501', null, 'staff cannot change the policy');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_booking_policy(tests.id('tenant_a'), 'on_signature', 0) $$, 'P0002', 'not found', 'nor another business');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.tenants set booking_confirmation_policy = 'on_signature' where id = tests.id('tenant_a') $$,
  '42501', null, 'the column cannot be written directly');
select throws_like($$ select public.update_booking_policy(tests.id('tenant_a'), 'manual', 0) $$, '%choose when bookings are confirmed%',
  'only the two policies exist');
select is(public.update_booking_policy(tests.id('tenant_a'), 'on_signature', 0), 1, 'the owner switches to booking on signature');
select throws_ok($$ select public.update_booking_policy(tests.id('tenant_a'), 'on_deposit', 0) $$, 'PT409', null, 'a stale tab is refused');
reset role;

-- ===========================================================================
-- On signature: frozen policy, booked when signed, payment still due
-- ===========================================================================
select set_config('tests.c_sig', tests.sent_contract('ev_sig')::text, true);
select is((select booking_policy from public.contracts where id = current_setting('tests.c_sig')::uuid), 'on_signature', 'the contract freezes the policy');
select tests.login_as(tests.id('owner_a'));
select is(public.update_booking_policy(tests.id('tenant_a'), 'on_deposit', 1), 2, 'the owner switches back to deposit');
reset role;
select is((select booking_policy from public.contracts where id = current_setting('tests.c_sig')::uuid), 'on_signature',
  'the existing contract keeps its frozen policy');
select throws_ok($$ update public.contracts set booking_policy = 'on_deposit' where id = current_setting('tests.c_sig')::uuid $$,
  '23514', null, 'which cannot change');
select is(tests.state('ev_sig'), 'awaiting_signature', 'sending does not book');
select is(tests.sign(current_setting('tests.c_sig')::uuid) ->> 'status', 'signed', 'the client signs');
select is(tests.state('ev_sig'), 'booked (confirmed)', 'signing books it under on_signature');
select is(tests.bookings('ev_sig'), 1, 'one booking audit event');
select results_eq(
  $$ select recipient_email, status, payload ->> 'remaining_cents', payload ->> 'received_cents', sender ->> 'display_name'
     from public.email_outbox o where o.event_type = 'booking_confirmed' and o.entity_id = current_setting('tests.c_sig')::uuid $$,
  $$ values ('client-y@example.test'::text, 'pending'::text, tests.total(current_setting('tests.c_sig')::uuid)::text, '0'::text, 'BOUPROD'::text) $$,
  'one confirmation email to the frozen signer, frozen sender, stating the full amount still due');
select ok((select (tests_summary ->> 'deposit_outstanding_cents')::bigint > 0 from (select private.event_payment_summary(tests.id('ev_sig')) as tests_summary) x),
  'a signature-only booking can still have the deposit outstanding');
select ok(not (private.event_payment_summary(tests.id('ev_sig')) -> 'booking' ->> 'deposit_no_longer_met')::boolean,
  'with no deposit warning under on_signature');

-- ===========================================================================
-- On deposit: payments before signing count
-- ===========================================================================
select set_config('tests.c_pre', tests.sent_contract('ev_pre')::text, true);
select is((select booking_policy from public.contracts where id = current_setting('tests.c_pre')::uuid), 'on_deposit', 'frozen as on_deposit');
select tests.pay('ev_pre', tests.deposit(current_setting('tests.c_pre')::uuid) + 1000);
select is(tests.state('ev_pre'), 'awaiting_signature', 'a payment before signing does not book an unsigned contract');
select tests.sign(current_setting('tests.c_pre')::uuid);
select is(tests.state('ev_pre'), 'booked (confirmed)', 'signing books it because the deposit was already received');
select is(tests.booking_emails('ev_pre'), 1, 'one confirmation email');

-- ===========================================================================
-- On deposit: partial payments, then the deposit, then corrections
-- ===========================================================================
select set_config('tests.c_part', tests.sent_contract('ev_part')::text, true);
select tests.pay('ev_part', 100);
select is(tests.sign(current_setting('tests.c_part')::uuid) ->> 'status', 'signed', 'signed with only part of the deposit');
select is(tests.state('ev_part'), 'awaiting_deposit', 'signed, awaiting the deposit');
select is(tests.pay('ev_part', tests.deposit(current_setting('tests.c_part')::uuid) - 101) ->> 'booking', 'awaiting_deposit',
  'one cent short still awaits the deposit');
select is(tests.pay('ev_part', 1) ->> 'booking', 'booked', 'the cent that completes the deposit books the event');
select set_config('tests.booked_at', (select booking_confirmed_at::text from public.events where id = tests.id('ev_part')), true);
select is(tests.pay('ev_part', 5000) ->> 'booking', 'already_booked', 'later payments leave the booking as it is');
select is(tests.check('ev_part') ->> 'status', 'already_booked', 'so does an explicit check');
select results_eq($$ select tests.bookings('ev_part'), tests.booking_emails('ev_part') $$, $$ values (1, 1) $$,
  'one transition, one audit event, one email');
select is((select payload ->> 'received_cents' from public.email_outbox where event_type = 'booking_confirmed' and entity_id = current_setting('tests.c_part')::uuid),
  tests.deposit(current_setting('tests.c_part')::uuid)::text, 'the email states what had been received when it was booked');

-- Invalidate the payment that completed the deposit: still booked, with a warning.
select tests.login_as(tests.id('owner_a'));
select public.invalidate_event_payment((select id from public.event_payments where event_id = tests.id('ev_part') and amount_cents = 5000), 'wrong event');
select public.invalidate_event_payment((select id from public.event_payments where event_id = tests.id('ev_part') and amount_cents = 1), 'bounced');
reset role;
select is(tests.state('ev_part'), 'booked (confirmed)', 'invalidating payments never cancels the booking');
select is((select booking_confirmed_at::text from public.events where id = tests.id('ev_part')), current_setting('tests.booked_at'),
  'and booking_confirmed_at is unchanged');
select is((private.event_payment_summary(tests.id('ev_part')) -> 'booking' ->> 'deposit_no_longer_met')::boolean, true,
  'staff are warned that the deposit is no longer covered');
select tests.login_as(tests.id('client_y'));
select results_eq(
  $$ select s ->> 'booking_status', (s ->> 'deposit_outstanding_cents')::bigint from (select public.client_payment_summary(current_setting('tests.c_part')::uuid, 'test-bouprod') s) x $$,
  $$ values ('booked'::text, 1::bigint) $$, 'the client sees the booking and the accurate amount outstanding');
reset role;

-- ===========================================================================
-- Zero deposit: signing is enough
-- ===========================================================================
update public.tenants set deposit_percent = 0 where id = tests.id('tenant_a');
select set_config('tests.c_zero', tests.sent_contract('ev_zero')::text, true);
update public.tenants set deposit_percent = 50 where id = tests.id('tenant_a');
select results_eq($$ select booking_policy, deposit_cents from public.contracts where id = current_setting('tests.c_zero')::uuid $$,
  $$ values ('on_deposit'::text, 0::bigint) $$, 'on_deposit with a 0% deposit');
select tests.sign(current_setting('tests.c_zero')::uuid);
select is(tests.state('ev_zero'), 'booked (confirmed)', 'a zero deposit is satisfied by signing');

-- ===========================================================================
-- Overpayment
-- ===========================================================================
select is((select (payload ->> 'credit_cents')::bigint > 0 from public.email_outbox where event_type = 'booking_confirmed'
  and entity_id = current_setting('tests.c_pre')::uuid), false, 'paying the deposit plus a little leaves no credit');
select tests.pay('ev_pre', tests.total(current_setting('tests.c_pre')::uuid));
select results_eq(
  $$ select (s ->> 'remaining_balance_cents')::bigint, (s ->> 'credit_cents')::bigint > 0 from (select private.event_payment_summary(tests.id('ev_pre')) s) x $$,
  $$ values (0::bigint, true) $$, 'an overpaid booked event shows a credit and nothing due');

-- ===========================================================================
-- Legacy contracts (generated before policies): explicit check only
-- ===========================================================================
select set_config('tests.c_lp', tests.sent_contract('ev_legacy_paid')::text, true);
select set_config('tests.c_lq', tests.sent_contract('ev_legacy_part')::text, true);
set local session_replication_role = replica;
update public.contracts set booking_policy = null where id in (current_setting('tests.c_lp')::uuid, current_setting('tests.c_lq')::uuid);
set local session_replication_role = origin;
-- The business now books on signature: legacy contracts must not use it.
select tests.login_as(tests.id('owner_a'));
select public.update_booking_policy(tests.id('tenant_a'), 'on_signature', 2);
reset role;
select tests.pay('ev_legacy_paid', tests.deposit(current_setting('tests.c_lp')::uuid));
select tests.sign(current_setting('tests.c_lp')::uuid);
select tests.sign(current_setting('tests.c_lq')::uuid);
select results_eq($$ select tests.state('ev_legacy_paid'), tests.state('ev_legacy_part') $$, $$ values ('awaiting_signature'::text, 'awaiting_signature'::text) $$,
  'signing a legacy contract books nothing automatically, even with the deposit paid and on_signature set');
select is(tests.pay('ev_legacy_paid', 100) ->> 'booking', 'needs_check', 'nor does a payment');
select is((private.event_payment_summary(tests.id('ev_legacy_paid')) -> 'booking' ->> 'legacy_signed')::boolean, true, 'staff see it needs a check');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.check_event_booking(tests.id('ev_legacy_paid')) $$, 'P0002', 'not found', 'clients cannot run the check');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.check_event_booking(tests.id('ev_legacy_paid')) $$, 'P0002', 'not found', 'nor another business');
select tests.login_as_anon();
select throws_ok($$ select public.check_event_booking(tests.id('ev_legacy_paid')) $$, '42501', null, 'nor anon');
reset role;
select is(tests.check('ev_legacy_paid') ->> 'status', 'booked', 'staff check it: the deposit is received, so it is booked');
select is((select metadata ->> 'policy' from public.audit_events where entity_id = tests.id('ev_legacy_paid') and action = 'booking_confirmed'),
  'on_deposit', 'evaluated as signature plus deposit, not the business''s on_signature');
select is(tests.check('ev_legacy_part') ->> 'status', 'awaiting_deposit', 'without the deposit the check leaves it awaiting the deposit');
select is(tests.state('ev_legacy_part'), 'awaiting_deposit', 'and records that state');
select is(tests.pay('ev_legacy_part', tests.deposit(current_setting('tests.c_lq')::uuid)) ->> 'booking', 'booked',
  'once checked, a later payment books it automatically');

-- ===========================================================================
-- Archived events are never booked
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select public.update_booking_policy(tests.id('tenant_a'), 'on_deposit', 3);
reset role;
select set_config('tests.c_arch', tests.sent_contract('ev_arch')::text, true);
select tests.sign(current_setting('tests.c_arch')::uuid);
select is(tests.state('ev_arch'), 'awaiting_deposit', 'signed, awaiting the deposit');
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('ev_arch'), true);
reset role;
select throws_like($$ select tests.pay('ev_arch', 1000000) $$, '%archived%', 'no payment can be recorded while archived');
-- Even if the deposit were covered (simulated), an archived event is not booked.
insert into public.event_payments (tenant_id, event_id, amount_cents, currency, paid_on, idempotency_key, recorded_by_user_id)
values (tests.id('tenant_a'), tests.id('ev_arch'), tests.deposit(current_setting('tests.c_arch')::uuid), 'CAD', current_date, gen_random_uuid(), tests.id('owner_a'));
select is(tests.check('ev_arch') ->> 'status', 'archived', 'an explicit check refuses an archived event');
select is(tests.state('ev_arch'), 'awaiting_deposit', 'it stays unbooked');
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('ev_arch'), false);
reset role;
select is(tests.check('ev_arch') ->> 'status', 'booked', 'after unarchiving, the check books it');

-- ===========================================================================
-- Guards
-- ===========================================================================
select throws_like($$ update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id('ev_iso') $$,
  '%booked only through evaluate_booking%', 'nothing else can book an event, not even privileged code');
select throws_like($$ update public.events set booking_confirmed_at = now() + interval '1 day' where id = tests.id('ev_part') $$,
  '%set once%', 'booking_confirmed_at is set once');
select throws_like($$ update public.events set lifecycle_status = 'awaiting_deposit' where id = tests.id('ev_part') $$,
  '%cannot go back%', 'a booked event cannot be unbooked');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.events set lifecycle_status = 'booked' where id = tests.id('ev_iso') $$, '42501', null,
  'staff cannot write the status');
reset role;
select is(tests.check('ev_iso') ->> 'status', 'not_signed', 'an event without a signed contract is not booked');

-- ===========================================================================
-- Booking emails and older workers
-- ===========================================================================
update public.email_outbox set next_attempt_at = now() - interval '1 minute' where event_type = 'booking_confirmed';
select tests.login_as_service();
select is((select count(*)::int from public.claim_email_outbox(100, 120, tests.id('tenant_a')) where event_type = 'booking_confirmed'), 0,
  'a worker that predates booking emails never claims them');
select ok((select bool_and(contract_deliverable) from public.claim_email_outbox(100, 120, tests.id('tenant_a'), true) where event_type = 'booking_confirmed'),
  'an updated worker claims them, deliverable while booked');
reset role;
select is((select count(*)::int from public.email_outbox where event_type = 'booking_confirmed' and tenant_id = tests.id('tenant_a')), 7,
  'one email per booked event (7 events booked here)');

select * from finish();
rollback;
