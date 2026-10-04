-- Contract sending, invitations, verified client access, resend, void,
-- replacement, archiving and superseding.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(81);

-- Raw invitation token in tests: 'invite-' || link id (the app uses an HMAC).
create function tests.send_c(contract text, fn text default 'send_contract') returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  perform set_config('tests.last_contract_link', v_link::text, true);
  if fn = 'resend_contract' then
    return public.resend_contract(current_setting(contract)::uuid, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
  end if;
  return public.send_contract(current_setting(contract)::uuid, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;
create function tests.invite_hash(link text) returns text language sql stable as $$
  select encode(sha256(convert_to('invite-' || current_setting(link), 'UTF8')), 'hex') $$;
-- Pretend an invitation was created long ago (created_at is otherwise immutable).
create function tests.age_invitations(contract text) returns void language plpgsql as $$
begin
  alter table public.access_links disable trigger access_links_immutable;
  update public.access_links set created_at = created_at - interval '1 hour' where contract_id = current_setting(contract)::uuid;
  alter table public.access_links enable trigger access_links_immutable;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Setup: complete business identity, an approved event A2 with a contract
-- draft, and Client Y's fixture access to A2 removed so access is granted
-- only by the invitation flow.
update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');
update public.event_access set revoked_at = now() where event_id = tests.id('event_a2') and revoked_at is null;
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections())::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
reset role;
create temp table c_before as select rendered_content, commercial_snapshot, party_snapshot, content_sha256 from public.contracts where id = current_setting('tests.c')::uuid;
grant select on c_before to authenticated;

-- ===========================================================================
-- Sending
-- ===========================================================================
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select tests.send_c('tests.c') $$, 'P0002', 'not found', 'another tenant cannot send');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select tests.send_c('tests.c') $$, 'P0002', 'not found', 'the client cannot send');
select tests.login_as_anon();
select throws_ok($$ select public.send_contract(gen_random_uuid(), gen_random_uuid(), repeat('a', 64)) $$, '42501', null, 'anon cannot send');
reset role;
update public.clients set name = 'Client Y Renamed' where id = tests.id('a_client_y');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.send_c('tests.c') $$, '%The event''s signer is now Client Y Renamed%Regenerate%', 'a changed signer blocks sending');
reset role;
update public.clients set name = 'Client Y (A)' where id = tests.id('a_client_y');
update public.events set archived_at = now() where id = tests.id('event_a2');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.send_c('tests.c') $$, '%event is archived%', 'an archived event blocks sending');
reset role;
update public.events set archived_at = null where id = tests.id('event_a2');

select tests.login_as(tests.id('staff_a'));
select set_config('tests.sent', tests.send_c('tests.c')::text, true);
select set_config('tests.link1', current_setting('tests.last_contract_link'), true);
select is(current_setting('tests.sent')::jsonb ->> 'recipient_email', 'client-y@example.test', 'staff send to the frozen signer');
select is(tests.send_c('tests.c') ->> 'replayed', 'true', 'sending again returns the existing result');
reset role;
select results_eq(
  $$ select c.status, c.sent_at is not null, c.rendered_content = b.rendered_content and c.commercial_snapshot = b.commercial_snapshot
              and c.party_snapshot = b.party_snapshot and c.content_sha256 = b.content_sha256,
            e.lifecycle_status, e.booking_confirmed_at is null
     from public.contracts c, c_before b, public.events e where c.id = current_setting('tests.c')::uuid and e.id = c.event_id $$,
  $$ values ('sent'::text, true, true, 'awaiting_signature'::text, true) $$,
  'the contract is sent with unchanged content and hash; the event awaits signature and is not booked');
select results_eq(
  $$ select count(*)::int, bool_and(l.contract_id = current_setting('tests.c')::uuid), bool_and(l.intended_client_id = tests.id('a_client_y')),
            bool_and(l.expires_at between now() + interval '13 days' and now() + interval '15 days'),
            bool_and(l.token_hash = tests.invite_hash('tests.link1'))
     from public.access_links l where l.purpose = 'contract' and l.tenant_id = tests.id('tenant_a') $$,
  $$ values (1, true, true, true, true) $$,
  'one expiring invitation scoped to the contract and frozen signer; repeats created none (only its hash is stored)');
