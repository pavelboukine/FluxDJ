-- Invite-only DJ onboarding: platform administrators invite new DJ business
-- owners, who verify their email and create their own empty workspace.
--
-- Authorization
--   * Platform administration is a separate, explicit grant
--     (public.platform_admins), never derived from a tenant role, an email
--     address or a slug. It is granted only from SQL by the database owner
--     (private.grant_platform_admin), never from the app or the API.
--   * Platform administrators get no access to any tenant's data: nothing
--     here touches private.member_tenant_ids() or any tenant RLS policy.
--
-- Invitations (public.platform_invitations)
--   * One open (unaccepted, unrevoked) invitation per normalized email.
--   * The emailed token is HMAC(PROPOSAL_LINK_SECRET,
--     "flux:platform-invite:v1:" + link_id), derived by the app; only its
--     SHA-256 is stored. A resend rotates link_id and token_hash, so the
--     previous link stops working, and cancels queued emails for it.
--   * The token only lets the holder ask for a verification email to the
--     invited address. Acceptance needs a signed-in user whose verified email
--     equals the invitation email, rechecked under a row lock.
--   * Acceptance creates the tenant, its owner membership and marks the
--     invitation accepted in one transaction. Repeats by the same user return
--     the same workspace; an accepted invitation never creates another.
--
-- Emails reuse public.email_outbox with tenant_id NULL (platform emails
-- belong to no business). The existing claim_email_outbox joins tenants, so
-- workers deployed before this migration never claim them; only the new
-- claim_platform_email_outbox does.

-- ===========================================================================
-- Slugs a new workspace may claim
-- ===========================================================================

-- Stricter than private.is_valid_tenant_slug (which existing rows were
-- validated against and stays unchanged): also keeps every top-level
-- application path, and a few likely future ones, out of tenant URLs.
create function private.is_claimable_tenant_slug(p_slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(private.is_valid_tenant_slug(p_slug), false)
     and p_slug not in (
       'about', 'account', 'accounts', 'apple-icon', 'billing', 'blog', 'contact', 'contracts', 'demo', 'docs',
       'email', 'emails', 'favicon', 'home', 'icon', 'icons', 'invitations', 'invite', 'join', 'mail', 'new',
       'next', 'onboarding', 'platform', 'pricing', 'proposals', 'robots', 'root', 'setup', 'sitemap', 'start',
       'system', 'welcome', 'workspace', 'workspaces'
     );
$$;
revoke execute on function private.is_claimable_tenant_slug(text) from public, anon, authenticated;

-- ===========================================================================
-- Platform administrators
-- ===========================================================================

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text not null
    constraint platform_admins_note_length check (length(btrim(note)) between 1 and 200),
  granted_at timestamptz not null default now()
);
comment on table public.platform_admins is
  'Users who may invite new DJ businesses. Granted only from SQL (private.grant_platform_admin). Gives no access to any tenant''s data.';
alter table public.platform_admins enable row level security;
-- Not even the app's secret key can grant: only SQL run by the database owner.
revoke all on public.platform_admins from anon, authenticated, service_role;

-- Whether the signed-in user is a platform administrator with a verified email.
create function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a join auth.users u on u.id = a.user_id
    where a.user_id = (select auth.uid()) and u.email_confirmed_at is not null);
$$;
revoke execute on function private.is_platform_admin() from public, anon, authenticated;

create function private.require_platform_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'only platform administrators can manage DJ invitations' using errcode = 'insufficient_privilege';
  end if;
end;
$$;
revoke execute on function private.require_platform_admin() from public, anon, authenticated;

-- For the app's navigation and page guard. Every operation checks again.
create function public.current_user_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin();
$$;
revoke execute on function public.current_user_is_platform_admin() from public, anon;
grant execute on function public.current_user_is_platform_admin() to authenticated;

-- ===========================================================================
-- Platform audit log (append-only; no tenant)
-- ===========================================================================

