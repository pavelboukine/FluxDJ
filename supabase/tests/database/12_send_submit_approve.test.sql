-- Step 6: sending, public proposal sessions, submission, approval, the email
-- outbox and rate limits, through the real functions and roles.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(82);

update public.tenants set tax_categories = '{"standard":["GST","QST"]}' where id = tests.id('tenant_a');

create function tests.hex(value text) returns text language sql immutable as $$
  select encode(sha256(convert_to(value, 'UTF8')), 'hex') $$;
create function tests.offer_sha(pid uuid) returns text language sql stable as $$
  select offer_sha256 from public.proposals where id = pid $$;
create function tests.selection(pid uuid, package text, answers jsonb, addons jsonb, lines jsonb,
                                subtotal bigint, gst bigint, qst bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'pricing_version', 'flux-pricing-1', 'currency', 'CAD', 'package_key', package,
    'addon_quantities', addons, 'logistics_answers', answers, 'requirements', '[]'::jsonb, 'lines', lines,
    'subtotal_cents', subtotal,
    'tax_breakdown', jsonb_build_array(
      jsonb_build_object('code','GST','label','GST','rate_ppm',50000,'taxable_cents',subtotal,'amount_cents',gst),
      jsonb_build_object('code','QST','label','QST','rate_ppm',99750,'taxable_cents',subtotal,'amount_cents',qst)),
    'tax_cents', gst + qst, 'total_cents', subtotal + gst + qst, 'offer_sha256', tests.offer_sha(pid));
$$;
create function tests.line(source text, item text, name text, qty int, unit bigint, req int default 0, reasons jsonb default '[]')
returns jsonb language sql immutable as $$
  select jsonb_build_object('source', source, 'item_key', item, 'name', name, 'description', null, 'quantity', qty,
    'unit_price_cents', unit, 'line_total_cents', qty * unit, 'required_quantity', req, 'required_reasons', reasons,
    'tax_category', 'standard') $$;
-- Signature, no extras, ceremony in the same room: 220000 + 11000 + 21945.
create function tests.valid_selection(pid uuid) returns jsonb language sql stable as $$
  select tests.selection(pid, 'signature', '{"ceremony_location":"same_room","needs_wireless_mic":false}', '{}',
    jsonb_build_array(tests.line('package','signature','Signature',1,220000),
                      tests.line('included','additional_speaker','Additional-location speaker',1,0)),
    220000, 11000, 21945) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Sending
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p1', public.open_proposal_draft(tests.id('event_a1'), tests.base_offer())::text, true);

select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select tests.send(current_setting('tests.p1')::uuid) $$, 'P0002', 'not found', 'another tenant''s staff cannot send');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select tests.send(current_setting('tests.p1')::uuid) $$, 'P0002', 'not found', 'a client cannot send');
select tests.login_as_anon();
select throws_ok($$ select public.send_proposal(current_setting('tests.p1')::uuid, 0, gen_random_uuid(), repeat('a', 64)) $$,
  '42501', null, 'anon cannot send');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.send_proposal(current_setting('tests.p1')::uuid, 99, gen_random_uuid(), repeat('a', 64)) $$,
  'PT409', null, 'sending a stale draft version (unsaved edits elsewhere) is rejected');
select throws_like($$ select public.send_proposal(current_setting('tests.p1')::uuid, 0, gen_random_uuid(), 'not-a-hash') $$,
  '%invalid access link%', 'the token hash must be a SHA-256 hex digest');

reset role;
insert into public.events (id, tenant_id, title, event_type, event_date)
  values ('30000000-0000-4000-8000-0000000000a9', tests.id('tenant_a'), 'No contact', 'party', '2027-05-01');
select tests.login_as(tests.id('owner_a'));
select throws_like(
  $$ select tests.send(public.open_proposal_draft('30000000-0000-4000-8000-0000000000a9', tests.base_offer())) $$,
  '%needs a primary contact%', 'an event without a primary contact cannot be sent');

