-- Richer staff lists (20261103000100_client_event_lists.sql): the earlier
-- calls still work unchanged; events gain a type filter, an inclusive date
-- range, email search, three orders and the records the list describes the
-- event from; clients gain a digits-only phone search and a newest-first
-- order. Access is unchanged: staff of the business only (not another
-- business, a client, a removed staff member or a suspended workspace).
begin;
\ir _fixtures.psql
select plan(35);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('client-event-lists-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.ev(name text, days int, type text, client text, created timestamptz, updated timestamptz)
returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, timezone, created_at)
  values (tests.id(name), tests.id('tenant_a'), name, type, (now() at time zone 'America/Toronto')::date + days, 'America/Toronto', created);
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id(client), true, true);
  -- updated_at is set by a trigger; pin it for the order test.
  set local session_replication_role = replica;
  update public.events set updated_at = updated where id = tests.id(name);
  set local session_replication_role = origin;
  return tests.id(name);
end $$;
create function tests.events(args jsonb, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.staff_event_list(
    p_tenant_id => tests.id('tenant_a'),
    p_view => coalesce(args ->> 'view', 'upcoming'),
    p_query => args ->> 'q',
    p_event_type => args ->> 'type',
    p_date_from => (args ->> 'from')::date,
    p_date_to => (args ->> 'to')::date,
    p_sort => coalesce(args ->> 'sort', 'date'));
  perform tests.su();
  return r;
end $$;
create function tests.titles(r jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(x ->> 'title' order by o), '{}') from jsonb_array_elements(r -> 'rows') with ordinality t(x, o);
$$;
create function tests.clients(q text default null, sort text default 'name', who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.staff_client_list(p_tenant_id => tests.id('tenant_a'), p_query => q, p_sort => sort);
  perform tests.su();
  return r;
end $$;
create function tests.names(r jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(x ->> 'name' order by o), '{}') from jsonb_array_elements(r -> 'rows') with ordinality t(x, o);
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Only this test's records count from here on.
update public.events set archived_at = now(), event_date = '2020-01-01' where tenant_id = tests.id('tenant_a');
update public.clients set archived_at = now() where tenant_id = tests.id('tenant_a');
insert into public.clients (id, tenant_id, name, email, phone, created_at) values
  (tests.id('yv_ana'), tests.id('tenant_a'), 'Yv Ana', 'ana@yv.example', '+1 (514) 555-0100', now() - interval '3 days'),
  (tests.id('yv_ben'), tests.id('tenant_a'), 'Yv Ben', 'ben@yv.example', '+33 1 23 45 67 89', now() - interval '1 day'),
  (tests.id('yv_cy'), tests.id('tenant_a'), 'Yv Cy', 'cy@yv.example', null, now() - interval '2 days');
select tests.ev('Wedding soon', 5, 'wedding', 'yv_ana', now() - interval '10 days', now() - interval '1 hour');
select tests.ev('Gala later', 40, 'corporate', 'yv_ben', now() - interval '1 day', now() - interval '5 days');
select tests.ev('School mid', 20, 'school', 'yv_cy', now() - interval '5 days', now() - interval '2 days');

-- ===========================================================================
-- Access and compatibility
-- ===========================================================================
select tests.login_as_anon();
select throws_ok($$ select public.staff_event_list(p_tenant_id => tests.id('tenant_a'), p_sort => 'created') $$, '42501', null, 'anon cannot list events');
select throws_ok($$ select public.staff_client_list(p_tenant_id => tests.id('tenant_a'), p_sort => 'recent') $$, '42501', null, 'anon cannot list clients');
select tests.su();
select throws_ok($$ select tests.events('{}', 'owner_b') $$, 'P0002', 'not found', 'another business cannot list events');
select throws_ok($$ select tests.clients(who => 'owner_b') $$, 'P0002', 'not found', 'nor its clients');
select throws_ok($$ select tests.clients('514', who => 'client_y') $$, 'P0002', 'not found', 'a client cannot search clients');
select is((select count(*)::int from pg_proc where proname in ('staff_event_list', 'staff_client_list') and pronamespace = 'public'::regnamespace), 2,
  'one version of each list (the earlier signatures were replaced, not overloaded)');
select ok((select bool_and(prosecdef and provolatile = 's' and not has_function_privilege('anon', oid, 'execute')
                           and has_function_privilege('authenticated', oid, 'execute'))
           from pg_proc where proname in ('staff_event_list', 'staff_client_list') and pronamespace = 'public'::regnamespace),
  'both stay STABLE security definer, for authenticated only');
-- The previously deployed app passes only the earlier parameters, by name.
select tests.login_as(tests.id('staff_a'));
select is(tests.titles(public.staff_event_list(p_tenant_id => tests.id('tenant_a'), p_view => 'upcoming', p_status => null, p_query => null,
                                               p_include_archived => false, p_limit => 25, p_offset => 0)),
  array['Wedding soon', 'School mid', 'Gala later'], 'the earlier events call works unchanged: upcoming, nearest first');
select is(tests.names(public.staff_client_list(p_tenant_id => tests.id('tenant_a'), p_query => 'yv', p_include_archived => false, p_limit => 25, p_offset => 0)),
  array['Yv Ana', 'Yv Ben', 'Yv Cy'], 'the earlier clients call works unchanged: by name');
select tests.su();

-- ===========================================================================
-- Events: type, range, email search, orders, row details
-- ===========================================================================
select throws_like($$ select tests.events('{"sort": "price"}') $$, '%list_invalid%', 'an unknown order is refused');
select throws_like($$ select tests.events('{"type": "Gala!"}') $$, '%list_invalid%', 'a malformed type is refused');
select throws_like($$ select tests.events(jsonb_build_object('from', current_date + 10, 'to', current_date)) $$, '%list_invalid%', 'a backwards range is refused');
select is(tests.titles(tests.events('{"type": "corporate"}')), array['Gala later'], 'type filter');
select is(tests.titles(tests.events(jsonb_build_object('from', (now() at time zone 'America/Toronto')::date + 5, 'to', (now() at time zone 'America/Toronto')::date + 20))),
  array['Wedding soon', 'School mid'], 'the date range includes both ends');
select is(tests.titles(tests.events(jsonb_build_object('view', 'past', 'from', (now() at time zone 'America/Toronto')::date))), '{}'::text[],
  'the range combines with the date view');
select is(tests.titles(tests.events('{"q": "BEN@YV"}')), array['Gala later'], 'search matches the primary contact''s email');
select is(tests.titles(tests.events('{"sort": "updated"}')), array['Wedding soon', 'School mid', 'Gala later'], 'most recently updated first');
select is(tests.titles(tests.events('{"sort": "created"}')), array['Gala later', 'School mid', 'Wedding soon'], 'newest first');
select is(tests.titles(tests.events('{"sort": "created", "type": "school"}')), array['School mid'], 'orders combine with filters');
select is((select x -> 'event_type' from jsonb_array_elements(tests.events('{}') -> 'rows') x where x ->> 'title' = 'Gala later'), '"corporate"'::jsonb,
  'rows carry the event type');
select is((select jsonb_build_array(x -> 'proposal_status', x -> 'proposal_draft', x -> 'contract_status', x -> 'contract_signed')
           from jsonb_array_elements(tests.events('{}') -> 'rows') x where x ->> 'title' = 'Wedding soon'),
  '[null, false, null, false]'::jsonb, 'a new event: no proposal, no draft, no contract');
select ok((select bool_and(x ? 'updated_at' and x ? 'created_at') from jsonb_array_elements(tests.events('{}') -> 'rows') x), 'rows carry their timestamps');

-- A proposal and contract the list describes (taken straight from the records, never stored).
set local session_replication_role = replica;
insert into public.proposals (id, tenant_id, event_id, revision, status, sent_at, expires_at, offer_snapshot, offer_frozen_at, offer_sha256)
values (tests.id('p_sent'), tests.id('tenant_a'), tests.id('School mid'), 1, 'sent', now() - interval '15 days', now() - interval '1 day', '{}', now() - interval '15 days', repeat('a', 64));
insert into public.proposals (id, tenant_id, event_id, revision, status)
values (tests.id('p_draft'), tests.id('tenant_a'), tests.id('School mid'), 2, 'draft');
update public.events set active_proposal_id = tests.id('p_sent') where id = tests.id('School mid');
set local session_replication_role = origin;
select is((select jsonb_build_array(x -> 'proposal_status', x -> 'proposal_draft')
           from jsonb_array_elements(tests.events('{}') -> 'rows') x where x ->> 'title' = 'School mid'),
  '["expired", true]'::jsonb, 'a sent offer past its expiry reads as expired, and the revision draft is reported');
select is((select status from public.proposals where id = tests.id('p_sent')), 'sent', '(the stored proposal is untouched)');

-- ===========================================================================
-- Clients: phone search by digits, newest first
-- ===========================================================================
select throws_like($$ select tests.clients(sort => 'email') $$, '%list_invalid%', 'an unknown client order is refused');
select is(tests.names(tests.clients('514 555')), array['Yv Ana'], 'phone search ignores punctuation: "514 555" finds "+1 (514) 555-0100"');
select is(tests.names(tests.clients('5145550100')), array['Yv Ana'], 'and the digits alone find it');
select is(tests.names(tests.clients('33 1 23')), array['Yv Ben'], 'international numbers too');
select is(tests.names(tests.clients('yv 12')), '{}'::text[], 'two digits are not a phone search (and match no name or email)');
select is(tests.names(tests.clients('yv', 'recent')), array['Yv Ben', 'Yv Cy', 'Yv Ana'], 'recently added: newest first');
select ok((select bool_and(x ? 'created_at') from jsonb_array_elements(tests.clients('yv') -> 'rows') x), 'rows carry when the client was added');

-- ===========================================================================
-- Removed staff and a suspended workspace
-- ===========================================================================
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a')
where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select throws_ok($$ select tests.events('{}') $$, 'P0002', 'not found', 'a removed staff member cannot list events');
select throws_ok($$ select tests.clients('yv') $$, 'P0002', 'not found', 'nor clients');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f4900000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cel-op@example.test', now(), now(), now());
insert into public.platform_admins (user_id, note) values ('f4900000-0000-4000-8000-000000000001', 'operator');
select tests.login_as('f4900000-0000-4000-8000-000000000001');
select public.suspend_workspace(tests.id('tenant_a'), 0, 'Client and event lists test suspension');
select tests.su();
select throws_ok($$ select tests.events('{"sort": "updated"}', 'owner_a') $$, 'PT423', null, 'a suspended workspace''s events list is refused');
select throws_ok($$ select tests.clients('514', who => 'owner_a') $$, 'PT423', null, 'and so is its clients list');

select * from finish();
rollback;
