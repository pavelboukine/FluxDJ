-- Staff Events and Clients lists (staff_event_list, staff_client_list) and
-- client archiving (set_client_archived): who may call them, each event's own
-- date, ordering, status, search (with literal % and _), archived inclusion
-- and counts, pagination, next events, and that archiving changes only the
-- client's archived state, once, with an audit event.
begin;
\ir _fixtures.psql
select plan(43);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('lists-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- An event in tenant A, `days` after today in its own time zone, with a primary contact.
create function tests.ev(name text, days int, tz text default 'America/Toronto', client text default 'a_client_x', venue text default null, status text default 'lead')
returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, timezone, venue_name)
  values (tests.id(name), tests.id('tenant_a'), name, 'wedding', (now() at time zone tz)::date + days, tz, venue);
  if status <> 'lead' then
    -- A state the list only displays (booking itself is tested in 24_booking).
    set local session_replication_role = replica;
    update public.events set lifecycle_status = status, booking_confirmed_at = case when status in ('booked', 'completed') then now() end where id = tests.id(name);
    set local session_replication_role = origin;
  end if;
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id(client), true, true);
  return tests.id(name);
end $$;
create function tests.events(view text default 'upcoming', q text default null, status text default null, archived boolean default false, lim int default 25, off int default 0, who text default 'staff_a')
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.staff_event_list(tests.id('tenant_a'), view, status, q, archived, lim, off);
  perform tests.su();
  return r;
end $$;
create function tests.titles(r jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(x ->> 'title' order by o), '{}') from jsonb_array_elements(r -> 'rows') with ordinality t(x, o);
$$;
create function tests.clients(q text default null, archived boolean default false, lim int default 25, off int default 0) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('staff_a'));
  r := public.staff_client_list(tests.id('tenant_a'), q, archived, lim, off);
  perform tests.su();
  return r;
