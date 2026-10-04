-- Contract signing: who may sign, what is checked, the atomic signed state
-- and evidence, idempotent replays, immutability, protected lifecycle paths,
-- revisions blocked by a signed contract, archiving, and access to the
-- stored signature.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(84);

create function tests.send_c(contract uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  return public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;

-- Stands in for the app's verified upload: an object in the contract's folder.
create function tests.put_sig(contract uuid, size int default 4096, mime text default 'image/png') returns text language plpgsql as $$
declare
  v_path text;
begin
  select k.tenant_id || '/' || k.id || '/' || gen_random_uuid() || '.png' into v_path from public.contracts k where k.id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, jsonb_build_object('size', size, 'mimetype', mime));
  return v_path;
end $$;

-- Calls sign_contract as the service role (what the app server does) with
-- valid defaults; o overrides any argument.
create function tests.sign(contract uuid, signer text, o jsonb default '{}') returns jsonb language plpgsql as $$
declare
  v_hash text;
  v_path text;
  r jsonb;
begin
  select content_sha256 into v_hash from public.contracts where id = contract;
  v_path := coalesce(o ->> 'path', tests.put_sig(contract));
  perform set_config('tests.last_sig_path', v_path, true);
  perform tests.login_as_service();
  r := public.sign_contract(
    contract, coalesce(o ->> 'slug', 'test-bouprod'), case when signer is null then null else tests.id(signer) end,
    coalesce(o ->> 'name', 'Client Y Signer'), coalesce(o ->> 'hash', v_hash), coalesce(o ->> 'consent_version', 'demo-v1'),
    coalesce((o ->> 'consent')::boolean, true), v_path, coalesce(o ->> 'sha', repeat('b', 64)),
    coalesce((o ->> 'bytes')::int, 4096), 900, 300, 'Test Browser/1.0', o ->> 'ip', coalesce(o ->> 'ip_source', 'unavailable'));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Setup: a sent DEMO contract for event A2 (signer Client Y, who has access)
-- ===========================================================================
update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections(), 'DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}')::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c(current_setting('tests.c')::uuid);
-- A revision draft opened before signing, to try sending after signing.
select set_config('tests.rev', public.open_proposal_draft(tests.id('event_a2'), tests.base_offer())::text, true);
reset role;
create temp table c_before as
  select rendered_content, commercial_snapshot, party_snapshot, content_sha256, sent_at from public.contracts where id = current_setting('tests.c')::uuid;
grant select on c_before to authenticated, service_role;

-- ===========================================================================
-- Only the service role can call sign_contract
-- ===========================================================================
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.sign_contract(current_setting('tests.c')::uuid, 'test-bouprod', tests.id('client_y'), 'X', repeat('a', 64),
  'demo-v1', true, 'x', repeat('a', 64), 1, 900, 300, null, null, 'unavailable') $$, '42501', null,
  'the signer cannot call sign_contract directly (the server derives identity)');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.sign_contract(current_setting('tests.c')::uuid, 'test-bouprod', tests.id('client_y'), 'X', repeat('a', 64),
  'demo-v1', true, 'x', repeat('a', 64), 1, 900, 300, null, null, 'unavailable') $$, '42501', null, 'nor can staff');
select tests.login_as_anon();
select throws_ok($$ select public.sign_contract(current_setting('tests.c')::uuid, 'test-bouprod', tests.id('client_y'), 'X', repeat('a', 64),
  'demo-v1', true, 'x', repeat('a', 64), 1, 900, 300, null, null, 'unavailable') $$, '42501', null, 'nor anon');
reset role;

-- ===========================================================================
-- Identity and access
-- ===========================================================================
select is(tests.sign(current_setting('tests.c')::uuid, 'client_x') ->> 'code', 'unavailable', 'another client cannot sign');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_u') ->> 'code', 'unavailable', 'a client of another event cannot sign');
select is(tests.sign(current_setting('tests.c')::uuid, 'owner_a') ->> 'code', 'unavailable', 'staff cannot sign for the client');
select is(tests.sign(current_setting('tests.c')::uuid, 'stranger') ->> 'code', 'unavailable', 'a stranger cannot sign');
select is(tests.sign(current_setting('tests.c')::uuid, null) ->> 'code', 'unavailable', 'no identity cannot sign');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"slug":"test-other-dj"}') ->> 'code', 'unavailable',
  'the wrong tenant path cannot sign');
