-- Staff dashboard facts (public.staff_dashboard): who may read them, upcoming
-- events by each event's own date, submitted proposals, deposits under each
-- booking policy, legacy booking checks, planning near or past its deadline
-- (reopenings and completed plans), email failures versus retries, setup
-- facts, archived events and suspended workspaces, and that reading changes
-- nothing.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(49);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('dashboard-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- An event in tenant A for client Y, `days` days after today in its own time zone.
create function tests.ev(name text, days int, tz text default 'America/Toronto', venue text default null) returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, timezone, venue_name)
  values (tests.id(name), tests.id('tenant_a'), name, 'wedding', (now() at time zone tz)::date + days, tz, venue);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  return tests.id(name);
end $$;
-- Booked as evaluate_booking does it (which also sets up the plan).
create function tests.book(name text) returns void language plpgsql as $$
begin
  perform set_config('flux.booking_event', tests.id(name)::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id(name);
  perform set_config('flux.booking_event', '', true);
end $$;
create function tests.dash(who text default 'staff_a', tenant text default 'tenant_a', lim int default 8) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.staff_dashboard(tests.id(tenant), lim);
  perform tests.su();
  return r;
end $$;
create function tests.has(list text, event text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(tests.dash() -> list) x where x ->> 'event_id' = tests.id(event)::text);
$$;
create function tests.upcoming_ids(lim int default 50) returns text[] language sql as $$
  select coalesce(array_agg(x ->> 'title' order by o), '{}') from jsonb_array_elements(tests.dash(lim => lim) -> 'upcoming') with ordinality u(x, o);
$$;
-- A proposal submitted by the client and not yet approved (tests.approved without the approval).
create function tests.submitted(event_name text) returns uuid language plpgsql as $$
declare pid uuid; link uuid; sess text; sub jsonb;
begin
  perform tests.login_as(tests.id('owner_a'));
  pid := public.open_proposal_draft(tests.id(event_name), tests.base_offer());
  perform tests.send(pid);
  link := current_setting('tests.last_link_id')::uuid;
  perform tests.login_as_service();
  sess := tests.hex('session-' || pid);
  perform public.exchange_proposal_link(tests.hex('token-' || link), sess, 'test-bouprod', 3600);
  perform public.client_save_selection_draft(sess, pid, 'test-bouprod', 0, 'signature', '{}', '{"ceremony_location":"same_room","needs_wireless_mic":false}');
  sub := public.client_submit_selection(sess, pid, 'test-bouprod', 1, 'key-' || replace(pid::text, '-', ''), tests.valid_selection(pid));
  set constraints public.proposal_selections_verify, public.proposal_selection_lines_verify deferred;
  perform tests.su();
  return pid;
end $$;
create function tests.sent_contract(event text) returns uuid language plpgsql as $$
declare v_approval uuid := tests.approved(event); v_contract uuid; v_link uuid := gen_random_uuid();
begin
  perform tests.login_as(tests.id('owner_a'));
  v_contract := (public.generate_contract_draft(v_approval, current_setting('tests.v')::uuid) ->> 'contract_id')::uuid;
  perform public.send_contract(v_contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
  perform tests.su();
  return v_contract;
end $$;
create function tests.sign(contract uuid) returns jsonb language plpgsql as $$
declare v_hash text; v_consent text; v_path text; r jsonb;
begin
  select content_sha256, consent_version, tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' into v_hash, v_consent, v_path
  from public.contracts where id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size": 4096, "mimetype": "image/png"}');
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id('client_y'), 'Client Y', v_hash, v_consent, true, v_path,
    repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  perform tests.su();
  return r;
end $$;
create function tests.pay(event text, cents bigint) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('staff_a'));
  r := public.record_event_payment(tests.id(event), cents, current_date - 1, null, null, gen_random_uuid(), true);
  perform tests.su();
  return r;
end $$;
create function tests.policy(p text) returns void language plpgsql as $$
begin
  perform tests.login_as(tests.id('owner_a'));
  perform public.update_booking_policy(tests.id('tenant_a'), p, (select booking_policy_version from public.tenants where id = tests.id('tenant_a')));
  perform tests.su();
end $$;
create function tests.outstanding(event text) returns bigint language sql as $$
  select (x ->> 'deposit_outstanding_cents')::bigint from jsonb_array_elements(tests.dash() -> 'awaiting_deposit') x where x ->> 'event_id' = tests.id(event)::text;
$$;
create function tests.planning(event text) returns jsonb language sql as $$
  select x from jsonb_array_elements(tests.dash() -> 'planning') x where x ->> 'event_id' = tests.id(event)::text;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test', reply_to_email = 'hello@bouprod.test',
  tax_categories = '{"standard": ["GST", "QST"]}' where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
-- Only this test's events count from here on.
update public.events set archived_at = now() where tenant_id = tests.id('tenant_a');

-- ===========================================================================
-- Access
-- ===========================================================================
select tests.login_as_anon();
select throws_ok($$ select public.staff_dashboard(tests.id('tenant_a')) $$, '42501', null, 'anon cannot read the dashboard');
select tests.su();
select throws_ok($$ select tests.dash('owner_b') $$, 'P0002', 'not found', 'another business''s owner gets not found');
select throws_ok($$ select tests.dash('client_y') $$, 'P0002', 'not found', 'a client gets not found');
select lives_ok($$ select tests.dash('owner_a') $$, 'the owner reads it');
select is((select provolatile from pg_proc where oid = 'public.staff_dashboard(uuid, integer)'::regprocedure), 's',
  'it is STABLE, so Postgres refuses any write inside it');

-- ===========================================================================
-- Upcoming events: each event's own date, archived left out, ordered, limited
-- ===========================================================================
select tests.ev('Kiritimati yesterday', 0, 'Pacific/Kiritimati');
update public.events set event_date = event_date - 1 where id = tests.id('Kiritimati yesterday');
select tests.ev('Pago Pago today', 0, 'Pacific/Pago_Pago');
select tests.ev('Toronto yesterday', -1);
select tests.ev('C later', 20, 'America/Toronto', 'Le Windsor');
select tests.ev('A later', 20);
select tests.ev('Archived soon', 2);
update public.events set archived_at = now() where id = tests.id('Archived soon');
select ok((select (event_date >= (now() at time zone 'Pacific/Pago_Pago')::date) from public.events where id = tests.id('Kiritimati yesterday')),
  'the Kiritimati event''s date is still today or later in Pago Pago');
select is(tests.upcoming_ids(), array['Pago Pago today', 'A later', 'C later'],
  'today and later in each event''s own time zone, by date then title; past and archived events left out');
select is(tests.dash(lim => 2) -> 'upcoming_more', 'true'::jsonb, 'more than the limit: flagged');
select is(jsonb_array_length(tests.dash(lim => 2) -> 'upcoming'), 2, 'and only the limit returned');
select is(tests.dash(lim => 3) -> 'upcoming_more', 'false'::jsonb, 'exactly the limit: nothing more');
select is((select jsonb_build_array(x ->> 'client_name', x ->> 'venue_name', x ->> 'lifecycle_status', x -> 'contract_signed')
           from jsonb_array_elements(tests.dash() -> 'upcoming') x where x ->> 'title' = 'C later'),
  '["Client Y (A)", "Le Windsor", "lead", false]'::jsonb, 'with the primary client, venue and lifecycle');
select is((select x -> 'venue_name' from jsonb_array_elements(tests.dash() -> 'upcoming') x where x ->> 'title' = 'A later'),
  'null'::jsonb, 'a missing venue stays missing');

-- ===========================================================================
-- Submitted proposals
-- ===========================================================================
select tests.ev('Proposal waiting', 30);
select set_config('tests.p_wait', tests.submitted('Proposal waiting')::text, true);
select ok(tests.has('submitted', 'Proposal waiting'), 'a submitted current proposal waits for approval');
select is((select x ->> 'proposal_id' from jsonb_array_elements(tests.dash() -> 'submitted') x where x ->> 'event_id' = tests.id('Proposal waiting')::text),
  current_setting('tests.p_wait'), 'linked to that proposal');
select tests.ev('Proposal approved', 31);
select tests.approved('Proposal approved');
select ok(not tests.has('submitted', 'Proposal approved'), 'an approved proposal does not');

-- ===========================================================================
-- Deposits: only signed contracts waiting for the deposit under on_deposit
-- ===========================================================================
select tests.ev('Deposit due', 40);
select set_config('tests.c_dep', tests.sent_contract('Deposit due')::text, true);
select ok(not tests.has('awaiting_deposit', 'Deposit due'), 'a sent, unsigned contract is not waiting for a deposit');
select tests.sign(current_setting('tests.c_dep')::uuid);
select is(tests.outstanding('Deposit due'), (select deposit_cents from public.contracts where id = current_setting('tests.c_dep')::uuid),
  'signed under on_deposit: waiting for the whole deposit');
select tests.pay('Deposit due', 1000);
select is(tests.outstanding('Deposit due'), (select deposit_cents - 1000 from public.contracts where id = current_setting('tests.c_dep')::uuid),
  'a partial payment lowers what is outstanding (the authoritative summary)');
select tests.pay('Deposit due', (select deposit_cents - 1000 from public.contracts where id = current_setting('tests.c_dep')::uuid));
select ok(not tests.has('awaiting_deposit', 'Deposit due'), 'once the deposit is received the event is booked and leaves the list');

update public.tenants set deposit_percent = 0 where id = tests.id('tenant_a');
select tests.ev('Zero deposit', 41);
select tests.sign(tests.sent_contract('Zero deposit'));
select ok(not tests.has('awaiting_deposit', 'Zero deposit'), 'a 0% deposit books on signing: never waiting for a deposit');
update public.tenants set deposit_percent = 50 where id = tests.id('tenant_a');
select tests.policy('on_signature');
select tests.ev('Signature policy', 42);
select tests.sign(tests.sent_contract('Signature policy'));
select ok(not tests.has('awaiting_deposit', 'Signature policy'), 'on_signature books on signing even with a balance due');
select is((select lifecycle_status from public.events where id = tests.id('Signature policy')), 'booked', '(it is booked)');
select tests.policy('on_deposit');

-- ===========================================================================
-- Legacy contracts: check booking, then the deposit list (never both)
-- ===========================================================================
select tests.ev('Legacy', 43);
select set_config('tests.c_leg', tests.sent_contract('Legacy')::text, true);
set local session_replication_role = replica;
update public.contracts set booking_policy = null where id = current_setting('tests.c_leg')::uuid;
set local session_replication_role = origin;
select tests.sign(current_setting('tests.c_leg')::uuid);
select ok(tests.has('booking_check', 'Legacy'), 'a contract signed before booking policies needs a booking check');
select ok(not tests.has('awaiting_deposit', 'Legacy'), 'and is not listed as waiting for a deposit');
select ok(not tests.has('booking_check', 'Signature policy'), 'contracts with a policy never need the check');
select tests.login_as(tests.id('staff_a'));
select public.check_event_booking(tests.id('Legacy'));
select tests.su();
select ok(not tests.has('booking_check', 'Legacy') and tests.has('awaiting_deposit', 'Legacy'),
  'once checked without the deposit it moves to the deposit list, not both');

-- ===========================================================================
-- Planning near or past its deadline, with answers missing
-- ===========================================================================
select tests.ev('Plan soon', 50); select tests.book('Plan soon');
select private.set_plan_cutoff_columns(tests.id('Plan soon'), now() + interval '3 days', null);
select tests.ev('Plan later', 51); select tests.book('Plan later');
select private.set_plan_cutoff_columns(tests.id('Plan later'), now() + interval '10 days', null);
select tests.ev('Plan closed', 52); select tests.book('Plan closed');
select private.set_plan_cutoff_columns(tests.id('Plan closed'), now() - interval '1 day', null);
select tests.ev('Plan reopened', 53); select tests.book('Plan reopened');
select private.set_plan_cutoff_columns(tests.id('Plan reopened'), now() - interval '1 day', now() + interval '2 days');
select tests.ev('Plan reopen ended', 54); select tests.book('Plan reopen ended');
select private.set_plan_cutoff_columns(tests.id('Plan reopen ended'), now() - interval '3 days', now() - interval '1 day');
select tests.ev('Plan event over', -1); select tests.book('Plan event over');
select private.set_plan_cutoff_columns(tests.id('Plan event over'), now() - interval '5 days', null);
select tests.ev('Plan archived', 55); select tests.book('Plan archived');
select private.set_plan_cutoff_columns(tests.id('Plan archived'), now() - interval '1 day', null);
update public.events set archived_at = now() where id = tests.id('Plan archived');
select tests.ev('Plan not booked', 56);

select is(tests.planning('Plan soon') ->> 'state', 'open', 'closing within 7 days with answers missing');
select ok((tests.planning('Plan soon') ->> 'requirements_met')::int < (tests.planning('Plan soon') ->> 'requirements_total')::int,
  'with the plan''s own progress (available sections only)');
select is(tests.planning('Plan soon') ->> 'closes_at', tests.planning('Plan soon') ->> 'deadline', 'it closes at the deadline');
select is(tests.planning('Plan later'), null, 'a deadline 10 days away is not listed yet');
select is(tests.planning('Plan closed') ->> 'state', 'closed', 'past the deadline: closed, told apart from closing soon');
select is(tests.planning('Plan reopened') ->> 'state', 'reopened', 'a reopening is respected');
select is((tests.planning('Plan reopened') ->> 'closes_at')::timestamptz,
  (select planning_override_until from public.events where id = tests.id('Plan reopened')), 'and closes when the reopening ends');
select is(tests.planning('Plan reopen ended') ->> 'state', 'closed', 'an expired reopening is closed again');
select is(tests.planning('Plan event over'), null, 'events already past are not listed');
select is(tests.planning('Plan archived'), null, 'archived events are not listed');
select is(tests.planning('Plan not booked'), null, 'events without a booking (and so no client planning) are not listed');
select is((select count(*)::int from public.event_plans where event_id = tests.id('Plan not booked')), 0, 'and reading sets up no plan');

-- A plan whose available sections are all answered is not listed.
select tests.ev('Plan done', 57, 'America/Toronto', 'Château Montebello'); select tests.book('Plan done');
select private.set_plan_cutoff_columns(tests.id('Plan done'), now() + interval '2 days', null);
update public.event_plan_items set disabled_at = now()
  where plan_id = (select id from public.event_plans where event_id = tests.id('Plan done')) and key <> 'basics';
select ok(tests.planning('Plan done') is not null, 'listed while answers are missing');
select tests.login_as(tests.id('client_y'));
select public.client_save_plan_basics(tests.id('Plan done'), 'test-bouprod', 0,
  '{"guest_count":120,"start_time":"18:00","end_time":"23:00","access_notes_none":true}');
select tests.su();
select is((private.plan_progress((select id from public.event_plans where event_id = tests.id('Plan done'))) ->> 'requirements_met')::int,
  (private.plan_progress((select id from public.event_plans where event_id = tests.id('Plan done'))) ->> 'requirements_total')::int,
  '(the remaining sections are all answered)');
select is(tests.planning('Plan done'), null, 'and not listed once complete');

-- ===========================================================================
-- Email failures
-- ===========================================================================
insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, dedup_key, status, attempts, last_error) values
  (tests.id('tenant_a'), 'proposal_sent', 'a@example.test', 'proposal', gen_random_uuid(), 'dash-failed-1', 'failed', 5, 'bounced'),
  (tests.id('tenant_a'), 'proposal_sent', 'b@example.test', 'proposal', gen_random_uuid(), 'dash-failed-2', 'failed', 5, 'bounced'),
  (tests.id('tenant_a'), 'proposal_sent', 'c@example.test', 'proposal', gen_random_uuid(), 'dash-retry', 'pending', 2, 'timeout'),
  (tests.id('tenant_a'), 'proposal_sent', 'd@example.test', 'proposal', gen_random_uuid(), 'dash-sending', 'sending', 1, null),
  (tests.id('tenant_b'), 'proposal_sent', 'e@example.test', 'proposal', gen_random_uuid(), 'dash-other', 'failed', 5, 'bounced'),
  (null, 'platform_invitation', 'f@example.test', 'platform_invitation', gen_random_uuid(), 'dash-platform', 'failed', 5, 'bounced');
