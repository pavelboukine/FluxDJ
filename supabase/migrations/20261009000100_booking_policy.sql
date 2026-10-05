-- Booking policy and automatic booking confirmation.
--
-- Policies (tenants.booking_confirmation_policy, existing column and values):
--   on_deposit    signed contract plus valid recorded payments covering its
--                 frozen deposit (a 0% deposit means signing is enough).
--                 The default.
--   on_signature  the signed contract is enough. Payment may still be due.
-- Owners change it with update_booking_policy (versioned). Until now no
-- screen or function could set it, so every business still has the column's
-- old default, on_signature, which nobody chose; this migration moves them
-- to the new default, on_deposit, and makes on_deposit the column default.
--
-- Frozen per contract: contracts.booking_policy is copied from the business
-- when a contract is generated (contracts_booking_policy) and never changes,
-- so changing the setting only affects contracts generated afterwards. It is
-- not part of the content hash: hashes, evidence and PDFs are untouched.
-- Contracts generated before this migration keep booking_policy = null
-- ("legacy"): nothing books them automatically, not this migration and not
-- later payments. Staff run check_event_booking, which evaluates them under
-- on_deposit; once staff have checked one and it is awaiting its deposit,
-- later payments are evaluated automatically like any other.
--
-- Evaluation (private.evaluate_booking) runs inside the transactions that
-- sign a contract, record a payment or invalidate one, after locking the
-- event (the lock order everywhere is event, proposal, contract), and in the
-- explicit staff check. It reads only the database: the event's signed
-- contract and its frozen terms, valid payments in that contract's currency
-- (payments recorded before signing count), archive state of the event and
-- business. Under the lock it moves the event to
--   booked            requirements met: booking_confirmed_at = now(), once,
--                     one audit event and one booking-confirmation email
--                     queued in the same transaction;
--   awaiting_deposit  signed under on_deposit with the deposit still due.
-- Archived events and businesses are never booked. A booking is never undone
-- by a payment correction: booking_confirmed_at stays and the summary warns
-- staff when the deposit is no longer covered. Cancellation, refunds and
-- unbooking are out of scope.
--
-- The booking email ("booking_confirmed") goes to the frozen signer email,
-- with the sender frozen like signed copies, and states what was received
-- and what remains as of the booking. It promises no planning access. Workers
-- that predate it never claim it (claim_email_outbox p_include_booking), so
-- the previously deployed app can't send it as another kind of email; it is
-- delivered once the updated app runs.

-- ===========================================================================
-- Policy setting
-- ===========================================================================

alter table public.tenants add column booking_policy_version integer not null default 0
  constraint tenants_booking_policy_version_nonnegative check (booking_policy_version >= 0);
alter table public.tenants alter column booking_confirmation_policy set default 'on_deposit';
-- Never configurable before: move the untouched default to the new one.
alter table public.tenants disable trigger user;
update public.tenants set booking_confirmation_policy = 'on_deposit' where booking_confirmation_policy = 'on_signature';
alter table public.tenants enable trigger user;
-- Changed only through update_booking_policy (owner, versioned).
revoke update (booking_confirmation_policy) on public.tenants from authenticated;
comment on column public.tenants.booking_confirmation_policy is
  'on_deposit (signed + deposit received; default) or on_signature. Frozen into each contract when generated.';