update auth.users set email_confirmed_at = null where id = tests.id('client_y');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y') ->> 'code', 'unavailable', 'an unverified identity cannot sign');
update auth.users set email_confirmed_at = now() where id = tests.id('client_y');
update auth.users set email = 'someone-else@example.test' where id = tests.id('client_y');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y') ->> 'code', 'unavailable', 'an identity whose email no longer matches the frozen signer cannot sign');
update auth.users set email = 'client-y@example.test' where id = tests.id('client_y');
update public.event_access set revoked_at = now() where event_id = tests.id('event_a2') and user_id = tests.id('client_y');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y') ->> 'code', 'unavailable', 'revoked event access cannot sign');
insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id('event_a2'), tests.id('a_client_y'), tests.id('client_y'));
update public.events set archived_at = now() where id = tests.id('event_a2');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y') ->> 'code', 'unavailable', 'an archived event cannot be signed');
update public.events set archived_at = null where id = tests.id('event_a2');

-- ===========================================================================
-- Input checks
-- ===========================================================================
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"consent":false}') ->> 'code', 'consent_required', 'consent must be accepted');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"consent_version":"demo-v0"}') ->> 'code', 'consent_changed', 'only the current consent wording');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', jsonb_build_object('hash', repeat('0', 64))) ->> 'code', 'content_changed',
  'the displayed contract hash must match');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"name":"   "}') ->> 'code', 'name_required', 'a typed name is required');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', jsonb_build_object('name', repeat('n', 201))) ->> 'code', 'name_required', 'names are bounded');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y',
    jsonb_build_object('path', (select tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' from public.contracts where id = current_setting('tests.c')::uuid)))
  ->> 'code', 'signature_invalid', 'a signature that was never stored is rejected');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"bytes":4097}') ->> 'code', 'signature_invalid', 'the stored size must match');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', jsonb_build_object('path', tests.put_sig(current_setting('tests.c')::uuid, 4096, 'image/svg+xml')))
  ->> 'code', 'signature_invalid', 'only a stored PNG is accepted');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"bytes":300000}') ->> 'code', 'signature_invalid', 'oversized signatures are rejected');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"sha":"not-a-hash"}') ->> 'code', 'signature_invalid', 'the image hash must be a SHA-256');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y', jsonb_build_object('path', 'aaaaaaaa-0000-4000-8000-000000000000/' || current_setting('tests.c') || '/' || gen_random_uuid() || '.png'))
  ->> 'code', 'signature_invalid', 'a signature outside this contract''s folder is rejected');
select is((select count(*)::int from public.contract_signatures where contract_id = current_setting('tests.c')::uuid), 0, 'no rejected attempt stored evidence');
select is((select status from public.contracts where id = current_setting('tests.c')::uuid), 'sent', 'and the contract is still sent');
select throws_like($$ update public.contracts set status = 'signed' where id = current_setting('tests.c')::uuid $$,
  '%signed only through sign_contract%', 'privileged code cannot mark a contract signed directly');
select is(private.contract_signing_enabled('{"title":"Services agreement"}'), false, 'signing is limited to DEMO agreements in this stage');

-- ===========================================================================
-- Signing
-- ===========================================================================
select set_config('tests.signed', tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"name":"  Client Y Signer ","ip":"203.0.113.9","ip_source":"vercel"}')::text, true);
select set_config('tests.sig_path', current_setting('tests.last_sig_path'), true);
select is(current_setting('tests.signed')::jsonb ->> 'status', 'signed', 'the signer signs');
select is(current_setting('tests.signed')::jsonb ->> 'replayed', 'false', 'first signature');
select results_eq(
  $$ select c.status, c.signed_at is not null, c.signed_at = s.signed_at, c.sent_at = b.sent_at,
            c.rendered_content = b.rendered_content and c.commercial_snapshot = b.commercial_snapshot
              and c.party_snapshot = b.party_snapshot and c.content_sha256 = b.content_sha256
     from public.contracts c join public.contract_signatures s on s.contract_id = c.id, c_before b
     where c.id = current_setting('tests.c')::uuid $$,
  $$ values ('signed'::text, true, true, true, true) $$,
  'the contract is signed at one database time; content, terms, parties and hash are unchanged');