select set_config('tests.sent1', tests.send(current_setting('tests.p1')::uuid)::text, true);
select set_config('tests.link1', current_setting('tests.last_link_id'), true);
select is(current_setting('tests.sent1')::jsonb ->> 'recipient_email', 'client-x@example.test', 'sent to the primary contact');
reset role;
select results_eq(
  $$ select p.status, p.expires_at > now() + interval '13 days', e.active_proposal_id = p.id, e.lifecycle_status, e.booking_confirmed_at is null
     from public.proposals p join public.events e on e.id = p.event_id where p.id = current_setting('tests.p1')::uuid $$,
  $$ values ('sent'::text, true, true, 'lead'::text, true) $$,
  'sending freezes, sets the deadline, makes it the active proposal, and does not book the event');
select results_eq(
  $$ select intended_client_id, token_hash = tests.hex('token-' || id), revoked_at is null
     from public.access_links where proposal_id = current_setting('tests.p1')::uuid $$,
  $$ values (tests.id('a_client_x'), true, true) $$, 'one active link for the primary contact, storing only the token hash');
select results_eq(
  $$ select event_type, recipient_email, access_link_id::text, payload ? 'token', payload::text like '%token-%'
     from public.email_outbox where entity_id = current_setting('tests.p1')::uuid $$,
  $$ values ('proposal_sent'::text, 'client-x@example.test'::text, current_setting('tests.link1'), false, false) $$,
  'the proposal email is queued with the link id and no token');
select is((select count(*)::int from public.audit_events where entity_id = current_setting('tests.p1')::uuid and action = 'sent'), 1,
  'sending is audited');

select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select token_hash from public.access_links $$, '42501', null, 'staff cannot read link token hashes');
select lives_ok($$ select id, expires_at, revoked_at from public.access_links $$, 'staff can read link status');
select throws_ok($$ select * from public.proposal_sessions $$, '42501', null, 'staff cannot read client sessions');
select tests.login_as(tests.id('owner_b'));
select is_empty($$ select * from public.email_outbox $$, 'another tenant cannot see the outbox');
select is_empty($$ select id from public.access_links $$, 'another tenant cannot see links');
select tests.login_as_anon();
select throws_ok($$ select * from public.access_links $$, '42501', null, 'anon cannot read links');
select throws_ok($$ select * from public.email_outbox $$, '42501', null, 'anon cannot read the outbox');
select throws_ok($$ select public.exchange_proposal_link(repeat('a', 64), repeat('b', 64), 'test-bouprod', 3600) $$,
  '42501', null, 'anon cannot call the link exchange directly');
select tests.login_as(tests.id('client_x'));
select throws_ok($$ select public.client_proposal_view(repeat('a', 64), current_setting('tests.p1')::uuid, 'test-bouprod') $$,
  '42501', null, 'authenticated users cannot call client functions directly');

-- ===========================================================================
-- Link exchange and the client view (service_role = the Next.js server)
-- ===========================================================================
reset role;
create temp table access_before as select count(*) as n from public.event_access;
select tests.login_as_service();
select is(public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link1')), tests.hex('s1'), 'test-other-dj', 3600) ->> 'status',
  'invalid', 'a link only works under its own tenant');
select is(public.exchange_proposal_link(tests.hex('wrong-token'), tests.hex('s1'), 'test-bouprod', 3600) ->> 'status',
  'invalid', 'an unknown token is invalid');
select is(public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link1')), tests.hex('s1'), 'test-bouprod', 3600) ->> 'status',
  'ok', 'a valid link is exchanged for a session');
select is(public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link1')), tests.hex('s2'), 'test-bouprod', 3600) ->> 'status',
  'ok', 'the link can be opened again (it is not one-time)');
reset role;
select results_eq(
  $$ select (select count(*)::int from public.proposal_views where proposal_id = current_setting('tests.p1')::uuid),
            (select count(*)::int from public.email_outbox where entity_id = current_setting('tests.p1')::uuid and event_type = 'proposal_link_opened'),
            (select recipient_email from public.email_outbox where entity_id = current_setting('tests.p1')::uuid and event_type = 'proposal_link_opened'),
            (select first_viewed_at is not null from public.proposals where id = current_setting('tests.p1')::uuid) $$,
  $$ values (2, 1, 'owner-a@example.test'::text, true) $$,
  'every opening is recorded; staff get one best-effort "link opened" notice');
