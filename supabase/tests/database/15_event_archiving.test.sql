-- Event archiving: staff-only, tenant-scoped, transactional revocation, and
-- blocks on sending, approving, client sessions and contract generation.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(32);

-- Setup: event A1 is approved and has a contract draft; event A2 has a sent
-- proposal with an open client session.
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.v2', tests.published_version('owner_a', 'tenant_a', tests.simple_sections(), 'Another agreement')::text, true);
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c1', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select set_config('tests.p2', public.open_proposal_draft(tests.id('event_a2'), tests.base_offer())::text, true);
select tests.send(current_setting('tests.p2')::uuid);
select set_config('tests.link2', current_setting('tests.last_link_id'), true);
select tests.login_as_service();
select public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link2')), tests.hex('s-a2'), 'test-bouprod', 3600);
reset role;
create temp table history_before as
  select (select count(*) from public.proposals where event_id = tests.id('event_a1')) proposals,
         (select count(*) from public.proposal_selections s join public.proposals p on p.id = s.proposal_id where p.event_id = tests.id('event_a1')) selections,
         (select count(*) from public.proposal_approvals a join public.proposals p on p.id = a.proposal_id where p.event_id = tests.id('event_a1')) approvals,
         (select md5(string_agg(to_jsonb(c)::text, '' order by c.id)) from public.contracts c where event_id = tests.id('event_a1')) contracts,
         (select count(*) from public.audit_events where tenant_id = tests.id('tenant_a')) audits,
         (select lifecycle_status from public.events where id = tests.id('event_a1')) lifecycle_a1,
         (select lifecycle_status from public.events where id = tests.id('event_a2')) lifecycle_a2;
create temp table access_before as select count(*) n from public.event_access;
grant select on history_before, access_before to authenticated;

-- ===========================================================================
-- Who can archive
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.events set archived_at = now() where id = tests.id('event_a1') $$,
  '42501', null, 'staff cannot set archived_at directly (only through the archiving function)');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.set_event_archived(tests.id('event_a1'), true) $$, 'P0002', 'not found', 'another tenant''s staff cannot archive');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.set_event_archived(tests.id('event_a1'), true) $$, 'P0002', 'not found', 'a client cannot archive, even their own event');
select tests.login_as_anon();
select throws_ok($$ select public.set_event_archived(tests.id('event_a1'), true) $$, '42501', null, 'anon cannot archive');
reset role;
select is((select count(*)::int from public.events where archived_at is not null and tenant_id = tests.id('tenant_a')), 0, 'nothing was archived by them');

-- ===========================================================================
-- Archiving
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select is(public.set_event_archived(tests.id('event_a2'), true) ->> 'links_revoked', '1', 'staff archive an event; its active link is revoked');
select is(public.set_event_archived(tests.id('event_a2'), true) ->> 'replayed', 'true', 'archiving again changes nothing');
select is(public.set_event_archived(tests.id('event_a1'), true) ->> 'status', 'archived', 'an approved event with a contract can be archived');
reset role;
select results_eq(
  $$ select (select count(*)::int from public.access_links l join public.proposals p on p.id = l.proposal_id
             where p.event_id in (tests.id('event_a1'), tests.id('event_a2')) and l.revoked_at is null),
            (select count(*)::int from public.proposal_sessions s join public.proposals p on p.id = s.proposal_id
             where p.event_id in (tests.id('event_a1'), tests.id('event_a2')) and s.revoked_at is null),
            (select count(*)::int from public.email_outbox where entity_id = current_setting('tests.p2')::uuid
             and event_type = 'proposal_sent' and status = 'pending') $$,
  $$ values (0, 0, 0) $$,
  'every link and session of archived events is revoked and pending client emails are cancelled');
select results_eq(
  $$ select h.proposals = (select count(*) from public.proposals where event_id = tests.id('event_a1')),
            h.selections = (select count(*) from public.proposal_selections s join public.proposals p on p.id = s.proposal_id where p.event_id = tests.id('event_a1')),
            h.approvals = (select count(*) from public.proposal_approvals a join public.proposals p on p.id = a.proposal_id where p.event_id = tests.id('event_a1')),
            h.contracts = (select md5(string_agg(to_jsonb(c)::text, '' order by c.id)) from public.contracts c where event_id = tests.id('event_a1')),
            h.lifecycle_a1 = (select lifecycle_status from public.events where id = tests.id('event_a1')),
            h.lifecycle_a2 = (select lifecycle_status from public.events where id = tests.id('event_a2')),
            (select n from access_before) = (select count(*) from public.event_access)
     from history_before h $$,
  $$ values (true, true, true, true, true, true, true) $$,
  'proposals, selections, approvals and contracts are untouched; the lifecycle status is unchanged; no access changes');
