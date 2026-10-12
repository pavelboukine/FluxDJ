-- Event contacts (20261105000100_event_contacts_dashboard_status.sql):
-- add_event_contact is all-or-nothing under the event lock (a failure leaves
-- the previous primary and signer as they were; a stale expected primary
-- writes nothing), remove_event_contact only removes a contact of the named
-- event, both are staff-of-the-business only and audited, and the dashboard's
-- upcoming events carry the records the shared event status reads.
begin;
\ir _fixtures.psql
select plan(36);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('event-contacts-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.add(who text, event text, client text, primary_ boolean default false, signer boolean default false, expected text default null)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.add_event_contact(tests.id(event), tests.id(client), primary_, signer, case when expected is null then null else tests.id(expected) end);
  perform tests.su();
  return r;
end $$;
create function tests.remove(who text, event text, event_client uuid) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.remove_event_contact(tests.id(event), event_client);
  perform tests.su();
  return r;
end $$;
-- [primary client, signer client] of an event.
create function tests.roles(event text) returns uuid[] language sql stable as $$
  select array[(select client_id from public.event_clients where event_id = tests.id(event) and is_primary),
               (select client_id from public.event_clients where event_id = tests.id(event) and can_sign)];
$$;
create function tests.link(event text, client text) returns uuid language sql stable as $$
  select id from public.event_clients where event_id = tests.id(event) and client_id = tests.id(client);
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

insert into public.clients (id, tenant_id, name, email) values
  (tests.id('ec_one'), tests.id('tenant_a'), 'EC One', 'ec-one@example.test'),
  (tests.id('ec_two'), tests.id('tenant_a'), 'EC Two', 'ec-two@example.test'),
  (tests.id('ec_three'), tests.id('tenant_a'), 'EC Three', 'ec-three@example.test'),
  (tests.id('ec_four'), tests.id('tenant_a'), 'EC Four', 'ec-four@example.test'),
  (tests.id('ec_old'), tests.id('tenant_a'), 'EC Old', 'ec-old@example.test');
update public.clients set archived_at = now() where id = tests.id('ec_old');

-- ===========================================================================
-- Access
-- ===========================================================================
select tests.login_as_anon();
select throws_ok($$ select public.add_event_contact(tests.id('event_a2'), tests.id('ec_one')) $$, '42501', null, 'anon cannot add contacts');
select throws_ok($$ select public.remove_event_contact(tests.id('event_a2'), gen_random_uuid()) $$, '42501', null, 'anon cannot remove contacts');
select tests.su();
select throws_ok($$ select tests.add('owner_b', 'event_a2', 'ec_one') $$, 'P0002', 'not found', 'another business cannot add to the event');
select throws_ok($$ select tests.add('client_y', 'event_a2', 'ec_one') $$, 'P0002', 'not found', 'a client cannot add contacts');
select ok((select bool_and(prosecdef and not has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')
                           and exists (select 1 from unnest(proconfig) c where c = 'search_path=""'))
           from pg_proc where proname in ('add_event_contact', 'remove_event_contact') and pronamespace = 'public'::regnamespace),
  'both are security definer with an empty search_path, for authenticated only');

-- ===========================================================================
-- Adding: roles move together with the insert, or not at all
-- ===========================================================================
select is(tests.roles('event_a2'), array[tests.id('a_client_y'), tests.id('a_client_y')], '(event A2 starts with Client Y as primary and signer)');
select ok(tests.add('staff_a', 'event_a2', 'ec_one') ? 'event_client_id', 'staff add a plain contact');
select is((select array[is_primary, can_sign] from public.event_clients where id = tests.link('event_a2', 'ec_one')), array[false, false], 'with no role');
select is(tests.roles('event_a2'), array[tests.id('a_client_y'), tests.id('a_client_y')], 'the primary and signer are unchanged');

select ok(tests.add('staff_a', 'event_a2', 'ec_two', true, true, 'a_client_y') ? 'event_client_id', 'staff add a new primary contact and signer');
select is(tests.roles('event_a2'), array[tests.id('ec_two'), tests.id('ec_two')], 'who takes both roles from the previous holder');
select is((select array[is_primary, can_sign] from public.event_clients where id = tests.link('event_a2', 'a_client_y')), array[false, false],
  'the previous holder stays on the event as a contact');

select ok(tests.add('staff_a', 'event_a2', 'ec_three', false, true) ? 'event_client_id', 'the signer can be assigned on its own');
select is(tests.roles('event_a2'), array[tests.id('ec_two'), tests.id('ec_three')], 'the primary stays; only the signer moves');

-- Failures change nothing.
select throws_like($$ select tests.add('staff_a', 'event_a2', 'ec_one', true, true, 'ec_two') $$, '%contact_invalid: EC One is already a contact on this event%',
  'adding someone already on the event (a stale tab) is refused');
select is(tests.roles('event_a2'), array[tests.id('ec_two'), tests.id('ec_three')], 'and leaves the primary and the signer as they were');
select throws_ok($$ select tests.add('staff_a', 'event_a2', 'ec_four', true, true, 'a_client_y') $$, 'PT409', null,
  'taking the primary role from someone who no longer has it (another save came first) is refused');
select is(jsonb_build_array(tests.roles('event_a2'), tests.link('event_a2', 'ec_four')),
  jsonb_build_array(array[tests.id('ec_two'), tests.id('ec_three')], null), 'nothing is inserted or demoted');
select throws_like($$ select tests.add('staff_a', 'event_a2', 'b_client_x', true, true, 'ec_two') $$, '%contact_invalid: that client wasn''t found in this business%',
  'another business''s client is refused');
select throws_like($$ select tests.add('staff_a', 'event_a2', 'ec_old') $$, '%contact_invalid: that client is archived%', 'an archived client is refused');
select is(tests.roles('event_a2'), array[tests.id('ec_two'), tests.id('ec_three')], 'still unchanged after every refusal');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('event_a2') and action = 'contact_added'), 3,
  'each successful addition is audited once; refusals record nothing');