select is((tests.dash() ->> 'failed_emails')::int,
  (select count(*)::int from public.email_outbox where tenant_id = tests.id('tenant_a') and status = 'failed'),
  'failed emails are this business''s emails with status failed');
select ok((select count(*) from public.email_outbox where tenant_id = tests.id('tenant_a') and status = 'failed') >= 2
  and (tests.dash() ->> 'failed_emails')::int < (select count(*)::int from public.email_outbox where status = 'failed'),
  'retries, other businesses and platform invitations are not counted');

-- ===========================================================================
-- Setup facts
-- ===========================================================================
select is(tests.dash() -> 'setup' -> 'identity_saved', 'true'::jsonb, 'the saved legal identity');
select is(tests.dash() -> 'setup' -> 'tax_categories', '["standard"]'::jsonb, 'configured tax categories');
select is(tests.dash('owner_b', 'tenant_b') -> 'setup',
  '{"identity_saved": false, "tax_categories": [], "used_tax_categories": ["standard"], "active_packages": 1, "usable_proposal_templates": 0, "client_use_contract_templates": 0}'::jsonb,
  'a barely set up business: one package whose tax category isn''t configured, nothing else');
select is((tests.dash() -> 'setup' ->> 'client_use_contract_templates')::int, 0, 'a DEMO-only contract template is not client-ready');

