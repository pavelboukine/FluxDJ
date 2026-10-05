-- Manual payment tracking: who can record and invalidate, validation,
-- idempotency and duplicate confirmation, immutable history, the summary
-- against the authoritative contract (none, sent, signed, replaced), frozen
-- terms, zero-percent deposits, overpayment, the client's narrow summary,
-- archiving, the invoice link, and that nothing else changes.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(76);

create function tests.send_c(contract uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  return public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;

create function tests.sign(contract uuid, signer text) returns jsonb language plpgsql as $$
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
  r := public.sign_contract(contract, 'test-bouprod', tests.id(signer), 'Signer Name', v_hash, v_consent, true, v_path,
    repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

-- Records as a staff user; returns the RPC result.
create function tests.pay(who text, event text, cents bigint, paid date default current_date - 1, o jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.record_event_payment(tests.id(event), cents, paid, o ->> 'reference', o ->> 'note',
    coalesce((o ->> 'key')::uuid, gen_random_uuid()), coalesce((o ->> 'confirm')::boolean, false));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create function tests.summary(event text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('owner_a'));
  r := public.event_payment_summary(tests.id(event));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create function tests.client_summary(contract uuid, who text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.client_payment_summary(contract, 'test-bouprod');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');

-- ===========================================================================
-- No contract yet: payments are kept, no terms are invented
-- ===========================================================================
select is(tests.pay('owner_a', 'event_a2', 25000) ->> 'status', 'recorded', 'the owner records a payment');
select is(tests.summary('event_a2') - 'invoice_url' - 'booking',
  jsonb_build_object('currency', 'CAD', 'terms', null, 'received_cents', 25000, 'valid_payments', 1, 'other_currency_payments', 0,
    'deposit_outstanding_cents', null, 'remaining_balance_cents', null, 'credit_cents', null),
  'without a sent or signed contract there is no total, deposit or balance, only what was received');
select results_eq(
  $$ select amount_cents, currency, recorded_by_user_id, recorded_by_email, created_at <= now() from public.event_payments where event_id = tests.id('event_a2') $$,
  $$ values (25000::bigint, 'CAD'::text, tests.id('owner_a'), 'owner-a@example.test'::text, true) $$,
  'the staff identity and database time are recorded');

-- ===========================================================================
-- Who may record, and validation
-- ===========================================================================
select is(tests.pay('staff_a', 'event_a2', 1, current_date - 2) ->> 'status', 'recorded', 'non-owner staff record payments too');
select throws_ok($$ select tests.pay('owner_b', 'event_a2', 100) $$, 'P0002', 'not found', 'another tenant''s staff cannot record');
select throws_ok($$ select tests.pay('client_y', 'event_a2', 100) $$, 'P0002', 'not found', 'a client cannot record');
select tests.login_as_anon();
select throws_ok($$ select public.record_event_payment(tests.id('event_a2'), 100, current_date, null, null, gen_random_uuid(), false) $$,
  '42501', null, 'anon cannot call it');
reset role;
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ insert into public.event_payments (tenant_id, event_id, amount_cents, currency, paid_on, idempotency_key, recorded_by_user_id)
  values (tests.id('tenant_a'), tests.id('event_a2'), 1, 'CAD', current_date, gen_random_uuid(), tests.id('owner_a')) $$,
  '42501', null, 'staff cannot insert rows directly');
select throws_ok($$ update public.event_payments set amount_cents = 1 where event_id = tests.id('event_a2') $$,
  '42501', null, 'or update them');
select throws_ok($$ delete from public.event_payments where event_id = tests.id('event_a2') $$, '42501', null, 'or delete them');
reset role;
select tests.login_as(tests.id('client_y'));
select is((select count(*)::int from public.event_payments), 0, 'a client reads no payment rows');
select is((select count(*)::int from public.event_billing), 0, 'or invoice rows');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.event_payments where tenant_id = tests.id('tenant_a')), 0, 'another tenant reads none');
select throws_ok($$ select public.event_payment_summary(tests.id('event_a2')) $$, 'P0002', 'not found', 'nor its summary');
reset role;

select throws_like($$ select tests.pay('owner_a', 'event_a2', 0) $$, '%greater than zero%', 'zero is refused');
select throws_like($$ select tests.pay('owner_a', 'event_a2', -500) $$, '%greater than zero%', 'negative amounts are refused');
select throws_like($$ select tests.pay('owner_a', 'event_a2', 100000000000) $$, '%too large%', 'absurd amounts are refused');
select throws_like($$ select tests.pay('owner_a', 'event_a2', 100, null) $$, '%date the payment was received%', 'a date is required');
select throws_like($$ select tests.pay('owner_a', 'event_a2', 100, current_date + 3) $$, '%can''t be in the future%', 'future dates are refused');
select throws_like($$ select tests.pay('owner_a', 'event_a2', 100, current_date - 1, jsonb_build_object('reference', repeat('r', 201))) $$,
  '%200 characters%', 'long references are refused');

-- ===========================================================================
-- Idempotency and duplicates
-- ===========================================================================
select set_config('tests.key', gen_random_uuid()::text, true);
select is(tests.pay('owner_a', 'event_a2', 1999, current_date - 3, jsonb_build_object('key', current_setting('tests.key'), 'reference', 'ET-1')) ->> 'status',
  'recorded', 'a payment with a key');
select is(tests.pay('owner_a', 'event_a2', 1999, current_date - 3, jsonb_build_object('key', current_setting('tests.key'), 'reference', 'ET-1')) ->> 'status',
  'replayed', 'the same submission again records nothing new');
select throws_like($$ select tests.pay('owner_a', 'event_a2', 2000, current_date - 3, jsonb_build_object('key', current_setting('tests.key'))) $$,
  '%already used for another payment%', 'a reused key with different values is refused');
select is((select count(*)::int from public.event_payments where idempotency_key = current_setting('tests.key')::uuid), 1, 'one row for that key');
select throws_like($$ select tests.pay('owner_a', 'event_a2', 1999, current_date - 3) $$,
  '%same amount and date is already recorded%', 'a second payment with the same amount and date needs confirmation');
select is(tests.pay('owner_a', 'event_a2', 1999, current_date - 3, '{"confirm": true}') ->> 'status', 'recorded', 'and is recorded once confirmed');
select is((tests.summary('event_a2') ->> 'received_cents')::bigint, 25000 + 1 + 1999 + 1999::bigint, 'exact cents are summed');

-- ===========================================================================
-- Invalidation and history
-- ===========================================================================
select set_config('tests.p_bad', (select id::text from public.event_payments where event_id = tests.id('event_a2') and amount_cents = 1), true);
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.invalidate_event_payment(current_setting('tests.p_bad')::uuid, ' x ') $$, '%give a reason%', 'a reason is required');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.invalidate_event_payment(current_setting('tests.p_bad')::uuid, 'not mine') $$, 'P0002', 'not found',
  'another tenant cannot invalidate');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.invalidate_event_payment(current_setting('tests.p_bad')::uuid, 'client says so') $$, 'P0002', 'not found',
  'nor can a client');
