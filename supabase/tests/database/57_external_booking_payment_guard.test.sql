-- Events booked outside Flux DJ record no Flux payments or invoice link, for
-- every role and path (the RPCs and direct writes), with a clear error, no
-- partial write and no status change; Flux events keep recording,
-- invalidating and linking as before. Planning invitations stop working when
-- the primary contact or their email changes.
begin;
\ir _fixtures.psql
select plan(41);

create table tests.created (name text primary key, id uuid not null);
grant select, insert on tests.created to anon, authenticated, service_role;
alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql stable as $$
  select coalesce(tests.id_base(name), (select c.id from tests.created c where c.name = id.name), md5('payment-guard-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.as_user(who text, stmt text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  execute stmt into r;
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
-- Staff A creates an event through the staff insert path, with client Y as primary contact.
create function tests.create_event(name text, source text) returns void language plpgsql as $$
declare v_id uuid;
begin
  perform tests.login_as(tests.id('staff_a'));
  insert into public.events (tenant_id, title, event_type, event_date, timezone, booking_source)
  values (tests.id('tenant_a'), name, 'wedding', current_date + 120, 'America/Toronto', source)
  returning id into v_id;
  insert into tests.created (name, id) values (name, v_id);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign)
  values (tests.id('tenant_a'), v_id, tests.id('a_client_y'), true, true);
  perform tests.su();
end $$;
create function tests.pay_sql(event text, cents int, confirm boolean default false) returns text language sql stable as $$
  select format('select public.record_event_payment(%L, %s, %L, %L, null, %L, %L)',
    tests.id(event), cents, current_date - 1, 'ref', gen_random_uuid(), confirm);
$$;
create function tests.payments(event text) returns int language sql stable as $$
  select count(*)::int from public.event_payments where event_id = tests.id(event);
$$;
create function tests.state(event text) returns text[] language sql stable as $$
  select array[lifecycle_status, coalesce(booking_confirmed_at::text, 'none'), booking_source] from public.events where id = tests.id(event);
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select tests.create_event('ext', 'external');
select tests.create_event('flux', 'flux');

-- ===========================================================================
-- Flux events: unchanged
-- ===========================================================================
select is(tests.as_user('staff_a', tests.pay_sql('flux', 50000)) ->> 'status', 'recorded', 'a Flux event records a deposit');
select is(tests.as_user('owner_a', tests.pay_sql('flux', 125050)) ->> 'status', 'recorded', 'and a balance payment');
select is((select sum(amount_cents)::bigint from public.event_payments where event_id = tests.id('flux')), 175050::bigint, 'in exact cents');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('flux') and action = 'payment_recorded'), 2, 'audited as before');
select is(tests.as_user('staff_a', format('select to_jsonb(public.set_event_invoice_url(%L, %L, 0))', tests.id('flux'), 'https://pay.example.test/inv/1')),
  '1'::jsonb, 'its invoice link can be set');
select is(tests.as_user('staff_a', format('select public.invalidate_event_payment(%L, %L)',
  (select id from public.event_payments where event_id = tests.id('flux') and amount_cents = 50000), 'entered twice')) ->> 'status', 'invalidated',
  'and a payment can be invalidated');
select is(tests.as_user('staff_a', format('select public.event_payment_summary(%L)', tests.id('flux'))) ->> 'received_cents', '125050',
  'the summary counts valid payments as before');

-- ===========================================================================
-- Events booked elsewhere: every write refused, nothing written
-- ===========================================================================
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', tests.pay_sql('ext', 50000)), '22023',
  'payment_invalid: this event was booked outside Flux DJ, so Flux DJ doesn''t record its payments or invoice',
  'staff cannot record a deposit for an event booked elsewhere');
select throws_ok(format('select tests.as_user(%L, %L)', 'owner_a', tests.pay_sql('ext', 125050)), '22023', null, 'nor can the owner record a balance payment');
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', tests.pay_sql('ext', 1, true)), '22023', null, 'nor any other manual payment, even confirmed as a duplicate');
select is(tests.payments('ext'), 0, 'no payment row is written');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('ext') and action like 'payment%'), 0, 'no payment audit entry either');
select is(tests.state('ext'), array['lead', 'none', 'external'], 'and the event is unchanged: not booked by Flux');
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select to_jsonb(public.set_event_invoice_url(%L, %L, 0))', tests.id('ext'), 'https://pay.example.test/x')),
  '22023', null, 'no invoice link can be set');
select is((select count(*)::int from public.event_billing where event_id = tests.id('ext')), 0, 'so no billing row exists');

-- Direct writes.
select throws_ok(format($$ select tests.as_user('staff_a', format('insert into public.event_payments (tenant_id, event_id, amount_cents, currency, paid_on, idempotency_key) values (%%L, %%L, 100, %%L, current_date, gen_random_uuid()) returning 1', %L, %L, 'CAD')) $$,
  tests.id('tenant_a'), tests.id('ext')), '42501', null, 'staff have no direct payment writes');
select throws_ok(format($$ select tests.as_user('client_y', format('insert into public.event_payments (tenant_id, event_id, amount_cents, currency, paid_on, idempotency_key) values (%%L, %%L, 100, %%L, current_date, gen_random_uuid()) returning 1', %L, %L, 'CAD')) $$,
  tests.id('tenant_a'), tests.id('ext')), '42501', null, 'nor do clients');
