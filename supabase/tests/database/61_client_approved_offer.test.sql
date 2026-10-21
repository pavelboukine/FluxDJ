-- client_approved_offer (6E): the signer, and only the signer, reads the
-- frozen offer and selection their contract was built from; nothing else
-- (another client, staff, another business, revoked access, archived or
-- suspended) learns anything; a newer revision or a catalogue price change
-- never shows; reading changes nothing.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
\ir _contract_fixtures.psql
select plan(26);

create function tests.send_c(contract uuid) returns jsonb language plpgsql as $$
declare v_link uuid := gen_random_uuid();
begin
  return public.send_contract(contract, v_link, encode(sha256(convert_to('invite-' || v_link, 'UTF8')), 'hex'));
end $$;

-- Signs as the service role (what the app server does), as in 20_contract_signing.
create function tests.sign(contract uuid, signer text) returns jsonb language plpgsql as $$
declare
  v_hash text;
  v_path text;
  r jsonb;
begin
  select content_sha256, tenant_id || '/' || id || '/' || gen_random_uuid() || '.png' into v_hash, v_path from public.contracts where id = contract;
  insert into storage.objects (bucket_id, name, metadata) values ('contract-signatures', v_path, '{"size":4096,"mimetype":"image/png"}');
  perform tests.login_as_service();
  r := public.sign_contract(contract, 'test-bouprod', tests.id(signer), 'Client Y Signer', v_hash, 'demo-v1', true, v_path,
    repeat('b', 64), 4096, 900, 300, 'Test Browser/1.0', null, 'unavailable');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

-- What the given user gets back.
create function tests.offer_as(who text, contract uuid, slug text default 'test-bouprod') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.client_approved_offer(contract, slug);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Setup: a sent contract for event A2 (signer Client Y, who has access)
-- ===========================================================================
update public.tenants set business_address = '1 Main St', contact_email = 'legal@bouprod.test' where id = tests.id('tenant_a');
select set_config('tests.v', tests.published_version('owner_a', 'tenant_a', tests.simple_sections(), 'DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}')::text, true);
select set_config('tests.a2', tests.approved('event_a2')::text, true);
select tests.login_as(tests.id('owner_a'));
select set_config('tests.c', public.generate_contract_draft(current_setting('tests.a2')::uuid, current_setting('tests.v')::uuid) ->> 'contract_id', true);
reset role;
create temp table frozen as
  select p.id as proposal_id, p.revision, p.offer_snapshot, p.offer_sha256, s.selection_snapshot, s.version, a.approved_at, c.commercial_snapshot
  from public.contracts c
  join public.proposals p on p.id = c.proposal_id
  join public.proposal_selections s on s.id = c.selection_id
  join public.proposal_approvals a on a.id = c.approval_id
  where c.id = current_setting('tests.c')::uuid;
grant select on frozen to authenticated, service_role;

-- ===========================================================================
-- Before sending: a draft contract is nobody's to read
-- ===========================================================================
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'state', 'unavailable', 'a draft contract shows nothing');

select tests.login_as(tests.id('owner_a'));
select tests.send_c(current_setting('tests.c')::uuid);
reset role;

-- ===========================================================================
-- The signer reads the exact frozen offer, selection and approval
-- ===========================================================================
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'state', 'available', 'the signer reads the approved offer of a sent contract');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'proposal' -> 'offer', (select offer_snapshot from frozen), 'the offer is the contract''s own frozen snapshot');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'selection' -> 'priced', (select selection_snapshot from frozen),
  'the selection is the approved one, unchanged (packages, add-ons, requirements, any discount, prices)');
select is((tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'approved_at')::timestamptz, (select approved_at from frozen), 'with its approval time');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'agreed' -> 'total_cents', (select commercial_snapshot -> 'total_cents' from frozen),
  'the agreed total is the contract''s frozen total');
select is((tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'agreed' ->> 'total_cents')::int, 252945, 'which is the approved price');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'event_id', tests.id('event_a2')::text, 'it names the contract''s event');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'agreed' -> 'discount', 'null'::jsonb, 'no discount appears where none was agreed');

