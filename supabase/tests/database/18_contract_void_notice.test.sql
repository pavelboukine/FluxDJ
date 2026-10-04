-- The void notice: one per voided sent contract, staff or revised-offer
-- voids only, never for archiving, and without the internal reason.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(14);

create function tests.send_c(contract text) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  return public.send_contract(current_setting(contract)::uuid, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;
create function tests.notices(contract text) returns int language sql stable as $$
  select count(*)::int from public.email_outbox where entity_id = current_setting(contract)::uuid and event_type = 'contract_voided' $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c('tests.c');
reset role;
create temp table identity_before as
  select (select count(*) from public.tenant_memberships) memberships, (select count(*) from auth.users) users,
         (select md5(string_agg(to_jsonb(ea)::text, '' order by ea.id)) from public.event_access ea) access,
         (select md5(string_agg(to_jsonb(e)::text, '' order by e.id)) from public.events e where e.id <> tests.id('event_a2')) other_events;

-- Staff void: exactly one notice, queued with the void.
select tests.login_as(tests.id('owner_a'));
select public.void_contract(current_setting('tests.c')::uuid, 'Internal: client never paid last time');
select public.void_contract(current_setting('tests.c')::uuid, 'Internal: client never paid last time');
reset role;
select is(tests.notices('tests.c'), 1, 'a staff void queues exactly one notice, and repeating the void queues none');
select results_eq(
  $$ select recipient_email, status, access_link_id is null, dedup_key, payload::text !~ 'Internal|reason'
     from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_voided' $$,
  $$ values ('client-y@example.test'::text, 'pending'::text, true, 'contract_voided:' || current_setting('tests.c'), true) $$,
  'to the frozen signer, with no link, a per-contract dedup key, and no internal reason');
select is((select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type <> 'contract_voided' and status = 'pending'), 0,
  'the obsolete invitation email is cancelled, not delivered');
select results_eq(
  $$ select (select count(*) from public.tenant_memberships) = memberships, (select count(*) from auth.users) = users,
            (select md5(string_agg(to_jsonb(ea)::text, '' order by ea.id)) from public.event_access ea) = access,
            (select md5(string_agg(to_jsonb(e)::text, '' order by e.id)) from public.events e where e.id <> tests.id('event_a2')) = other_events
     from identity_before $$,
  $$ values (true, true, true, true) $$,
  'voiding changes no staff memberships, Auth identities, event access or other events');

-- Dispatch: the notice stays deliverable while the contract is void.
select tests.login_as_service();
select results_eq(
  $$ select contract_deliverable, access_link_id is null from public.claim_email_outbox(20, 60, tests.id('tenant_a'))
     where event_type = 'contract_voided' $$,
  $$ values (true, true) $$, 'the worker may deliver the notice');
reset role;
update public.email_outbox set status = 'pending', locked_until = null where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_voided';

-- Archiving never sends or cancels a notice.
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a2'), true);
reset role;
select is((select status from public.email_outbox where entity_id = current_setting('tests.c')::uuid and event_type = 'contract_voided'), 'pending',
  'archiving the event does not cancel an already queued notice');
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a2'), false);
reset role;
select is((select count(*)::int from public.email_outbox where event_type = 'contract_voided' and tenant_id = tests.id('tenant_a')), 1, 'nor queue another');

-- A replacement contract voided automatically by a revised offer is notified once.
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c2', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c('tests.c2');
select tests.send(public.open_proposal_draft(tests.id('event_a2')));
reset role;
select is((select status from public.contracts where id = current_setting('tests.c2')::uuid), 'void', 'a revised offer voids the sent contract');
select is(tests.notices('tests.c2'), 1, 'and queues one notice');
select ok((select payload::text from public.email_outbox where entity_id = current_setting('tests.c2')::uuid and event_type = 'contract_voided') !~ 'revised offer|reason',
  'without the internal reason');

-- Archiving a sent contract's event (no void) queues no notice.
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c3', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c('tests.c3');
select public.set_event_archived(tests.id('event_a1'), true);
reset role;
select is((select status from public.contracts where id = current_setting('tests.c3')::uuid), 'sent', 'archiving does not void');
select is(tests.notices('tests.c3'), 0, 'so no void notice is queued');

-- Drafts that are replaced or superseded are not notified (never sent).
select is((select count(*)::int from public.email_outbox o join public.contracts k on k.id = o.entity_id
           where o.event_type = 'contract_voided' and k.sent_at is null), 0, 'unsent drafts never produce notices');
select tests.login_as(tests.id('staff_a'));
select is((select count(*)::int from public.email_outbox where event_type = 'contract_voided'), 2, 'staff can see the queued notices for their tenant');

select * from finish();
rollback;
