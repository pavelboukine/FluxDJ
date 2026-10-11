-- Staff invitations and team management: a business owner invites staff by
-- email, resends or cancels invitations, and removes staff members.
-- Separate from platform (DJ owner) invitations, which create a business:
-- a staff invitation only grants a staff membership in an existing one.
--
-- Memberships
--   * Removal is soft (removed_at, removed_by). Eight business tables point at
--     memberships for attribution (who created a proposal, approved it,
--     generated or published a contract, recorded a payment) with ON DELETE
--     SET NULL, and several of those columns are immutable, so deleting the
--     membership of anyone who ever created a proposal fails. The row stays;
--     every role-agnostic gate (member_tenant_ids, require_staff_of,
--     my_workspaces, tenant_write_guard) now ignores removed rows, so access
--     ends on the member's next request, whatever their session.
--   * Owner rows can never be removed (check constraint), so owner-only
--     checks elsewhere stay correct unchanged.
--   * Memberships change only through these functions and
--     accept_platform_invitation: the direct insert/update/delete grants and
--     policies for authenticated users are dropped (the app never used them;
--     they let an owner add any known user id without consent, unaudited).
--
-- Invitations (public.staff_invitations)
--   * One open (unaccepted, uncancelled) invitation per business and email.
--     The id comes from the caller, once per form visit, so a retried create
--     returns the invitation already made ("replayed") without another email.
--   * The emailed token is HMAC(PROPOSAL_LINK_SECRET, "flux:staff-invite:v1:"
--     + link_id), derived by the app; only its SHA-256 is stored. A resend
--     rotates link_id (the caller's request id, so a retried resend is a
--     replay) and token_hash: earlier links stop working, queued emails for
--     them are cancelled. Expires after 7 days; an expired one can be resent.
--   * The token only lets its holder ask for a verification email to the
--     invited address (or, when already signed in as that verified address,
--     open the acceptance page). Accepting needs a signed-in user whose
--     verified email equals the invitation's, rechecked under the
--     invitation's row lock, in a workspace that is neither suspended nor
--     archived. It creates (or restores a removed) staff membership; it never
--     changes an existing membership's role.
--
-- Emails reuse email_outbox with the business's tenant_id (so suspension,
-- archiving and the Emails page apply), as "staff_invitation" and
-- "staff_sign_in". claim_email_outbox no longer claims them, so a worker
-- deployed before this migration never renders them as something else; only
-- the new claim_staff_email_outbox does.

-- ===========================================================================
-- Memberships: soft removal, no direct writes
-- ===========================================================================

alter table public.tenant_memberships
  add column removed_at timestamptz,
  add column removed_by uuid,
  add constraint tenant_memberships_removed_complete check ((removed_at is null) = (removed_by is null)),
  add constraint tenant_memberships_owner_not_removed check (removed_at is null or role = 'staff');
comment on table public.tenant_memberships is
  'Staff access to a tenant. Removal sets removed_at (the row stays for attribution); removed rows grant nothing.';
comment on column public.tenant_memberships.removed_at is
  'Set by remove_staff_member. A removed membership grants no access; accept_staff_invitation can restore it.';

drop policy tenant_memberships_insert_owner on public.tenant_memberships;
drop policy tenant_memberships_update_owner on public.tenant_memberships;
drop policy tenant_memberships_delete_owner on public.tenant_memberships;
revoke insert, update, delete on public.tenant_memberships from authenticated;

create or replace function private.member_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid()) and m.removed_at is null and t.suspended_at is null;
$$;

create or replace function private.owner_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid()) and m.role = 'owner' and m.removed_at is null and t.suspended_at is null;
$$;

create or replace function private.require_staff_of(p_tenant_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
begin
  select m.id into v_membership_id
  from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid()) and m.removed_at is null;
  if v_membership_id is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.tenants t where t.id = p_tenant_id and t.suspended_at is not null) then
    raise exception 'workspace_suspended: this workspace is suspended' using errcode = 'PT423';
  end if;
  return v_membership_id;
end;
$$;

create or replace function public.my_workspaces()
returns table (slug text, display_name text, role text, suspended boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select t.slug, t.display_name, m.role, t.suspended_at is not null
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid()) and m.removed_at is null
  order by t.display_name, t.slug;
$$;

-- Unchanged apart from ignoring removed memberships in the non-member check.
create or replace function private.tenant_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
  v_suspended timestamptz;