end $$;
create function tests.archive(client text, archived boolean, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.set_client_archived(tests.id(client), archived);
  perform tests.su();
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Only this test's events count from here on.
update public.events set archived_at = now(), event_date = '2020-01-01' where tenant_id = tests.id('tenant_a');
update public.clients set name = 'Client X (A)' where id = tests.id('a_client_x');
insert into public.clients (id, tenant_id, name, email) values
  (tests.id('zq_ana'), tests.id('tenant_a'), 'Zq Ana Garcia', 'ana@zq.example'),
  (tests.id('zq_ben'), tests.id('tenant_a'), 'Zq Ben 100%_off', 'ben_x@zq.example'),
  (tests.id('zq_old'), tests.id('tenant_a'), 'Zq Old Lead', 'old@zq.example');
update public.clients set archived_at = now() - interval '3 days' where id = tests.id('zq_old');

select tests.ev('Kiritimati yesterday', 0, 'Pacific/Kiritimati');
update public.events set event_date = event_date - 1 where id = tests.id('Kiritimati yesterday');
select tests.ev('Pago Pago today', 0, 'Pacific/Pago_Pago', 'zq_ana', 'Château Ramezay');
select tests.ev('B later', 10, 'America/Toronto', 'zq_ben', null, 'booked');
select tests.ev('A later', 10, 'America/Toronto', 'zq_ana');
select tests.ev('Past week', -7, 'America/Toronto', 'zq_ana', 'Le Windsor', 'completed');
select tests.ev('Past month', -30);
select tests.ev('Archived soon', 3, 'America/Toronto', 'zq_old');
update public.events set archived_at = now() where id = tests.id('Archived soon');

-- ===========================================================================
-- Access and safety
-- ===========================================================================
select tests.login_as_anon();
select throws_ok($$ select public.staff_event_list(tests.id('tenant_a')) $$, '42501', null, 'anon cannot list events');
select throws_ok($$ select public.staff_client_list(tests.id('tenant_a')) $$, '42501', null, 'anon cannot list clients');
select throws_ok($$ select public.set_client_archived(tests.id('zq_ana'), true) $$, '42501', null, 'anon cannot archive a client');
select tests.su();
select throws_ok($$ select tests.events(who => 'owner_b') $$, 'P0002', 'not found', 'another business cannot list events');
select throws_ok($$ select tests.events(who => 'client_y') $$, 'P0002', 'not found', 'a client cannot list events');
select throws_ok($$ select tests.archive('zq_ana', true, 'owner_b') $$, 'P0002', 'not found', 'another business cannot archive a client');
select throws_ok($$ select tests.archive('zq_ana', true, 'client_y') $$, 'P0002', 'not found', 'nor can a client');
select throws_like($$ select tests.events('soon') $$, '%list_invalid%', 'an unknown date view is refused');
select throws_like($$ select tests.events(status => 'paid') $$, '%list_invalid%', 'an unknown status is refused');
select throws_like($$ select tests.events(q => repeat('x', 101)) $$, '%list_invalid%', 'an overlong search is refused');
select is((select array_agg(provolatile::text order by proname) from pg_proc where proname in ('staff_event_list', 'staff_client_list')),
  array['s', 's'], 'the lists are STABLE: Postgres refuses any write inside them');

-- ===========================================================================
-- Events: each event's own date, ordering, archived, status, search, pages
-- ===========================================================================
select is(tests.titles(tests.events()), array['Pago Pago today', 'A later', 'B later'],
  'upcoming: today or later in each event''s own time zone, nearest first; archived left out');
select is(tests.titles(tests.events('past')), array['Kiritimati yesterday', 'Past week', 'Past month'],
  'past: before today in the event''s own time zone, most recent first');
select ok((select event_date >= (now() at time zone 'Pacific/Pago_Pago')::date from public.events where id = tests.id('Kiritimati yesterday')),
  '(the Kiritimati event is past there, though its date is today or later in Pago Pago)');
-- The Kiritimati and Pago Pago events share a calendar date at some hours of the day; title breaks the tie.
select is(array_remove(tests.titles(tests.events('all')), 'Kiritimati yesterday'), array['A later', 'B later', 'Pago Pago today', 'Past week', 'Past month'],
  'all: latest date first, then title');
select is((tests.events() ->> 'archived_excluded')::int, 1, 'the archived upcoming event is counted as left out');
select is(tests.titles(tests.events(archived => true)), array['Pago Pago today', 'Archived soon', 'A later', 'B later'], 'include archived reveals it');
select is((select x -> 'archived' from jsonb_array_elements(tests.events(archived => true) -> 'rows') x where x ->> 'title' = 'Archived soon'), 'true'::jsonb,
  'flagged as archived');
select is(tests.titles(tests.events(status => 'booked')), array['B later'], 'status filter');
select is(tests.titles(tests.events('all', 'garcia')), array['A later', 'Pago Pago today', 'Past week'], 'search matches the primary contact''s name, across dates');
select is(tests.titles(tests.events('all', 'RAMEZAY')), array['Pago Pago today'], 'and the venue, case-insensitively');
select is(tests.titles(tests.events('past', 'garcia', 'completed')), array['Past week'], 'search, view and status combine');
select is(tests.titles(tests.events('all', '100%_off')), array['B later'], '% and _ in a search are literal');
select is(tests.titles(tests.events('all', '%%')), '{}'::text[], 'a literal %% matches nothing');
select is(tests.titles(tests.events('all', lim => 2, off => 4)), array['Past week', 'Past month'], 'pages follow the same order');
select is((tests.events('all', lim => 2) ->> 'total')::int, 6, 'the total counts every match, not the page');
select is((select (x ->> 'client_name') || ' · ' || (x ->> 'today') from jsonb_array_elements(tests.events() -> 'rows') x where x ->> 'title' = 'Pago Pago today'),
  'Zq Ana Garcia · ' || (now() at time zone 'Pacific/Pago_Pago')::date, 'rows carry the primary contact and the event''s own today');

-- ===========================================================================
-- Clients
-- ===========================================================================
select is((select array_agg(x ->> 'name' order by o) from jsonb_array_elements(tests.clients('zq') -> 'rows') with ordinality t(x, o)),
  array['Zq Ana Garcia', 'Zq Ben 100%_off'], 'active clients only by default, by name');
select is((tests.clients('zq') ->> 'archived_excluded')::int, 1, 'the archived match is counted as left out');
select is((select array_agg((x ->> 'name') || ':' || (x ->> 'archived') order by o) from jsonb_array_elements(tests.clients('zq', true) -> 'rows') with ordinality t(x, o)),
  array['Zq Ana Garcia:false', 'Zq Ben 100%_off:false', 'Zq Old Lead:true'], 'include archived reveals and flags it');
select is((select x ->> 'name' from jsonb_array_elements(tests.clients('BEN_X@') -> 'rows') x), 'Zq Ben 100%_off', 'search by email, case-insensitively, _ literal');
select is((select (x ->> 'events') || ' · ' || (x -> 'next_event' ->> 'title') from jsonb_array_elements(tests.clients('ana@zq') -> 'rows') x),
  '3 · Pago Pago today', 'each client''s event count and next upcoming event');

-- ===========================================================================
-- Archiving a client
-- ===========================================================================
select set_config('tests.links', (select count(*)::text from public.event_clients where client_id = tests.id('zq_ana')), true);
select is(tests.archive('zq_ana', true) ->> 'status', 'archived', 'staff archive a client');
select set_config('tests.at', (select archived_at::text from public.clients where id = tests.id('zq_ana')), true);
select is(tests.archive('zq_ana', true) ->> 'replayed', 'true', 'a repeat changes nothing');
select is((select archived_at::text from public.clients where id = tests.id('zq_ana')), current_setting('tests.at'), 'and never restamps the archive time');
select is((select count(*)::text from public.event_clients where client_id = tests.id('zq_ana')), current_setting('tests.links'),
  'their event links stay');
select is((select count(*)::int from public.events where id in (tests.id('Pago Pago today'), tests.id('A later'), tests.id('Past week')) and archived_at is null), 3,
  'their events are neither archived nor changed');
select is((select count(*)::int from public.audit_events where entity_type = 'client' and entity_id = tests.id('zq_ana') and action = 'client_archived'), 1,
  'one audit event');
select is(tests.archive('zq_ana', false) ->> 'status', 'active', 'and restore it');
select is((select archived_at from public.clients where id = tests.id('zq_ana')), null, 'archived_at is cleared');
select is((select count(*)::int from public.audit_events where entity_type = 'client' and entity_id = tests.id('zq_ana') and action = 'client_restored'), 1,
  'restoring is audited too');

-- A suspended workspace refuses lists and archiving.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f3000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lists-op@example.test', now(), now(), now());
insert into public.platform_admins (user_id, note) values ('f3000000-0000-4000-8000-000000000001', 'operator');
select tests.login_as('f3000000-0000-4000-8000-000000000001');
select public.suspend_workspace(tests.id('tenant_a'), 0, 'Lists test suspension');
select tests.su();
select throws_ok($$ select tests.events() $$, 'PT423', null, 'a suspended workspace''s events list is refused');
select throws_ok($$ select tests.archive('zq_ben', true) $$, 'PT423', null, 'and so is archiving its clients');

select * from finish();
rollback;
