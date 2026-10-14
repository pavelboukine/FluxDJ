-- Events booked outside Flux DJ record no Flux payments, and planning
-- invitations follow the current primary contact.
--
-- Payments. Flux DJ's payment tracking (event_payments, event_billing)
-- belongs to the Flux booking lifecycle: deposits and balances against a
-- signed contract's frozen terms. An event booked elsewhere
-- (events.booking_source = 'external', set once at creation) uses Flux DJ for
-- planning only, so the database refuses, for every role:
--   * inserting a payment (record_event_payment: deposits, balances, any
--     manual payment; and direct writes by privileged roles),
--   * changing a payment (invalidate_event_payment),
--   * setting or changing its invoice link (set_event_invoice_url).
-- The check is a BEFORE INSERT OR UPDATE trigger on both tables, reading the
-- event's stored booking source, so every current and future write path is
-- covered without changing any function signature or grant. anon and
-- authenticated still have no direct write grants on either table. The
-- refusal is the existing payment error ("payment_invalid: ..."), raised
-- before the row is written; the whole transaction (audit, booking
-- evaluation) rolls back, so nothing is partly written and the event's
-- status never changes. Flux events are unaffected: their checks,
-- calculations, booking evaluation and existing rows are unchanged. No row
-- is read, rewritten or deleted by this migration (an external event can't
-- have payments: its source is set on insert and the 20261115000100 app was
-- never deployed).
--
-- Planning invitations (private.planning_invitation, otherwise unchanged).
-- An invitation is usable only while its client is still the event's
-- primary contact and the client's current email is still the invited
-- address. Changing the contact's email or the primary contact never moves
-- an invitation to another address or person; staff send a new one. Access
-- already granted (event_access) is unaffected, as before.
--
-- Migration-first: the previously deployed app never creates external
-- events, so its payment and invoice actions behave exactly as before.

create function private.event_finances_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.events e where e.tenant_id = new.tenant_id and e.id = new.event_id and e.booking_source = 'external') then
    perform private.payment_error('this event was booked outside Flux DJ, so Flux DJ doesn''t record its payments or invoice');
  end if;
  return new;
end;
$$;
comment on function private.event_finances_guard() is
  'Refuses payment and invoice rows for events booked outside Flux DJ (events.booking_source = external), for every role.';
revoke execute on function private.event_finances_guard() from public, anon, authenticated;

create trigger event_payments_external_guard before insert or update on public.event_payments
  for each row execute function private.event_finances_guard();
create trigger event_billing_external_guard before insert or update on public.event_billing
  for each row execute function private.event_finances_guard();

-- Unchanged apart from the two conditions on the current primary contact.
create or replace function private.planning_invitation(p_id uuid, p_token_hash text, p_tenant_slug text)
returns table (usable boolean, invitation_id uuid, tenant_id uuid, tenant_display_name text, event_id uuid, event_title text,
               event_date date, client_id uuid, client_name text, email text, accepted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select (i.revoked_at is null and i.expires_at > now() and t.archived_at is null and t.suspended_at is null
          and e.archived_at is null and e.booking_source = 'external' and c.archived_at is null
          -- Still the client's address: an email change never moves an invitation.
          and lower(c.email) = i.email
          -- Still the primary contact: only they are invited to planning.
          and exists (select 1 from public.event_clients ec
                      where ec.tenant_id = i.tenant_id and ec.event_id = i.event_id and ec.client_id = i.client_id and ec.is_primary)),
         i.id, i.tenant_id, t.display_name, e.id, e.title, e.event_date, c.id, c.name, i.email, i.accepted_at
  from public.planning_invitations i
  join public.tenants t on t.id = i.tenant_id
  join public.events e on e.tenant_id = i.tenant_id and e.id = i.event_id
  join public.clients c on c.tenant_id = i.tenant_id and c.id = i.client_id
  where t.slug = p_tenant_slug
    and ((p_id is not null and i.id = p_id) or (p_token_hash is not null and i.token_hash = p_token_hash));
$$;
