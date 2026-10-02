-- Flux DJ tenancy core: tenants, memberships, clients, events, event clients
-- and event access. Spec sections 3, 4 (accounts, clients and events) and 7.
--
-- Isolation is enforced in three layers:
--   1. Composite foreign keys (tenant_id, parent_id) make cross-tenant
--      references impossible, whatever role writes the row.
--   2. Triggers make id, tenant_id and parent references immutable.
--   3. Row-level security plus narrow column grants limit what each
--      authenticated user can see and change. anon has no table access.

-- ===========================================================================
-- Tables
-- ===========================================================================

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    constraint tenants_slug_valid check (private.is_valid_tenant_slug(slug)),
  business_name text not null
    constraint tenants_business_name_length check (length(btrim(business_name)) between 1 and 200),
  display_name text not null
    constraint tenants_display_name_length check (length(btrim(display_name)) between 1 and 200),
  logo_storage_path text
    constraint tenants_logo_path_length check (length(logo_storage_path) between 1 and 1024),
  brand_colors jsonb not null default '{}'::jsonb
    constraint tenants_brand_colors_valid check (private.is_valid_brand_colors(brand_colors)),
  reply_to_email text
    constraint tenants_reply_to_email_valid check (private.is_valid_email(reply_to_email)),
  timezone text not null default 'America/Toronto'
    constraint tenants_timezone_valid check (private.is_valid_timezone(timezone)),
  currency text not null default 'CAD'
    constraint tenants_currency_valid check (currency ~ '^[A-Z]{3}$'),
  planning_lock_days integer not null default 7
    constraint tenants_planning_lock_days_range check (planning_lock_days between 0 and 365),
  booking_confirmation_policy text not null default 'on_signature'
    constraint tenants_booking_policy_valid check (booking_confirmation_policy in ('on_signature', 'on_deposit')),
  tax_config jsonb not null default '[]'::jsonb
    constraint tenants_tax_config_valid check (private.is_valid_tax_config(tax_config)),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.tenants is 'A DJ business. Root of tenant isolation; the only table without tenant_id.';
comment on column public.tenants.tax_config is 'Array of {code,label,rate_ppm}; rate_ppm is parts per million (50000 = 5%).';

create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null
    constraint tenant_memberships_role_valid check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_memberships_tenant_user_key unique (tenant_id, user_id),
  constraint tenant_memberships_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.tenant_memberships is 'Staff access to a tenant. Deleting the row revokes access.';
-- V1: exactly one owner per tenant. Drop this index to allow co-owners later.
create unique index tenant_memberships_one_owner_idx
  on public.tenant_memberships (tenant_id) where role = 'owner';
create index tenant_memberships_user_id_idx on public.tenant_memberships (user_id);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  name text not null
    constraint clients_name_length check (length(btrim(name)) between 1 and 200),
  email text not null
    constraint clients_email_valid check (private.is_valid_email(email)),
  phone text
    constraint clients_phone_length check (length(btrim(phone)) between 1 and 40),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.clients is 'Contacts of one DJ business. Never shared between tenants. Archive instead of delete.';
