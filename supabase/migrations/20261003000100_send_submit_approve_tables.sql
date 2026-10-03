-- Flux DJ step 6 (part 1): tables and integrity rules for sending proposals,
-- public proposal access, client submission, staff approval, the email
-- outbox, durable rate limits and the audit log.
--
-- Access model (spec section 7):
--   * access_links store only sha256(token). The token itself is derived on
--     the server as HMAC(PROPOSAL_LINK_SECRET, link id), so an email retry can
--     rebuild the same link without plaintext or ciphertext in the database.
--   * proposal_sessions are what a link is exchanged for: a random session
--     token in an HttpOnly cookie, stored here only as a hash, scoped to one
--     proposal, expiring, and revocable.
--   * None of these tables are reachable by anon. Clients act only through
--     service_role functions that recheck the session on every call.

-- ===========================================================================
-- Proposals: lifecycle guards
-- ===========================================================================

-- At most one actionable (sent, submitted or approved) proposal per event.
create unique index proposals_one_actionable_per_event_idx
  on public.proposals (event_id) where status in ('sent', 'submitted', 'approved');

alter table public.proposals
  add constraint proposals_sent_has_dates check (status = 'draft' or (sent_at is not null and expires_at is not null));

-- supersedes_id is set by the send transaction, together with freezing; after
-- that it, like the rest of the offer, never changes.
drop trigger proposals_immutable on public.proposals;
create trigger proposals_immutable before update on public.proposals
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'revision', 'created_by_membership_id', 'created_at');

create or replace function private.proposals_freeze_once()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.offer_snapshot is not null then
      raise exception 'proposals are created as drafts; they are frozen only by send_proposal'
        using errcode = 'check_violation';
    end if;
    new.offer_sha256 := null;
    new.offer_frozen_at := null;
    return new;
  end if;

  if old.offer_snapshot is not null then
    if new.offer_snapshot is distinct from old.offer_snapshot
       or new.offer_sha256 is distinct from old.offer_sha256
       or new.offer_frozen_at is distinct from old.offer_frozen_at
       or new.draft_offer is distinct from old.draft_offer
       or new.source_template_id is distinct from old.source_template_id
       or new.supersedes_id is distinct from old.supersedes_id
       or new.sent_at is distinct from old.sent_at then
      raise exception 'the offer is frozen and cannot change' using errcode = 'check_violation';
    end if;
    -- The deadline may be brought forward (withdrawing an offer), never extended.
    if old.expires_at is not null and (new.expires_at is null or new.expires_at > old.expires_at) then
      raise exception 'a sent offer''s deadline cannot be extended; send a new revision instead'
        using errcode = 'check_violation';
    end if;
  elsif new.offer_snapshot is not null then
    new.offer_sha256 := encode(pg_catalog.sha256(convert_to(new.offer_snapshot::text, 'UTF8')), 'hex');
    new.offer_frozen_at := now();
  else
    new.offer_sha256 := null;
    new.offer_frozen_at := null;
  end if;
  return new;
end;
$$;

create function private.proposals_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status = 'sent')
    or (old.status = 'sent' and new.status in ('submitted', 'superseded', 'expired', 'declined'))
    or (old.status = 'submitted' and new.status in ('approved', 'superseded', 'declined'))
    or (old.status = 'approved' and new.status = 'superseded')
  ) then
    raise exception 'proposal cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger proposals_status_transition before update on public.proposals
  for each row execute function private.proposals_status_transition();

-- ===========================================================================
-- Events: the one actionable proposal
-- ===========================================================================

alter table public.events
  add column active_proposal_id uuid,
  add constraint events_active_proposal_fk foreign key (tenant_id, active_proposal_id)
    references public.proposals (tenant_id, id) on delete restrict;
create index events_tenant_active_proposal_idx on public.events (tenant_id, active_proposal_id);
comment on column public.events.active_proposal_id is
  'The proposal clients can act on. Set only by send_proposal; never by staff directly.';

create function private.events_active_proposal_matches()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active_proposal_id is not null and not exists (
    select 1 from public.proposals p
    where p.tenant_id = new.tenant_id and p.id = new.active_proposal_id and p.event_id = new.id
  ) then
    raise exception 'active proposal must belong to the event' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke execute on function private.events_active_proposal_matches() from public, anon, authenticated;
create trigger events_active_proposal_matches before insert or update of active_proposal_id on public.events
  for each row execute function private.events_active_proposal_matches();

-- ===========================================================================
-- Selections: idempotent submissions and approval references
-- ===========================================================================