select results_eq(
  $$ select s.signer_user_id, s.signer_email, s.typed_name, s.signer_client_id, s.content_sha256 = c.content_sha256,
            s.consent_version, s.consent_text = private.contract_signing_consent('demo-v1'), s.signature_path,
            s.signature_sha256, s.signature_bytes, s.user_agent, host(s.client_ip), s.client_ip_source
     from public.contract_signatures s join public.contracts c on c.id = s.contract_id where s.contract_id = current_setting('tests.c')::uuid $$,
  $$ values (tests.id('client_y'), 'client-y@example.test'::text, 'Client Y Signer'::text, tests.id('a_client_y'), true,
             'demo-v1'::text, true, current_setting('tests.sig_path'), repeat('b', 64), 4096, 'Test Browser/1.0'::text,
             '203.0.113.9'::text, 'vercel'::text) $$,
  'evidence: verified identity from Auth, trimmed typed name, frozen hash, exact consent text, stored image and request context');
select results_eq(
  $$ select e.lifecycle_status, e.booking_confirmed_at is null from public.events e where e.id = tests.id('event_a2') $$,
  $$ values ('awaiting_signature'::text, true) $$, 'signing does not book the event');
select lives_ok($$ set constraints public.contracts_signature_consistent, public.contract_signatures_consistent immediate $$,
  'the commit-time consistency checks pass for a real signature (they never run in a rolled-back test otherwise)');
select is((select count(*)::int from public.access_links where contract_id = current_setting('tests.c')::uuid and revoked_at is null), 0,
  'the contract invitation is retired');
select is((select count(*)::int from public.audit_events where entity_id = current_setting('tests.c')::uuid and action = 'signed'), 1, 'one audit event');
select is((select metadata ? 'client_ip' or metadata ? 'user_agent' from public.audit_events
           where entity_id = current_setting('tests.c')::uuid and action = 'signed'), false, 'evidence is kept out of the audit log');

-- Replays and other signers
select set_config('tests.replay', tests.sign(current_setting('tests.c')::uuid, 'client_y', '{"name":"Different Name"}')::text, true);
select is(current_setting('tests.replay')::jsonb ->> 'replayed', 'true', 'a retry by the signer returns the existing signature');
select is(current_setting('tests.replay')::jsonb ->> 'typed_name', 'Client Y Signer', 'with the first signature''s details');
select is((select signature_path from public.contract_signatures where contract_id = current_setting('tests.c')::uuid), current_setting('tests.sig_path'),
  'the first signature is never replaced');
select is((select count(*)::int from public.contract_signatures where contract_id = current_setting('tests.c')::uuid), 1, 'still one signature');
select is((select count(*)::int from public.audit_events where entity_id = current_setting('tests.c')::uuid and action = 'signed'), 1, 'and one audit event');
select is(tests.sign(current_setting('tests.c')::uuid, 'client_x') ->> 'code', 'unavailable', 'another account learns nothing about the signed contract');
select throws_ok(
  format($$ insert into public.contract_signatures (tenant_id, event_id, contract_id, signer_client_id, signer_user_id, signer_email, typed_name,
    signature_path, signature_sha256, signature_bytes, signature_width, signature_height, content_sha256, consent_version, consent_text, client_ip_source)
    select tenant_id, event_id, id, signer_client_id, %L, signer_email, 'Dup', %L, repeat('c', 64), 10, 900, 300, content_sha256, 'demo-v1', 'x', 'unavailable'
    from public.contracts where id = %L $$, tests.id('client_y'), current_setting('tests.last_sig_path'), current_setting('tests.c')),
  '23505', null, 'the database allows one signature per contract');

-- ===========================================================================
-- Immutability and protected lifecycle paths
-- ===========================================================================
select throws_ok($$ update public.contract_signatures set typed_name = 'Changed' where contract_id = current_setting('tests.c')::uuid $$,
  '23514', null, 'evidence cannot be edited, even by privileged code');