create index clients_tenant_email_idx on public.clients (tenant_id, email);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  title text not null
    constraint events_title_length check (length(btrim(title)) between 1 and 200),
  event_type text not null
    constraint events_event_type_valid check (event_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  event_date date not null,
  timezone text not null default 'America/Toronto'
    constraint events_timezone_valid check (private.is_valid_timezone(timezone)),
  venue_name text
    constraint events_venue_name_length check (length(btrim(venue_name)) between 1 and 200),
  venue_address text
    constraint events_venue_address_length check (length(btrim(venue_address)) between 1 and 500),
  lifecycle_status text not null default 'lead'
    constraint events_lifecycle_status_valid check (lifecycle_status in (
      'lead', 'pending_approval', 'awaiting_signature', 'awaiting_deposit',
      'booked', 'completed', 'cancelled'
    )),
  booking_confirmed_at timestamptz,
  -- Null means "use tenants.planning_lock_days before event_date in timezone".
  planning_lock_at timestamptz,
  planning_override_until timestamptz,
  internal_notes text
    constraint events_internal_notes_length check (length(internal_notes) <= 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_tenant_id_id_key unique (tenant_id, id),
  constraint events_booked_has_confirmation check (
    lifecycle_status not in ('booked', 'completed') or booking_confirmed_at is not null
  )
);
comment on table public.events is 'Staff-only table. Clients read safe columns via public.my_events(); internal_notes is never exposed to clients.';
comment on column public.events.timezone is 'IANA timezone; governs planning cutoff and local timeline times.';
-- active_proposal_id is added with the proposals migration (Phase 1, step 5/6)
-- so it never exists without its composite foreign key.
create index events_tenant_date_idx on public.events (tenant_id, event_date);

create table public.event_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  client_id uuid not null,
  is_primary boolean not null default false,
  can_sign boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_clients_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete cascade,
  constraint event_clients_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict,
  constraint event_clients_event_client_key unique (event_id, client_id),
  constraint event_clients_tenant_event_client_key unique (tenant_id, event_id, client_id),
  constraint event_clients_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.event_clients is 'Contacts on an event. One primary contact and (V1) one signer per event.';
create unique index event_clients_one_primary_idx on public.event_clients (event_id) where is_primary;
-- V1 supports one client signer. Drop this index when multi-signer lands.
create unique index event_clients_one_signer_idx on public.event_clients (event_id) where can_sign;
create index event_clients_tenant_client_idx on public.event_clients (tenant_id, client_id);

create table public.event_access (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  client_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_access_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete cascade,
  constraint event_access_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict,
  -- Access can only be granted to a contact who is actually on the event.
  constraint event_access_event_client_fk foreign key (tenant_id, event_id, client_id)
    references public.event_clients (tenant_id, event_id, client_id) on delete restrict,
  constraint event_access_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.event_access is
  'Grants one verified Auth user access to one event, never to a whole tenant. '
  'Created only by trusted server code after email verification. Revoke by setting revoked_at.';
create unique index event_access_one_active_idx
  on public.event_access (event_id, user_id) where revoked_at is null;
create index event_access_user_active_idx
  on public.event_access (user_id) where revoked_at is null;
create index event_access_tenant_event_client_idx
  on public.event_access (tenant_id, event_id, client_id);
create index event_access_tenant_client_idx on public.event_access (tenant_id, client_id);

-- ===========================================================================
-- Triggers
-- ===========================================================================

create trigger tenants_set_updated_at before update on public.tenants
  for each row execute function private.set_updated_at();
create trigger tenants_immutable before update on public.tenants
  for each row execute function private.forbid_column_changes('id', 'created_at');

create trigger tenant_memberships_set_updated_at before update on public.tenant_memberships
  for each row execute function private.set_updated_at();
create trigger tenant_memberships_immutable before update on public.tenant_memberships
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'user_id', 'created_at');

create trigger clients_set_updated_at before update on public.clients
  for each row execute function private.set_updated_at();
create trigger clients_immutable before update on public.clients
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_at');

create trigger events_set_updated_at before update on public.events
  for each row execute function private.set_updated_at();
create trigger events_immutable before update on public.events
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_at');

create trigger event_clients_set_updated_at before update on public.event_clients
  for each row execute function private.set_updated_at();
create trigger event_clients_immutable before update on public.event_clients
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'event_id', 'client_id', 'created_at');

create trigger event_access_set_updated_at before update on public.event_access
  for each row execute function private.set_updated_at();
create trigger event_access_immutable before update on public.event_access
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'event_id', 'client_id', 'user_id', 'created_at');

-- Revocation is one-way and timestamped by the database. Re-granting access
-- creates a new row, which preserves history.
create function private.event_access_revocation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'event access revocation cannot be undone or changed'
      using errcode = 'check_violation';
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;
create trigger event_access_revocation before update on public.event_access
  for each row execute function private.event_access_revocation();

-- ===========================================================================
-- Authorization helpers
-- Security definer so policies can read memberships without recursing through
-- tenant_memberships RLS. Fixed empty search_path; schema-qualified names only.
-- ===========================================================================

create function private.member_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
  from public.tenant_memberships m
  where m.user_id = (select auth.uid());
$$;

create function private.owner_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
  from public.tenant_memberships m
  where m.user_id = (select auth.uid())
    and m.role = 'owner';
$$;

-- Events the current user may access as a client: an active (unrevoked)
-- event_access row and a verified Auth email. An email match alone grants
-- nothing.
create function private.client_event_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ea.event_id
  from public.event_access ea
  join auth.users u on u.id = ea.user_id
  where ea.user_id = (select auth.uid())
    and ea.revoked_at is null
    and u.email_confirmed_at is not null;
$$;

revoke execute on function private.member_tenant_ids() from public, anon;
revoke execute on function private.owner_tenant_ids() from public, anon;
revoke execute on function private.client_event_ids() from public, anon;
grant execute on function private.member_tenant_ids() to authenticated;
grant execute on function private.owner_tenant_ids() to authenticated;
grant execute on function private.client_event_ids() to authenticated;

-- ===========================================================================
-- Privileges. RLS limits rows, not columns, so column grants restrict which
-- fields each role can write. anon gets nothing.
-- ===========================================================================

revoke all on public.tenants, public.tenant_memberships, public.clients,
  public.events, public.event_clients, public.event_access
  from anon, authenticated;

-- Tenants: created, renamed (slug) and archived by trusted server code only.
grant select on public.tenants to authenticated;
grant update (
  business_name, display_name, logo_storage_path, brand_colors, reply_to_email,
  timezone, currency, planning_lock_days, booking_confirmation_policy, tax_config
) on public.tenants to authenticated;

-- Memberships: owners manage staff. Owner rows are managed by trusted code.
grant select, delete on public.tenant_memberships to authenticated;
grant insert (tenant_id, user_id, role) on public.tenant_memberships to authenticated;
grant update (role) on public.tenant_memberships to authenticated;

