-- Events booked outside Flux DJ: standalone planning without a proposal,
-- contract or payment.
--
-- Booking source (events.booking_source, structured, set once)
--   flux      the event is booked through Flux DJ: proposal, approval,
--             contract, signature and the business's booking policy. Every
--             existing event, and the default for new ones. Unchanged.
--   external  staff affirm, when they create the event, that it is already
--             booked elsewhere (another agency, booked directly) and that
--             only its planning is managed here. Nothing is pretended: no
--             proposal, approval, contract, signature, payment or booking
--             confirmation is created, and lifecycle_status stays 'lead' with
--             booking_confirmed_at null (a check constraint holds external
--             events to exactly that, so they can never look Flux-booked).
--             Proposals can't be started for them, so no contract can be
--             generated either. Recorded payments are not blocked (they are
--             real money received), but nothing books the event from them.
-- Staff choose the source only when inserting the event (the same RLS
-- insert policy as every other column: active, non-removed members of a
-- non-suspended business). It can never change afterwards, for any role,
-- so an event with booking records can't be converted either way. Existing
-- events keep 'flux'; nothing is reclassified or rewritten.
--
-- Planning eligibility, one rule (private.event_booked_for_planning):
--   flux      booked by Flux (booking_confirmed_at set, lifecycle booked or
--             completed), exactly as before;
--   external  the staff affirmation itself.
-- client_can_access_plan keeps every other condition (verified, unrevoked
-- event access in a non-suspended business, neither event nor business
-- archived, a plan exists) and the setup gate (Event basics only from
-- booking), the client editing deadline and staff close, and answer
-- revisions are untouched.
--
-- Client access for external events (public.planning_invitations). A Flux
-- client gets event access only by accepting their contract invitation, which
-- an external event never has. Staff can now invite the event's primary
-- contact to planning, once planning is set up, exactly the way contract
-- invitations work: the emailed token (HMAC(PROPOSAL_LINK_SECRET,
-- "flux:planning-invite:v1:" + invitation id), only its SHA-256 stored)
-- only lets its holder ask for a verification email to the invited, frozen
-- address; accepting needs a signed-in user whose verified email equals it,
-- rechecked under the event lock, and grants event access to that event and
-- client only. Each send replaces the event's open invitation; archiving the
-- event revokes it. Only for external events: Flux events keep their
-- contract invitations. Nothing is sent automatically.
--
-- Emails reuse email_outbox ("planning_invitation", "planning_sign_in",
-- entity_type 'planning_invitation'), so suspension, archiving, the Emails
-- page and delivery tracking apply. claim_email_outbox no longer claims them,
-- so a worker deployed before this migration never renders them as
-- something else; only claim_planning_email_outbox does.
--
-- Read functions gain keys only: staff_dashboard (booking_source on upcoming
-- events; external events in the planning attention list), staff_event_list
-- (booking_source on rows; status "external", and Flux statuses now match
-- Flux events only), my_events (booking_source column appended).
--
-- Migration-first: the previously deployed app never inserts booking_source
-- (default 'flux') and calls nothing new, so it behaves exactly as before
-- until the new app is deployed.

-- ===========================================================================
-- Booking source
-- ===========================================================================

alter table public.events
  add column booking_source text not null default 'flux'
    constraint events_booking_source_valid check (booking_source in ('flux', 'external'));
alter table public.events
  add constraint events_external_not_flux_booked check (
    booking_source = 'flux' or (lifecycle_status = 'lead' and booking_confirmed_at is null and active_proposal_id is null));
comment on column public.events.booking_source is
  'flux: booked through Flux DJ (proposal, contract, booking policy). external: staff affirmed at creation that it is booked elsewhere; planning only. Set on insert, never changed.';

grant insert (booking_source) on public.events to authenticated;

drop trigger events_immutable on public.events;
create trigger events_immutable before update on public.events
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_at', 'booking_source');

-- The affirmation is audited with who made it.
create function private.events_audit_external_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.audit(new.tenant_id, 'event', new.id, 'booked_externally',
    case when (select auth.uid()) is null then 'system' else 'staff' end, (select auth.uid()), '{}'::jsonb);
  return null;
end;
$$;
revoke execute on function private.events_audit_external_booking() from public, anon, authenticated;
create trigger events_audit_external_booking after insert on public.events
  for each row when (new.booking_source = 'external')
  execute function private.events_audit_external_booking();