select throws_ok($$ delete from public.contract_signatures where contract_id = current_setting('tests.c')::uuid $$,
  '23514', null, 'evidence cannot be deleted');
select throws_ok($$ update public.contracts set rendered_content = '{"title":"x","sections":[]}' where id = current_setting('tests.c')::uuid $$,
  '23514', null, 'signed content cannot change');
select throws_like($$ update public.contracts set status = 'void', void_reason = 'x' where id = current_setting('tests.c')::uuid $$,
  '%cannot move from signed to void%', 'a signed contract cannot be voided directly');
select throws_like($$ update public.contracts set status = 'sent' where id = current_setting('tests.c')::uuid $$,
  '%cannot move from signed to sent%', 'nor moved back to sent');
select throws_ok($$ delete from public.contracts where id = current_setting('tests.c')::uuid $$, '23514', null, 'nor deleted');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.void_contract(current_setting('tests.c')::uuid, 'Changed my mind') $$,
  '%only a sent, unsigned contract can be voided (this one is signed)%', 'the void workflow refuses signed contracts');
select throws_like($$ select tests.send_c(current_setting('tests.c')::uuid) $$, '%contract_not_sendable%', 'it cannot be sent again');
select throws_like($$ select public.resend_contract(current_setting('tests.c')::uuid, gen_random_uuid(), repeat('a', 64)) $$,
  '%only a sent, unsigned contract can be resent%', 'or resent');
select throws_like($$ select public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) $$,
  '%already been sent%', 'or replaced by a regenerated draft');
select is((public.review_contract_for_send(current_setting('tests.c')::uuid)) ->> 'send_unavailable_reason',
  'This contract has been signed. It can no longer be sent, resent or voided.', 'staff review explains the signed state');

-- Revisions are blocked until amendments exist.
select throws_like($$ select tests.send(current_setting('tests.rev')::uuid) $$,
  '%offer_invalid: a contract has been signed for this event%', 'a revision drafted before signing cannot be sent');
reset role;
select results_eq(
  $$ select p.status, e.active_proposal_id = p.id from public.proposals p join public.events e on e.id = p.event_id
     where p.id = (select proposal_id from public.contracts where id = current_setting('tests.c')::uuid) $$,
  $$ values ('approved'::text, true) $$, 'the signed terms stay the current approval');
select throws_like($$ update public.proposals set status = 'superseded'
    where id = (select proposal_id from public.contracts where id = current_setting('tests.c')::uuid) $$,
  '%a contract has been signed for this event%', 'nothing can supersede the signed proposal');
select tests.login_as(tests.id('owner_a'));
select is(public.open_proposal_draft(tests.id('event_a2')), current_setting('tests.rev')::uuid, 'the existing draft can still be opened (read-only use)');
reset role;
select is((select status from public.contracts where id = current_setting('tests.c')::uuid), 'signed', 'the contract is still signed after every refused path');

-- ===========================================================================
-- What the client and staff can read
-- ===========================================================================
select tests.login_as(tests.id('client_y'));
select results_eq(
  $$ select v ->> 'state', v #>> '{contract,status}', v #>> '{signing,signed}', v #>> '{signing,typed_name}',
            (v -> 'signing') ? 'client_ip', (v -> 'signing') ? 'signature_path'
     from (select public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') as v) x $$,
  $$ values ('available'::text, 'signed'::text, 'true'::text, 'Client Y Signer'::text, false, false) $$,
  'the signer reads the signed contract, with the signed name and time but no technical evidence');
select is(public.client_signature_object(current_setting('tests.c')::uuid, 'test-bouprod'), current_setting('tests.sig_path'),
  'the signer may get the stored signature (as a short-lived link from the server)');
select is((select count(*)::int from public.contract_signatures), 0, 'clients cannot read the evidence table');
select is((select count(*)::int from storage.objects where bucket_id = 'contract-signatures'), 0, 'clients cannot read or list the signature bucket');
select is((select status from public.my_contracts() where contract_id = current_setting('tests.c')::uuid), 'signed', 'the client home lists it as signed');
select tests.login_as(tests.id('client_x'));
select is(public.client_signature_object(current_setting('tests.c')::uuid, 'test-bouprod'), null, 'another client gets nothing');
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'and cannot read the contract');
select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.contract_signatures where contract_id = current_setting('tests.c')::uuid), 1, 'staff read the evidence');
select results_eq($$ select name from storage.objects where bucket_id = 'contract-signatures' $$,
  $$ values (current_setting('tests.sig_path')) $$, 'staff can read only committed signatures, never orphan uploads');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.contract_signatures), 0, 'another tenant reads no evidence');