select is((select count(*)::int from public.audit_events where tenant_id = tests.id('tenant_a') and entity_type = 'event' and action = 'archived'), 2,
  'each archive is audited once');
select is((select count(*)::int from public.audit_events where tenant_id = tests.id('tenant_a')) - (select audits from history_before)::int, 2,
  'no other audit history was added or removed');
select is((select actor_id from public.audit_events where entity_id = tests.id('event_a2') and action = 'archived'), tests.id('staff_a'),
  'the audit records who archived it');

-- ===========================================================================
-- Blocked while archived
-- ===========================================================================
select tests.login_as_service();
select is(public.client_proposal_view(tests.hex('s-a2'), current_setting('tests.p2')::uuid, 'test-bouprod') ->> 'state', 'invalid',
  'an open client session can no longer view the proposal');
select is(public.client_save_selection_draft(tests.hex('s-a2'), current_setting('tests.p2')::uuid, 'test-bouprod', 0, 'signature', '{}', '{}') ->> 'status',
  'invalid', 'nor save a selection');
select is(public.client_submit_selection(tests.hex('s-a2'), current_setting('tests.p2')::uuid, 'test-bouprod', 0, 'key-after-archive-xx',
  tests.valid_selection(current_setting('tests.p2')::uuid)) ->> 'status', 'invalid', 'nor submit');
select is(public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link2')), tests.hex('s-a2-new'), 'test-bouprod', 3600) ->> 'status',
  'invalid', 'the emailed link no longer opens a session');
reset role;
-- A session that somehow escaped revocation is still refused: the archive check is independent.
update public.events set archived_at = null where id = tests.id('event_a2');
insert into public.proposal_sessions (tenant_id, proposal_id, access_link_id, session_hash, expires_at)
  select tenant_id, proposal_id, id, tests.hex('s-late'), now() + interval '1 hour' from public.access_links where id = current_setting('tests.link2')::uuid;
update public.events set archived_at = now() where id = tests.id('event_a2');
select tests.login_as_service();
select is(public.client_proposal_view(tests.hex('s-late'), current_setting('tests.p2')::uuid, 'test-bouprod') ->> 'state', 'invalid',
  'client sessions of an archived event resolve as invalid regardless of revocation');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p2b', public.open_proposal_draft(tests.id('event_a2'))::text, true);
select throws_like($$ select tests.send(current_setting('tests.p2b')::uuid) $$, '%event_archived%', 'a proposal cannot be sent for an archived event');
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v2')::uuid, null, current_setting('tests.c1')::uuid) $$,
  '%the event is archived%', 'a contract cannot be generated or replaced for an archived event');
reset role;
select throws_like($$ update public.proposals set status = 'approved' where id = current_setting('tests.p2')::uuid $$,
  '%event_archived%', 'a proposal cannot be approved for an archived event, even by privileged code');
select results_eq(
  $$ select status from public.contracts where id = current_setting('tests.c1')::uuid $$, $$ values ('draft'::text) $$,
  'the existing contract draft is kept as it was');

-- ===========================================================================
-- Visibility and isolation
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.events where archived_at is null), 0, 'both tenant A events are now archived');
select is((select count(*)::int from public.proposals where event_id = tests.id('event_a1')), (select proposals from history_before)::int,
  'staff can still read the archived event''s proposals');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.events where archived_at is not null), 0, 'tenant B staff see no archived tenant A events');
select tests.login_as(tests.id('client_x'));
select is((select count(*)::int from public.events), 0, 'clients still have no direct event access');

-- ===========================================================================
-- Unarchiving
-- ===========================================================================
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.set_event_archived(tests.id('event_a2'), false) $$, 'P0002', 'not found', 'another tenant cannot unarchive');
select tests.login_as(tests.id('owner_a'));
select is(public.set_event_archived(tests.id('event_a2'), false) ->> 'status', 'active', 'staff unarchive the event');
reset role;
select results_eq(
  $$ select archived_at is null, (select count(*)::int from public.access_links l where l.proposal_id = current_setting('tests.p2')::uuid and l.revoked_at is null)
     from public.events where id = tests.id('event_a2') $$,
  $$ values (true, 0) $$, 'unarchiving does not resurrect revoked links');
select throws_ok($$ update public.access_links set revoked_at = null where id = current_setting('tests.link2')::uuid $$,
  '23514', null, 'revocation stays one-way');
select tests.login_as(tests.id('owner_a'));
select is(tests.send(current_setting('tests.p2b')::uuid) ->> 'status', 'sent', 'after unarchiving, a revised offer can be sent with a new link');
reset role;
select is((select count(*)::int from public.audit_events where entity_id = tests.id('event_a2') and action = 'unarchived'), 1, 'unarchiving is audited');

select * from finish();
rollback;