-- An archived event keeps its contacts editable, and a new contact gains no client access.
update public.events set archived_at = now() where id = tests.id('event_a1');
select ok(tests.add('staff_a', 'event_a1', 'ec_four') ? 'event_client_id', 'a contact can still be added to an archived event');
select is((select count(*)::int from public.event_access where event_id = tests.id('event_a1') and client_id = tests.id('ec_four')), 0,
  'which grants that client no access');

-- ===========================================================================
-- Removing: only a contact of the named event
-- ===========================================================================
select throws_ok(format('select tests.remove(%L, %L, %L)', 'staff_a', 'event_a2', tests.link('event_a1', 'ec_four')), 'P0002', 'not found',
  'a contact of another event can''t be removed through this event');
select isnt(tests.link('event_a1', 'ec_four'), null, 'and stays on its own event');
select throws_ok(format('select tests.remove(%L, %L, %L)', 'owner_b', 'event_a2', tests.link('event_a2', 'ec_one')), 'P0002', 'not found',
  'another business can''t remove contacts');
select throws_ok(format('select tests.remove(%L, %L, %L)', 'staff_a', 'event_a2', tests.link('event_a2', 'a_client_y')), '23503', null,
  'a contact with client access history can''t be removed');
select is(tests.remove('staff_a', 'event_a2', tests.link('event_a2', 'ec_one')) ->> 'removed', 'true', 'staff remove a contact of the event');
select is(tests.link('event_a2', 'ec_one'), null, 'it is gone');
select is((select count(*)::int from public.audit_events where entity_id = tests.id('event_a2') and action = 'contact_removed'), 1, 'and the removal is audited');

-- The dashboard's upcoming events carry what the shared event status reads (keys added; earlier ones kept).
select tests.login_as(tests.id('owner_a'));
create temp table dash as select public.staff_dashboard(tests.id('tenant_a')) as d;
select tests.su();
select ok((select bool_and(x ?& array['lifecycle_status', 'contract_signed', 'proposal_status', 'proposal_draft', 'contract_status'])
           and count(*) > 0 from dash, jsonb_array_elements(d -> 'upcoming') x),
  'each upcoming dashboard event has its lifecycle, proposal and contract records');

-- ===========================================================================
-- Removed staff and a suspended workspace
-- ===========================================================================
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a')
where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select throws_ok($$ select tests.add('staff_a', 'event_a2', 'ec_four') $$, 'P0002', 'not found', 'a removed staff member can''t add contacts');
select throws_ok(format('select tests.remove(%L, %L, %L)', 'staff_a', 'event_a2', tests.link('event_a2', 'ec_three')), 'P0002', 'not found',
  'nor remove them');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f5100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ec-op@example.test', now(), now(), now());
insert into public.platform_admins (user_id, note) values ('f5100000-0000-4000-8000-000000000001', 'operator');
select tests.login_as('f5100000-0000-4000-8000-000000000001');
select public.suspend_workspace(tests.id('tenant_a'), 0, 'Event contacts test suspension');
select tests.su();
select throws_ok($$ select tests.add('owner_a', 'event_a2', 'ec_four') $$, 'PT423', null, 'a suspended workspace can''t add contacts');
select throws_ok(format('select tests.remove(%L, %L, %L)', 'owner_a', 'event_a2', tests.link('event_a2', 'ec_three')), 'PT423', null,
  'nor remove them');

select * from finish();
rollback;