select results_eq(
  $$ select count(*)::int, min(recipient_email), min(access_link_id::text), bool_and(payload::text !~ tests.invite_hash('tests.link1'))
     from public.email_outbox where entity_type = 'contract' and event_type = 'contract_sent' and tenant_id = tests.id('tenant_a') $$,
  $$ values (1, 'client-y@example.test'::text, current_setting('tests.link1'), true) $$,
  'exactly one contract email is queued, holding no token');
select is((select count(*)::int from public.audit_events where entity_id = current_setting('tests.c')::uuid and action = 'sent'), 1, 'sending is audited once');
select throws_ok($$ update public.contracts set sent_at = now() + interval '1 day' where id = current_setting('tests.c')::uuid $$, '23514', null, 'the original sent_at never changes');
select throws_ok($$ update public.contracts set rendered_content = '{"schema_version":1,"title":"x","sections":[]}' where id = current_setting('tests.c')::uuid $$,
  '23514', null, 'sent content stays frozen');

-- Only send_contract can send; generation is blocked while a contract is sent.
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c_a1', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) $$,
  '%already been sent for this event%', 'no new draft while a contract is sent');
reset role;
select throws_like($$ update public.contracts set status = 'sent' where id = current_setting('tests.c_a1')::uuid $$,
  '%only through send_contract%', 'even privileged code cannot mark a contract sent directly');

-- ===========================================================================
-- Requesting a verification email (invitation token)
-- ===========================================================================
select tests.login_as_anon();
select throws_ok($$ select public.request_contract_sign_in(repeat('a', 64), 'test-bouprod') $$, '42501', null, 'anon cannot call it directly');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.request_contract_sign_in(repeat('a', 64), 'test-bouprod') $$, '42501', null, 'nor can authenticated users');
select tests.login_as_service();
select is(public.request_contract_sign_in(repeat('a', 64), 'test-bouprod') ->> 'status', 'invalid', 'an unknown token is invalid');
select is(public.request_contract_sign_in(tests.invite_hash('tests.link1'), 'test-other-dj') ->> 'status', 'invalid', 'a token only works under its tenant');
select is(public.request_contract_sign_in(tests.invite_hash('tests.link1'), 'test-bouprod'),
  '{"status":"ok","masked_email":"c•••@example.test","tenant_display_name":"BOUPROD"}'::jsonb, 'a valid token queues a verification email to the masked signer address');
select is(public.request_contract_sign_in(tests.invite_hash('tests.link1'), 'test-bouprod') ->> 'status', 'ok', 'a second request');
select is(public.request_contract_sign_in(tests.invite_hash('tests.link1'), 'test-bouprod') ->> 'status', 'ok', 'a third request');
select is(public.request_contract_sign_in(tests.invite_hash('tests.link1'), 'test-bouprod') ->> 'status', 'rate_limited', 'a fourth within 15 minutes is refused');
reset role;
select results_eq(
  $$ select count(*)::int, min(recipient_email) from public.email_outbox where event_type = 'contract_sign_in' and tenant_id = tests.id('tenant_a') $$,
  $$ values (3, 'client-y@example.test'::text) $$, 'three verification emails are queued, only to the frozen signer');
select is((select count(*)::int from public.event_access where event_id = tests.id('event_a2') and revoked_at is null), 0,
  'requesting emails grants nothing');

-- ===========================================================================
-- Verified acceptance
-- ===========================================================================
select tests.login_as(tests.id('client_x'));
select is(public.client_invitation_status(current_setting('tests.link1')::uuid, 'test-bouprod'),
  '{"state":"wrong_account","signed_in_email":"client-x@example.test","intended_email":"c•••@example.test","tenant_display_name":"BOUPROD"}'::jsonb,
  'a verified user with another email sees only that it is the wrong account (no event details)');
select is(public.accept_contract_invitation(current_setting('tests.link1')::uuid, 'test-bouprod') ->> 'state', 'wrong_account', 'and cannot accept');
select tests.login_as(tests.id('client_u'));
select is(public.accept_contract_invitation(current_setting('tests.link1')::uuid, 'test-bouprod') ->> 'state', 'unverified', 'an unverified identity cannot accept');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'the signer cannot read before accepting');
select is(public.client_invitation_status(current_setting('tests.link1')::uuid, 'test-bouprod') ->> 'state', 'ready', 'the verified signer is ready to accept');
select is(public.accept_contract_invitation(current_setting('tests.link1')::uuid, 'test-other-dj') ->> 'state', 'invalid', 'not under another tenant');
select is(public.accept_contract_invitation(current_setting('tests.link1')::uuid, 'test-bouprod') ->> 'state', 'accepted', 'the verified signer accepts');
select is(public.accept_contract_invitation(current_setting('tests.link1')::uuid, 'test-bouprod') ->> 'state', 'accepted', 'accepting again is harmless');
reset role;
select results_eq(
  $$ select count(*)::int, min(client_id::text), min(user_id::text) from public.event_access where event_id = tests.id('event_a2') and revoked_at is null $$,
  $$ values (1, tests.id('a_client_y')::text, tests.id('client_y')::text) $$,
  'exactly one access grant, to the exact event, client and verified user');