select tests.login_as(tests.id('staff_a'));
select is(public.invalidate_event_payment(current_setting('tests.p_bad')::uuid, 'Typed $0.01 instead of $100') ->> 'status', 'invalidated',
  'staff invalidate a wrong entry');
select is(public.invalidate_event_payment(current_setting('tests.p_bad')::uuid, 'again') ->> 'status', 'already_invalidated',
  'a second invalidation changes nothing');
reset role;
select results_eq(
  $$ select amount_cents, invalidated_by_user_id, invalidated_by_email, invalidation_reason, invalidated_at is not null
     from public.event_payments where id = current_setting('tests.p_bad')::uuid $$,
  $$ values (1::bigint, tests.id('staff_a'), 'staff-a@example.test'::text, 'Typed $0.01 instead of $100'::text, true) $$,
  'the original entry, who invalidated it, when and why are kept');
select is((tests.summary('event_a2') ->> 'received_cents')::bigint, 25000 + 1999 + 1999::bigint, 'an invalidated entry no longer counts');
select throws_like($$ update public.event_payments set amount_cents = 2 where id = current_setting('tests.p_bad')::uuid $$,
  '%immutable%', 'even privileged code cannot change a recorded amount');
select throws_like($$ update public.event_payments set invalidation_reason = 'edited' where id = current_setting('tests.p_bad')::uuid $$,
  '%cannot change%', 'or an invalidation');
