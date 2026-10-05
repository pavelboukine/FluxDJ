-- Manual payment tracking: payments received elsewhere (Wave, e-transfer,
-- cash...), recorded by staff against an event. No processing, invoicing,
-- provider integration or automatic verification.
--
-- * event_payments: one row per received payment, in integer cents, with the
--   date it was received, an optional reference and internal note, and the
--   recording staff member (user id, membership, email snapshot) and database
--   time. Rows are never updated or deleted. A wrong entry is invalidated
--   once, with a required reason, who and when; a correction is a new entry.
--   Each submission carries an idempotency key, so retries and double
--   submissions record one payment; a second payment with the same amount and
--   date on the same event needs explicit confirmation.
-- * event_billing: an optional external invoice URL per event (HTTPS only,
--   never fetched), versioned for conflict detection.
-- * private.event_payment_summary: the one place the totals are computed.
--   Terms come only from the event's authoritative contract:
--     - the signed contract, if any (frozen total, deposit, balance, date);
--     - otherwise the contract currently sent to the client, labelled as not
--       signed (it may still be voided and replaced);
--     - otherwise none: payments are listed, but no total or deposit is
--       invented. Drafts, void, replaced and superseded contracts never count.
--   At most one contract per event is sent or signed (contracts_before_insert
--   refuses a new draft while one is), so totals are never summed across
--   contract versions. Overpayment is reported as a credit, never as a
--   negative amount due.
--
-- Recording or invalidating a payment changes nothing else: not the event's
-- lifecycle status or booking, not any contract, not planning access, and it
-- sends no email. Clients get a narrow read-only summary for a contract they
-- can already read (verified signer, live access, not archived).

-- ===========================================================================
-- Payments
-- ===========================================================================

create table public.event_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  amount_cents bigint not null
    constraint event_payments_amount_range check (amount_cents between 1 and 99999999999),
  currency text not null
    constraint event_payments_currency_format check (currency ~ '^[A-Z]{3}$'),
  paid_on date not null
    constraint event_payments_paid_on_range check (paid_on >= date '2000-01-01'),
  reference text
    constraint event_payments_reference_length check (length(btrim(reference)) between 1 and 200 and reference = btrim(reference)),
  note text
    constraint event_payments_note_length check (length(btrim(note)) between 1 and 2000),
  idempotency_key uuid not null,
  recorded_by_user_id uuid not null,
  recorded_by_membership_id uuid,
  recorded_by_email text,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidated_by_user_id uuid,
  invalidated_by_membership_id uuid,
  invalidated_by_email text,
  invalidation_reason text
    constraint event_payments_reason_length check (length(btrim(invalidation_reason)) between 3 and 500),
  constraint event_payments_invalidation_complete check (
    (invalidated_at is null) = (invalidated_by_user_id is null)
    and (invalidated_at is null) = (invalidation_reason is null)),
  constraint event_payments_tenant_key unique (tenant_id, idempotency_key),
  constraint event_payments_tenant_id_id_key unique (tenant_id, id),
  constraint event_payments_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete restrict,
  constraint event_payments_recorded_by_fk foreign key (tenant_id, recorded_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (recorded_by_membership_id),
  constraint event_payments_invalidated_by_fk foreign key (tenant_id, invalidated_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (invalidated_by_membership_id)
);
comment on table public.event_payments is
  'Payments received outside Flux DJ, recorded manually by staff. Never updated or deleted; wrong entries are invalidated with a reason. Not verified with any provider.';
create index event_payments_tenant_event_idx on public.event_payments (tenant_id, event_id, created_at);
create index event_payments_tenant_recorded_by_idx on public.event_payments (tenant_id, recorded_by_membership_id);
create index event_payments_tenant_invalidated_by_idx on public.event_payments (tenant_id, invalidated_by_membership_id);

-- The recorded payment never changes; invalidation is set once.
create function private.event_payments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.tenant_id, new.event_id, new.amount_cents, new.currency, new.paid_on, new.reference, new.note, new.idempotency_key,
      new.recorded_by_user_id, new.recorded_by_email, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.event_id, old.amount_cents, old.currency, old.paid_on, old.reference, old.note, old.idempotency_key,
      old.recorded_by_user_id, old.recorded_by_email, old.created_at) then
    raise exception 'recorded payments are immutable; invalidate the entry and record a new one' using errcode = 'check_violation';
  end if;
  if old.invalidated_at is not null
     and (new.invalidated_at, new.invalidated_by_user_id, new.invalidated_by_email, new.invalidation_reason)
         is distinct from (old.invalidated_at, old.invalidated_by_user_id, old.invalidated_by_email, old.invalidation_reason) then
    raise exception 'an invalidated payment cannot change' using errcode = 'check_violation';
  end if;
  if old.invalidated_at is null and new.invalidated_at is not null
     and current_setting('flux.invalidating_payment', true) is distinct from new.id::text then
    raise exception 'payments are invalidated only through invalidate_event_payment' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger event_payments_guard before update on public.event_payments
  for each row execute function private.event_payments_guard();
create trigger event_payments_no_delete before delete on public.event_payments
  for each row execute function private.reject_change();

alter table public.event_payments enable row level security;
revoke all on public.event_payments from anon, authenticated;
grant select on public.event_payments to authenticated;
-- Staff of the tenant read the full history. Clients have no policy: they
-- only ever see the summary from client_payment_summary.
create policy event_payments_select_staff on public.event_payments
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- ===========================================================================
-- Invoice link
-- ===========================================================================

