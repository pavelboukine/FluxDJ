-- Owner-managed business branding: a verified logo and a primary colour.
--
-- Sources of truth (unchanged columns, now written only through checked paths):
--   tenants.logo_storage_path   the active logo, or null (display name instead)
--   tenants.brand_colors        {"primary": "#RRGGBB", ...} (existing validator)
-- New:
--   tenants.branding_version    optimistic version (PT409 on stale saves)
--   public.tenant_logos         every logo the server verified and re-encoded;
--                               a logo can be active only if registered here
--   storage bucket tenant-logos private, PNG only; read and written by the
--                               server alone (signed URLs after each page's
--                               own authorization), like signed PDFs
--
-- Logos are immutable and never deleted: a new upload gets a new path, so
-- proposals that froze a logo path at send time keep showing that logo after
-- the owner replaces or removes it. private.unused_tenant_logos() lists logos
-- nothing references (for a later, deliberate clean-up).

-- ===========================================================================
-- Registry of verified logos
-- ===========================================================================

create table public.tenant_logos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  storage_path text not null
    constraint tenant_logos_path_key unique,
  sha256 text not null
    constraint tenant_logos_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer not null
    constraint tenant_logos_byte_size_range check (byte_size between 1 and 3145728),
  width integer not null
    constraint tenant_logos_width_range check (width between 1 and 1024),
  height integer not null
    constraint tenant_logos_height_range check (height between 1 and 1024),
  -- Mostly light artwork (for example white on transparent): shown on a dark
  -- backdrop so it stays visible on light backgrounds.
  needs_dark_background boolean not null,
  uploaded_by uuid not null,
  created_at timestamptz not null default now(),
  constraint tenant_logos_path_format check (
    storage_path ~ ('^' || tenant_id || '/logos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$')),
  constraint tenant_logos_tenant_path_key unique (tenant_id, storage_path),
  constraint tenant_logos_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.tenant_logos is
  'Logos verified and re-encoded by the server (PNG). Immutable and never deleted, so frozen proposals keep their logo.';
create trigger tenant_logos_immutable before update or delete on public.tenant_logos
  for each row execute function private.reject_change();
create trigger tenant_logos_workspace_suspended before insert on public.tenant_logos
  for each row execute function private.tenant_write_guard();

alter table public.tenant_logos enable row level security;
revoke all on public.tenant_logos from anon, authenticated;
grant select on public.tenant_logos to authenticated;
create policy tenant_logos_select_staff on public.tenant_logos
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));

-- The active logo must be a registered logo of the same business. Not
-- validated for existing rows (none was ever set through the app); enforced
-- for every change from now on.
alter table public.tenants
  add constraint tenants_logo_registered foreign key (id, logo_storage_path)
    references public.tenant_logos (tenant_id, storage_path) on delete restrict not valid;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-logos', 'tenant-logos', false, 3145728, array['image/png'])
on conflict (id) do nothing;
-- No Storage policies: only the service role reads or writes this bucket.

-- ===========================================================================
-- Branding columns: owner-only, versioned, through update_tenant_branding
-- ===========================================================================

alter table public.tenants add column branding_version integer not null default 0
  constraint tenants_branding_version_nonnegative check (branding_version >= 0);
comment on column public.tenants.branding_version is
  'Optimistic version for update_tenant_branding; increases by one on every branding change.';
revoke update (logo_storage_path, brand_colors) on public.tenants from authenticated;