select throws_ok(format($$ select tests.as_user('client_y', format('select public.record_event_payment(%%L, 100, current_date - 1, null, null, gen_random_uuid())', %L)) $$, tests.id('ext')),
  'P0002', null, 'a client calling the RPC is refused');
select tests.login_as_service();
select throws_ok(format('insert into public.event_payments (tenant_id, event_id, amount_cents, currency, paid_on, idempotency_key) values (%L, %L, 100, %L, current_date, gen_random_uuid())',
  tests.id('tenant_a'), tests.id('ext'), 'CAD'), '22023', null, 'even the service role cannot insert a payment for it');
select throws_ok(format('insert into public.event_billing (event_id, tenant_id, invoice_url, version) values (%L, %L, %L, 1)',
  tests.id('ext'), tests.id('tenant_a'), 'https://pay.example.test/x'), '22023', null, 'or an invoice link');
select tests.su();
select throws_ok(format('insert into public.event_payments (tenant_id, event_id, amount_cents, currency, paid_on, idempotency_key) values (%L, %L, 100, %L, current_date, gen_random_uuid())',
  tests.id('tenant_a'), tests.id('ext'), 'CAD'), '22023', null, 'nor the database owner');

-- An existing row (only possible by bypassing triggers) cannot be changed through the RPC either.
set local session_replication_role = replica;
insert into public.event_payments (id, tenant_id, event_id, amount_cents, currency, paid_on, idempotency_key, recorded_by_user_id, recorded_by_email)
values (tests.id('legacy_payment'), tests.id('tenant_a'), tests.id('ext'), 100, 'CAD', current_date - 1, gen_random_uuid(), tests.id('staff_a'), 'staff-a@example.test');
set local session_replication_role = origin;
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.invalidate_event_payment(%L, %L)', tests.id('legacy_payment'), 'not ours')),
  '22023', null, 'invalidating a payment of an event booked elsewhere is refused');
select ok((select invalidated_at is null from public.event_payments where id = tests.id('legacy_payment')), 'and the row is unchanged');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('ext') and action = 'payment_invalidated'), 0, 'with no audit entry');
set local session_replication_role = replica;
delete from public.event_payments where id = tests.id('legacy_payment');
set local session_replication_role = origin;

-- Authorization is still checked first.
select throws_ok(format('select tests.as_user(%L, %L)', 'owner_b', tests.pay_sql('ext', 100)), 'P0002', null, 'staff of another business get "not found"');
select throws_ok(format('select tests.as_user(%L, %L)', 'owner_b', tests.pay_sql('flux', 100)), 'P0002', null, 'also for a Flux event of this business');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', tests.pay_sql('ext', 100)), 'P0002', null, 'removed staff stay refused');
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', tests.pay_sql('flux', 100)), 'P0002', null, 'on any event');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = null, removed_by = null where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', tests.pay_sql('ext', 100)), 'PT423', null, 'a suspended workspace stays refused');
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', tests.pay_sql('flux', 100)), 'PT423', null, 'for every event');
set local session_replication_role = replica;
update public.tenants set suspended_at = null where id = tests.id('tenant_a');
set local session_replication_role = origin;
select lives_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.set_event_archived(%L, true)', tests.id('ext'))), 'archive the event booked elsewhere');
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', tests.pay_sql('ext', 100)), '22023', null, 'an archived event booked elsewhere stays refused');
select lives_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.set_event_archived(%L, false)', tests.id('ext'))), 'and restored');

-- The booking source can't be changed to get around it.
select throws_ok(format('select tests.as_user(%L, %L)', 'client_y', format('update public.events set booking_source = %L where id = %L returning 1', 'flux', tests.id('ext'))),
  '42501', null, 'a client cannot change the booking source');
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('update public.events set booking_source = %L where id = %L returning 1', 'flux', tests.id('ext'))),
  '42501', null, 'nor can staff');
select is(tests.payments('ext'), 0, 'the event booked elsewhere still has no payments');
select is(tests.state('ext'), array['lead', 'none', 'external'], 'and its status never changed');

-- ===========================================================================
-- Planning invitations follow the current primary contact
-- ===========================================================================
select tests.as_user('staff_a', format('select public.setup_event_plan(%L, null)', tests.id('ext')));
select tests.as_user('staff_a', format('select public.send_planning_invitation(%L, %L, %L)', tests.id('ext'), tests.id('inv'), encode(sha256(convert_to(gen_random_uuid()::text, 'utf8')), 'hex')));
select is((select usable from private.planning_invitation(tests.id('inv'), null, 'test-bouprod')), true, 'a new invitation works');
update public.clients set email = 'client-y-new@example.test' where id = tests.id('a_client_y');
select is((select usable from private.planning_invitation(tests.id('inv'), null, 'test-bouprod')), false, 'it stops working when the client''s email changes');
select is(tests.as_user('client_y', format('select public.accept_planning_invitation(%L, %L)', tests.id('inv'), 'test-bouprod')) ->> 'state', 'invalid',
  'so the old address cannot accept it');
update public.clients set email = 'client-y@example.test' where id = tests.id('a_client_y');
update public.event_clients set is_primary = false where event_id = tests.id('ext');
select is((select usable from private.planning_invitation(tests.id('inv'), null, 'test-bouprod')), false, 'and when they stop being the primary contact');

select * from finish();
rollback;