create function public.update_booking_policy(p_tenant_id uuid, p_policy text, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  t public.tenants%rowtype;
begin
  select m.role into v_role from public.tenant_memberships m where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change the booking policy' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if p_expected_version is null or t.booking_policy_version <> p_expected_version then
    raise exception 'booking policy was changed elsewhere' using errcode = 'serialization_failure';
  end if;
  if p_policy is null or p_policy not in ('on_deposit', 'on_signature') then
    raise exception 'settings_invalid: choose when bookings are confirmed' using errcode = 'invalid_parameter_value';
  end if;
  update public.tenants set booking_confirmation_policy = p_policy, booking_policy_version = booking_policy_version + 1
  where id = t.id returning * into t;
  perform private.audit(t.id, 'tenant', t.id, 'booking_policy_changed', 'staff', (select auth.uid()), jsonb_build_object('policy', p_policy));
  return t.booking_policy_version;
end;
$$;
revoke execute on function public.update_booking_policy(uuid, text, integer) from public, anon;
grant execute on function public.update_booking_policy(uuid, text, integer) to authenticated;

-- ===========================================================================
-- Contracts freeze the policy
-- ===========================================================================

alter table public.contracts add column booking_policy text
  constraint contracts_booking_policy_valid check (booking_policy in ('on_deposit', 'on_signature'));
comment on column public.contracts.booking_policy is
  'Booking policy frozen at generation. Null for contracts generated before policies existed (checked explicitly by staff).';

create function private.contracts_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.booking_policy := (select t.booking_confirmation_policy from public.tenants t where t.id = new.tenant_id);
  return new;
end;
$$;
revoke execute on function private.contracts_booking_policy() from public, anon, authenticated;
create trigger contracts_booking_policy before insert on public.contracts
  for each row execute function private.contracts_booking_policy();

drop trigger contracts_immutable on public.contracts;
create trigger contracts_immutable before update on public.contracts
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'proposal_id', 'selection_id', 'approval_id', 'template_id', 'template_version_id',
    'template_content_sha256', 'replaces_id', 'signer_client_id', 'signer_name', 'signer_email', 'currency', 'total_cents',
    'deposit_percent', 'deposit_cents', 'balance_cents', 'balance_due_date', 'rendered_content', 'commercial_snapshot',
    'party_snapshot', 'content_sha256', 'generated_by_user_id', 'created_at', 'signing_mode', 'consent_version', 'booking_policy');

-- ===========================================================================
-- Events: booked once, through evaluate_booking only
-- ===========================================================================

create function private.events_booking_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.booking_confirmed_at is not null and new.booking_confirmed_at is distinct from old.booking_confirmed_at then
    raise exception 'booking_confirmed_at is set once' using errcode = 'check_violation';
  end if;
  if old.lifecycle_status = 'booked' and new.lifecycle_status not in ('booked', 'completed', 'cancelled') then
    raise exception 'a booked event cannot go back to %', new.lifecycle_status using errcode = 'check_violation';
  end if;
  if new.lifecycle_status = 'booked' and old.lifecycle_status <> 'booked'
     and current_setting('flux.booking_event', true) is distinct from new.id::text then
    raise exception 'events are booked only through evaluate_booking' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger events_booking_guard before update of lifecycle_status, booking_confirmed_at on public.events
  for each row execute function private.events_booking_guard();

-- ===========================================================================
-- Booking emails
-- ===========================================================================

alter table public.email_outbox drop constraint email_outbox_event_type_valid;
alter table public.email_outbox
  add constraint email_outbox_event_type_valid check (event_type in (
    'proposal_sent', 'proposal_link_opened', 'proposal_submitted', 'proposal_approved',
    'contract_sent', 'contract_sign_in', 'contract_voided', 'contract_signed_copy', 'booking_confirmed'));

-- ===========================================================================
-- Evaluation
-- ===========================================================================