-- No proposals (and so no approvals or contracts) for an event booked elsewhere.
create function private.proposals_block_external_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.events e where e.tenant_id = new.tenant_id and e.id = new.event_id and e.booking_source = 'external') then
    raise exception 'external_booking: this event was booked outside Flux DJ, so it has no proposal or contract. Plan it from its planning page'
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;
revoke execute on function private.proposals_block_external_event() from public, anon, authenticated;
create trigger proposals_block_external_event before insert on public.proposals
  for each row execute function private.proposals_block_external_event();

-- ===========================================================================
-- Planning eligibility: one rule
-- ===========================================================================

create function private.event_booked_for_planning(p_event public.events)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case p_event.booking_source
    when 'external' then true
    when 'flux' then p_event.booking_confirmed_at is not null and p_event.lifecycle_status in ('booked', 'completed')
    else false
  end;
$$;
comment on function private.event_booked_for_planning(public.events) is
  'Whether the event is booked for client planning: by Flux (confirmed booking) or affirmed by staff as booked elsewhere. Archive, access and setup are checked by callers.';
revoke execute on function private.event_booked_for_planning(public.events) from public, anon, authenticated;

-- Unchanged apart from the booking condition, now the shared rule.
create or replace function private.client_can_access_plan(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.events e
    join public.tenants t on t.id = e.tenant_id
    join public.event_plans p on p.tenant_id = e.tenant_id and p.event_id = e.id
    where e.id = p_event_id
      and e.id in (select private.client_event_ids())
      and e.archived_at is null and t.archived_at is null
      and private.event_booked_for_planning(e)
  );
$$;

-- ===========================================================================
-- Planning invitations
-- ===========================================================================

create table public.planning_invitations (
  -- Chosen by the caller once per form visit (a retried send is a replay);
  -- the token is derived from it, so it exists before the row.
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  client_id uuid not null,
  -- The client's address when sent, frozen: only this verified email can accept.
  email text not null
    constraint planning_invitations_email_valid check (private.is_valid_email(email)),
  token_hash text not null
    constraint planning_invitations_token_hash_key unique
    constraint planning_invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  -- Actor columns are history, like audit_events.actor_id (no foreign key).
  invited_by uuid not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text
    constraint planning_invitations_revoke_reason_length check (length(revoke_reason) between 1 and 200),
  accepted_at timestamptz,
  accepted_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint planning_invitations_tenant_id_id_key unique (tenant_id, id),
  constraint planning_invitations_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete restrict,
  constraint planning_invitations_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict,
  constraint planning_invitations_revoked_complete check ((revoked_at is null) = (revoke_reason is null)),
  constraint planning_invitations_accepted_complete check ((accepted_at is null) = (accepted_by is null))
);
comment on table public.planning_invitations is
  'Invitations to plan an event booked elsewhere. Only the SHA-256 of the emailed token is stored. Accepting grants event access to the invited client only.';
create unique index planning_invitations_one_open_idx on public.planning_invitations (event_id) where revoked_at is null;
create index planning_invitations_tenant_event_idx on public.planning_invitations (tenant_id, event_id, created_at desc);
create index planning_invitations_tenant_client_idx on public.planning_invitations (tenant_id, client_id);

create trigger planning_invitations_set_updated_at before update on public.planning_invitations
  for each row execute function private.set_updated_at();
create trigger planning_invitations_immutable before update on public.planning_invitations
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'client_id', 'email', 'token_hash', 'expires_at', 'invited_by', 'created_at');
create trigger planning_invitations_no_delete before delete on public.planning_invitations
  for each row execute function private.reject_change();
create trigger planning_invitations_workspace_suspended before insert or update or delete on public.planning_invitations
  for each row execute function private.tenant_write_guard();

-- Revocation and acceptance are recorded once.
create function private.planning_invitations_once()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null and (new.revoked_at, new.revoked_by, new.revoke_reason) is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason) then
    raise exception 'a revoked invitation cannot change' using errcode = 'check_violation';
  end if;
  if old.accepted_at is not null and (new.accepted_at, new.accepted_by) is distinct from (old.accepted_at, old.accepted_by) then
    raise exception 'acceptance is recorded once' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger planning_invitations_once before update on public.planning_invitations
  for each row execute function private.planning_invitations_once();

alter table public.planning_invitations enable row level security;
revoke all on public.planning_invitations from anon, authenticated;
-- Staff read their business's invitations (state on the event page); only
-- the functions below write. The token hash is never readable.
grant select (id, tenant_id, event_id, client_id, email, expires_at, invited_by, revoked_at, revoke_reason, accepted_at, created_at)
  on public.planning_invitations to authenticated;