select results_eq(
  $$ select (select consumed_at is not null from public.access_links where id = current_setting('tests.link1')::uuid),
            (select count(*)::int from public.audit_events where entity_id = tests.id('event_a2') and action = 'client_access_granted'),
            (select count(*)::int from public.tenant_memberships where user_id = tests.id('client_y')) $$,
  $$ values (true, 1, 0) $$, 'the invitation is marked used, the grant audited once, and no staff membership exists');

-- ===========================================================================
-- Reading
-- ===========================================================================
select tests.login_as(tests.id('client_y'));
select set_config('tests.view', public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod')::text, true);
select is(current_setting('tests.view')::jsonb ->> 'state', 'available', 'the signer reads the sent contract');
select is((current_setting('tests.view')::jsonb -> 'contract' ->> 'content_sha256'), (select content_sha256 from c_before), 'exactly the frozen contract');
select ok(current_setting('tests.view') !~ 'secret staff note|tenant_id|internal_notes|client-x@|token_hash|approval_id|selection_id',
  'the view leaks no internal notes, ids of other records, other contacts or tokens');
select is((select array_agg(k order by k) from jsonb_object_keys(current_setting('tests.view')::jsonb -> 'contract') k),
  array['balance_cents', 'balance_due_date', 'content_sha256', 'currency', 'deposit_cents', 'deposit_percent', 'event_date', 'event_title',
        'id', 'legal_name', 'rendered_content', 'sent_at', 'signer_name', 'status', 'total_cents'],
  'the contract DTO has exactly the intended fields');
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-other-dj') ->> 'state', 'unavailable', 'not under another tenant slug');
select is((select count(*)::int from public.my_contracts()), 1, 'the client home lists it');
select is((select count(*)::int from public.contracts), 0, 'direct table reads still return nothing to clients');
select is((select count(*)::int from public.events), 0, 'nor events');
select tests.login_as(tests.id('client_x'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable',
  'a client of other events at this and another DJ cannot read it');
select is((select count(*)::int from public.my_contracts()), 0, 'and does not see it listed');
select tests.login_as(tests.id('owner_b'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'another tenant''s staff cannot read it as a client');
select tests.login_as_anon();
select throws_ok($$ select public.client_contract_view(gen_random_uuid(), 'test-bouprod') $$, '42501', null, 'anon cannot call the client view');
select throws_ok($$ select * from public.contracts $$, '42501', null, 'anon cannot read contracts');

-- ===========================================================================
-- Outbox: contract emails are rechecked at dispatch
-- ===========================================================================
reset role;
update public.email_outbox set status = 'cancelled' where entity_type = 'contract' and event_type = 'contract_sign_in' and tenant_id = tests.id('tenant_a');
select tests.login_as_service();
select results_eq(
  $$ select event_type, contract_deliverable, contract_id = current_setting('tests.c')::uuid, link_token_hash = tests.invite_hash('tests.link1')
     from public.claim_email_outbox(10, 60, tests.id('tenant_a')) where event_type like 'contract%' $$,
  $$ values ('contract_sent'::text, true, true, true) $$,
  'a claimed contract email is deliverable while the contract and invitation are current');

-- ===========================================================================
-- Resend
-- ===========================================================================
reset role;
select tests.login_as_service();
select public.request_contract_sign_in(tests.invite_hash('tests.link1'), 'test-bouprod');
reset role;
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.send_c('tests.c', 'resend_contract') $$, '%sent very recently%', 'resending is rate limited');
reset role;
select tests.age_invitations('tests.c');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.resent', tests.send_c('tests.c', 'resend_contract')::text, true);
select set_config('tests.link2', current_setting('tests.last_contract_link'), true);
reset role;
select results_eq(
  $$ select (select revoked_at is not null from public.access_links where id = current_setting('tests.link1')::uuid),
            (select revoked_at is null from public.access_links where id = current_setting('tests.link2')::uuid),
            (select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c')::uuid and status = 'pending'),
            (select min(access_link_id::text) from public.email_outbox where entity_id = current_setting('tests.c')::uuid and status = 'pending'),
            (select sent_at from public.contracts where id = current_setting('tests.c')::uuid) = (current_setting('tests.sent')::jsonb ->> 'sent_at')::timestamptz,
            (select content_sha256 from public.contracts where id = current_setting('tests.c')::uuid) = (select content_sha256 from c_before),
            (select count(*)::int from public.event_access where event_id = tests.id('event_a2') and revoked_at is null),
            (select count(*)::int from public.audit_events where entity_id = current_setting('tests.c')::uuid and action = 'resent') $$,
  $$ values (true, true, 1, current_setting('tests.link2'), true, true, 1, 1) $$,
  'resend: old invitation revoked, obsolete pending emails cancelled, one new email; sent_at, content and access kept; audited');
select tests.login_as_service();
select is(public.request_contract_sign_in(tests.invite_hash('tests.link1'), 'test-bouprod') ->> 'status', 'invalid', 'the old invitation no longer works');
select is(public.request_contract_sign_in(tests.invite_hash('tests.link2'), 'test-bouprod') ->> 'status', 'ok', 'the new one does');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'available', 'the already verified client can still read it');

-- ===========================================================================
-- Void and replacement
-- ===========================================================================
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.void_contract(current_setting('tests.c')::uuid, 'x') $$, 'P0002', 'not found', 'another tenant cannot void');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.void_contract(current_setting('tests.c')::uuid, '  ') $$, '%give a reason%', 'a reason is required');
select throws_like($$ select public.void_contract(current_setting('tests.c_a1')::uuid, 'x') $$, '%only a sent, unsigned contract%', 'drafts are replaced, not voided');
select is(public.void_contract(current_setting('tests.c')::uuid, 'Wrong venue') ->> 'status', 'void', 'staff void the sent contract');
select is(public.void_contract(current_setting('tests.c')::uuid, 'Wrong venue') ->> 'replayed', 'true', 'voiding again changes nothing');
select throws_like($$ select tests.send_c('tests.c', 'resend_contract') $$, '%only a sent, unsigned contract can be resent%', 'a void contract cannot be resent');
reset role;
select results_eq(
  $$ select c.status, c.void_reason, c.voided_at is not null, c.sent_at is not null, c.content_sha256 = b.content_sha256,
            (select count(*)::int from public.access_links where contract_id = c.id and revoked_at is null),
            (select count(*)::int from public.email_outbox where entity_id = c.id and status = 'pending' and event_type <> 'contract_voided'),
            (select count(*)::int from public.event_access where revoked_at is null and user_id = tests.id('client_y')),
            (select count(*)::int from public.event_access where revoked_at is null and user_id = tests.id('client_x'))
     from public.contracts c, c_before b where c.id = current_setting('tests.c')::uuid $$,
  $$ values ('void'::text, 'Wrong venue'::text, true, true, true, 0, 0, 1, 2) $$,
  'void keeps content and history, revokes invitations and cancels emails; event access and other clients are untouched');
