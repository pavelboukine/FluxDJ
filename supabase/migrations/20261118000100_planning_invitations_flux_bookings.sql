-- Planning invitations for every event booked for planning: Flux bookings as
-- well as events booked elsewhere.
--
-- Until now public.planning_invitations (20261115000100) worked only for
-- events booked elsewhere; a Flux client reached planning through the access
-- their contract invitation granted, and staff had no way to tell them
-- planning was ready. Now staff can send the same invitation for a Flux
-- event once Flux has booked it. Nothing else about invitations changes:
-- same table, token scheme (HMAC of the invitation id, only its SHA-256
-- stored), 14-day expiry, frozen primary-contact address, verified-email
-- acceptance under the event lock, replacement, archive revocation, outbox
-- delivery through claim_planning_email_outbox. Nothing is sent
-- automatically: not on creation, booking, contract signature, payment,
-- planning setup or opening client editing.
--
-- Eligibility is the one shared rule, private.event_booked_for_planning:
--   flux      booked by Flux (booking_confirmed_at set, lifecycle booked or
--             completed). A lead, a proposal or contract in progress, an
--             event awaiting its deposit or a cancelled event can't be
--             invited, and an invitation stops working if the event stops
--             being booked (for example cancelled);
--   external  the staff affirmation, as before.
-- Flux booking prerequisites are untouched: the invitation never books an
-- event or bypasses its contract or booking policy.
--
-- Sending also requires client editing to be open (open, or reopened by
-- staff): the email asks the client to fill planning in. If editing is
-- closed, staff open it first on the planning page; sending never opens it.
-- Accepting doesn't check editing: a client who accepts after editing closed
-- reads planning, as every client with access does.
--
-- Accepting a Flux invitation when the user already has access to the event
-- for the same client (from the contract) only records the acceptance: no
-- second access row, and contract access and signed evidence are untouched.
--
-- Functions replaced (signatures, grants and security unchanged):
--   private.planning_invitation      the booking condition is the shared rule;
--   public.send_planning_invitation  the booking condition is the shared rule,
--                                    plus the client editing check.
--
-- Migration-first: the deployed app offers invitations only on events booked
-- elsewhere, which behave exactly as before (the editing check only refuses
-- a send while editing is closed, with a readable error). Its worker renders
-- any planning invitation with the earlier "Your event is booked" wording,
-- which is true for a Flux booking too.

create or replace function private.planning_invitation(p_id uuid, p_token_hash text, p_tenant_slug text)
returns table (usable boolean, invitation_id uuid, tenant_id uuid, tenant_display_name text, event_id uuid, event_title text,
               event_date date, client_id uuid, client_name text, email text, accepted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select (i.revoked_at is null and i.expires_at > now() and t.archived_at is null and t.suspended_at is null
          and e.archived_at is null and private.event_booked_for_planning(e) and c.archived_at is null
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

-- Sends a planning invitation to the event's primary contact, replacing any
-- open one (its link stops working, its queued emails are cancelled). A
-- repeat with the same invitation id returns the first result.
create or replace function public.send_planning_invitation(p_event_id uuid, p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  v_plan public.event_plans%rowtype;
  v_client public.clients%rowtype;
  v_existing public.planning_invitations%rowtype;
  v_expires timestamptz := now() + interval '14 days';
  v_replaced integer;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = e.id for update;
  select * into t from public.tenants where id = e.tenant_id;

  if p_invitation_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation link' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_existing from public.planning_invitations where id = p_invitation_id;
  if found then
    if v_existing.event_id <> e.id or v_existing.token_hash <> p_token_hash then
      raise exception 'invalid invitation link' using errcode = 'invalid_parameter_value';
    end if;
    return jsonb_build_object('status', 'sent', 'replayed', true, 'invitation_id', v_existing.id,
      'recipient_email', v_existing.email, 'expires_at', v_existing.expires_at);
  end if;

  if e.archived_at is not null or t.archived_at is not null then
    perform private.planning_error('the event is archived. Unarchive it before inviting the client');
  end if;
  if not private.event_booked_for_planning(e) then
    perform private.planning_error('the event isn''t booked yet. Invite the client to planning once the booking is confirmed');
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  if not found or private.plan_awaiting_setup(v_plan) then
    perform private.planning_error('set up planning before inviting the client');
  end if;
  if private.plan_editing_state(private.plan_deadline(e, v_plan), e.planning_override_until, now(), e.planning_client_closed_at) = 'closed' then
    perform private.planning_error('client editing is closed. Open client editing on the planning page before inviting the client');
  end if;
  select c.* into v_client
  from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary;
  if not found or v_client.archived_at is not null then
    perform private.planning_error('add an active primary contact to invite');
  end if;

  v_replaced := private.revoke_planning_invitations(e.id, 'replaced by a new invitation', (select auth.uid()));
  insert into public.planning_invitations (id, tenant_id, event_id, client_id, email, token_hash, expires_at, invited_by)
  values (p_invitation_id, e.tenant_id, e.id, v_client.id, lower(v_client.email), p_token_hash, v_expires, (select auth.uid()));
  perform private.enqueue_planning_email(e.tenant_id, 'planning_invitation', v_client.email, p_invitation_id,
    jsonb_build_object('client_name', v_client.name, 'event_title', e.title, 'event_date', e.event_date, 'expires_at', v_expires),
    'planning_invitation:' || p_invitation_id);
  perform private.audit(e.tenant_id, 'event', e.id, 'planning_invitation_sent', 'staff', (select auth.uid()),
    jsonb_build_object('invitation_id', p_invitation_id, 'client_id', v_client.id, 'replaced', v_replaced));
  return jsonb_build_object('status', 'sent', 'replayed', false, 'invitation_id', p_invitation_id,
    'recipient_email', lower(v_client.email), 'expires_at', v_expires);
end;
$$;

comment on table public.planning_invitations is
  'Invitations to plan an event booked for planning (by Flux, or elsewhere). Only the SHA-256 of the emailed token is stored. Accepting grants event access to the invited client only.';