alter table public.proposal_selections
  add column idempotency_key text
    constraint proposal_selections_idempotency_key_format check (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  add constraint proposal_selections_proposal_idempotency_key unique (proposal_id, idempotency_key),
  add constraint proposal_selections_tenant_proposal_id_key unique (tenant_id, proposal_id, id);

-- ===========================================================================
-- Generic one-way revocation
-- ===========================================================================

create function private.one_way_revocation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'revocation cannot be undone or changed' using errcode = 'check_violation';
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- Access links (bearer links) and proposal sessions
-- ===========================================================================

create table public.access_links (
  -- Chosen by the server: the token is HMAC(secret, id), so the id must exist
  -- before the row is inserted.
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  purpose text not null
    constraint access_links_purpose_valid check (purpose in ('proposal')),
  proposal_id uuid not null,
  intended_client_id uuid not null,
  token_hash text not null unique
    constraint access_links_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  -- Reserved for one-time signing links (Phase 2). Proposal links are reusable.
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint access_links_proposal_fk foreign key (tenant_id, proposal_id)
    references public.proposals (tenant_id, id) on delete restrict,
  constraint access_links_client_fk foreign key (tenant_id, intended_client_id)
    references public.clients (tenant_id, id) on delete restrict,
  constraint access_links_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.access_links is
  'Bearer links. Only sha256(token) is stored. A proposal link grants proposal access only: never signing identity, event access or planning.';
create unique index access_links_one_active_proposal_link_idx
  on public.access_links (proposal_id) where purpose = 'proposal' and revoked_at is null;
create index access_links_tenant_proposal_idx on public.access_links (tenant_id, proposal_id);
create index access_links_tenant_client_idx on public.access_links (tenant_id, intended_client_id);

create trigger access_links_set_updated_at before update on public.access_links
  for each row execute function private.set_updated_at();
create trigger access_links_immutable before update on public.access_links
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'purpose', 'proposal_id', 'intended_client_id', 'token_hash', 'expires_at', 'created_at');
create trigger access_links_revocation before update on public.access_links
  for each row execute function private.one_way_revocation();

create table public.proposal_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  proposal_id uuid not null,
  access_link_id uuid not null,
  session_hash text not null unique
    constraint proposal_sessions_hash_format check (session_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposal_sessions_proposal_fk foreign key (tenant_id, proposal_id)
    references public.proposals (tenant_id, id) on delete restrict,
  constraint proposal_sessions_link_fk foreign key (tenant_id, access_link_id)
    references public.access_links (tenant_id, id) on delete restrict,
  constraint proposal_sessions_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.proposal_sessions is
  'Anonymous proposal sessions created by exchanging a link. Scope: one proposal; view, edit selection, submit. Never staff-visible tokens.';
create index proposal_sessions_tenant_proposal_idx on public.proposal_sessions (tenant_id, proposal_id);
create index proposal_sessions_tenant_link_idx on public.proposal_sessions (tenant_id, access_link_id);

create trigger proposal_sessions_set_updated_at before update on public.proposal_sessions
  for each row execute function private.set_updated_at();
create trigger proposal_sessions_immutable before update on public.proposal_sessions
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'proposal_id', 'access_link_id', 'session_hash', 'expires_at', 'created_at');
create trigger proposal_sessions_revocation before update on public.proposal_sessions
  for each row execute function private.one_way_revocation();

-- Link openings. Best effort: email scanners and previews can open links, so
-- an opening is not proof the client read the proposal.
create table public.proposal_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  proposal_id uuid not null,
  access_link_id uuid not null,
  kind text not null default 'link_opened'
    constraint proposal_views_kind_valid check (kind in ('link_opened')),
  opened_at timestamptz not null default now(),
  constraint proposal_views_proposal_fk foreign key (tenant_id, proposal_id)
    references public.proposals (tenant_id, id) on delete restrict,
  constraint proposal_views_link_fk foreign key (tenant_id, access_link_id)
    references public.access_links (tenant_id, id) on delete restrict,
  constraint proposal_views_tenant_id_id_key unique (tenant_id, id)
);
create index proposal_views_tenant_proposal_idx on public.proposal_views (tenant_id, proposal_id, opened_at);
create index proposal_views_tenant_link_idx on public.proposal_views (tenant_id, access_link_id);
create trigger proposal_views_append_only before update or delete on public.proposal_views
  for each row execute function private.reject_change();

-- ===========================================================================
-- Approvals
-- ===========================================================================