-- ===========================================================================
-- Reading changes nothing; suspended workspaces are refused
-- ===========================================================================
select set_config('tests.before', (select md5(string_agg(e.id || e.lifecycle_status || coalesce(e.booking_confirmed_at::text, '') || e.updated_at, ',' order by e.id))
  || (select count(*) from public.email_outbox) || (select count(*) from public.event_plans) || (select count(*) from public.audit_events)
  from public.events e), true);
select tests.dash();
select tests.dash('owner_a');
select is((select md5(string_agg(e.id || e.lifecycle_status || coalesce(e.booking_confirmed_at::text, '') || e.updated_at, ',' order by e.id))
  || (select count(*) from public.email_outbox) || (select count(*) from public.event_plans) || (select count(*) from public.audit_events)
  from public.events e), current_setting('tests.before'), 'reading changes no event, plan, email or audit row');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f2000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dash-op@example.test', now(), now(), now());
insert into public.platform_admins (user_id, note) values ('f2000000-0000-4000-8000-000000000001', 'operator');
select tests.login_as('f2000000-0000-4000-8000-000000000001');
select public.suspend_workspace(tests.id('tenant_a'), 0, 'Dashboard test suspension');
select tests.su();
select throws_ok($$ select tests.dash() $$, 'PT423', null, 'a suspended workspace''s dashboard is refused');

select * from finish();
rollback;