create policy planning_invitations_select_staff on public.planning_invitations
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- ---------------------------------------------------------------------------
-- Email outbox: planning invitation emails
-- ---------------------------------------------------------------------------

alter table public.email_outbox drop constraint email_outbox_event_type_valid;
alter table public.email_outbox drop constraint email_outbox_entity_type_valid;
alter table public.email_outbox
  add constraint email_outbox_event_type_valid check (event_type in (
    'proposal_sent', 'proposal_link_opened', 'proposal_submitted', 'proposal_approved',
    'contract_sent', 'contract_sign_in', 'contract_voided', 'contract_signed_copy', 'booking_confirmed',
    'platform_invitation', 'platform_sign_in', 'staff_invitation', 'staff_sign_in',
    'planning_invitation', 'planning_sign_in')),
  add constraint email_outbox_entity_type_valid check (entity_type in (
    'proposal', 'contract', 'platform_invitation', 'staff_invitation', 'planning_invitation')),
  add constraint email_outbox_planning_scope check (
    (entity_type = 'planning_invitation') = (event_type in ('planning_invitation', 'planning_sign_in'))
    and (entity_type <> 'planning_invitation' or access_link_id is null));
create index email_outbox_planning_idx on public.email_outbox (entity_id, event_type, created_at)
  where entity_type = 'planning_invitation';

create function private.enqueue_planning_email(
  p_tenant_id uuid, p_event_type text, p_recipient text, p_invitation_id uuid, p_payload jsonb, p_dedup_key text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key)
  values (p_tenant_id, p_event_type, lower(p_recipient), 'planning_invitation', p_invitation_id, coalesce(p_payload, '{}'::jsonb), p_dedup_key)
  on conflict (dedup_key) do nothing;
$$;
revoke execute on function private.enqueue_planning_email(uuid, text, text, uuid, jsonb, text) from public, anon, authenticated;