begin
  if v_tenant is not null then
    select t.suspended_at into v_suspended from public.tenants t where t.id = v_tenant for key share;
    if v_suspended is not null then
      -- Signed-in non-members get the same refusal RLS would give them, so
      -- the suspension of a business they don't belong to never shows.
      if (select auth.uid()) is not null and not exists (
           select 1 from public.tenant_memberships m
           where m.tenant_id = v_tenant and m.user_id = (select auth.uid()) and m.removed_at is null) then
        raise exception 'new row violates row-level security policy' using errcode = 'insufficient_privilege';
      end if;
      raise exception 'workspace_suspended: this workspace is suspended' using errcode = 'PT423';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- The caller's active owner membership of the business. Non-members (and
-- removed staff) get "not found", a suspended workspace workspace_suspended,
-- staff a permission error.
create function private.require_owner_of(p_tenant_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid := private.require_staff_of(p_tenant_id);
begin
  if not exists (select 1 from public.tenant_memberships m where m.id = v_membership_id and m.role = 'owner') then
    raise exception 'only the owner can manage the team' using errcode = 'insufficient_privilege';
  end if;
  return v_membership_id;
end;
$$;
revoke execute on function private.require_owner_of(uuid) from public, anon, authenticated;

-- ===========================================================================
-- Invitations
-- ===========================================================================

create table public.staff_invitations (
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  email text not null
    constraint staff_invitations_email_valid check (private.is_valid_email(email)),
  role text not null default 'staff'
    constraint staff_invitations_role_staff check (role = 'staff'),
  -- The current link. A resend replaces both, so earlier links stop working.
  link_id uuid not null
    constraint staff_invitations_link_id_key unique,
  token_hash text not null
    constraint staff_invitations_token_hash_key unique
    constraint staff_invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  send_count integer not null default 1
    constraint staff_invitations_send_count_positive check (send_count >= 1),
  last_sent_at timestamptz not null default now(),
  -- Actor columns are history, like audit_events.actor_id (no foreign key).
  invited_by uuid not null,
  revoked_at timestamptz,
  revoked_by uuid,
  accepted_at timestamptz,
  accepted_by uuid,
  membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_invitations_tenant_id_id_key unique (tenant_id, id),
  constraint staff_invitations_membership_fk foreign key (tenant_id, membership_id)
    references public.tenant_memberships (tenant_id, id),
  constraint staff_invitations_one_outcome check (revoked_at is null or accepted_at is null),
  constraint staff_invitations_revoked_complete check ((revoked_at is null) = (revoked_by is null)),
  constraint staff_invitations_accepted_complete check (
    (accepted_at is null and accepted_by is null and membership_id is null)
    or (accepted_at is not null and accepted_by is not null and membership_id is not null))
);
comment on table public.staff_invitations is
  'Invitations to join a business as staff. Only the SHA-256 of the emailed token is stored. Accepting creates or restores one staff membership.';
create unique index staff_invitations_one_open_idx on public.staff_invitations (tenant_id, email)
  where accepted_at is null and revoked_at is null;
create index staff_invitations_tenant_created_idx on public.staff_invitations (tenant_id, created_at desc);

create trigger staff_invitations_set_updated_at before update on public.staff_invitations
  for each row execute function private.set_updated_at();
create trigger staff_invitations_immutable before update on public.staff_invitations
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'email', 'role', 'invited_by', 'created_at');
create trigger staff_invitations_no_delete before delete on public.staff_invitations
  for each row execute function private.reject_change();
create trigger staff_invitations_workspace_suspended before insert or update or delete on public.staff_invitations
  for each row execute function private.tenant_write_guard();

-- Accepted and cancelled are final, for every role.
create function private.staff_invitations_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception 'an accepted or cancelled invitation cannot change' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger staff_invitations_final before update on public.staff_invitations
  for each row execute function private.staff_invitations_final();

alter table public.staff_invitations enable row level security;
revoke all on public.staff_invitations from anon, authenticated;

-- ===========================================================================
-- Email outbox: staff invitation emails
-- ===========================================================================

