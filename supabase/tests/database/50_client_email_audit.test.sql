-- Client email changes are audited (20261104000100_client_email_audit.sql):
-- one client_email_changed event per real change, in the same transaction,
-- naming the acting staff member and storing neither address. Unchanged
-- saves, other fields, stale versions, retries and anything RLS refuses
-- (a client, another business, removed staff, a suspended workspace)
-- record nothing.
begin;
\ir _fixtures.psql
select plan(17);

create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- Saves as the app does: only the version the form was opened with. Returns rows changed.
create function tests.save(who text, values_ jsonb, expected timestamptz default null) returns int language plpgsql as $$
declare n int;
begin
  perform tests.login_as(tests.id(who));
  update public.clients set
    email = coalesce(values_ ->> 'email', email),
    name = coalesce(values_ ->> 'name', name),
    phone = coalesce(values_ ->> 'phone', phone)
  where id = tests.id('a_client_x') and (expected is null or updated_at = expected);
  get diagnostics n = row_count;
  perform tests.su();
  return n;
end $$;
create function tests.audits() returns int language sql stable as $$
  select count(*)::int from public.audit_events where entity_type = 'client' and entity_id = tests.id('a_client_x') and action = 'client_email_changed';
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select is(tests.audits(), 0, 'no email change recorded yet');

-- An authorized change.
select is(tests.save('staff_a', '{"email": "new-x@example.test"}'), 1, 'staff change the client''s email');
select is(tests.audits(), 1, 'one audit event');
select is((select jsonb_build_array(tenant_id, actor_type, actor_id, metadata ->> 'membership_id')
           from public.audit_events where entity_id = tests.id('a_client_x') and action = 'client_email_changed'),
  jsonb_build_array(tests.id('tenant_a'), 'staff', tests.id('staff_a'),
    (select id from public.tenant_memberships where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a'))::text),
  'it names the business, the acting staff user and their membership');
select ok((select occurred_at is not null and metadata::text not like '%@%' from public.audit_events
           where entity_id = tests.id('a_client_x') and action = 'client_email_changed'),
  'it is timestamped and stores neither address');

-- Not changes.
select is(tests.save('staff_a', '{"name": "Client X renamed", "phone": "514 555-0100"}'), 1, 'other fields change');
select is(tests.save('staff_a', '{"email": "new-x@example.test"}'), 1, 'and the same email is saved again');
select is(tests.audits(), 1, 'neither records an email change');

-- A stale form (the version it was opened with is gone) changes nothing and records nothing.
select is(tests.save('staff_a', '{"email": "stale@example.test"}', now() - interval '1 year'), 0, 'a stale version updates no row');
select is(tests.audits(), 1, 'and records nothing');

-- A retried save: the first applies, the repeat (same email, old version) matches nothing.
-- (The whole test is one transaction, so now() doesn't move: the stored version is put in the past first,
-- as a save made in an earlier request would have left it.)
set local session_replication_role = replica;
update public.clients set updated_at = now() - interval '1 hour' where id = tests.id('a_client_x');
set local session_replication_role = origin;
create temp table v as select updated_at from public.clients where id = tests.id('a_client_x');
grant select on v to authenticated;
select is(tests.save('staff_a', '{"email": "retry@example.test"}', (select updated_at from v)), 1, 'a save applies once');
select is(tests.save('staff_a', '{"email": "retry@example.test"}', (select updated_at from v)), 0, 'its retry matches no row');
select is(tests.audits(), 2, 'one event for the change, none for the retry');

-- Refused by RLS: no row, no event.
select is(tests.save('client_y', '{"email": "client@example.test"}') + tests.save('owner_b', '{"email": "other@example.test"}'), 0,
  'a client and another business change nothing');
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a')
where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select is(tests.save('staff_a', '{"email": "removed@example.test"}'), 0, 'a removed staff member changes nothing');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('f5000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'audit-op@example.test', now(), now(), now());
insert into public.platform_admins (user_id, note) values ('f5000000-0000-4000-8000-000000000001', 'operator');
select tests.login_as('f5000000-0000-4000-8000-000000000001');
select public.suspend_workspace(tests.id('tenant_a'), 0, 'Email audit test suspension');
select tests.su();
select is(tests.save('owner_a', '{"email": "suspended@example.test"}'), 0, 'a suspended workspace changes nothing');
select is(jsonb_build_array(tests.audits(), (select email from public.clients where id = tests.id('a_client_x'))),
  jsonb_build_array(2, 'retry@example.test'), 'no refused attempt was recorded or applied');

select * from finish();
rollback;