-- Revokes the event's open invitation (if any) and cancels its pending emails.
create function private.revoke_planning_invitations(p_event_id uuid, p_reason text, p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with revoked as (
    update public.planning_invitations set revoked_at = now(), revoked_by = p_actor, revoke_reason = left(p_reason, 200)
      where event_id = p_event_id and revoked_at is null
      returning id
  )
  select coalesce(array_agg(id), '{}') into v_ids from revoked;
  if cardinality(v_ids) > 0 then
    update public.email_outbox set status = 'cancelled', last_error = left('Cancelled: ' || p_reason, 1000), locked_until = null
      where entity_type = 'planning_invitation' and entity_id = any (v_ids) and status = 'pending';
  end if;
  return cardinality(v_ids);
end;
$$;
revoke execute on function private.revoke_planning_invitations(uuid, text, uuid) from public, anon, authenticated;

-- Archiving an event revokes its planning invitation, like its other client
-- links (set_event_archived itself is unchanged). Restoring doesn't reissue it.
create function private.events_archive_planning_invitations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.revoke_planning_invitations(new.id, 'event archived', (select auth.uid()));
  return null;
end;
$$;
revoke execute on function private.events_archive_planning_invitations() from public, anon, authenticated;
create trigger events_archive_planning_invitations after update of archived_at on public.events
  for each row when (new.archived_at is not null and old.archived_at is null)
  execute function private.events_archive_planning_invitations();

-- What an invitation (by id or token hash) currently allows. Usable while
-- open and unexpired, the event booked elsewhere and not archived, the
-- business active, and the invited client still an active contact of the event.
create function private.planning_invitation(p_id uuid, p_token_hash text, p_tenant_slug text)
returns table (usable boolean, invitation_id uuid, tenant_id uuid, tenant_display_name text, event_id uuid, event_title text,
               event_date date, client_id uuid, client_name text, email text, accepted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select (i.revoked_at is null and i.expires_at > now() and t.archived_at is null and t.suspended_at is null
          and e.archived_at is null and e.booking_source = 'external' and c.archived_at is null
          and exists (select 1 from public.event_clients ec
                      where ec.tenant_id = i.tenant_id and ec.event_id = i.event_id and ec.client_id = i.client_id)),
         i.id, i.tenant_id, t.display_name, e.id, e.title, e.event_date, c.id, c.name, i.email, i.accepted_at
  from public.planning_invitations i
  join public.tenants t on t.id = i.tenant_id
  join public.events e on e.tenant_id = i.tenant_id and e.id = i.event_id
  join public.clients c on c.tenant_id = i.tenant_id and c.id = i.client_id
  where t.slug = p_tenant_slug
    and ((p_id is not null and i.id = p_id) or (p_token_hash is not null and i.token_hash = p_token_hash));
$$;
revoke execute on function private.planning_invitation(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Staff: invite the primary contact to planning
-- ---------------------------------------------------------------------------

-- Sends a planning invitation to the event's primary contact, replacing any
-- open one (its link stops working, its queued emails are cancelled). A
-- repeat with the same invitation id returns the first result.
create function public.send_planning_invitation(p_event_id uuid, p_invitation_id uuid, p_token_hash text)
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
  if e.booking_source <> 'external' then
    perform private.planning_error('planning invitations are for events booked elsewhere. A Flux booking gives the client access when they open their contract');
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  if not found or private.plan_awaiting_setup(v_plan) then
    perform private.planning_error('set up planning before inviting the client');
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

-- ---------------------------------------------------------------------------
-- Client: verification email, status and acceptance
-- ---------------------------------------------------------------------------

-- Queues a verification email to the invited address (service role, after
-- the app's per-IP limit). The token only authorizes this; it never signs
-- anyone in. At most 3 requests per invitation per 15 minutes.
create function public.request_planning_sign_in(p_token_hash text, p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i record;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into i from private.planning_invitation(null, p_token_hash, p_tenant_slug);
  if not found or not i.usable then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform 1 from public.planning_invitations where id = i.invitation_id for update;
  if (select count(*) from public.email_outbox o
      where o.entity_type = 'planning_invitation' and o.entity_id = i.invitation_id and o.event_type = 'planning_sign_in'
        and o.created_at > now() - interval '15 minutes') >= 3 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  perform private.enqueue_planning_email(i.tenant_id, 'planning_sign_in', i.email, i.invitation_id,
    jsonb_build_object('client_name', i.client_name, 'event_title', i.event_title),
    'planning_sign_in:' || i.invitation_id || ':' || gen_random_uuid());
  perform private.audit(i.tenant_id, 'event', i.event_id, 'planning_sign_in_requested', 'client', null,
    jsonb_build_object('invitation_id', i.invitation_id));
  return jsonb_build_object('status', 'ok', 'masked_email', private.masked_email(i.email), 'tenant_display_name', i.tenant_display_name);
end;
$$;

-- What the signed-in user may do with an invitation. Reveals the event only
-- to the verified invited address.
create function public.client_planning_invitation_status(p_invitation_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i record;
  v_email text;
begin
  if (select auth.uid()) is null then
    return jsonb_build_object('state', 'signed_out');
  end if;
  select * into i from private.planning_invitation(p_invitation_id, null, p_tenant_slug);
  if not found or not i.usable then
    return jsonb_build_object('state', 'invalid');
  end if;
  v_email := private.current_verified_email();
  if v_email is null then
    return jsonb_build_object('state', 'unverified', 'tenant_display_name', i.tenant_display_name);
  end if;
  if v_email <> i.email then
    return jsonb_build_object('state', 'wrong_account', 'tenant_display_name', i.tenant_display_name,
      'signed_in_email', v_email, 'intended_email', private.masked_email(i.email));
  end if;
  return jsonb_build_object(
    'state', case when exists (
      select 1 from public.event_access ea where ea.tenant_id = i.tenant_id and ea.event_id = i.event_id
        and ea.user_id = (select auth.uid()) and ea.client_id = i.client_id and ea.revoked_at is null)
      then 'accepted' else 'ready' end,
    'tenant_display_name', i.tenant_display_name, 'event_title', i.event_title, 'event_date', i.event_date,
    'client_name', i.client_name, 'event_id', i.event_id);
end;
$$;

-- Grants the verified invited client access to the event, idempotently,
-- after rechecking everything under the event lock. Planning itself still
-- follows client_can_access_plan (set up, not archived, editing rules).
create function public.accept_planning_invitation(p_invitation_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i record;
  v_uid uuid := (select auth.uid());
  v_email text;
  v_existing record;
begin
  if v_uid is null then
    return jsonb_build_object('state', 'signed_out');
  end if;
  select * into i from private.planning_invitation(p_invitation_id, null, p_tenant_slug);
  if not found then
    return jsonb_build_object('state', 'invalid');
  end if;
  -- Lock order: event, then invitation.
  perform 1 from public.events where tenant_id = i.tenant_id and id = i.event_id for update;
  perform 1 from public.planning_invitations where id = i.invitation_id for update;
  select * into i from private.planning_invitation(p_invitation_id, null, p_tenant_slug);
  if not i.usable then
    return jsonb_build_object('state', 'invalid');
  end if;
  v_email := private.current_verified_email();
  if v_email is null then
    return jsonb_build_object('state', 'unverified');
  end if;
  if v_email <> i.email then
    return jsonb_build_object('state', 'wrong_account');
  end if;

  select ea.client_id into v_existing from public.event_access ea
  where ea.tenant_id = i.tenant_id and ea.event_id = i.event_id and ea.user_id = v_uid and ea.revoked_at is null;
  if found and v_existing.client_id <> i.client_id then
    return jsonb_build_object('state', 'invalid');
  end if;
  if not found then
    insert into public.event_access (tenant_id, event_id, client_id, user_id)
    values (i.tenant_id, i.event_id, i.client_id, v_uid);
    perform private.audit(i.tenant_id, 'event', i.event_id, 'client_access_granted', 'client', v_uid,
      jsonb_build_object('planning_invitation_id', i.invitation_id));
  end if;
  update public.planning_invitations set accepted_at = now(), accepted_by = v_uid
    where id = i.invitation_id and accepted_at is null;
  return jsonb_build_object('state', 'accepted', 'event_id', i.event_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------------

-- Claims due planning invitation emails (service role), of active businesses
-- only. "deliverable" is rechecked at claim time: the invitation is still
-- usable and the row is addressed to it.
create function public.claim_planning_email_outbox(
  p_limit integer default 10, p_lock_seconds integer default 120, p_tenant_id uuid default null, p_invitation_id uuid default null
)
returns table (
  id uuid, tenant_id uuid, event_type text, recipient_email text, payload jsonb, attempts integer,
  invitation_id uuid, token_hash text, expires_at timestamptz, deliverable boolean,
  tenant_slug text, tenant_display_name text, tenant_reply_to text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.email_outbox o
    set status = 'failed', locked_until = null, last_error = coalesce(o.last_error, 'delivery did not complete')
    where o.entity_type = 'planning_invitation' and o.status = 'sending' and o.locked_until < now() and o.attempts >= o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id)
      and (p_invitation_id is null or o.entity_id = p_invitation_id);

  return query
  with due as (
    select o.id from public.email_outbox o
    where o.entity_type = 'planning_invitation'
      and (o.status = 'pending' or (o.status = 'sending' and o.locked_until < now()))
      and o.next_attempt_at <= now()
      and o.attempts < o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id)
      and (p_invitation_id is null or o.entity_id = p_invitation_id)
      and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null and t.suspended_at is null)
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
  select c.id, c.tenant_id, c.event_type, c.recipient_email, c.payload, c.attempts, i.id, i.token_hash, i.expires_at,
         coalesce(x.usable and c.recipient_email = i.email, false),
         t.slug, t.display_name, t.reply_to_email
  from claimed c
  join public.tenants t on t.id = c.tenant_id
  left join public.planning_invitations i on i.tenant_id = c.tenant_id and i.id = c.entity_id
  left join lateral (select p.usable from private.planning_invitation(i.id, null, t.slug) p) x on true;
end;
$$;

revoke execute on function
  public.send_planning_invitation(uuid, uuid, text),
  public.request_planning_sign_in(text, text),
  public.client_planning_invitation_status(uuid, text),
  public.accept_planning_invitation(uuid, text),
  public.claim_planning_email_outbox(integer, integer, uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.send_planning_invitation(uuid, uuid, text),
  public.client_planning_invitation_status(uuid, text),
  public.accept_planning_invitation(uuid, text)
  to authenticated;
grant execute on function
  public.request_planning_sign_in(text, text),
  public.claim_planning_email_outbox(integer, integer, uuid, uuid)
  to service_role;

-- ===========================================================================
-- Client home: the event's booking source (column appended)
-- ===========================================================================

drop function public.my_events();
create function public.my_events()
returns table (
  event_id uuid,
  tenant_slug text,
  tenant_display_name text,
  title text,
  event_type text,
  event_date date,
  timezone text,
  venue_name text,
  venue_address text,
  lifecycle_status text,
  booking_source text
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, t.slug, t.display_name, e.title, e.event_type, e.event_date,
         e.timezone, e.venue_name, e.venue_address, e.lifecycle_status, e.booking_source
  from public.events e
  join public.tenants t on t.id = e.tenant_id
  where e.id in (select private.client_event_ids())
    and t.archived_at is null
    and e.archived_at is null
  order by e.event_date, e.id;
$$;
revoke execute on function public.my_events() from public, anon;
grant execute on function public.my_events() to authenticated;

-- ===========================================================================
-- Staff reads: keys added only (bodies otherwise unchanged)
-- ===========================================================================

-- Unchanged apart from leaving planning invitation emails to claim_planning_email_outbox.
CREATE OR REPLACE FUNCTION public.claim_email_outbox(p_limit integer DEFAULT 10, p_lock_seconds integer DEFAULT 120, p_tenant_id uuid DEFAULT NULL::uuid, p_include_booking boolean DEFAULT false)
 RETURNS TABLE(id uuid, tenant_id uuid, event_type text, recipient_email text, entity_id uuid, payload jsonb, attempts integer, access_link_id uuid, link_token_hash text, link_usable boolean, proposal_active boolean, tenant_slug text, tenant_display_name text, tenant_reply_to text, contract_deliverable boolean, contract_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      -- Staff invitation emails are claimed only by claim_staff_email_outbox.
      and o.entity_type <> 'staff_invitation'
      -- Planning invitation emails are claimed only by claim_planning_email_outbox.
      and o.entity_type <> 'planning_invitation'
      -- Archived businesses send nothing.
      and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null and t.suspended_at is null)
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
$function$;

-- Unchanged apart from booking_source on upcoming events and external events
-- (planning set up, booked elsewhere) in the planning attention list.
CREATE OR REPLACE FUNCTION public.staff_dashboard(p_tenant_id uuid, p_upcoming_limit integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_at timestamptz := now();
  v_limit integer := least(greatest(coalesce(p_upcoming_limit, 8), 1), 50);
  v_upcoming jsonb;
  v_more boolean;
  t public.tenants%rowtype;
begin
  perform private.require_staff_of(p_tenant_id);
  select * into t from public.tenants where id = p_tenant_id;

  with upcoming as (
    select e.id, e.title, e.event_date, e.timezone, e.venue_name, e.lifecycle_status, e.booking_source,
           (select c.name from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
            where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary limit 1) as client_name,
           exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed') as contract_signed,
           (select case when ap.status = 'sent' and ap.expires_at is not null and ap.expires_at <= v_at then 'expired' else ap.status end
            from public.proposals ap where ap.tenant_id = e.tenant_id and ap.id = e.active_proposal_id) as proposal_status,
           exists (select 1 from public.proposals d where d.tenant_id = e.tenant_id and d.event_id = e.id and d.status = 'draft') as proposal_draft,
           (select k.status from public.contracts k
            where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status in ('signed', 'sent', 'draft')
            order by case k.status when 'signed' then 1 when 'sent' then 2 else 3 end limit 1) as contract_status
    from public.events e
    where e.tenant_id = p_tenant_id and e.archived_at is null
      and e.event_date >= (v_at at time zone e.timezone)::date
    order by e.event_date, e.title, e.id
    limit v_limit + 1
  )
  select coalesce(jsonb_agg(to_jsonb(u) order by u.event_date, u.title, u.id), '[]'::jsonb) into v_upcoming from upcoming u;
  v_more := jsonb_array_length(v_upcoming) > v_limit;
  if v_more then
    v_upcoming := v_upcoming - v_limit;
  end if;

  return jsonb_build_object(
    'now', v_at,
    'planning_window_days', 7,
    'upcoming', v_upcoming,
    'upcoming_more', v_more,
    'submitted', coalesce((
      select jsonb_agg(jsonb_build_object(
               'proposal_id', p.id, 'event_id', e.id, 'title', e.title, 'event_date', e.event_date, 'revision', p.revision,
               'submitted_at', (select max(s.submitted_at) from public.proposal_selections s where s.tenant_id = p.tenant_id and s.proposal_id = p.id))
             order by e.event_date, e.title)
      from public.proposals p
      join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id and e.active_proposal_id = p.id
      where p.tenant_id = p_tenant_id and p.status = 'submitted'
        and e.archived_at is null and e.lifecycle_status not in ('cancelled', 'completed')), '[]'::jsonb),
    'awaiting_deposit', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', e.id, 'title', e.title, 'event_date', e.event_date,
               'currency', s.summary ->> 'currency',
               'deposit_outstanding_cents', (s.summary ->> 'deposit_outstanding_cents')::bigint)
             order by e.event_date, e.title)
      from public.events e
      cross join lateral (select private.event_payment_summary(e.id) as summary) s
      where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'awaiting_deposit'), '[]'::jsonb),
    'booking_check', coalesce((
      select jsonb_agg(jsonb_build_object('event_id', e.id, 'title', e.title, 'event_date', e.event_date) order by e.event_date, e.title)
      from public.events e
      where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'awaiting_signature'
        and exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id
                    and k.status = 'signed' and k.booking_policy is null)), '[]'::jsonb),
    'planning', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', x.id, 'title', x.title, 'event_date', x.event_date, 'timezone', x.timezone,
               'state', x.state, 'deadline', x.deadline, 'closes_at', x.closes_at,
               'requirements_met', (x.progress ->> 'requirements_met')::int,
               'requirements_total', (x.progress ->> 'requirements_total')::int)
             order by coalesce(x.closes_at, x.deadline), x.title)
      from (
        select c.*, private.plan_progress(c.plan_id) as progress
        from (
          select e.id, e.title, e.event_date, e.timezone, ep.id as plan_id, d.deadline,
                 private.plan_editing_state(d.deadline, e.planning_override_until, v_at, e.planning_client_closed_at) as state,
                 case private.plan_editing_state(d.deadline, e.planning_override_until, v_at, e.planning_client_closed_at)
                   when 'open' then d.deadline
                   when 'reopened' then e.planning_override_until end as closes_at
          from public.events e
          join public.event_plans ep on ep.tenant_id = e.tenant_id and ep.event_id = e.id
          cross join lateral (select private.plan_deadline(e, ep) as deadline) d
          where e.tenant_id = p_tenant_id and e.archived_at is null
            and (e.lifecycle_status = 'booked' or e.booking_source = 'external')
            and e.event_date >= (v_at at time zone e.timezone)::date
        ) c
        where c.state <> 'open' or c.deadline <= v_at + interval '7 days'
      ) x
      where (x.progress ->> 'requirements_met')::int < (x.progress ->> 'requirements_total')::int), '[]'::jsonb),
    'failed_emails', (select count(*) from public.email_outbox o where o.tenant_id = p_tenant_id and o.status = 'failed'),
    'setup', jsonb_build_object(
      'identity_saved', t.business_address is not null and t.contact_email is not null,
      'tax_categories', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(t.tax_categories) k), '[]'::jsonb),
      'used_tax_categories', coalesce((
        select jsonb_agg(distinct u.cat)
        from (select g.tax_category as cat from public.gear_items g where g.tenant_id = p_tenant_id and g.active
              union
              select pk.tax_category from public.packages pk where pk.tenant_id = p_tenant_id and pk.active) u), '[]'::jsonb),
      'active_packages', (select count(*) from public.packages pk where pk.tenant_id = p_tenant_id and pk.active),
      'usable_proposal_templates', (
        select count(*) from public.proposal_templates pt
        where pt.tenant_id = p_tenant_id and pt.active
          and (select count(*) from public.proposal_template_packages tp
               join public.packages pk on pk.tenant_id = tp.tenant_id and pk.id = tp.package_id and pk.active
               where tp.tenant_id = pt.tenant_id and tp.template_id = pt.id) = 3),
      'client_use_contract_templates', (
        select count(distinct ct.id) from public.contract_templates ct
        join public.contract_template_versions v on v.tenant_id = ct.tenant_id and v.template_id = ct.id
        where ct.tenant_id = p_tenant_id and ct.active and v.published_at is not null and v.usage = 'client_use')));