select throws_like($$ update public.event_payments set invalidated_at = now(), invalidated_by_user_id = tests.id('owner_a'), invalidation_reason = 'sneaky'
  where id <> current_setting('tests.p_bad')::uuid and event_id = tests.id('event_a2') $$,
  '%only through invalidate_event_payment%', 'or invalidate outside the function');
select throws_like($$ delete from public.event_payments where id = current_setting('tests.p_bad')::uuid $$, '%', 'or delete a payment');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('event_a2') and action in ('payment_recorded', 'payment_invalidated')),
  5, 'every recording (4) and invalidation (1) is audited');

-- ===========================================================================
-- Terms: drafts don't count, sent contracts are labelled, signed are frozen
-- ===========================================================================
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c1', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
reset role;
select is(tests.summary('event_a2') -> 'terms', 'null'::jsonb, 'a draft contract is not authoritative');
select tests.login_as(tests.id('owner_a'));
select tests.send_c(current_setting('tests.c1')::uuid);
reset role;
create temp table c1 as select total_cents, deposit_cents, deposit_percent, balance_due_date from public.contracts where id = current_setting('tests.c1')::uuid;
grant select on c1 to authenticated, service_role;
select is(tests.summary('event_a2') -> 'terms' ->> 'status', 'sent', 'the sent contract gives the terms, marked as not signed');
select is((tests.summary('event_a2') -> 'terms' ->> 'total_cents')::bigint, (select total_cents from c1), 'its frozen total');
select is((tests.summary('event_a2') ->> 'deposit_outstanding_cents')::bigint, greatest((select deposit_cents from c1) - 28998, 0),
  'partial payments leave the rest of the deposit outstanding');
select is((tests.summary('event_a2') ->> 'remaining_balance_cents')::bigint, (select total_cents from c1) - 28998, 'and the remaining balance');

-- Void and replace: only the new contract counts, never both.
select tests.login_as(tests.id('owner_a'));
select public.void_contract(current_setting('tests.c1')::uuid, 'Wrong date');
select is(public.event_payment_summary(tests.id('event_a2')) -> 'terms', 'null'::jsonb, 'a void contract gives no terms');
reset role;
update public.tenants set deposit_percent = 30 where id = tests.id('tenant_a');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c2', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c(current_setting('tests.c2')::uuid);
reset role;
create temp table c2 as select total_cents, deposit_cents, deposit_percent from public.contracts where id = current_setting('tests.c2')::uuid;
grant select on c2 to authenticated, service_role;
select results_eq($$ select (tests.summary('event_a2') -> 'terms' ->> 'contract_id')::uuid, (tests.summary('event_a2') -> 'terms' ->> 'deposit_percent')::int $$,
  $$ values (current_setting('tests.c2')::uuid, 30) $$, 'the replacement is the only authoritative contract, with its own deposit');
select is((tests.summary('event_a2') ->> 'remaining_balance_cents')::bigint, (select total_cents from c2) - 28998,
  'totals are not added across contract versions');