select throws_ok($$ update public.contracts set status = 'sent' where id = current_setting('tests.c')::uuid $$, '23514', null, 'a void contract cannot be revived');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'an authenticated client can no longer read a void contract');
select is((select count(*)::int from public.my_contracts()), 0, 'nor see it listed');
select tests.login_as_service();
select is(public.request_contract_sign_in(tests.invite_hash('tests.link2'), 'test-bouprod') ->> 'status', 'invalid', 'its invitation is dead');

select tests.login_as(tests.id('owner_a'));
select set_config('tests.c2', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select ok(current_setting('tests.c2') is not null and current_setting('tests.c2') <> current_setting('tests.c'), 'a replacement draft is generated after voiding');
select is(tests.send_c('tests.c2') ->> 'status', 'sent', 'and sent');
select set_config('tests.link3', current_setting('tests.last_contract_link'), true);
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c2')::uuid, 'test-bouprod') ->> 'state', 'available', 'the already verified client reads the replacement');

-- ===========================================================================
-- Archiving
-- ===========================================================================
select tests.login_as_service();
select public.request_contract_sign_in(tests.invite_hash('tests.link3'), 'test-bouprod');
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a2'), true);
reset role;
select results_eq(
  $$ select (select count(*)::int from public.access_links where contract_id = current_setting('tests.c2')::uuid and revoked_at is null),
            (select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c2')::uuid and status = 'pending') $$,
  $$ values (0, 0) $$, 'archiving revokes contract invitations and cancels pending contract emails');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c2')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'clients cannot read contracts of archived events');
select is(public.accept_contract_invitation(current_setting('tests.link3')::uuid, 'test-bouprod') ->> 'state', 'invalid', 'nor accept invitations');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select tests.send_c('tests.c2', 'resend_contract') $$, '%event is archived%', 'nor can staff resend while archived');
select public.set_event_archived(tests.id('event_a2'), false);
reset role;
select is((select count(*)::int from public.access_links where contract_id = current_setting('tests.c2')::uuid and revoked_at is null), 0,
  'unarchiving does not revive invitations');
select tests.login_as_service();
select is(public.request_contract_sign_in(tests.invite_hash('tests.link3'), 'test-bouprod') ->> 'status', 'invalid', 'the old invitation stays dead');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c2')::uuid, 'test-bouprod') ->> 'state', 'available',
  'access that was already verified works again once unarchived');