-- Evaluates and, when the requirements are met, books the event. Locks the
-- event (callers already hold it; re-locking is a no-op). p_explicit: a staff
-- check, which evaluates legacy contracts (no frozen policy) under on_deposit.
-- Returns {"status": "booked" | "already_booked" | "awaiting_deposit" |
-- "not_signed" | "archived" | "needs_check" | "not_bookable", ...}.
create function private.evaluate_booking(p_event_id uuid, p_actor_type text, p_actor_id uuid, p_explicit boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  c public.contracts%rowtype;
  v_policy text;
  v_received bigint;
begin
  select * into e from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  select * into t from public.tenants where id = e.tenant_id;
  if e.lifecycle_status = 'booked' then
    return jsonb_build_object('status', 'already_booked', 'booking_confirmed_at', e.booking_confirmed_at);
  end if;
  if e.lifecycle_status in ('cancelled', 'completed') then
    return jsonb_build_object('status', 'not_bookable');
  end if;
  select * into c from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed';
  if not found then
    return jsonb_build_object('status', 'not_signed');
  end if;
  if e.archived_at is not null or t.archived_at is not null then
    return jsonb_build_object('status', 'archived');
  end if;
  -- Legacy contracts: only an explicit staff check (or one already done,
  -- which left the event awaiting its deposit) evaluates them, as on_deposit.
  v_policy := coalesce(c.booking_policy,
    case when p_explicit or e.lifecycle_status = 'awaiting_deposit' then 'on_deposit' end);
  if v_policy is null then
    return jsonb_build_object('status', 'needs_check');
  end if;
  select coalesce(sum(p.amount_cents), 0) into v_received from public.event_payments p
  where p.tenant_id = e.tenant_id and p.event_id = e.id and p.invalidated_at is null and p.currency = c.currency;

  if v_policy = 'on_deposit' and v_received < c.deposit_cents then
    if e.lifecycle_status <> 'awaiting_deposit' then
      update public.events set lifecycle_status = 'awaiting_deposit' where id = e.id;
      perform private.audit(e.tenant_id, 'event', e.id, 'awaiting_deposit', p_actor_type, p_actor_id,
        jsonb_build_object('contract_id', c.id, 'policy', v_policy, 'deposit_cents', c.deposit_cents, 'received_cents', v_received));
    end if;
    return jsonb_build_object('status', 'awaiting_deposit', 'policy', v_policy,
      'deposit_outstanding_cents', c.deposit_cents - v_received);
  end if;

  perform set_config('flux.booking_event', e.id::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = e.id returning * into e;
  perform set_config('flux.booking_event', '', true);
  perform private.audit(e.tenant_id, 'event', e.id, 'booking_confirmed', p_actor_type, p_actor_id,
    jsonb_build_object('contract_id', c.id, 'policy', v_policy, 'legacy', c.booking_policy is null,
                       'deposit_cents', c.deposit_cents, 'received_cents', v_received));
  -- One confirmation email, queued with the booking. Frozen recipient,
  -- sender and figures, so retries are identical.
  insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key, sender)
  values (e.tenant_id, 'booking_confirmed', lower(c.signer_email), 'contract', c.id,
    jsonb_build_object(
      'client_name', c.signer_name,
      'event_title', c.party_snapshot -> 'event' ->> 'title',
      'event_date', c.party_snapshot -> 'event' ->> 'date',
      'legal_name', coalesce(c.party_snapshot -> 'business' ->> 'legal_name', c.party_snapshot -> 'business' ->> 'name'),
      'contact_email', c.party_snapshot -> 'business' ->> 'contact_email',
      'currency', c.currency,
      'total_cents', c.total_cents,
      'deposit_cents', c.deposit_cents,
      'received_cents', v_received,
      'remaining_cents', greatest(c.total_cents - v_received, 0),
      'credit_cents', greatest(v_received - c.total_cents, 0),
      'balance_due_date', c.balance_due_date,
      'booked_on', (e.booking_confirmed_at at time zone t.timezone)::date),
    'booking_confirmed:' || e.id,
    jsonb_build_object('display_name', t.display_name, 'from_name', t.display_name || ' via Flux DJ', 'reply_to', t.reply_to_email))
  on conflict (dedup_key) do nothing;
  return jsonb_build_object('status', 'booked', 'policy', v_policy, 'booking_confirmed_at', e.booking_confirmed_at);
end;
$$;
revoke execute on function private.evaluate_booking(uuid, text, uuid, boolean) from public, anon, authenticated;

-- Staff: evaluate the event now. Needed for contracts signed before booking
-- policies existed (evaluated as on_deposit); harmless for any other event.
create function public.check_event_booking(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.events where id = p_event_id;
  if v_tenant is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_tenant);
  return private.evaluate_booking(p_event_id, 'staff', (select auth.uid()), true);
end;
$$;
revoke execute on function public.check_event_booking(uuid) from public, anon;
grant execute on function public.check_event_booking(uuid) to authenticated;

-- ===========================================================================
-- Callers: signing, payments, summaries, the outbox
-- ===========================================================================

create or replace function public.sign_contract(
  p_contract_id uuid,
  p_tenant_slug text,
  p_user_id uuid,
  p_typed_name text,
  p_content_sha256 text,
  p_consent_version text,
  p_consent_accepted boolean,
  p_signature_path text,
  p_signature_sha256 text,
  p_signature_bytes integer,
  p_signature_width integer,
  p_signature_height integer,
  p_user_agent text,
  p_client_ip text,
  p_client_ip_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  e public.events%rowtype;
  p public.proposals%rowtype;
  s public.contract_signatures%rowtype;
  v_email text;
  v_name text := btrim(coalesce(p_typed_name, ''));
  v_consent text;
  v_object record;
  v_ip inet;
  v_ua text := nullif(left(btrim(coalesce(p_user_agent, '')), 512), '');
begin
  select k.* into c from public.contracts k join public.tenants t on t.id = k.tenant_id
  where k.id = p_contract_id and t.slug = p_tenant_slug;
  if not found or p_user_id is null then
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;

  -- Lock order everywhere: event, proposal, contract.
  select * into e from public.events where tenant_id = c.tenant_id and id = c.event_id for update;
  select * into p from public.proposals where tenant_id = c.tenant_id and id = c.proposal_id for update;
  select * into c from public.contracts where id = c.id for update;

  -- Identity and access: verified email matching the frozen signer, live
  -- access for the signer client, nothing archived. Same answer for every
  -- failure so nothing leaks to other accounts.
  if not private.signer_can_access_contract(c.id, p_user_id) then
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;

  -- Already signed: the same signer gets the existing result back.
  if c.status = 'signed' then
    select * into s from public.contract_signatures where contract_id = c.id;
    if s.signer_user_id = p_user_id then
      return jsonb_build_object('status', 'signed', 'replayed', true, 'contract_id', c.id, 'signed_at', s.signed_at,
        'typed_name', s.typed_name);
    end if;
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;

  -- Contract still sent, current, on the current approval.
  if c.status <> 'sent' or p.status <> 'approved' or e.active_proposal_id is distinct from c.proposal_id
     or e.lifecycle_status <> 'awaiting_signature'
     or not exists (select 1 from public.proposal_approvals a where a.tenant_id = c.tenant_id and a.id = c.approval_id
                    and a.proposal_id = c.proposal_id and a.selection_id = c.selection_id) then
    return jsonb_build_object('status', 'rejected', 'code', 'unavailable', 'message', 'This contract isn''t available.');
  end if;
  -- The frozen signing mode decides; "none" was generated from a legacy version.
  if c.signing_mode = 'none' or c.consent_version is null then
    return jsonb_build_object('status', 'rejected', 'code', 'signing_disabled',
      'message', 'This contract can''t be signed online. Contact your DJ for an updated contract.');
  end if;
  if p_content_sha256 is distinct from c.content_sha256 then
    return jsonb_build_object('status', 'rejected', 'code', 'content_changed',
      'message', 'This contract is not the one you were shown. Reload the page and read it again before signing.');
  end if;
  v_consent := private.contract_signing_consent(c.consent_version);
  if p_consent_version is distinct from c.consent_version or v_consent is null then
    return jsonb_build_object('status', 'rejected', 'code', 'consent_changed',
      'message', 'The signing statement has changed. Reload the page and read it again before signing.');
  end if;
  if p_consent_accepted is not true then
    return jsonb_build_object('status', 'rejected', 'code', 'consent_required',
      'message', 'Check the box to confirm you agree to sign electronically.');
  end if;
  if length(v_name) not between 1 and 200 then
    return jsonb_build_object('status', 'rejected', 'code', 'name_required', 'message', 'Type your full name (up to 200 characters).');
  end if;

  -- The signature image: stored first by the server, unique, in this
  -- contract's folder, with the declared size and type, and unused.
  if p_signature_path is null
     or p_signature_path !~ ('^' || c.tenant_id || '/' || c.id || '/[0-9a-f-]{36}\.png$')
     or p_signature_sha256 is null or p_signature_sha256 !~ '^[0-9a-f]{64}$'
     or p_signature_bytes is null or p_signature_bytes not between 1 and 262144
     or p_signature_width is null or p_signature_width not between 1 and 4096
     or p_signature_height is null or p_signature_height not between 1 and 4096 then
    return jsonb_build_object('status', 'rejected', 'code', 'signature_invalid', 'message', 'Draw your signature again.');
  end if;
  select o.name, (o.metadata ->> 'size')::bigint as size, o.metadata ->> 'mimetype' as mimetype into v_object
  from storage.objects o where o.bucket_id = 'contract-signatures' and o.name = p_signature_path;
  if not found or v_object.size is distinct from p_signature_bytes or v_object.mimetype is distinct from 'image/png'
     or exists (select 1 from public.contract_signatures x where x.signature_path = p_signature_path) then
    return jsonb_build_object('status', 'rejected', 'code', 'signature_invalid', 'message', 'Draw your signature again.');
  end if;

  if p_client_ip_source = 'vercel' and p_client_ip is not null then
    begin
      v_ip := p_client_ip::inet;
    exception when others then
      v_ip := null;
    end;
  end if;

  insert into public.contract_signatures (
    tenant_id, event_id, contract_id, signer_client_id, signer_user_id, signer_email, typed_name,
    signature_path, signature_sha256, signature_bytes, signature_width, signature_height,
    content_sha256, consent_version, consent_text, user_agent, client_ip, client_ip_source)
  values (
    c.tenant_id, c.event_id, c.id, c.signer_client_id, p_user_id, v_email, v_name,
    p_signature_path, p_signature_sha256, p_signature_bytes, p_signature_width, p_signature_height,
    c.content_sha256, c.consent_version, v_consent, v_ua, v_ip, case when v_ip is null then 'unavailable' else 'vercel' end)
  returning * into s;

  perform set_config('flux.signing_contract', c.id::text, true);
  update public.contracts set status = 'signed' where id = c.id returning * into c;
  perform set_config('flux.signing_contract', '', true);
  -- The signature row and the contract share one database timestamp.
  if s.signed_at <> c.signed_at then
    raise exception 'signing timestamps diverged' using errcode = 'internal_error';
  end if;

  perform private.retire_contract_invitations(c.id, 'contract signed');
  -- PDF work is queued in this same transaction and rendered later by the
  -- worker, so a rendering failure can never undo or lose the signature.
  perform private.enqueue_signed_contract_pdf(c.id, true, null);
  -- One audit event. Evidence stays in contract_signatures, not in the log.
  perform private.audit(c.tenant_id, 'contract', c.id, 'signed', 'client', p_user_id,
    jsonb_build_object('signature_id', s.id, 'content_sha256', c.content_sha256, 'signing_mode', c.signing_mode,
                       'consent_version', c.consent_version));
  -- Booking under the contract's frozen policy, in this same transaction
  -- (payments recorded before signing count). Rendering and email happen
  -- later, so they can never block or undo it.
  perform private.evaluate_booking(c.event_id, 'client', p_user_id, false);
  return jsonb_build_object('status', 'signed', 'replayed', false, 'contract_id', c.id, 'signed_at', s.signed_at,
    'typed_name', s.typed_name);
end;
$$;


create or replace function public.record_event_payment(
  p_event_id uuid,
  p_amount_cents bigint,
  p_paid_on date,
  p_reference text,
  p_note text,
  p_idempotency_key uuid,
  p_confirm_duplicate boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  v_membership_id uuid;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_existing public.event_payments%rowtype;
  v_id uuid;
  v_booking jsonb;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(e.tenant_id);
  -- Serializes payments per event (duplicate check and idempotency).
  select * into e from public.events where id = e.id for update;
  select * into t from public.tenants where id = e.tenant_id;

  if p_idempotency_key is null then
    perform private.payment_error('reload the page and try again');
  end if;
  select * into v_existing from public.event_payments where tenant_id = e.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.event_id = e.id and v_existing.amount_cents = p_amount_cents and v_existing.paid_on = p_paid_on
       and v_existing.reference is not distinct from v_reference and v_existing.note is not distinct from v_note then
      return jsonb_build_object('status', 'replayed', 'payment_id', v_existing.id);
    end if;
    perform private.payment_error('this form was already used for another payment. Reload the page and enter it again');
  end if;

  if e.archived_at is not null or t.archived_at is not null then
    perform private.payment_error('the event is archived. Unarchive it before recording payments');
  end if;
  if p_amount_cents is null or p_amount_cents < 1 then
    perform private.payment_error('enter an amount greater than zero');
  end if;
  if p_amount_cents > 99999999999 then
    perform private.payment_error('the amount is too large');
  end if;
  if p_paid_on is null then
    perform private.payment_error('enter the date the payment was received');
  end if;
  if p_paid_on < date '2000-01-01' or p_paid_on > (now() at time zone t.timezone)::date then
    perform private.payment_error('the payment date can''t be in the future');
  end if;
  if v_reference is not null and length(v_reference) > 200 then
    perform private.payment_error('the reference is limited to 200 characters');
  end if;
  if v_note is not null and length(v_note) > 2000 then
    perform private.payment_error('the note is limited to 2,000 characters');
  end if;
  if not coalesce(p_confirm_duplicate, false) and exists (
    select 1 from public.event_payments x
    where x.tenant_id = e.tenant_id and x.event_id = e.id and x.invalidated_at is null
      and x.amount_cents = p_amount_cents and x.paid_on = p_paid_on) then
    raise exception 'payment_possible_duplicate: a payment with the same amount and date is already recorded for this event. If this is a separate payment, confirm it and record it again'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.event_payments (tenant_id, event_id, amount_cents, currency, paid_on, reference, note, idempotency_key,
    recorded_by_user_id, recorded_by_membership_id, recorded_by_email)
  values (e.tenant_id, e.id, p_amount_cents, t.currency, p_paid_on, v_reference, v_note, p_idempotency_key,
    (select auth.uid()), v_membership_id, (select lower(u.email) from auth.users u where u.id = (select auth.uid())))
  returning id into v_id;
  perform private.audit(e.tenant_id, 'event', e.id, 'payment_recorded', 'staff', (select auth.uid()),
    jsonb_build_object('payment_id', v_id, 'amount_cents', p_amount_cents, 'currency', t.currency, 'paid_on', p_paid_on));
  -- The payment may complete a signed contract's deposit: same transaction.
  v_booking := private.evaluate_booking(e.id, 'staff', (select auth.uid()), false);
  return jsonb_build_object('status', 'recorded', 'payment_id', v_id, 'booking', v_booking ->> 'status');
end;
$$;


create or replace function public.invalidate_event_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_payments%rowtype;
  e public.events%rowtype;
  v_membership_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into p from public.event_payments where id = p_payment_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(p.tenant_id);
  -- Lock order: event, then payment.
  select * into e from public.events where tenant_id = p.tenant_id and id = p.event_id for update;
  select * into p from public.event_payments where id = p.id for update;
  if p.invalidated_at is not null then
    return jsonb_build_object('status', 'already_invalidated', 'invalidated_at', p.invalidated_at);
  end if;
  if e.archived_at is not null then
    perform private.payment_error('the event is archived. Unarchive it before correcting payments');
  end if;
  if length(v_reason) not between 3 and 500 then
    perform private.payment_error('give a reason (3 to 500 characters)');
  end if;

  perform set_config('flux.invalidating_payment', p.id::text, true);
  update public.event_payments
    set invalidated_at = now(), invalidated_by_user_id = (select auth.uid()), invalidated_by_membership_id = v_membership_id,
        invalidated_by_email = (select lower(u.email) from auth.users u where u.id = (select auth.uid())),
        invalidation_reason = v_reason
    where id = p.id
    returning * into p;
  perform set_config('flux.invalidating_payment', '', true);
  perform private.audit(p.tenant_id, 'event', p.event_id, 'payment_invalidated', 'staff', (select auth.uid()),
    jsonb_build_object('payment_id', p.id, 'amount_cents', p.amount_cents));
  -- Re-evaluated like every payment change. A booking is never undone here;
  -- the summary warns staff if the deposit is no longer covered.
  perform private.evaluate_booking(p.event_id, 'staff', (select auth.uid()), false);
  return jsonb_build_object('status', 'invalidated', 'invalidated_at', p.invalidated_at);
end;
$$;


create or replace function private.event_payment_summary(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  c public.contracts%rowtype;
  v_has_terms boolean;
  v_currency text;
  v_received bigint;
  v_valid int;
  v_other_currency int;
begin
  select * into e from public.events where id = p_event_id;
  select * into t from public.tenants where id = e.tenant_id;
  -- The authoritative contract: signed, else currently sent (at most one of
  -- either exists per event).
  select * into c from public.contracts k
  where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status in ('signed', 'sent')
  order by (k.status = 'signed') desc, k.sent_at desc
  limit 1;
  v_has_terms := found;
  v_currency := case when v_has_terms then c.currency else t.currency end;
  select coalesce(sum(p.amount_cents) filter (where p.currency = v_currency), 0),
         count(*) filter (where p.currency = v_currency),
         count(*) filter (where p.currency <> v_currency)
    into v_received, v_valid, v_other_currency
  from public.event_payments p
  where p.tenant_id = e.tenant_id and p.event_id = e.id and p.invalidated_at is null;

  return jsonb_build_object(
    'currency', v_currency,
    'terms', case when v_has_terms then jsonb_build_object(
        'status', c.status, 'contract_id', c.id,
        'total_cents', c.total_cents, 'deposit_percent', c.deposit_percent, 'deposit_cents', c.deposit_cents,
        'balance_cents', c.balance_cents, 'balance_due_date', c.balance_due_date) end,
    'received_cents', v_received,
    'valid_payments', v_valid,
    'other_currency_payments', v_other_currency,
    'deposit_outstanding_cents', case when v_has_terms then greatest(c.deposit_cents - v_received, 0) end,
    'remaining_balance_cents', case when v_has_terms then greatest(c.total_cents - v_received, 0) end,
    'credit_cents', case when v_has_terms then greatest(v_received - c.total_cents, 0) end,
    'invoice_url', (select b.invoice_url from public.event_billing b where b.event_id = e.id),
    'booking', jsonb_build_object(
      'lifecycle_status', e.lifecycle_status,
      'booking_confirmed_at', e.booking_confirmed_at,
      -- The signed contract's frozen policy; null for contracts generated
      -- before policies existed (staff check those explicitly).
      'policy', case when v_has_terms and c.status = 'signed' then c.booking_policy end,
      'legacy_signed', v_has_terms and c.status = 'signed' and c.booking_policy is null,
      -- Booked under the deposit policy but valid payments no longer cover
      -- the deposit (a payment was invalidated). The booking stands.
      'deposit_no_longer_met', e.lifecycle_status = 'booked' and v_has_terms and c.status = 'signed'
        and coalesce(c.booking_policy, 'on_deposit') = 'on_deposit' and v_received < c.deposit_cents)
  );
end;
$$;


create or replace function public.client_payment_summary(p_contract_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  s jsonb;
begin
  select k.* into c from public.contracts k join public.tenants t on t.id = k.tenant_id
  where k.id = p_contract_id and t.slug = p_tenant_slug;
  if not found or not private.client_can_read_contract(c.id) then
    return null;
  end if;
  s := private.event_payment_summary(c.event_id);
  return jsonb_build_object(
    'currency', s ->> 'currency',
    'terms_status', s -> 'terms' ->> 'status',
    'total_cents', s -> 'terms' -> 'total_cents',
    'deposit_percent', s -> 'terms' -> 'deposit_percent',
    'deposit_cents', s -> 'terms' -> 'deposit_cents',
    'balance_due_date', s -> 'terms' -> 'balance_due_date',
    'received_cents', s -> 'received_cents',
    'deposit_outstanding_cents', s -> 'deposit_outstanding_cents',
    'remaining_balance_cents', s -> 'remaining_balance_cents',
    'credit_cents', s -> 'credit_cents',
    'invoice_url', s -> 'invoice_url',
    'booking_status', case s -> 'booking' ->> 'lifecycle_status' when 'booked' then 'booked' when 'awaiting_deposit' then 'awaiting_deposit' end
  );
end;
$$;


drop function public.claim_email_outbox(integer, integer, uuid);
create function public.claim_email_outbox(
  p_limit integer default 10, p_lock_seconds integer default 120, p_tenant_id uuid default null, p_include_booking boolean default false
)
returns table (
  id uuid, tenant_id uuid, event_type text, recipient_email text, entity_id uuid, payload jsonb, attempts integer,
  access_link_id uuid, link_token_hash text, link_usable boolean, proposal_active boolean,
  tenant_slug text, tenant_display_name text, tenant_reply_to text,
  contract_deliverable boolean, contract_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- Claims that expired with no attempts left are given up.
  update public.email_outbox o
    set status = 'failed', locked_until = null, last_error = coalesce(o.last_error, 'delivery did not complete')
    where o.status = 'sending' and o.locked_until < now() and o.attempts >= o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id);

  return query
  with due as (
    select o.id from public.email_outbox o
    where (o.status = 'pending' or (o.status = 'sending' and o.locked_until < now()))
      and o.next_attempt_at <= now()
      and o.attempts < o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id)
      -- Workers that predate booking emails never claim them (they would
      -- render them as something else); they wait for an updated worker.
      and (o.event_type <> 'booking_confirmed' or coalesce(p_include_booking, false))
      -- Archived businesses send nothing.
      and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null)
    order by o.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  ),
  claimed as (
    update public.email_outbox o
      set status = 'sending', attempts = o.attempts + 1,
          locked_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lock_seconds, 120), 900)))
      from due where o.id = due.id
      returning o.*
  )
  select c.id, c.tenant_id, c.event_type, c.recipient_email, c.entity_id, c.payload, c.attempts,
         c.access_link_id, l.token_hash, (l.id is not null and l.revoked_at is null and l.expires_at > now()),
         coalesce(e.active_proposal_id = c.entity_id, false),
         t.slug, t.display_name, t.reply_to_email,
         -- Contract emails are deliverable only while their invitation is
         -- usable and the contract is still sent, current and not archived.
         -- A void notice is deliverable while the contract is void.
         -- A signed copy is deliverable while the contract is signed, its event
         -- is not archived and its canonical PDF is committed.
         -- A booking confirmation is deliverable while the event is booked,
         -- not archived, and its contract signed.
         coalesce(case when c.event_type = 'booking_confirmed' then c.entity_type = 'contract' and k.status = 'signed'
                    and ke.archived_at is null and ke.lifecycle_status = 'booked'
                  when c.event_type = 'contract_signed_copy' then c.entity_type = 'contract' and k.status = 'signed'
                    and ke.archived_at is null
                    and exists (select 1 from public.contract_documents d where d.contract_id = k.id and d.kind = 'signed_contract')
                  when c.event_type = 'contract_voided' then c.entity_type = 'contract' and k.status = 'void'
                  else c.entity_type = 'contract' and l.purpose = 'contract' and l.contract_id = c.entity_id
                  and l.revoked_at is null and l.expires_at > now()
                  and k.status = 'sent' and ke.archived_at is null
                  and kp.status = 'approved' and ke.active_proposal_id = k.proposal_id end, false),
         k.id
  from claimed c
  join public.tenants t on t.id = c.tenant_id
  left join public.access_links l on l.tenant_id = c.tenant_id and l.id = c.access_link_id
  left join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.entity_id
  left join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  left join public.contracts k on c.entity_type = 'contract' and k.tenant_id = c.tenant_id and k.id = c.entity_id
  left join public.events ke on ke.tenant_id = k.tenant_id and ke.id = k.event_id
  left join public.proposals kp on kp.tenant_id = k.tenant_id and kp.id = k.proposal_id;
end;
$$;

revoke execute on function public.claim_email_outbox(integer, integer, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(integer, integer, uuid, boolean) to service_role;