create table public.platform_audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null
    constraint platform_audit_events_entity_type_valid check (entity_type ~ '^[a-z_]{1,40}$'),
  entity_id uuid not null,
  action text not null
    constraint platform_audit_events_action_valid check (action ~ '^[a-z_]{1,60}$'),
  -- The Auth user who acted; null for SQL grants and anonymous requests.
  actor_id uuid,
  -- Minimal metadata only. No tokens or IP addresses.
  metadata jsonb not null default '{}'::jsonb
    constraint platform_audit_events_metadata_object check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now()
);
create index platform_audit_events_entity_idx on public.platform_audit_events (entity_type, entity_id, occurred_at);
create trigger platform_audit_events_append_only before update or delete on public.platform_audit_events
  for each row execute function private.reject_change();
alter table public.platform_audit_events enable row level security;
revoke all on public.platform_audit_events from anon, authenticated;

create function private.platform_audit(p_entity_type text, p_entity_id uuid, p_action text, p_actor_id uuid, p_metadata jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.platform_audit_events (entity_type, entity_id, action, actor_id, metadata)
  values (p_entity_type, p_entity_id, p_action, p_actor_id, coalesce(p_metadata, '{}'::jsonb));
$$;
revoke execute on function private.platform_audit(text, uuid, text, uuid, jsonb) from public, anon, authenticated;

-- ===========================================================================
-- One-time grants, run by the database owner in the SQL editor:
--   select private.grant_platform_admin('you@example.com', 'Flux DJ operator');
-- Only an existing Auth user with a verified email can be granted. Not
-- callable by the app, the API or the service role.
-- ===========================================================================

create function private.grant_platform_admin(p_email text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_users uuid[];
begin
  select array_agg(u.id) into v_users from auth.users u
  where lower(u.email) = lower(btrim(p_email)) and u.email_confirmed_at is not null;
  if coalesce(array_length(v_users, 1), 0) <> 1 then
    raise exception 'expected exactly one verified Auth user with that email, found %', coalesce(array_length(v_users, 1), 0)
      using errcode = 'no_data_found';
  end if;
  insert into public.platform_admins (user_id, note) values (v_users[1], btrim(p_note))
    on conflict (user_id) do nothing;
  if found then
    perform private.platform_audit('platform_admin', v_users[1], 'granted', null, jsonb_build_object('note', btrim(p_note)));
  end if;
  return v_users[1];
end;
$$;
revoke execute on function private.grant_platform_admin(text, text) from public, anon, authenticated, service_role;

create function private.revoke_platform_admin(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  delete from public.platform_admins a using auth.users u
    where u.id = a.user_id and lower(u.email) = lower(btrim(p_email))
    returning a.user_id into v_user;
  if v_user is null then
    return false;
  end if;
  perform private.platform_audit('platform_admin', v_user, 'revoked', null, '{}'::jsonb);
  return true;
end;
$$;
revoke execute on function private.revoke_platform_admin(text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- Invitations
-- ===========================================================================

create table public.platform_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null
    constraint platform_invitations_email_valid check (private.is_valid_email(email)),
  -- The current link. A resend replaces both, so earlier links stop working.
  link_id uuid not null
    constraint platform_invitations_link_id_key unique,
  token_hash text not null
    constraint platform_invitations_token_hash_key unique
    constraint platform_invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  send_count integer not null default 1
    constraint platform_invitations_send_count_positive check (send_count >= 1),
  last_sent_at timestamptz not null default now(),
  -- Actor columns are history, like audit_events.actor_id (no foreign key).
  invited_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  accepted_at timestamptz,
  accepted_by uuid,
  tenant_id uuid references public.tenants (id) on delete restrict
    constraint platform_invitations_tenant_key unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_invitations_one_outcome check (revoked_at is null or accepted_at is null),
  constraint platform_invitations_revoked_complete check ((revoked_at is null) = (revoked_by is null)),
  constraint platform_invitations_accepted_complete check (
    (accepted_at is null and accepted_by is null and tenant_id is null)
    or (accepted_at is not null and accepted_by is not null and tenant_id is not null))
);
comment on table public.platform_invitations is
  'Invitations for new DJ business owners. Only the SHA-256 of the emailed token is stored. Accepting creates exactly one tenant.';
-- No accidental duplicates: one open invitation per email (an expired one is resent, not duplicated).
create unique index platform_invitations_one_open_idx on public.platform_invitations (email)
  where accepted_at is null and revoked_at is null;
create index platform_invitations_created_idx on public.platform_invitations (created_at desc);

create trigger platform_invitations_set_updated_at before update on public.platform_invitations
  for each row execute function private.set_updated_at();
create trigger platform_invitations_immutable before update on public.platform_invitations
  for each row execute function private.forbid_column_changes('id', 'email', 'invited_by', 'created_at');

-- Accepted and revoked are final, for every role.
create function private.platform_invitations_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception 'an accepted or revoked invitation cannot change' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger platform_invitations_final before update on public.platform_invitations
  for each row execute function private.platform_invitations_final();
create trigger platform_invitations_no_delete before delete on public.platform_invitations
  for each row execute function private.reject_change();

alter table public.platform_invitations enable row level security;
revoke all on public.platform_invitations from anon, authenticated;

-- ===========================================================================
-- Email outbox: platform emails (no tenant)
-- ===========================================================================

alter table public.email_outbox alter column tenant_id drop not null;
alter table public.email_outbox drop constraint email_outbox_event_type_valid;
alter table public.email_outbox drop constraint email_outbox_entity_type_valid;
alter table public.email_outbox
  add constraint email_outbox_event_type_valid check (event_type in (
    'proposal_sent', 'proposal_link_opened', 'proposal_submitted', 'proposal_approved',
    'contract_sent', 'contract_sign_in', 'contract_voided', 'contract_signed_copy', 'booking_confirmed',
    'platform_invitation', 'platform_sign_in')),
  add constraint email_outbox_entity_type_valid check (entity_type in ('proposal', 'contract', 'platform_invitation')),
  -- Exactly the platform emails have no tenant.
  add constraint email_outbox_platform_scope check (
    (tenant_id is null) = (event_type in ('platform_invitation', 'platform_sign_in'))
    and (tenant_id is not null or (entity_type = 'platform_invitation' and access_link_id is null)));
create index email_outbox_platform_idx on public.email_outbox (entity_id, event_type, created_at)
  where tenant_id is null;
comment on column public.email_outbox.tenant_id is
  'The sending business. Null only for platform emails (DJ invitations), which staff never see.';

create function private.enqueue_platform_email(
  p_event_type text, p_recipient text, p_invitation_id uuid, p_payload jsonb, p_dedup_key text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_type, entity_id, payload, dedup_key)
  values (null, p_event_type, lower(p_recipient), 'platform_invitation', p_invitation_id, coalesce(p_payload, '{}'::jsonb), p_dedup_key)
  on conflict (dedup_key) do nothing;
$$;
revoke execute on function private.enqueue_platform_email(text, text, uuid, jsonb, text) from public, anon, authenticated;

create function private.cancel_platform_invitation_emails(p_invitation_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox set status = 'cancelled', last_error = left(p_reason, 1000), locked_until = null
    where tenant_id is null and entity_type = 'platform_invitation' and entity_id = p_invitation_id and status = 'pending';
$$;
revoke execute on function private.cancel_platform_invitation_emails(uuid, text) from public, anon, authenticated;

-- Claims due platform emails (service role). Separate from claim_email_outbox
-- so older workers never see them. "deliverable" is rechecked at claim time:
-- the invitation is still open and unexpired, and the row belongs to its
-- current link and address.
create function public.claim_platform_email_outbox(
  p_limit integer default 10, p_lock_seconds integer default 120, p_invitation_id uuid default null
)
returns table (
  id uuid, event_type text, recipient_email text, payload jsonb, attempts integer,
  invitation_id uuid, link_id uuid, token_hash text, deliverable boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.email_outbox o
    set status = 'failed', locked_until = null, last_error = coalesce(o.last_error, 'delivery did not complete')
    where o.tenant_id is null and o.status = 'sending' and o.locked_until < now() and o.attempts >= o.max_attempts
      and (p_invitation_id is null or o.entity_id = p_invitation_id);

  return query
  with due as (
    select o.id from public.email_outbox o
    where o.tenant_id is null and o.entity_type = 'platform_invitation'
      and (o.status = 'pending' or (o.status = 'sending' and o.locked_until < now()))
      and o.next_attempt_at <= now()
      and o.attempts < o.max_attempts
      and (p_invitation_id is null or o.entity_id = p_invitation_id)
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
  select c.id, c.event_type, c.recipient_email, c.payload, c.attempts, i.id, i.link_id, i.token_hash,
         coalesce(i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
                  and c.payload ->> 'link_id' = i.link_id::text and c.recipient_email = i.email, false)
  from claimed c
  left join public.platform_invitations i on i.id = c.entity_id;
end;
$$;
revoke execute on function public.claim_platform_email_outbox(integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_platform_email_outbox(integer, integer, uuid) to service_role;

-- ===========================================================================
-- Platform administrators: invite, resend, revoke, list
-- ===========================================================================

-- Creates an invitation and queues its email. An open invitation for the
-- same email is returned instead of creating a duplicate ("exists"); resend
-- that one. At most 50 new invitations per administrator per day.
create function public.create_platform_invitation(p_email text, p_link_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_open public.platform_invitations%rowtype;
  v_id uuid;
  v_expires timestamptz := now() + interval '14 days';
begin
  perform private.require_platform_admin();
  if not coalesce(private.is_valid_email(v_email), false) then
    raise exception 'invitation_invalid: enter a valid email address' using errcode = 'invalid_parameter_value';
  end if;
  if p_link_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation link' using errcode = 'invalid_parameter_value';
  end if;
  -- Serializes concurrent invitations to the same address.
  perform pg_advisory_xact_lock(hashtextextended('flux:platform-invitation:' || v_email, 0));
  select * into v_open from public.platform_invitations
    where email = v_email and accepted_at is null and revoked_at is null for update;
  if found then
    return jsonb_build_object('status', 'exists', 'invitation_id', v_open.id, 'email', v_open.email,
      'state', case when v_open.expires_at > now() then 'pending' else 'expired' end, 'expires_at', v_open.expires_at);
  end if;
  if (select count(*) from public.platform_invitations i
      where i.invited_by = (select auth.uid()) and i.created_at > now() - interval '1 day') >= 50 then
    raise exception 'invitation_limit: you have sent many invitations today. Try again tomorrow' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.platform_invitations (email, link_id, token_hash, expires_at, invited_by)
  values (v_email, p_link_id, p_token_hash, v_expires, (select auth.uid()))
  returning id into v_id;
  perform private.enqueue_platform_email('platform_invitation', v_email, v_id,
    jsonb_build_object('link_id', p_link_id, 'expires_at', v_expires), 'platform_invitation:' || p_link_id);
  perform private.platform_audit('platform_invitation', v_id, 'created', (select auth.uid()),
    jsonb_build_object('email', v_email, 'link_id', p_link_id, 'expires_at', v_expires));
  return jsonb_build_object('status', 'created', 'invitation_id', v_id, 'email', v_email, 'expires_at', v_expires);
end;
$$;

-- Sends a fresh link (also for an expired invitation) with a new 14-day
-- expiry. The previous link stops working at once and its queued emails are
-- cancelled. Limited to one resend per 2 minutes and 10 emails a day.
create function public.resend_platform_invitation(p_invitation_id uuid, p_link_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.platform_invitations%rowtype;
  v_expires timestamptz := now() + interval '14 days';
begin
  perform private.require_platform_admin();
  if p_link_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation link' using errcode = 'invalid_parameter_value';
  end if;
  select * into i from public.platform_invitations where id = p_invitation_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if i.accepted_at is not null then
    raise exception 'invitation_not_resendable: this invitation was already accepted' using errcode = 'invalid_parameter_value';
  end if;
  if i.revoked_at is not null then
    raise exception 'invitation_not_resendable: this invitation was revoked. Send a new invitation instead' using errcode = 'invalid_parameter_value';
  end if;
  if i.last_sent_at > now() - interval '2 minutes'
     or (select count(*) from public.email_outbox o where o.tenant_id is null and o.entity_type = 'platform_invitation'
         and o.entity_id = i.id and o.event_type = 'platform_invitation' and o.created_at > now() - interval '1 day') >= 10 then
    raise exception 'invitation_resend_too_soon: this invitation was sent very recently. Wait a few minutes before resending'
      using errcode = 'invalid_parameter_value';
  end if;

  perform private.cancel_platform_invitation_emails(i.id, 'replaced by a resend');
  update public.platform_invitations
    set link_id = p_link_id, token_hash = p_token_hash, expires_at = v_expires,
        send_count = send_count + 1, last_sent_at = now()
    where id = i.id;
  perform private.enqueue_platform_email('platform_invitation', i.email, i.id,
    jsonb_build_object('link_id', p_link_id, 'expires_at', v_expires), 'platform_invitation:' || p_link_id);
  perform private.platform_audit('platform_invitation', i.id, 'resent', (select auth.uid()),
    jsonb_build_object('previous_link_id', i.link_id, 'link_id', p_link_id, 'expires_at', v_expires));
  return jsonb_build_object('status', 'sent', 'invitation_id', i.id, 'email', i.email, 'expires_at', v_expires);
end;
$$;

-- Revokes an unaccepted invitation: its link stops working and queued emails
-- are cancelled. Repeats are no-ops. An accepted invitation can't be revoked.
create function public.revoke_platform_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.platform_invitations%rowtype;
begin
  perform private.require_platform_admin();
  select * into i from public.platform_invitations where id = p_invitation_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if i.revoked_at is not null then
    return jsonb_build_object('status', 'revoked', 'replayed', true);
  end if;
  if i.accepted_at is not null then
    raise exception 'invitation_not_revocable: this invitation was already accepted and its workspace created'
      using errcode = 'invalid_parameter_value';
  end if;
  update public.platform_invitations set revoked_at = now(), revoked_by = (select auth.uid()) where id = i.id;
  perform private.cancel_platform_invitation_emails(i.id, 'invitation revoked');
  perform private.platform_audit('platform_invitation', i.id, 'revoked', (select auth.uid()), '{}'::jsonb);
  return jsonb_build_object('status', 'revoked', 'replayed', false);
end;
$$;

-- Every invitation with its state and latest delivery status. Never token hashes.
create function public.platform_invitations_overview()
returns table (
  id uuid, email text, state text, expires_at timestamptz, send_count integer, last_sent_at timestamptz,
  created_at timestamptz, accepted_at timestamptz, revoked_at timestamptz,
  workspace_slug text, workspace_name text, delivery_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_platform_admin();
  return query
  select i.id, i.email,
         case when i.accepted_at is not null then 'accepted' when i.revoked_at is not null then 'revoked'
              when i.expires_at <= now() then 'expired' else 'pending' end,
         i.expires_at, i.send_count, i.last_sent_at, i.created_at, i.accepted_at, i.revoked_at,
         t.slug, t.display_name,
         (select o.status from public.email_outbox o
          where o.tenant_id is null and o.entity_type = 'platform_invitation' and o.entity_id = i.id
            and o.event_type = 'platform_invitation' and o.payload ->> 'link_id' = i.link_id::text
          order by o.created_at desc limit 1)
  from public.platform_invitations i
  left join public.tenants t on t.id = i.tenant_id
  order by i.created_at desc
  limit 500;
end;
$$;

revoke execute on function
  public.create_platform_invitation(text, uuid, text),
  public.resend_platform_invitation(uuid, uuid, text),
  public.revoke_platform_invitation(uuid),
  public.platform_invitations_overview()
  from public, anon;
grant execute on function
  public.create_platform_invitation(text, uuid, text),
  public.resend_platform_invitation(uuid, uuid, text),
  public.revoke_platform_invitation(uuid),
  public.platform_invitations_overview()
  to authenticated;

-- ===========================================================================
-- Invited DJ: verification request (service role, after per-IP limiting)
-- ===========================================================================

-- Queues a verification email to the invited address. The token only
-- authorizes this; it never signs anyone in. At most 3 per invitation per
-- 15 minutes.
create function public.request_platform_sign_in(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.platform_invitations%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into i from public.platform_invitations where token_hash = p_token_hash for update;
  if not found or i.revoked_at is not null or (i.accepted_at is null and i.expires_at <= now()) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if i.accepted_at is not null then
    return jsonb_build_object('status', 'used');
  end if;
  if (select count(*) from public.email_outbox o
      where o.tenant_id is null and o.entity_type = 'platform_invitation' and o.entity_id = i.id
        and o.event_type = 'platform_sign_in' and o.created_at > now() - interval '15 minutes') >= 3 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  perform private.enqueue_platform_email('platform_sign_in', i.email, i.id,
    jsonb_build_object('link_id', i.link_id), 'platform_sign_in:' || i.id || ':' || gen_random_uuid());
  perform private.platform_audit('platform_invitation', i.id, 'sign_in_requested', null, jsonb_build_object('link_id', i.link_id));
  return jsonb_build_object('status', 'ok', 'masked_email', private.masked_email(i.email));
end;
$$;
revoke execute on function public.request_platform_sign_in(text) from public, anon, authenticated;
grant execute on function public.request_platform_sign_in(text) to service_role;

-- ===========================================================================
-- Invited DJ: status and verified acceptance (authenticated)
-- ===========================================================================

-- What the signed-in user may do with an invitation. Details only for the
-- verified invited address; a created workspace only for the user who created it.
create function public.platform_invitation_status(p_invitation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i public.platform_invitations%rowtype;
  v_uid uuid := (select auth.uid());
  v_email text;
  t public.tenants%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('state', 'signed_out');
  end if;
  select * into i from public.platform_invitations where id = p_invitation_id;
  if not found then
    return jsonb_build_object('state', 'invalid');
  end if;
  if i.accepted_at is not null then
    if i.accepted_by <> v_uid then
      return jsonb_build_object('state', 'invalid');
    end if;
    select * into t from public.tenants where id = i.tenant_id;
    return jsonb_build_object('state', 'created', 'slug', t.slug, 'display_name', t.display_name);
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
  return jsonb_build_object('state', 'ready', 'email', i.email, 'expires_at', i.expires_at);
end;
$$;

-- Creates the workspace: the tenant, its owner membership and the accepted
-- invitation, atomically, under the invitation's row lock. The owner is
-- always the signed-in user and the tenant always new. Repeats by the same
-- user return the same workspace; a taken or reserved slug changes nothing.
-- Returns {"state": "created" | "slug_taken" | "slug_invalid" | "name_invalid"
-- | "invalid" | "unverified" | "wrong_account" | "signed_out", ...}.
create function public.accept_platform_invitation(p_invitation_id uuid, p_display_name text, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.platform_invitations%rowtype;
  v_uid uuid := (select auth.uid());
  v_email text;
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_tenant uuid;
  v_existing_slug text;
begin
  if v_uid is null then
    return jsonb_build_object('state', 'signed_out');
  end if;
  select * into i from public.platform_invitations where id = p_invitation_id for update;
  if not found then
    return jsonb_build_object('state', 'invalid');
  end if;
  if i.accepted_at is not null then
    if i.accepted_by <> v_uid then
      return jsonb_build_object('state', 'invalid');
    end if;
    select t.slug into v_existing_slug from public.tenants t where t.id = i.tenant_id;
    return jsonb_build_object('state', 'created', 'slug', v_existing_slug, 'replayed', true);
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

  if length(v_name) not between 2 and 100 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('state', 'name_invalid');
  end if;
  if not private.is_claimable_tenant_slug(v_slug) then
    return jsonb_build_object('state', 'slug_invalid');
  end if;
  begin
    -- The legal name is unknown until the owner enters it in Business
    -- settings; the display name stands in (the column is required). Address
    -- and contact email stay empty, which keeps contracts unsendable
    -- (business_settings_incomplete) until the owner saves those settings.
    insert into public.tenants (slug, business_name, display_name)
    values (v_slug, v_name, v_name)
    returning id into v_tenant;
  exception when unique_violation then
    return jsonb_build_object('state', 'slug_taken');
  end;
  insert into public.tenant_memberships (tenant_id, user_id, role) values (v_tenant, v_uid, 'owner');
  update public.platform_invitations
    set accepted_at = now(), accepted_by = v_uid, tenant_id = v_tenant
    where id = i.id;
  perform private.cancel_platform_invitation_emails(i.id, 'invitation accepted');
  perform private.platform_audit('platform_invitation', i.id, 'accepted', v_uid, jsonb_build_object('tenant_id', v_tenant, 'slug', v_slug));
  perform private.audit(v_tenant, 'tenant', v_tenant, 'created', 'staff', v_uid, jsonb_build_object('platform_invitation_id', i.id));
  return jsonb_build_object('state', 'created', 'slug', v_slug, 'replayed', false);
end;
$$;

revoke execute on function
  public.platform_invitation_status(uuid),
  public.accept_platform_invitation(uuid, text, text)
  from public, anon;
grant execute on function
  public.platform_invitation_status(uuid),
  public.accept_platform_invitation(uuid, text, text)
  to authenticated;