-- An absolute HTTPS URL with a host name and no credentials or whitespace.
create function private.is_https_url(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url is not null and length(p_url) <= 2000
    and p_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?([/?#][^[:space:]<>"\\]*)?$';
$$;

create table public.event_billing (
  event_id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  invoice_url text
    constraint event_billing_invoice_url_valid check (invoice_url is null or private.is_https_url(invoice_url)),
  version integer not null default 0
    constraint event_billing_version_nonnegative check (version >= 0),
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_billing_tenant_event_key unique (tenant_id, event_id),
  constraint event_billing_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete restrict
);
comment on table public.event_billing is
  'Optional external invoice URL per event (any provider). HTTPS only; Flux DJ never fetches it.';
create trigger event_billing_set_updated_at before update on public.event_billing
  for each row execute function private.set_updated_at();
create trigger event_billing_immutable before update on public.event_billing
  for each row execute function private.forbid_column_changes('event_id', 'tenant_id', 'created_at');
create trigger event_billing_no_delete before delete on public.event_billing
  for each row execute function private.reject_change();

alter table public.event_billing enable row level security;
revoke all on public.event_billing from anon, authenticated;
grant select on public.event_billing to authenticated;
create policy event_billing_select_staff on public.event_billing
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- ===========================================================================
-- Staff functions (membership checked inside)
-- ===========================================================================

create function private.payment_error(p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'payment_invalid: %', p_message using errcode = 'invalid_parameter_value';
end;
$$;

-- Records a received payment. Returns {"status":"recorded"|"replayed",
-- "payment_id"}. The same idempotency key with the same values replays; with
-- different values it is refused. Another valid payment with the same amount
-- and date on this event needs p_confirm_duplicate.
create function public.record_event_payment(
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
  return jsonb_build_object('status', 'recorded', 'payment_id', v_id);
end;
$$;

-- Invalidates a wrong entry once, with a reason. The entry stays in the
-- history. Invalidating it again returns "already_invalidated".
create function public.invalidate_event_payment(p_payment_id uuid, p_reason text)
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
  return jsonb_build_object('status', 'invalidated', 'invalidated_at', p.invalidated_at);
end;
$$;

-- Sets or clears the event's invoice URL. A stale p_expected_version (another
-- tab saved first) fails with SQLSTATE 40001. Returns the new version.
create function public.set_event_invoice_url(p_event_id uuid, p_invoice_url text, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  b public.event_billing%rowtype;
  v_url text := nullif(btrim(coalesce(p_invoice_url, '')), '');
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = e.id for update;
  if e.archived_at is not null then
    perform private.payment_error('the event is archived. Unarchive it before changing the invoice link');
  end if;
  if v_url is not null and not private.is_https_url(v_url) then
    perform private.payment_error('the invoice link must be a full https:// address');
  end if;
  select * into b from public.event_billing where event_id = e.id;
  if coalesce(b.version, 0) <> p_expected_version then
    raise exception 'draft_version_conflict: expected %, current %', p_expected_version, coalesce(b.version, 0)
      using errcode = 'serialization_failure';
  end if;
  insert into public.event_billing as x (event_id, tenant_id, invoice_url, version, updated_by_user_id)
  values (e.id, e.tenant_id, v_url, 1, (select auth.uid()))
  on conflict (event_id) do update
    set invoice_url = excluded.invoice_url, version = x.version + 1, updated_by_user_id = excluded.updated_by_user_id
  returning * into b;
  perform private.audit(e.tenant_id, 'event', e.id, 'invoice_link_changed', 'staff', (select auth.uid()),
    jsonb_build_object('has_link', v_url is not null));
  return b.version;
end;
$$;

-- ===========================================================================
-- Summary
-- ===========================================================================

create function private.event_payment_summary(p_event_id uuid)
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
    'invoice_url', (select b.invoice_url from public.event_billing b where b.event_id = e.id)
  );
end;
$$;
revoke execute on function private.event_payment_summary(uuid) from public, anon, authenticated;

-- Staff: the full summary for an event of their tenant.
create function public.event_payment_summary(p_event_id uuid)
returns jsonb
language plpgsql
stable
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
  return private.event_payment_summary(p_event_id);
end;
$$;

-- Client: a narrow read-only summary for the event of a contract the caller
-- can already read (verified signer, live access, nothing archived). No
-- references, notes, staff identities, invalidations or contract ids.
create function public.client_payment_summary(p_contract_id uuid, p_tenant_slug text)
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
    'invoice_url', s -> 'invoice_url'
  );
end;
$$;

-- ===========================================================================
-- Grants
-- ===========================================================================

revoke execute on function
  public.record_event_payment(uuid, bigint, date, text, text, uuid, boolean),
  public.invalidate_event_payment(uuid, text),
  public.set_event_invoice_url(uuid, text, integer),
  public.event_payment_summary(uuid),
  public.client_payment_summary(uuid, text)
  from public, anon;
grant execute on function
  public.record_event_payment(uuid, bigint, date, text, text, uuid, boolean),
  public.invalidate_event_payment(uuid, text),
  public.set_event_invoice_url(uuid, text, integer),
  public.event_payment_summary(uuid),
  public.client_payment_summary(uuid, text)
  to authenticated;
revoke execute on function private.payment_error(text), private.event_payments_guard() from public, anon, authenticated;
grant execute on function private.is_https_url(text) to authenticated, service_role;