-- Signed: frozen against later business, tax and catalog changes.
select is(tests.sign(current_setting('tests.c2')::uuid, 'client_y') ->> 'status', 'signed', 'the client signs');
update public.tenants set deposit_percent = 80, tax_config = '[{"code":"GST","label":"GST","rate_ppm":150000},{"code":"QST","label":"QST","rate_ppm":99750}]' where id = tests.id('tenant_a');
update public.packages set base_price_cents = base_price_cents * 3 where tenant_id = tests.id('tenant_a');
select results_eq(
  $$ select tests.summary('event_a2') -> 'terms' ->> 'status', (tests.summary('event_a2') -> 'terms' ->> 'total_cents')::bigint,
            (tests.summary('event_a2') -> 'terms' ->> 'deposit_cents')::bigint $$,
  $$ select 'signed'::text, total_cents, deposit_cents from c2 $$,
  'signed terms are the frozen contract values after business, tax and catalog changes');
-- Restore the catalog and taxes for the offers made below.
update public.packages set base_price_cents = base_price_cents / 3 where tenant_id = tests.id('tenant_a');
update public.tenants set tax_config = '[{"code":"GST","label":"GST","rate_ppm":50000},{"code":"QST","label":"QST","rate_ppm":99750}]'
where id = tests.id('tenant_a');

-- Overpayment: a credit, never a negative amount due.
select tests.pay('owner_a', 'event_a2', (select total_cents from c2), current_date - 1, '{"reference": "overpay"}');
select results_eq(
  $$ select (tests.summary('event_a2') ->> 'remaining_balance_cents')::bigint, (tests.summary('event_a2') ->> 'deposit_outstanding_cents')::bigint,
            (tests.summary('event_a2') ->> 'credit_cents')::bigint $$,
  $$ values (0::bigint, 0::bigint, 28998::bigint) $$, 'an overpayment shows a credit and nothing due');

-- ===========================================================================
-- The client's summary
-- ===========================================================================
select set_config('tests.cs', tests.client_summary(current_setting('tests.c2')::uuid, 'client_y')::text, true);
select is((select array_agg(k order by k) from jsonb_object_keys(current_setting('tests.cs')::jsonb) k),
  array['balance_due_date', 'booking_status', 'credit_cents', 'currency', 'deposit_cents', 'deposit_outstanding_cents', 'deposit_percent',
        'invoice_url', 'received_cents', 'remaining_balance_cents', 'terms_status', 'total_cents'],
  'the client summary has exactly the intended fields');
select ok(current_setting('tests.cs') !~ ('overpay|ET-1|Typed|example.test|contract_id|' || current_setting('tests.c2')),
  'no references, notes, reasons, staff identities or ids');
select is((current_setting('tests.cs')::jsonb ->> 'received_cents')::bigint, 28998 + (select total_cents from c2), 'the client sees the received total');
select is(tests.client_summary(current_setting('tests.c2')::uuid, 'client_x'), null, 'another client sees nothing');
select is(tests.client_summary(current_setting('tests.c1')::uuid, 'client_y'), null, 'nothing through a void contract');
select is(tests.client_summary(current_setting('tests.c2')::uuid, 'owner_a'), null, 'staff get nothing through the client function');
select tests.login_as_anon();
select throws_ok($$ select public.client_payment_summary(current_setting('tests.c2')::uuid, 'test-bouprod') $$, '42501', null, 'anon cannot call it');
reset role;

-- ===========================================================================
-- Invoice link
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is(public.set_event_invoice_url(tests.id('event_a2'), 'https://invoice.example.com/i/42?x=1#p', 0), 1, 'staff save an HTTPS invoice link');
select throws_ok($$ select public.set_event_invoice_url(tests.id('event_a2'), 'https://invoice.example.com/other', 0) $$,
  '40001', null, 'a stale tab cannot overwrite it');
select throws_like($$ select public.set_event_invoice_url(tests.id('event_a2'), 'http://invoice.example.com/x', 1) $$, '%https://%', 'http is refused');
select throws_like($$ select public.set_event_invoice_url(tests.id('event_a2'), 'javascript:alert(1)', 1) $$, '%https://%', 'scripts are refused');
select throws_like($$ select public.set_event_invoice_url(tests.id('event_a2'), 'https://user:pw@invoice.example.com/', 1) $$, '%https://%',
  'credentials are refused');