create table public.proposal_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  proposal_id uuid not null,
  selection_id uuid not null,
  approved_by_membership_id uuid,
  approved_by_user_id uuid not null,
  approved_at timestamptz not null default now(),
  -- SHA-256 of the approved selection's stored snapshot (canonical jsonb text).
  selection_sha256 text not null
    constraint proposal_approvals_sha256_format check (selection_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint proposal_approvals_selection_fk foreign key (tenant_id, proposal_id, selection_id)
    references public.proposal_selections (tenant_id, proposal_id, id) on delete restrict,
  constraint proposal_approvals_membership_fk foreign key (tenant_id, approved_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (approved_by_membership_id),
  constraint proposal_approvals_proposal_key unique (proposal_id),
  constraint proposal_approvals_selection_key unique (selection_id),
  constraint proposal_approvals_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.proposal_approvals is
  'Staff approval of one exact, immutable submitted selection. Prepares the contract phase; is not a booking.';
create index proposal_approvals_tenant_selection_idx on public.proposal_approvals (tenant_id, proposal_id, selection_id);
create index proposal_approvals_tenant_membership_idx on public.proposal_approvals (tenant_id, approved_by_membership_id);
create trigger proposal_approvals_immutable before update or delete on public.proposal_approvals
  for each row execute function private.reject_change();

-- ===========================================================================
-- Email outbox
-- ===========================================================================

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_type text not null
    constraint email_outbox_event_type_valid check (event_type in (
      'proposal_sent', 'proposal_link_opened', 'proposal_submitted', 'proposal_approved'
    )),
  recipient_email text not null
    constraint email_outbox_recipient_valid check (private.is_valid_email(recipient_email)),
  entity_type text not null default 'proposal'
    constraint email_outbox_entity_type_valid check (entity_type in ('proposal')),
  entity_id uuid not null,
  -- For proposal emails: the link whose token the worker re-derives at send
  -- time. No token, plaintext or encrypted, is ever stored here.
  access_link_id uuid,
  -- Non-secret template data only.
  payload jsonb not null default '{}'::jsonb
    constraint email_outbox_payload_object check (jsonb_typeof(payload) = 'object'),
  dedup_key text not null unique
    constraint email_outbox_dedup_key_length check (length(dedup_key) between 1 and 200),
  status text not null default 'pending'
    constraint email_outbox_status_valid check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0
    constraint email_outbox_attempts_nonnegative check (attempts >= 0),
  max_attempts integer not null default 5
    constraint email_outbox_max_attempts_range check (max_attempts between 1 and 50),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text
    constraint email_outbox_last_error_length check (length(last_error) <= 1000),
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_outbox_link_fk foreign key (tenant_id, access_link_id)
    references public.access_links (tenant_id, id) on delete restrict,
  constraint email_outbox_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.email_outbox is
  'Durable outbox. Business state commits first; delivery happens afterwards with bounded retries. Dedup keys stop duplicate emails.';
create index email_outbox_due_idx on public.email_outbox (next_attempt_at) where status in ('pending', 'sending');
create index email_outbox_tenant_status_idx on public.email_outbox (tenant_id, status, created_at);
create index email_outbox_tenant_link_idx on public.email_outbox (tenant_id, access_link_id);
create trigger email_outbox_set_updated_at before update on public.email_outbox
  for each row execute function private.set_updated_at();
create trigger email_outbox_immutable before update on public.email_outbox
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_type', 'recipient_email', 'entity_type', 'entity_id', 'access_link_id', 'payload', 'dedup_key', 'created_at');

-- ===========================================================================
-- Audit log (append-only, staff-readable)
-- ===========================================================================

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  entity_type text not null
    constraint audit_events_entity_type_valid check (entity_type ~ '^[a-z_]{1,40}$'),
  entity_id uuid not null,
  action text not null
    constraint audit_events_action_valid check (action ~ '^[a-z_]{1,60}$'),
  actor_type text not null
    constraint audit_events_actor_type_valid check (actor_type in ('staff', 'client', 'system')),
  actor_id uuid,
  -- Minimal metadata only. No IP addresses or tokens (retention not yet decided).
  metadata jsonb not null default '{}'::jsonb
    constraint audit_events_metadata_object check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now()
);
create index audit_events_tenant_entity_idx on public.audit_events (tenant_id, entity_type, entity_id, occurred_at);
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function private.reject_change();

-- ===========================================================================
-- Durable rate limits (shared across server instances)
-- ===========================================================================

create table private.rate_limit_counters (
  bucket text not null,
  -- sha256 of the subject (e.g. client IP); raw IPs are never stored.
  subject_hash text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, subject_hash, window_start)
);
revoke all on private.rate_limit_counters from public, anon, authenticated;

-- ===========================================================================
-- Privileges and RLS
-- ===========================================================================

revoke all on public.access_links, public.proposal_sessions, public.proposal_views,
  public.proposal_approvals, public.email_outbox, public.audit_events
  from anon, authenticated;

-- Staff may see link status, never token hashes.
grant select (id, tenant_id, purpose, proposal_id, intended_client_id, expires_at, revoked_at, consumed_at, created_at)
  on public.access_links to authenticated;
grant select on public.proposal_views, public.proposal_approvals, public.email_outbox, public.audit_events to authenticated;
-- proposal_sessions: no authenticated access at all.

alter table public.access_links enable row level security;
alter table public.proposal_sessions enable row level security;
alter table public.proposal_views enable row level security;
alter table public.proposal_approvals enable row level security;
alter table public.email_outbox enable row level security;
alter table public.audit_events enable row level security;

create policy access_links_select_staff on public.access_links
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
create policy proposal_views_select_staff on public.proposal_views
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
create policy proposal_approvals_select_staff on public.proposal_approvals
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
create policy email_outbox_select_staff on public.email_outbox
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
create policy audit_events_select_staff on public.audit_events
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