alter table public.email_outbox drop constraint email_outbox_event_type_valid;
alter table public.email_outbox drop constraint email_outbox_entity_type_valid;
alter table public.email_outbox
  add constraint email_outbox_event_type_valid check (event_type in (
    'proposal_sent', 'proposal_link_opened', 'proposal_submitted', 'proposal_approved',
    'contract_sent', 'contract_sign_in', 'contract_voided', 'contract_signed_copy', 'booking_confirmed',
    'platform_invitation', 'platform_sign_in', 'staff_invitation', 'staff_sign_in')),
  add constraint email_outbox_entity_type_valid check (entity_type in ('proposal', 'contract', 'platform_invitation', 'staff_invitation')),
  add constraint email_outbox_staff_scope check (
    (entity_type = 'staff_invitation') = (event_type in ('staff_invitation', 'staff_sign_in'))
    and (entity_type <> 'staff_invitation' or access_link_id is null));
create index email_outbox_staff_idx on public.email_outbox (entity_id, event_type, created_at)
  where entity_type = 'staff_invitation';

create function private.enqueue_staff_email(
  p_tenant_id uuid, p_event_type text, p_recipient text, p_invitation_id uuid, p_payload jsonb, p_dedup_key text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key)
  values (p_tenant_id, p_event_type, lower(p_recipient), 'staff_invitation', p_invitation_id, coalesce(p_payload, '{}'::jsonb), p_dedup_key)
  on conflict (dedup_key) do nothing;
$$;
revoke execute on function private.enqueue_staff_email(uuid, text, text, uuid, jsonb, text) from public, anon, authenticated;