-- ===========================================================================
-- Nobody else learns anything, and the answer never says whether it exists
-- ===========================================================================
select is(tests.offer_as('client_x', current_setting('tests.c')::uuid), '{"state":"unavailable"}'::jsonb, 'another client of the business gets nothing');
select is(tests.offer_as('owner_a', current_setting('tests.c')::uuid), '{"state":"unavailable"}'::jsonb, 'staff use their own views, not this one');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid, 'test-other-dj'), '{"state":"unavailable"}'::jsonb, 'another business''s address gets nothing');
select is(tests.offer_as('client_y', gen_random_uuid()), '{"state":"unavailable"}'::jsonb, 'an unknown contract gets the same answer');
select tests.login_as_anon();
select throws_ok($$ select public.client_approved_offer(current_setting('tests.c')::uuid, 'test-bouprod') $$, '42501', null, 'anonymous visitors cannot call it');
reset role;
-- A client who has access to the event but isn't the signer.
insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id('event_a2'), tests.id('a_client_x'), false, false);
insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id('event_a2'), tests.id('a_client_x'), tests.id('client_x'));
select is(tests.offer_as('client_x', current_setting('tests.c')::uuid) ->> 'state', 'unavailable', 'an event participant who isn''t the signer gets nothing');

-- ===========================================================================
-- Revoked access, unverified email, archived and suspended
-- ===========================================================================
update public.event_access set revoked_at = now() where event_id = tests.id('event_a2') and user_id = tests.id('client_y') and revoked_at is null;
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'state', 'unavailable', 'revoked event access gets nothing');
insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id('event_a2'), tests.id('a_client_y'), tests.id('client_y'));
update auth.users set email_confirmed_at = null where id = tests.id('client_y');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'state', 'unavailable', 'an unverified identity gets nothing');
update auth.users set email_confirmed_at = now() where id = tests.id('client_y');
update public.events set archived_at = now() where id = tests.id('event_a2');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'state', 'unavailable', 'an archived event shows nothing');
update public.events set archived_at = null where id = tests.id('event_a2');
-- Suspension normally goes through suspend_workspace (platform admins); set directly in this rolled-back test.
alter table public.tenants disable trigger user;
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'state', 'unavailable', 'a suspended business shows nothing');
update public.tenants set suspended_at = null where id = tests.id('tenant_a');
alter table public.tenants enable trigger user;
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) ->> 'state', 'available', 'restored access reads it again');

-- ===========================================================================
-- Signed: still the approved revision, whatever happens later
-- ===========================================================================
-- A newer revision drafted before signing (revisions are blocked once signed).
select tests.login_as(tests.id('owner_a'));
select set_config('tests.rev', public.open_proposal_draft(tests.id('event_a2'), tests.base_offer())::text, true);
reset role;
select is(tests.sign(current_setting('tests.c')::uuid, 'client_y') ->> 'status', 'signed', 'the signer signs');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'contract' ->> 'status', 'signed', 'a signed contract''s offer stays readable');
-- The catalogue repriced afterwards.
update public.packages set base_price_cents = base_price_cents * 3 where tenant_id = tests.id('tenant_a');
update public.gear_items set default_price_cents = default_price_cents * 3 where tenant_id = tests.id('tenant_a');
select is((tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'proposal' ->> 'revision')::int, (select revision from frozen),
  'a newer revision never replaces the approved one');
select is(tests.offer_as('client_y', current_setting('tests.c')::uuid) -> 'selection' -> 'priced', (select selection_snapshot from frozen),
  'catalogue price changes never reach the agreed selection');

-- ===========================================================================
-- Reading changes nothing
-- ===========================================================================
select is((select offer_sha256 from public.proposals where id = (select proposal_id from frozen)), (select offer_sha256 from frozen), 'the offer is untouched');
select is((select commercial_snapshot from public.contracts where id = current_setting('tests.c')::uuid), (select commercial_snapshot from frozen),
  'the contract''s frozen terms are untouched');

select * from finish();
rollback;