-- Registers a logo the server has verified, re-encoded and stored. Service
-- role only (the app calls it after its checks); rechecks the uploader is the
-- owner and the stored object matches. At most 30 logos per business a day.
create function public.register_tenant_logo(
  p_tenant_id uuid, p_user_id uuid, p_storage_path text, p_sha256 text, p_byte_size integer,
  p_width integer, p_height integer, p_needs_dark_background boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_object record;
  v_id uuid;
begin
  if not exists (select 1 from public.tenant_memberships m
                 where m.tenant_id = p_tenant_id and m.user_id = p_user_id and m.role = 'owner') then
    raise exception 'only the owner can change branding' using errcode = 'insufficient_privilege';
  end if;
  if (select count(*) from public.tenant_logos l where l.tenant_id = p_tenant_id and l.created_at > now() - interval '1 day') >= 30 then
    raise exception 'branding_invalid: too many logo uploads today. Try again tomorrow' using errcode = 'invalid_parameter_value';
  end if;
  select (o.metadata ->> 'size')::bigint as size, o.metadata ->> 'mimetype' as mimetype into v_object
  from storage.objects o where o.bucket_id = 'tenant-logos' and o.name = p_storage_path;
  if not found or v_object.size is distinct from p_byte_size or v_object.mimetype is distinct from 'image/png' then
    raise exception 'branding_invalid: the stored logo is missing or does not match' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.tenant_logos (tenant_id, storage_path, sha256, byte_size, width, height, needs_dark_background, uploaded_by)
  values (p_tenant_id, p_storage_path, p_sha256, p_byte_size, p_width, p_height, p_needs_dark_background, p_user_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.register_tenant_logo(uuid, uuid, text, text, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.register_tenant_logo(uuid, uuid, text, text, integer, integer, integer, boolean) to service_role;

-- Sets the active logo (a registered logo of this business, or null for the
-- display name) and the primary colour (#RRGGBB, or null for the default).
-- Owner only; other brand_colors keys are kept. Stale versions raise PT409.
create function public.update_tenant_branding(p_tenant_id uuid, p_expected_version integer, p_logo_id uuid, p_primary_color text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  t public.tenants%rowtype;
  v_path text;
  v_color text := nullif(lower(btrim(coalesce(p_primary_color, ''))), '');
  v_colors jsonb;
begin
  select m.role into v_role from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change branding' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.suspended_at is not null then
    raise exception 'workspace_suspended: this workspace is suspended' using errcode = 'PT423';
  end if;
  if p_expected_version is distinct from t.branding_version then
    raise exception 'branding was changed elsewhere' using errcode = 'PT409';
  end if;
  if v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'branding_invalid: the colour must be a hex value like #1a2b3c' using errcode = 'invalid_parameter_value';
  end if;
  if p_logo_id is not null then
    select l.storage_path into v_path from public.tenant_logos l where l.tenant_id = p_tenant_id and l.id = p_logo_id;
    if v_path is null then
      raise exception 'branding_invalid: that logo is not available' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  v_colors := case when v_color is null then t.brand_colors - 'primary' else t.brand_colors || jsonb_build_object('primary', v_color) end;

  update public.tenants
    set logo_storage_path = v_path, brand_colors = v_colors, branding_version = branding_version + 1
    where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'branding_updated', 'staff', (select auth.uid()),
    jsonb_build_object('logo_changed', v_path is distinct from t.logo_storage_path, 'logo_storage_path', v_path,
                       'primary_color', v_color, 'version', t.branding_version + 1));
  return t.branding_version + 1;
end;
$$;
revoke execute on function public.update_tenant_branding(uuid, integer, uuid, text) from public, anon;
grant execute on function public.update_tenant_branding(uuid, integer, uuid, text) to authenticated;

-- ===========================================================================
-- Live branding for client pages (contract, planning, invitation, proposal
-- messages): adds the active logo. Unchanged otherwise (still nothing for
-- archived or suspended businesses).
-- ===========================================================================

create or replace function public.public_tenant_brand(p_tenant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors,
           'logo_storage_path', l.storage_path, 'logo_needs_dark_background', l.needs_dark_background,
           'logo_width', l.width, 'logo_height', l.height)
  from public.tenants t
  left join public.tenant_logos l on l.tenant_id = t.id and l.storage_path = t.logo_storage_path
  where t.slug = p_tenant_slug and t.archived_at is null and t.suspended_at is null;
$$;

-- Display details of a frozen proposal logo (service role): only a
-- registered logo of the proposal's own business.
create function public.tenant_logo_details(p_tenant_id uuid, p_storage_path text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('storage_path', l.storage_path, 'needs_dark_background', l.needs_dark_background,
           'width', l.width, 'height', l.height)
  from public.tenant_logos l where l.tenant_id = p_tenant_id and l.storage_path = p_storage_path;
$$;
revoke execute on function public.tenant_logo_details(uuid, text) from public, anon, authenticated;
grant execute on function public.tenant_logo_details(uuid, text) to service_role;

-- ===========================================================================
-- Orphans
-- ===========================================================================

-- Registered logos that are neither active nor frozen into any proposal, and
-- stored objects that never became a registered logo (an upload whose
-- registration failed). Nothing is deleted automatically.
create function private.unused_tenant_logos()
returns table (tenant_id uuid, storage_path text, registered boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.tenant_id, l.storage_path, true, l.created_at
  from public.tenant_logos l
  where not exists (select 1 from public.tenants t where t.id = l.tenant_id and t.logo_storage_path = l.storage_path)
    and not exists (select 1 from public.proposals p
                    where p.tenant_id = l.tenant_id and p.offer_snapshot -> 'branding' ->> 'logo_storage_path' = l.storage_path)
  union all
  select (split_part(o.name, '/', 1))::uuid, o.name, false, o.created_at
  from storage.objects o
  where o.bucket_id = 'tenant-logos' and split_part(o.name, '/', 1) ~ '^[0-9a-f-]{36}$'
    and not exists (select 1 from public.tenant_logos l where l.storage_path = o.name);
$$;
revoke execute on function private.unused_tenant_logos() from public, anon, authenticated, service_role;