select throws_like($$ select public.set_event_invoice_url(tests.id('event_a2'), 'https://localhost/x', 1) $$, '%https://%', 'bare hosts are refused');
select throws_like($$ select public.set_event_invoice_url(tests.id('event_a2'), 'https://a.example.com/"><script>', 1) $$, '%https://%',
  'markup is refused');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.set_event_invoice_url(tests.id('event_a2'), 'https://evil.example.com/', 1) $$, 'P0002', 'not found',
  'another tenant cannot set it');
reset role;
select is(tests.client_summary(current_setting('tests.c2')::uuid, 'client_y') ->> 'invoice_url', 'https://invoice.example.com/i/42?x=1#p',
  'the client sees the link');
select tests.login_as(tests.id('staff_a'));
select is(public.set_event_invoice_url(tests.id('event_a2'), '', 1), 2, 'an empty value removes it');
reset role;
select is(tests.client_summary(current_setting('tests.c2')::uuid, 'client_y') ->> 'invoice_url', null, 'and the client no longer sees it');

-- ===========================================================================
-- Zero-percent deposit
-- ===========================================================================
update public.tenants set deposit_percent = 0 where id = tests.id('tenant_a');
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c3', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c(current_setting('tests.c3')::uuid);
reset role;
select tests.pay('owner_a', 'event_a1', 1050);
select results_eq(
  $$ select (tests.summary('event_a1') -> 'terms' ->> 'deposit_cents')::bigint, (tests.summary('event_a1') ->> 'deposit_outstanding_cents')::bigint,
            (tests.summary('event_a1') ->> 'remaining_balance_cents')::bigint $$,
  $$ select 0::bigint, 0::bigint, total_cents - 1050 from public.contracts where id = current_setting('tests.c3')::uuid $$,
  'with no deposit required nothing is outstanding for the deposit, and the balance still counts down');

-- ===========================================================================
-- Archiving
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a2'), true);
reset role;
select throws_like($$ select tests.pay('owner_a', 'event_a2', 700) $$, '%archived%', 'no payments are recorded on an archived event');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.invalidate_event_payment((select id from public.event_payments where event_id = tests.id('event_a2') and invalidated_at is null limit 1), 'late') $$,
  '%archived%', 'or invalidated');
select is((public.event_payment_summary(tests.id('event_a2')) ->> 'valid_payments')::int, 4, 'staff still see the summary and history');
reset role;
select is(tests.client_summary(current_setting('tests.c2')::uuid, 'client_y'), null, 'the client loses the summary with access');
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a2'), false);
reset role;

-- ===========================================================================
-- Nothing else changes
-- ===========================================================================
create temp table around as
  select (select count(*) from public.email_outbox) as emails,
         (select (lifecycle_status, booking_confirmed_at, archived_at)::text from public.events where id = tests.id('event_a2')) as state,
         (select (status, total_cents, deposit_cents, content_sha256)::text from public.contracts where id = current_setting('tests.c2')::uuid) as contract;
grant select on around to authenticated, service_role;
select tests.pay('staff_a', 'event_a2', 4321, current_date - 1, '{"reference": "no side effects"}');
select tests.login_as(tests.id('staff_a'));
select public.invalidate_event_payment((select id from public.event_payments where reference = 'no side effects'), 'Checking side effects');
select public.set_event_invoice_url(tests.id('event_a2'), 'https://invoice.example.com/z', 2);
reset role;
select is((select count(*) from public.email_outbox) - (select emails from around), 0::bigint, 'payments and invoice links send no email');
select is((select (lifecycle_status, booking_confirmed_at, archived_at)::text from public.events where id = tests.id('event_a2')),
  (select state from around), 'the event''s status and booking are unchanged');
select is((select (status, total_cents, deposit_cents, content_sha256)::text from public.contracts where id = current_setting('tests.c2')::uuid),
  (select contract from around), 'the signed contract is unchanged');

select * from finish();
rollback;