select is((select count(*)::int from storage.objects where bucket_id = 'contract-signatures'), 0, 'and no signature images');
select tests.login_as_anon();
select throws_ok($$ select count(*) from public.contract_signatures $$, '42501', null, 'anon has no access to evidence');
reset role;
select ok((select count(*) from private.contract_signature_orphans) >= 10, 'rejected uploads are listed as orphans for cleanup');
select ok(not exists (select 1 from private.contract_signature_orphans where name = current_setting('tests.sig_path')), 'the committed signature is not an orphan');

-- ===========================================================================
-- Archiving keeps the signed agreement and evidence
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select public.set_event_archived(tests.id('event_a2'), true);
reset role;
select results_eq(
  $$ select c.status, (select count(*)::int from public.contract_signatures s where s.contract_id = c.id)
     from public.contracts c where c.id = current_setting('tests.c')::uuid $$,
  $$ values ('signed'::text, 1) $$, 'archiving keeps the signed contract and its evidence');
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') ->> 'state', 'unavailable', 'archiving hides it from the client');
reset role;
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y') ->> 'code', 'unavailable', 'and a retry no longer returns it');
select tests.login_as(tests.id('owner_a'));
select is((select count(*)::int from public.contract_signatures where contract_id = current_setting('tests.c')::uuid), 1, 'staff still read the evidence');
select public.set_event_archived(tests.id('event_a2'), false);
select tests.login_as(tests.id('client_y'));
select is(public.client_contract_view(current_setting('tests.c')::uuid, 'test-bouprod') #>> '{contract,status}', 'signed', 'unarchiving restores the signer''s read access');
reset role;

-- ===========================================================================
-- Void and superseded contracts cannot be signed (event A1, signer Client X)
-- ===========================================================================
select set_config('tests.a1', tests.approved('event_a1')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.k1', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c(current_setting('tests.k1')::uuid);
select public.void_contract(current_setting('tests.k1')::uuid, 'Wrong date');
reset role;
select is(tests.sign(current_setting('tests.k1')::uuid, 'client_x') ->> 'code', 'unavailable', 'a voided contract cannot be signed');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.k2', public.generate_contract_draft(current_setting('tests.a1')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
select tests.send_c(current_setting('tests.k2')::uuid);
-- A revised offer supersedes the approval and voids the sent contract.
select set_config('tests.rev1', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select tests.send(current_setting('tests.rev1')::uuid);
reset role;
select is((select status from public.contracts where id = current_setting('tests.k2')::uuid), 'void', 'a revised offer voided the unsigned contract');
select is(tests.sign(current_setting('tests.k2')::uuid, 'client_x') ->> 'code', 'unavailable', 'so it cannot be signed');
select is((select count(*)::int from public.contract_signatures where contract_id in (current_setting('tests.k1')::uuid, current_setting('tests.k2')::uuid)), 0,
  'no evidence for refused contracts');

-- ===========================================================================
-- Consistency backstop: a signed contract always has its evidence
-- ===========================================================================
select throws_like(
  format($$ insert into public.contract_signatures (tenant_id, event_id, contract_id, signer_client_id, signer_user_id, signer_email, typed_name,
    signature_path, signature_sha256, signature_bytes, signature_width, signature_height, content_sha256, consent_version, consent_text, client_ip_source)
    select tenant_id, event_id, id, signer_client_id, %L, signer_email, 'Forged', tenant_id || '/' || id || '/' || gen_random_uuid() || '.png',
      repeat('c', 64), 10, 900, 300, content_sha256, 'demo-v1', 'x', 'unavailable'
    from public.contracts where id = %L;
    set constraints public.contract_signatures_consistent immediate $$, tests.id('client_x'), current_setting('tests.k1')),
  '%exactly one signature record%', 'evidence cannot exist for a contract that is not signed (checked at commit)');

select * from finish();
rollback;