end;
$function$;

-- Unchanged apart from booking_source on rows and the "external" status filter
-- (Flux statuses now match Flux events only).
CREATE OR REPLACE FUNCTION public.staff_event_list(p_tenant_id uuid, p_view text DEFAULT 'upcoming'::text, p_status text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_include_archived boolean DEFAULT false, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_event_type text DEFAULT NULL::text, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_sort text DEFAULT 'date'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_at timestamptz := now();
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sort text := coalesce(p_sort, 'date');
  v_result jsonb;
begin
  perform private.require_staff_of(p_tenant_id);
  if p_view is null or p_view not in ('upcoming', 'past', 'all') then
    raise exception 'list_invalid: unknown date view' using errcode = 'invalid_parameter_value';
  end if;
  if p_status is not null and p_status not in ('lead', 'pending_approval', 'awaiting_signature', 'awaiting_deposit', 'booked', 'completed', 'cancelled', 'external') then
    raise exception 'list_invalid: unknown status' using errcode = 'invalid_parameter_value';
  end if;
  if v_query is not null and length(v_query) > 100 then
    raise exception 'list_invalid: the search is too long' using errcode = 'invalid_parameter_value';
  end if;
  if p_event_type is not null and p_event_type !~ '^[a-z][a-z0-9_]{0,39}$' then
    raise exception 'list_invalid: unknown event type' using errcode = 'invalid_parameter_value';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'list_invalid: the start date is after the end date' using errcode = 'invalid_parameter_value';
  end if;
  if v_sort not in ('date', 'updated', 'created') then
    raise exception 'list_invalid: unknown sort' using errcode = 'invalid_parameter_value';
  end if;

  with candidates as (
    select e.id, e.title, e.event_type, e.event_date, e.timezone, e.venue_name, e.lifecycle_status, e.booking_source, e.archived_at,
           e.active_proposal_id, e.created_at, e.updated_at, pc.name as client_name
    from public.events e
    left join lateral (
      select c.name, c.email from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
      where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary limit 1
    ) pc on true
    where e.tenant_id = p_tenant_id
      and (p_view = 'all'
           or (p_view = 'upcoming' and e.event_date >= (v_at at time zone e.timezone)::date)
           or (p_view = 'past' and e.event_date < (v_at at time zone e.timezone)::date))
      -- "external": booked elsewhere; every other status is a Flux booking stage.
      and (p_status is null
           or (p_status = 'external' and e.booking_source = 'external')
           or (p_status <> 'external' and e.booking_source = 'flux' and e.lifecycle_status = p_status))
      and (p_event_type is null or e.event_type = p_event_type)
      and (p_date_from is null or e.event_date >= p_date_from)
      and (p_date_to is null or e.event_date <= p_date_to)
      and (v_query is null
           or e.title ilike private.contains_pattern(v_query)
           or e.venue_name ilike private.contains_pattern(v_query)
           or pc.name ilike private.contains_pattern(v_query)
           or pc.email ilike private.contains_pattern(v_query))
  ),
  matching as (
    select * from candidates where p_include_archived or archived_at is null
  ),
  page as (
    select m.* from matching m
    order by
      case when v_sort = 'updated' then m.updated_at end desc,
      case when v_sort = 'created' then m.created_at end desc,
      case when v_sort = 'date' and p_view = 'upcoming' then m.event_date end asc,
      case when v_sort = 'date' and p_view <> 'upcoming' then m.event_date end desc,
      m.event_date, m.title, m.id
    limit v_limit offset v_offset
  ),
  described as (
    select p.*,
           (select case when ap.status = 'sent' and ap.expires_at is not null and ap.expires_at <= v_at then 'expired' else ap.status end
            from public.proposals ap where ap.tenant_id = p_tenant_id and ap.id = p.active_proposal_id) as proposal_status,
           exists (select 1 from public.proposals d where d.tenant_id = p_tenant_id and d.event_id = p.id and d.status = 'draft') as proposal_draft,
           (select k.status from public.contracts k
            where k.tenant_id = p_tenant_id and k.event_id = p.id and k.status in ('signed', 'sent', 'draft')
            order by case k.status when 'signed' then 1 when 'sent' then 2 else 3 end limit 1) as contract_status
    from page p
  )
  select jsonb_build_object(
    'total', (select count(*) from matching),
    'archived_excluded', case when p_include_archived then 0 else (select count(*) from candidates where archived_at is not null) end,
    'tenant_events', (select count(*) from public.events e where e.tenant_id = p_tenant_id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'title', d.title, 'event_type', d.event_type, 'event_date', d.event_date, 'timezone', d.timezone,
               'venue_name', d.venue_name, 'lifecycle_status', d.lifecycle_status, 'booking_source', d.booking_source,
               'archived', d.archived_at is not null,
               'client_name', d.client_name, 'today', (v_at at time zone d.timezone)::date,
               'contract_signed', coalesce(d.contract_status = 'signed', false),
               'proposal_status', d.proposal_status, 'proposal_draft', d.proposal_draft, 'contract_status', d.contract_status,
               'updated_at', d.updated_at, 'created_at', d.created_at)
             order by
               case when v_sort = 'updated' then d.updated_at end desc,
               case when v_sort = 'created' then d.created_at end desc,
               case when v_sort = 'date' and p_view = 'upcoming' then d.event_date end asc,
               case when v_sort = 'date' and p_view <> 'upcoming' then d.event_date end desc,
               d.event_date, d.title, d.id)
      from described d), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$function$;