-- Clients: staff manage contacts; archive instead of delete.
grant select on public.clients to authenticated;
grant insert (tenant_id, name, email, phone) on public.clients to authenticated;
grant update (name, email, phone, archived_at) on public.clients to authenticated;

-- Events: staff manage descriptive fields. lifecycle_status and
-- booking_confirmed_at change only through transactional server operations
-- (send, submit, approve, sign, payment update). Events are cancelled, not deleted.
grant select on public.events to authenticated;
grant insert (
  tenant_id, title, event_type, event_date, timezone, venue_name, venue_address,
  planning_lock_at, internal_notes
) on public.events to authenticated;
grant update (
  title, event_type, event_date, timezone, venue_name, venue_address,
  planning_lock_at, planning_override_until, internal_notes
) on public.events to authenticated;

-- Event contacts: staff manage them.
grant select, delete on public.event_clients to authenticated;
grant insert (tenant_id, event_id, client_id, is_primary, can_sign) on public.event_clients to authenticated;
grant update (is_primary, can_sign) on public.event_clients to authenticated;

-- Event access: created only after verified email by trusted server code
-- (service_role). Staff can see and revoke it.
grant select on public.event_access to authenticated;
grant update (revoked_at) on public.event_access to authenticated;

-- ===========================================================================
-- Row-level security
-- ===========================================================================

alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.clients enable row level security;
alter table public.events enable row level security;
alter table public.event_clients enable row level security;
alter table public.event_access enable row level security;

-- tenants ---------------------------------------------------------------------
create policy tenants_select_member on public.tenants
  for select to authenticated
  using (id in (select private.member_tenant_ids()));

create policy tenants_update_owner on public.tenants
  for update to authenticated
  using (id in (select private.owner_tenant_ids()))
  with check (id in (select private.owner_tenant_ids()));

-- tenant_memberships ------------------------------------------------------------
create policy tenant_memberships_select_member on public.tenant_memberships
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

create policy tenant_memberships_insert_owner on public.tenant_memberships
  for insert to authenticated
  with check (role = 'staff' and tenant_id in (select private.owner_tenant_ids()));

create policy tenant_memberships_update_owner on public.tenant_memberships
  for update to authenticated
  using (role = 'staff' and tenant_id in (select private.owner_tenant_ids()))
  with check (role = 'staff' and tenant_id in (select private.owner_tenant_ids()));

create policy tenant_memberships_delete_owner on public.tenant_memberships
  for delete to authenticated
  using (role = 'staff' and tenant_id in (select private.owner_tenant_ids()));

-- clients ---------------------------------------------------------------------
create policy clients_select_staff on public.clients
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

create policy clients_insert_staff on public.clients
  for insert to authenticated
  with check (tenant_id in (select private.member_tenant_ids()));

create policy clients_update_staff on public.clients
  for update to authenticated
  using (tenant_id in (select private.member_tenant_ids()))
  with check (tenant_id in (select private.member_tenant_ids()));

-- events ------------------------------------------------------------------------
-- No client policy: clients use public.my_events(), which omits staff fields.
create policy events_select_staff on public.events
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

create policy events_insert_staff on public.events
  for insert to authenticated
  with check (tenant_id in (select private.member_tenant_ids()));

create policy events_update_staff on public.events
  for update to authenticated
  using (tenant_id in (select private.member_tenant_ids()))
  with check (tenant_id in (select private.member_tenant_ids()));

-- event_clients -----------------------------------------------------------------
create policy event_clients_select_staff on public.event_clients
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

create policy event_clients_insert_staff on public.event_clients
  for insert to authenticated
  with check (tenant_id in (select private.member_tenant_ids()));

create policy event_clients_update_staff on public.event_clients
  for update to authenticated
  using (tenant_id in (select private.member_tenant_ids()))
  with check (tenant_id in (select private.member_tenant_ids()));

create policy event_clients_delete_staff on public.event_clients
  for delete to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- event_access --------------------------------------------------------------------
create policy event_access_select_staff on public.event_access
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

create policy event_access_update_staff on public.event_access
  for update to authenticated
  using (tenant_id in (select private.member_tenant_ids()))
  with check (tenant_id in (select private.member_tenant_ids()));

-- ===========================================================================
-- Client read projection
-- ===========================================================================

-- Safe event list for a signed-in client: only events with active, verified
-- access, and only client-safe columns. Never returns internal_notes, other
-- contacts, planning lock overrides or tenant settings beyond branding.
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
  lifecycle_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, t.slug, t.display_name, e.title, e.event_type, e.event_date,
         e.timezone, e.venue_name, e.venue_address, e.lifecycle_status
  from public.events e
  join public.tenants t on t.id = e.tenant_id
  where e.id in (select private.client_event_ids())
    and t.archived_at is null
  order by e.event_date, e.id;
$$;
revoke execute on function public.my_events() from public, anon;
grant execute on function public.my_events() to authenticated;