-- Dispatch rechecks: a pending email whose invitation was revoked is not deliverable.
reset role;
select tests.age_invitations('tests.c2');
select tests.login_as(tests.id('owner_a'));
select tests.send_c('tests.c2', 'resend_contract');
reset role;
update public.access_links set revoked_at = now() where contract_id = current_setting('tests.c2')::uuid and revoked_at is null;
select tests.login_as_service();
select results_eq(
  $$ select bool_and(not contract_deliverable) from public.claim_email_outbox(10, 60, tests.id('tenant_a')) where event_type in ('contract_sent', 'contract_sign_in') $$,
  $$ values (true) $$, 'a contract email whose invitation was revoked after queueing is not deliverable at dispatch');

-- ===========================================================================
-- A revised offer voids the sent contract
-- ===========================================================================
reset role;
select tests.age_invitations('tests.c2');
select tests.login_as(tests.id('owner_a'));
select tests.send_c('tests.c2', 'resend_contract');
select tests.send(public.open_proposal_draft(tests.id('event_a2')));
reset role;
select results_eq(
  $$ select status, void_reason, (select count(*)::int from public.access_links where contract_id = current_setting('tests.c2')::uuid and revoked_at is null),
            (select count(*)::int from public.email_outbox where entity_id = current_setting('tests.c2')::uuid and status = 'pending' and event_type <> 'contract_voided')
     from public.contracts where id = current_setting('tests.c2')::uuid $$,
  $$ values ('void'::text, 'A revised offer replaced the approved terms.'::text, 0, 0) $$,
  'sending a revised offer voids the sent contract and retires its invitation and emails');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c2')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'and the client can no longer read it');
reset role;
select is((select count(*)::int from public.contracts where status = 'signed' and tenant_id = tests.id('tenant_a')), 0, 'nothing is ever signed in this stage');

-- Expired invitations: the replacement contract's link, made to look expired.
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c3', public.generate_contract_draft(
  (select a.id::text from public.proposal_approvals a join public.proposals p on p.id = a.proposal_id where p.event_id = tests.id('event_a1'))::uuid,
  current_setting('tests.v')::uuid, null, current_setting('tests.c_a1')::uuid) ->> 'contract_id', true);
select tests.send_c('tests.c_a1');
select set_config('tests.link4', current_setting('tests.last_contract_link'), true);
reset role;
alter table public.access_links disable trigger access_links_immutable;
update public.access_links set expires_at = now() - interval '1 minute' where id = current_setting('tests.link4')::uuid;
alter table public.access_links enable trigger access_links_immutable;
select tests.login_as_service();
select is(public.request_contract_sign_in(tests.invite_hash('tests.link4'), 'test-bouprod') ->> 'status', 'invalid', 'an expired invitation cannot request emails');
select tests.login_as(tests.id('client_x'));
select is(public.accept_contract_invitation(current_setting('tests.link4')::uuid, 'test-bouprod') ->> 'state', 'invalid', 'nor be accepted, even by the intended signer');

select * from finish();
rollback;