select is((select n from access_before), (select count(*) from public.event_access), 'opening a link grants no event access');

select tests.login_as_service();
select set_config('tests.view', public.client_proposal_view(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod')::text, true);
select is(current_setting('tests.view')::jsonb ->> 'state', 'open', 'the client view is open');
select ok(current_setting('tests.view') not like '%secret staff note%', 'the client view excludes internal notes');
select ok(current_setting('tests.view') not like '%client-y@%' and current_setting('tests.view') not like '%client-u@%',
  'the client view excludes other contacts');
select ok(not (current_setting('tests.view')::jsonb -> 'proposal' ?| array['draft_offer', 'created_by_membership_id', 'tenant_id', 'current_selection_version']),
  'the client view excludes staff-only proposal fields');
select is(public.client_proposal_view(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-other-dj') ->> 'state', 'invalid',
  'a session is rejected under another tenant');
select is(public.client_proposal_view(tests.hex('s1'), tests.id('event_b1'), 'test-bouprod') ->> 'state', 'invalid',
  'a session is rejected for any other proposal');
select is(public.client_proposal_view(tests.hex('nobody'), current_setting('tests.p1')::uuid, 'test-bouprod') ->> 'state', 'invalid',
  'an unknown session is rejected');

-- ===========================================================================
-- Selection draft
-- ===========================================================================
select is(public.client_save_selection_draft(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 0, 'signature',
  '{"uplights_4":1}', '{"ceremony_location":"same_room"}'), '{"status":"ok","version":1}'::jsonb, 'the first draft save creates version 1');
select is(public.client_save_selection_draft(tests.hex('s2'), current_setting('tests.p1')::uuid, 'test-bouprod', 0, 'premium', '{}', '{}'),
  '{"status":"conflict","version":1}'::jsonb, 'a stale tab gets a conflict instead of overwriting');
select is(public.client_save_selection_draft(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1, 'signature',
  '{"laser_show":1}', '{}') ->> 'status', 'invalid_input', 'unknown addons are rejected');
select is(public.client_save_selection_draft(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1, 'signature',
  '{"uplights_4":9}', '{}') ->> 'status', 'invalid_input', 'quantities above the maximum are rejected');
select is(public.client_save_selection_draft(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1, 'platinum',
  '{}', '{}') ->> 'status', 'invalid_input', 'packages outside the offer are rejected');

-- ===========================================================================
-- Submission: choices are verified, not just money
-- ===========================================================================
select is(public.client_submit_selection(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1, 'key-omitted-required-gear',
  tests.selection(current_setting('tests.p1')::uuid, 'essential', '{"ceremony_location":"separate_space","needs_wireless_mic":false}', '{}',
    jsonb_build_array(tests.line('package','essential','Essential',1,150000)), 150000, 7500, 14963)) ->> 'message',
  'invalid selection: chargeable gear does not match the answers, package and addons: additional_speaker',
  'omitting required gear is rejected even when the money adds up');
select is(public.client_submit_selection(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1, 'key-quantity-above-max',
  tests.selection(current_setting('tests.p1')::uuid, 'signature', '{"ceremony_location":"same_room","needs_wireless_mic":false}', '{"uplights_4":9}',
    jsonb_build_array(tests.line('package','signature','Signature',1,220000),
                      tests.line('included','additional_speaker','Additional-location speaker',1,0),
                      tests.line('optional','uplights_4','Uplights (pack of 4)',9,12000)), 328000, 16400, 32718)) ->> 'message',
  'invalid selection: addon quantities are outside what the offer allows',
  'an addon quantity above the offered maximum is rejected even when the money adds up');
select is(public.client_submit_selection(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1, 'key-missing-answer-xx',
  jsonb_set(tests.valid_selection(current_setting('tests.p1')::uuid), '{logistics_answers}', '{"needs_wireless_mic":false}')) ->> 'message',
  'invalid selection: required answer missing: ceremony_location', 'a missing required answer is rejected');
select is(public.client_submit_selection(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1, 'key-tampered-price-xx',
  jsonb_set(jsonb_set(jsonb_set(jsonb_set(tests.valid_selection(current_setting('tests.p1')::uuid),
    '{lines,0,unit_price_cents}', '1'), '{lines,0,line_total_cents}', '1'), '{subtotal_cents}', '1'), '{total_cents}', '32946')) ->> 'message',
  'invalid priced selection: line 1 (signature) does not match the frozen offer', 'a tampered price is rejected');
select is(public.client_submit_selection(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 0, 'key-stale-draft-xxxx',
  tests.valid_selection(current_setting('tests.p1')::uuid)) ->> 'status', 'conflict', 'a stale tab cannot submit');
select is((select count(*)::int from public.proposal_selections where proposal_id = current_setting('tests.p1')::uuid), 0,
  'no rejected attempt stored anything');

select set_config('tests.sub1', public.client_submit_selection(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 1,
  'key-valid-submission', tests.valid_selection(current_setting('tests.p1')::uuid))::text, true);
select is(current_setting('tests.sub1')::jsonb ->> 'status', 'submitted', 'a valid selection is submitted');
select is(public.client_submit_selection(tests.hex('s2'), current_setting('tests.p1')::uuid, 'test-bouprod', 1,
  'key-valid-submission', tests.valid_selection(current_setting('tests.p1')::uuid)) ->> 'selection_id',
  current_setting('tests.sub1')::jsonb ->> 'selection_id', 'repeating the same submission returns the original (idempotent)');
select is(public.client_submit_selection(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 2,
  'key-second-attempt-x', tests.valid_selection(current_setting('tests.p1')::uuid)) ->> 'status',
  'submitted', 'a different submission after submitting is refused (state is submitted)');
select is(public.client_save_selection_draft(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod', 2, 'premium', '{}', '{}') ->> 'status',
  'submitted', 'the selection can no longer be edited after submission');
reset role;
select results_eq(
  $$ select (select count(*)::int from public.proposal_selections where proposal_id = p.id),
            p.status, e.lifecycle_status,
            (select count(*)::int from public.email_outbox o where o.entity_id = p.id and o.event_type = 'proposal_submitted')
     from public.proposals p join public.events e on e.id = p.event_id where p.id = current_setting('tests.p1')::uuid $$,
  $$ values (1, 'submitted'::text, 'pending_approval'::text, 1) $$,
  'exactly one immutable submission; event pending approval; staff notified once');

-- ===========================================================================
-- Approval
-- ===========================================================================
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.approve_proposal_selection(current_setting('tests.p1')::uuid, (current_setting('tests.sub1')::jsonb ->> 'selection_id')::uuid) $$,
  'P0002', 'not found', 'another tenant cannot approve');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.approve_proposal_selection(current_setting('tests.p1')::uuid, gen_random_uuid()) $$,
  '%latest submitted selection%', 'only the exact submitted selection can be approved');
select is(public.approve_proposal_selection(current_setting('tests.p1')::uuid, (current_setting('tests.sub1')::jsonb ->> 'selection_id')::uuid) ->> 'status',
  'approved', 'staff approve the submitted selection');
select is(public.approve_proposal_selection(current_setting('tests.p1')::uuid, (current_setting('tests.sub1')::jsonb ->> 'selection_id')::uuid) ->> 'replayed',
  'true', 'approving again returns the existing approval');
reset role;
select results_eq(
  $$ select p.status, e.lifecycle_status, e.booking_confirmed_at is null,
            a.selection_sha256 = encode(sha256(convert_to(s.selection_snapshot::text, 'UTF8')), 'hex'),
            (select recipient_email from public.email_outbox o where o.entity_id = p.id and o.event_type = 'proposal_approved')
     from public.proposals p join public.events e on e.id = p.event_id
     join public.proposal_approvals a on a.proposal_id = p.id join public.proposal_selections s on s.id = a.selection_id
     where p.id = current_setting('tests.p1')::uuid $$,
  $$ values ('approved'::text, 'awaiting_signature'::text, true, true, 'client-x@example.test'::text) $$,
  'approval references the exact selection, awaits the contract phase, is not a booking, and acknowledges the client');
select throws_ok($$ update public.proposal_approvals set selection_sha256 = repeat('a', 64) $$, '23514', null, 'approvals are immutable');
select tests.login_as_service();
select is(public.client_proposal_view(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod') ->> 'state', 'approved',
  'the client sees the approval');
reset role;
select is((select n from access_before), (select count(*) from public.event_access), 'the whole proposal flow granted no event access');

-- ===========================================================================
-- Replacement: a revised offer supersedes and revokes the previous one
-- ===========================================================================
create temp table saved1 as select offer_snapshot, offer_sha256 from public.proposals where id = current_setting('tests.p1')::uuid;
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p2', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select is((select draft_offer from public.proposals where id = current_setting('tests.p2')::uuid), tests.base_offer(),
  'a revision starts from the current offer');
select set_config('tests.sent2', tests.send(current_setting('tests.p2')::uuid)::text, true);
reset role;
select results_eq(
  $$ select p1.status, p2.status, p2.supersedes_id = p1.id, e.active_proposal_id = p2.id, e.lifecycle_status,
            p1.offer_snapshot = (select offer_snapshot from saved1), p1.offer_sha256 = (select offer_sha256 from saved1)
     from public.proposals p1, public.proposals p2, public.events e
     where p1.id = current_setting('tests.p1')::uuid and p2.id = current_setting('tests.p2')::uuid and e.id = p1.event_id $$,
  $$ values ('superseded'::text, 'sent'::text, true, true, 'lead'::text, true, true) $$,
  'the new revision supersedes the old one, whose terms are untouched');
select results_eq(
  $$ select bool_and(revoked_at is not null) from public.access_links where proposal_id = current_setting('tests.p1')::uuid
     union all
     select bool_and(revoked_at is not null) from public.proposal_sessions where proposal_id = current_setting('tests.p1')::uuid $$,
  $$ values (true), (true) $$, 'the old links and sessions are revoked');
select is((select count(*)::int from public.proposal_approvals where proposal_id = current_setting('tests.p1')::uuid), 1,
  'the earlier approval is preserved as history');
select tests.login_as_service();
select is(public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link1')), tests.hex('s3'), 'test-bouprod', 3600) ->> 'status',
  'superseded', 'the old link reports that a newer offer exists');
select is(public.client_proposal_view(tests.hex('s1'), current_setting('tests.p1')::uuid, 'test-bouprod') ->> 'state', 'superseded',
  'an old session sees "superseded" and no offer data');
select is(public.client_submit_selection(tests.hex('s2'), current_setting('tests.p1')::uuid, 'test-bouprod', 2, 'key-after-supersede-x',
  tests.valid_selection(current_setting('tests.p1')::uuid)) ->> 'status', 'superseded', 'an old session cannot submit');
reset role;
select throws_ok($$ update public.proposals set status = 'sent' where id = current_setting('tests.p1')::uuid $$,
  '23514', null, 'a superseded proposal cannot become actionable again');

-- ===========================================================================
-- Expiry while open
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.p3', public.open_proposal_draft(tests.id('event_a2'), tests.base_offer())::text, true);
select tests.send(current_setting('tests.p3')::uuid);
select set_config('tests.link3', current_setting('tests.last_link_id'), true);
select tests.login_as_service();
select public.exchange_proposal_link(tests.hex('token-' || current_setting('tests.link3')), tests.hex('s-exp'), 'test-bouprod', 3600);
reset role;
update public.proposals set expires_at = now() - interval '1 minute' where id = current_setting('tests.p3')::uuid;
select throws_ok($$ update public.proposals set expires_at = now() + interval '90 days' where id = current_setting('tests.p3')::uuid $$,
  '23514', null, 'a sent deadline cannot be extended');
select tests.login_as_service();
select is(public.client_proposal_view(tests.hex('s-exp'), current_setting('tests.p3')::uuid, 'test-bouprod') ->> 'state', 'expired',
  'an open page sees the proposal as expired');
select is(public.client_save_selection_draft(tests.hex('s-exp'), current_setting('tests.p3')::uuid, 'test-bouprod', 0, 'signature', '{}', '{}') ->> 'status',
  'expired', 'an expired proposal cannot be edited');
select is(public.client_submit_selection(tests.hex('s-exp'), current_setting('tests.p3')::uuid, 'test-bouprod', 0, 'key-after-expiry-xxx',
  tests.valid_selection(current_setting('tests.p3')::uuid)) ->> 'status', 'expired', 'an expired proposal cannot be submitted');
reset role;
update public.proposal_sessions set revoked_at = now() where proposal_id = current_setting('tests.p3')::uuid;
select tests.login_as_service();
select is(public.client_proposal_view(tests.hex('s-exp'), current_setting('tests.p3')::uuid, 'test-bouprod') ->> 'state', 'invalid',
  'a revoked session is invalid');

-- ===========================================================================
-- Outbox
-- ===========================================================================
reset role;
select private.enqueue_email(tests.id('tenant_a'), 'proposal_submitted', 'dup@example.test', tests.id('event_a1'), null, '{}', 'dedup-test');
select private.enqueue_email(tests.id('tenant_a'), 'proposal_submitted', 'dup@example.test', tests.id('event_a1'), null, '{}', 'dedup-test');
select is((select count(*)::int from public.email_outbox where dedup_key = 'dedup-test'), 1, 'the dedup key prevents duplicate emails');
select is((select status from public.email_outbox where entity_id = current_setting('tests.p1')::uuid and event_type = 'proposal_sent'),
  'cancelled', 'an undelivered email for a superseded offer is cancelled');

select tests.login_as_service();
select set_config('tests.claimed', (select string_agg(id::text, ',') from public.claim_email_outbox(100, 60, tests.id('tenant_a'))), true);
select ok((select bool_and(status = 'sending' and attempts = 1) from public.email_outbox
           where id::text = any (string_to_array(current_setting('tests.claimed'), ','))), 'claimed emails are locked for sending');
select is((select count(*)::int from public.claim_email_outbox(100, 60, tests.id('tenant_a'))), 0, 'locked emails are not claimed twice');
select public.fail_email_outbox(id, 'smtp down', false) from public.email_outbox where dedup_key = 'dedup-test';
select results_eq($$ select status, attempts, next_attempt_at > now(), last_error from public.email_outbox where dedup_key = 'dedup-test' $$,
  $$ values ('pending'::text, 1, true, 'smtp down'::text) $$, 'a failed attempt is retried later with backoff');
reset role;
update public.email_outbox set next_attempt_at = now() - interval '1 second', max_attempts = 2 where dedup_key = 'dedup-test';
select tests.login_as_service();
select public.claim_email_outbox(100, 60, tests.id('tenant_a'));
select public.fail_email_outbox(id, 'smtp still down', false) from public.email_outbox where dedup_key = 'dedup-test';
select is((select status from public.email_outbox where dedup_key = 'dedup-test'), 'failed', 'after the last attempt the email is marked failed');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.retry_email_outbox((select id from public.email_outbox where dedup_key = 'dedup-test')) $$,
  'P0002', null, 'another tenant cannot retry (or even see) the email');
select tests.login_as(tests.id('owner_a'));
select is(public.retry_email_outbox((select id from public.email_outbox where dedup_key = 'dedup-test')), true, 'staff can retry a failed email');
select results_eq($$ select status, max_attempts from public.email_outbox where dedup_key = 'dedup-test' $$,
  $$ values ('pending'::text, 5) $$, 'a retried email is queued with more attempts');
reset role;
select is((select count(*)::int from public.proposal_selections
           where proposal_id in (current_setting('tests.p1')::uuid, current_setting('tests.p2')::uuid, current_setting('tests.p3')::uuid)),
  1, 'email processing never created business records');

-- ===========================================================================
-- Rate limits
-- ===========================================================================
select tests.login_as_service();
select results_eq(
  $$ select public.consume_rate_limit('test_bucket', tests.hex('ip-1'), 2, 60) union all
     select public.consume_rate_limit('test_bucket', tests.hex('ip-1'), 2, 60) union all
     select public.consume_rate_limit('test_bucket', tests.hex('ip-1'), 2, 60) union all
     select public.consume_rate_limit('test_bucket', tests.hex('ip-2'), 2, 60) $$,
  $$ values (true), (true), (false), (true) $$, 'the third hit in a window is refused; other subjects are separate');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.consume_rate_limit('x', repeat('a', 64), 1, 60) $$, '42501', null, 'only the server can use rate limits');

select * from finish();
rollback;