create function private.cancel_staff_invitation_emails(p_invitation_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox set status = 'cancelled', last_error = left(p_reason, 1000), locked_until = null
    where entity_type = 'staff_invitation' and entity_id = p_invitation_id and status = 'pending';
$$;
revoke execute on function private.cancel_staff_invitation_emails(uuid, text) from public, anon, authenticated;

-- Unchanged apart from leaving staff invitation emails to claim_staff_email_outbox.
create or replace function public.claim_email_outbox(p_limit integer default 10, p_lock_seconds integer default 120, p_tenant_id uuid default null, p_include_booking boolean default false)
 returns table(id uuid, tenant_id uuid, event_type text, recipient_email text, entity_id uuid, payload jsonb, attempts integer, access_link_id uuid, link_token_hash text, link_usable boolean, proposal_active boolean, tenant_slug text, tenant_display_name text, tenant_reply_to text, contract_deliverable boolean, contract_id uuid)
 language plpgsql
 security definer
 set search_path to ''
as $function$
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

-- Claims due staff invitation emails (service role), of active businesses
-- only. "deliverable" is rechecked at claim time: the invitation is still
-- open and unexpired, and the row belongs to its current link and address.
create function public.claim_staff_email_outbox(
  p_limit integer default 10, p_lock_seconds integer default 120, p_tenant_id uuid default null, p_invitation_id uuid default null
)
returns table (
  id uuid, tenant_id uuid, event_type text, recipient_email text, payload jsonb, attempts integer,
  invitation_id uuid, link_id uuid, token_hash text, expires_at timestamptz, deliverable boolean,
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
    where o.entity_type = 'staff_invitation' and o.status = 'sending' and o.locked_until < now() and o.attempts >= o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id)
      and (p_invitation_id is null or o.entity_id = p_invitation_id);

  return query
  with due as (
    select o.id from public.email_outbox o
    where o.entity_type = 'staff_invitation'
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
  select c.id, c.tenant_id, c.event_type, c.recipient_email, c.payload, c.attempts, i.id, i.link_id, i.token_hash, i.expires_at,
         coalesce(i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
                  and c.payload ->> 'link_id' = i.link_id::text and c.recipient_email = i.email, false),
         t.slug, t.display_name, t.reply_to_email
  from claimed c
  join public.tenants t on t.id = c.tenant_id
  left join public.staff_invitations i on i.tenant_id = c.tenant_id and i.id = c.entity_id;
end;
$$;
revoke execute on function public.claim_staff_email_outbox(integer, integer, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_staff_email_outbox(integer, integer, uuid, uuid) to service_role;

-- ===========================================================================
-- Owners: invite, resend, cancel, remove, overview
-- ===========================================================================

-- Creates an invitation and queues its email. p_invitation_id is the
-- caller's request id: repeating it returns the same invitation ("replayed")
-- and sends nothing more. An active member gets "member"; an open invitation
-- for the same email, "exists" (resend that one). At most 30 new
-- invitations per business per day.
create function public.create_staff_invitation(p_tenant_id uuid, p_invitation_id uuid, p_email text, p_link_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_existing public.staff_invitations%rowtype;
  v_expires timestamptz := now() + interval '7 days';
begin
  perform private.require_owner_of(p_tenant_id);
  if exists (select 1 from public.tenants t where t.id = p_tenant_id and t.archived_at is not null) then
    raise exception 'workspace_archived: this business is archived' using errcode = 'invalid_parameter_value';
  end if;
  if p_invitation_id is null or p_link_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation request' using errcode = 'invalid_parameter_value';
  end if;

  -- A retry of a request that already succeeded (its response was lost).
  select * into v_existing from public.staff_invitations where id = p_invitation_id;
  if found then
    if v_existing.tenant_id <> p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('status', 'created', 'replayed', true, 'invitation_id', v_existing.id, 'email', v_existing.email,
      'expires_at', v_existing.expires_at);
  end if;

  if not coalesce(private.is_valid_email(v_email), false) then
    raise exception 'invitation_invalid: enter a valid email address' using errcode = 'invalid_parameter_value';
  end if;
  -- Serializes concurrent invitations to the same address in this business.
  perform pg_advisory_xact_lock(hashtextextended('flux:staff-invitation:' || p_tenant_id || ':' || v_email, 0));
  if exists (select 1 from public.tenant_memberships m join auth.users u on u.id = m.user_id
             where m.tenant_id = p_tenant_id and m.removed_at is null and lower(u.email) = v_email) then
    return jsonb_build_object('status', 'member', 'email', v_email);
  end if;
  select * into v_existing from public.staff_invitations
    where tenant_id = p_tenant_id and email = v_email and accepted_at is null and revoked_at is null;
  if found then
    return jsonb_build_object('status', 'exists', 'invitation_id', v_existing.id, 'email', v_existing.email,
      'state', case when v_existing.expires_at > now() then 'pending' else 'expired' end, 'expires_at', v_existing.expires_at);
  end if;
  if (select count(*) from public.staff_invitations i
      where i.tenant_id = p_tenant_id and i.created_at > now() - interval '1 day') >= 30 then
    raise exception 'invitation_limit: this business has sent many invitations today. Try again tomorrow' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.staff_invitations (id, tenant_id, email, link_id, token_hash, expires_at, invited_by)
  values (p_invitation_id, p_tenant_id, v_email, p_link_id, p_token_hash, v_expires, (select auth.uid()));
  perform private.enqueue_staff_email(p_tenant_id, 'staff_invitation', v_email, p_invitation_id,
    jsonb_build_object('link_id', p_link_id, 'expires_at', v_expires), 'staff_invitation:' || p_link_id);
  perform private.audit(p_tenant_id, 'staff_invitation', p_invitation_id, 'created', 'staff', (select auth.uid()),
    jsonb_build_object('email', v_email, 'expires_at', v_expires));
  return jsonb_build_object('status', 'created', 'replayed', false, 'invitation_id', p_invitation_id, 'email', v_email, 'expires_at', v_expires);
end;
$$;

-- Sends a fresh link (also for an expired invitation) with a new 7-day
-- expiry; the previous link stops working at once and its queued emails are
-- cancelled. p_link_id is the caller's request id: repeating it is a replay.
-- Limited to one resend per 2 minutes and 10 emails a day per invitation.
create function public.resend_staff_invitation(p_tenant_id uuid, p_invitation_id uuid, p_link_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.staff_invitations%rowtype;
  v_expires timestamptz := now() + interval '7 days';
begin
  perform private.require_owner_of(p_tenant_id);
  if exists (select 1 from public.tenants t where t.id = p_tenant_id and t.archived_at is not null) then
    raise exception 'workspace_archived: this business is archived' using errcode = 'invalid_parameter_value';
  end if;
  if p_link_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation request' using errcode = 'invalid_parameter_value';
  end if;
  select * into i from public.staff_invitations where tenant_id = p_tenant_id and id = p_invitation_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if i.link_id = p_link_id then
    return jsonb_build_object('status', 'sent', 'replayed', true, 'email', i.email, 'expires_at', i.expires_at);
  end if;
  if i.accepted_at is not null then
    raise exception 'invitation_not_resendable: this invitation was already accepted' using errcode = 'invalid_parameter_value';
  end if;
  if i.revoked_at is not null then
    raise exception 'invitation_not_resendable: this invitation was cancelled. Send a new invitation instead' using errcode = 'invalid_parameter_value';
  end if;
  if i.last_sent_at > now() - interval '2 minutes'
     or (select count(*) from public.email_outbox o where o.entity_type = 'staff_invitation' and o.entity_id = i.id
         and o.event_type = 'staff_invitation' and o.created_at > now() - interval '1 day') >= 10 then
    raise exception 'invitation_resend_too_soon: this invitation was sent very recently. Wait a few minutes before resending'
      using errcode = 'invalid_parameter_value';
  end if;

  perform private.cancel_staff_invitation_emails(i.id, 'replaced by a resend');
  update public.staff_invitations
    set link_id = p_link_id, token_hash = p_token_hash, expires_at = v_expires, send_count = send_count + 1, last_sent_at = now()
    where id = i.id;
  perform private.enqueue_staff_email(p_tenant_id, 'staff_invitation', i.email, i.id,
    jsonb_build_object('link_id', p_link_id, 'expires_at', v_expires), 'staff_invitation:' || p_link_id);
  perform private.audit(p_tenant_id, 'staff_invitation', i.id, 'resent', 'staff', (select auth.uid()),
    jsonb_build_object('expires_at', v_expires, 'send_count', i.send_count + 1));
  return jsonb_build_object('status', 'sent', 'replayed', false, 'email', i.email, 'expires_at', v_expires);
end;
$$;

-- Cancels an unaccepted invitation under its row lock: its link stops
-- working at once (acceptance takes the same lock) and queued emails are
-- cancelled. Repeats are no-ops; an accepted invitation can't be cancelled.
create function public.cancel_staff_invitation(p_tenant_id uuid, p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.staff_invitations%rowtype;
begin
  perform private.require_owner_of(p_tenant_id);
  select * into i from public.staff_invitations where tenant_id = p_tenant_id and id = p_invitation_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if i.revoked_at is not null then
    return jsonb_build_object('status', 'cancelled', 'replayed', true);
  end if;
  if i.accepted_at is not null then
    raise exception 'invitation_not_cancellable: this invitation was already accepted. Remove the staff member instead'
      using errcode = 'invalid_parameter_value';
  end if;
  update public.staff_invitations set revoked_at = now(), revoked_by = (select auth.uid()) where id = i.id;
  perform private.cancel_staff_invitation_emails(i.id, 'invitation cancelled');
  perform private.audit(p_tenant_id, 'staff_invitation', i.id, 'cancelled', 'staff', (select auth.uid()), '{}'::jsonb);
  return jsonb_build_object('status', 'cancelled', 'replayed', false);
end;
$$;

-- Removes a staff member: access ends on their next request. The membership
-- row stays (removed_at) so everything they did keeps its attribution.
-- Owners can't be removed; repeats are no-ops.
create function public.remove_staff_member(p_tenant_id uuid, p_membership_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.tenant_memberships%rowtype;
begin
  perform private.require_owner_of(p_tenant_id);
  select * into m from public.tenant_memberships where tenant_id = p_tenant_id and id = p_membership_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if m.role = 'owner' then
    raise exception 'member_owner_protected: the business owner can''t be removed' using errcode = 'insufficient_privilege';
  end if;
  if m.removed_at is not null then
    return jsonb_build_object('status', 'removed', 'replayed', true);
  end if;
  update public.tenant_memberships set removed_at = now(), removed_by = (select auth.uid()) where id = m.id;
  perform private.audit(p_tenant_id, 'membership', m.id, 'removed', 'staff', (select auth.uid()), jsonb_build_object('role', m.role));
  return jsonb_build_object('status', 'removed', 'replayed', false);
end;
$$;

-- The team for the owner: members (active and removed) and recent
-- invitations with their state and latest delivery status. Never token hashes.
create function public.staff_team_overview(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_owner_of(p_tenant_id);
begin
  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membership_id', m.id, 'email', lower(u.email), 'role', m.role, 'joined_at', m.created_at,
        'removed_at', m.removed_at, 'is_you', m.id = v_me)
        order by m.removed_at nulls first, (m.role = 'owner') desc, lower(u.email))
      from public.tenant_memberships m join auth.users u on u.id = m.user_id
      where m.tenant_id = p_tenant_id), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(x.j order by x.open desc, x.created_at desc)
      from (
        select i.created_at, (i.accepted_at is null and i.revoked_at is null) as open,
          jsonb_build_object(
            'id', i.id, 'email', i.email,
            'state', case when i.accepted_at is not null then 'accepted' when i.revoked_at is not null then 'cancelled'
                          when i.expires_at <= now() then 'expired' else 'pending' end,
            'created_at', i.created_at, 'expires_at', i.expires_at, 'last_sent_at', i.last_sent_at, 'send_count', i.send_count,
            'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at,
            'delivery_status', (select o.status from public.email_outbox o
              where o.entity_type = 'staff_invitation' and o.entity_id = i.id and o.event_type = 'staff_invitation'
                and o.payload ->> 'link_id' = i.link_id::text
              order by o.created_at desc limit 1)) as j
        from public.staff_invitations i
        where i.tenant_id = p_tenant_id
          -- Open ones always; closed ones for 30 days, as recent history.
          and ((i.accepted_at is null and i.revoked_at is null) or coalesce(i.accepted_at, i.revoked_at) > now() - interval '30 days')
        order by i.created_at desc
        limit 200
      ) x), '[]'::jsonb));
end;
$$;

revoke execute on function
  public.create_staff_invitation(uuid, uuid, text, uuid, text),
  public.resend_staff_invitation(uuid, uuid, uuid, text),
  public.cancel_staff_invitation(uuid, uuid),
  public.remove_staff_member(uuid, uuid),
  public.staff_team_overview(uuid)
  from public, anon;
grant execute on function
  public.create_staff_invitation(uuid, uuid, text, uuid, text),
  public.resend_staff_invitation(uuid, uuid, uuid, text),
  public.cancel_staff_invitation(uuid, uuid),
  public.remove_staff_member(uuid, uuid),
  public.staff_team_overview(uuid)
  to authenticated;

-- ===========================================================================
-- Invited staff: verification request and acceptance
-- ===========================================================================

-- An invitation that can still be accepted: open, unexpired, in an active business.
create function private.open_staff_invitation(p_token_hash text)
returns public.staff_invitations
language sql
stable
security definer
set search_path = ''
as $$
  select i.* from public.staff_invitations i join public.tenants t on t.id = i.tenant_id
  where i.token_hash = p_token_hash and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
    and t.archived_at is null and t.suspended_at is null;
$$;
revoke execute on function private.open_staff_invitation(text) from public, anon, authenticated;

-- Service role, after per-IP limiting: queues a verification email to the
-- invited address. The token only authorizes this; it never signs anyone in.
-- Unknown, cancelled, expired and accepted invitations, and those of a
-- suspended or archived business, all answer "invalid" (nothing leaks). At
-- most 3 per invitation per 15 minutes.
create function public.request_staff_sign_in(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.staff_invitations%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  i := private.open_staff_invitation(p_token_hash);
  if i.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform 1 from public.staff_invitations where id = i.id for update;
  if (select count(*) from public.email_outbox o
      where o.entity_type = 'staff_invitation' and o.entity_id = i.id
        and o.event_type = 'staff_sign_in' and o.created_at > now() - interval '15 minutes') >= 3 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  perform private.enqueue_staff_email(i.tenant_id, 'staff_sign_in', i.email, i.id,
    jsonb_build_object('link_id', i.link_id), 'staff_sign_in:' || i.id || ':' || gen_random_uuid());
  perform private.audit(i.tenant_id, 'staff_invitation', i.id, 'sign_in_requested', 'system', null, '{}'::jsonb);
  return jsonb_build_object('status', 'ok', 'masked_email', private.masked_email(i.email));
end;
$$;
revoke execute on function public.request_staff_sign_in(text) from public, anon, authenticated;
grant execute on function public.request_staff_sign_in(text) to service_role;

-- For a signed-in user who already verified the invited address: the
-- invitation's id, so they can go straight to acceptance. Null otherwise.
create function public.staff_invitation_for_token(p_token_hash text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i public.staff_invitations%rowtype;
begin
  if (select auth.uid()) is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  i := private.open_staff_invitation(p_token_hash);
  if i.id is null or private.current_verified_email() is distinct from i.email then
    return null;
  end if;
  return i.id;
end;
$$;

-- What the signed-in user may do with an invitation. The business is named
-- only to the verified invited address; an accepted invitation only to the
-- user who accepted it.
create function public.staff_invitation_status(p_invitation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i public.staff_invitations%rowtype;
  t public.tenants%rowtype;
  v_uid uuid := (select auth.uid());
  v_email text;
begin
  if v_uid is null then
    return jsonb_build_object('state', 'signed_out');
  end if;
  select * into i from public.staff_invitations where id = p_invitation_id;
  if not found then
    return jsonb_build_object('state', 'invalid');
  end if;
  select * into t from public.tenants where id = i.tenant_id;
  if i.accepted_at is not null then
    if i.accepted_by <> v_uid then
      return jsonb_build_object('state', 'invalid');
    end if;
    return jsonb_build_object('state', 'accepted', 'slug', t.slug, 'display_name', t.display_name,
      'active', exists (select 1 from public.tenant_memberships m where m.id = i.membership_id and m.removed_at is null)
                and t.suspended_at is null and t.archived_at is null);
  end if;
  if i.revoked_at is not null or i.expires_at <= now() then
    return jsonb_build_object('state', 'invalid');
  end if;
  v_email := private.current_verified_email();
  if v_email is null then
    return jsonb_build_object('state', 'unverified');
  end if;
  if v_email <> i.email then
    return jsonb_build_object('state', 'wrong_account', 'signed_in_email', v_email, 'intended_email', private.masked_email(i.email));
  end if;
  if t.suspended_at is not null or t.archived_at is not null then
    return jsonb_build_object('state', 'unavailable');
  end if;
  return jsonb_build_object('state', 'ready', 'email', i.email, 'display_name', t.display_name, 'expires_at', i.expires_at,
    'already_member', exists (select 1 from public.tenant_memberships m
                              where m.tenant_id = i.tenant_id and m.user_id = v_uid and m.removed_at is null));
end;
$$;

-- Accepts under the invitation's row lock: creates a staff membership for
-- the signed-in user, restores their removed one, or keeps their existing
-- active one unchanged (an owner stays owner). Repeats by the same user
-- return the same result; nobody else can use an accepted invitation.
-- Returns {"state": "accepted" | "invalid" | "unverified" | "wrong_account"
-- | "unavailable" | "signed_out", ...}.
create function public.accept_staff_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.staff_invitations%rowtype;
  t public.tenants%rowtype;
  m public.tenant_memberships%rowtype;
  v_uid uuid := (select auth.uid());
  v_email text;
  v_outcome text;
begin
  if v_uid is null then
    return jsonb_build_object('state', 'signed_out');
  end if;
  select * into i from public.staff_invitations where id = p_invitation_id for update;
  if not found then
    return jsonb_build_object('state', 'invalid');
  end if;
  select * into t from public.tenants where id = i.tenant_id;
  if i.accepted_at is not null then
    if i.accepted_by <> v_uid then
      return jsonb_build_object('state', 'invalid');
    end if;
    return jsonb_build_object('state', 'accepted', 'slug', t.slug, 'replayed', true);
  end if;
  if i.revoked_at is not null or i.expires_at <= now() then
    return jsonb_build_object('state', 'invalid');
  end if;
  v_email := private.current_verified_email();
  if v_email is null then
    return jsonb_build_object('state', 'unverified');
  end if;
  if v_email <> i.email then
    return jsonb_build_object('state', 'wrong_account');
  end if;
  if t.suspended_at is not null or t.archived_at is not null then
    return jsonb_build_object('state', 'unavailable');
  end if;

  select * into m from public.tenant_memberships where tenant_id = i.tenant_id and user_id = v_uid for update;
  if not found then
    insert into public.tenant_memberships (tenant_id, user_id, role) values (i.tenant_id, v_uid, 'staff') returning * into m;
    v_outcome := 'joined';
  elsif m.removed_at is not null then
    update public.tenant_memberships set removed_at = null, removed_by = null where id = m.id;
    v_outcome := 'restored';
  else
    v_outcome := 'already_member';
  end if;
  update public.staff_invitations set accepted_at = now(), accepted_by = v_uid, membership_id = m.id where id = i.id;
  perform private.cancel_staff_invitation_emails(i.id, 'invitation accepted');
  perform private.audit(i.tenant_id, 'staff_invitation', i.id, 'accepted', 'staff', v_uid,
    jsonb_build_object('membership_id', m.id, 'outcome', v_outcome));
  return jsonb_build_object('state', 'accepted', 'slug', t.slug, 'replayed', false, 'outcome', v_outcome);
end;
$$;

revoke execute on function
  public.staff_invitation_for_token(text),
  public.staff_invitation_status(uuid),
  public.accept_staff_invitation(uuid)
  from public, anon;
grant execute on function
  public.staff_invitation_for_token(text),
  public.staff_invitation_status(uuid),
  public.accept_staff_invitation(uuid)
  to authenticated;
