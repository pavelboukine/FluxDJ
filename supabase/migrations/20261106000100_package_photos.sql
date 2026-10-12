-- Package photos: one optional photo of its own per package.
--
-- Why a migration: packages had no media. A proposal's package card showed
-- the first photo of the first included gear item (by gear key), so a DJ
-- couldn't choose a photo of the whole setup. This adds a package photo that
-- follows the gear media conventions:
--
--   * package_media  one row per uploaded photo. Rows are never deleted and
--                    their file is never overwritten or removed: replacing
--                    or removing a photo archives its row (active = false),
--                    so proposals already sent keep showing it. At most one
--                    active photo per package. Images only.
--   * Storage        the private gear-media bucket, under
--                    {tenant_id}/packages/{package_id}/{uuid}.{ext}. Staff may
--                    read their own business's package photos and upload only
--                    under a package of their business. No update or delete
--                    policies (as for gear media); no public bucket.
--   * set_package_photo  sets (archiving the previous one) or removes the
--                    package's photo, audited. A repeat is a no-op.
--   * build_offer_snapshot  freezes the active photo into the package as
--                    "image" {storage_path, content_type, alt_text}, only when
--                    the package has one. A package without a photo is frozen
--                    exactly as before, so the previously deployed app (which
--                    rejects unknown snapshot fields) keeps working until a
--                    photo is added through the new app. Sent proposals keep
--                    their frozen copy; nothing reads the live photo for them.
--
-- Staff of the business only (member_tenant_ids / require_staff_of: removed
-- staff and other businesses get nothing, a suspended workspace is refused).
-- Clients and anon have no access to the table or the objects; proposal
-- pages serve frozen photos through the server's authorized media routes.

-- ===========================================================================
-- Validators
-- ===========================================================================

-- Package photo object names: {tenant_id}/packages/{package_id}/{uuid}.{ext}
-- (images only). A random object UUID per upload means a new photo never
-- replaces an object that a sent offer may still reference.
create function private.parse_package_media_path(object_name text)
returns table (tenant_id uuid, package_id uuid)
language sql
immutable
strict
set search_path = ''
as $$
  select m[1]::uuid, m[2]::uuid
  from (
    select regexp_match(
      object_name,
      '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
      '/packages/'
      '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
      '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      '\.(jpg|jpeg|png|webp|avif)$'
    ) as m
  ) parsed
  where m is not null;
$$;

create function private.is_valid_package_media_path(object_name text, p_tenant_id uuid, p_package_id uuid)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select exists (
    select 1 from private.parse_package_media_path(object_name) p
    where p.tenant_id = p_tenant_id and p.package_id = p_package_id
  );
$$;

grant execute on function
  private.parse_package_media_path(text),
  private.is_valid_package_media_path(text, uuid, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- Table
-- ===========================================================================

create table public.package_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  package_id uuid not null,
  storage_path text not null unique,
  content_type text not null,
  alt_text text not null
    constraint package_media_alt_text_length check (length(btrim(alt_text)) between 1 and 300),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint package_media_package_fk foreign key (tenant_id, package_id)
    references public.packages (tenant_id, id) on delete restrict,
  constraint package_media_path_valid
    check (private.is_valid_package_media_path(storage_path, tenant_id, package_id)),
  constraint package_media_type_is_image
    check (private.gear_media_type_kind(content_type) = 'image'),
  constraint package_media_extension_matches_type
    check (private.gear_media_extension_matches(storage_path, content_type)),
  constraint package_media_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.package_media is
  'A package''s own photo, stored in the gear-media bucket. At most one active per package. Never deleted or overwritten: replacing or removing archives the row (active = false), so sent offers keep it.';
create unique index package_media_one_active_idx on public.package_media (package_id) where active;
create index package_media_tenant_package_idx on public.package_media (tenant_id, package_id);

create trigger package_media_set_updated_at before update on public.package_media
  for each row execute function private.set_updated_at();
create trigger package_media_immutable before update on public.package_media
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'package_id', 'storage_path', 'content_type', 'alt_text', 'created_at');
create trigger package_media_workspace_suspended before insert or update or delete on public.package_media
  for each row execute function private.tenant_write_guard();

-- Staff read; every change goes through set_package_photo.
revoke all on public.package_media from anon, authenticated;
grant select on public.package_media to authenticated;

alter table public.package_media enable row level security;
create policy package_media_select_staff on public.package_media
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- ===========================================================================
-- Storage: package photos in the private gear-media bucket
-- ===========================================================================

-- Staff may read package photos of their own business.
create function private.can_read_package_media_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.parse_package_media_path(object_name) p
    where p.tenant_id in (select private.member_tenant_ids())
  );
$$;

-- Staff may upload only under a package that exists in their business.
create function private.can_upload_package_media_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.parse_package_media_path(object_name) p
    join public.packages pk on pk.tenant_id = p.tenant_id and pk.id = p.package_id
    where p.tenant_id in (select private.member_tenant_ids())
  );
$$;

revoke execute on function private.can_read_package_media_object(text) from public, anon;
revoke execute on function private.can_upload_package_media_object(text) from public, anon;
grant execute on function private.can_read_package_media_object(text) to authenticated;
grant execute on function private.can_upload_package_media_object(text) to authenticated;

-- As for gear media: no UPDATE or DELETE policies, so objects are never
-- overwritten (upsert fails) and never removed by staff.
create policy package_media_objects_select_staff on storage.objects
  for select to authenticated
  using (bucket_id = 'gear-media' and private.can_read_package_media_object(name));

create policy package_media_objects_insert_staff on storage.objects
  for insert to authenticated
  with check (bucket_id = 'gear-media' and private.can_upload_package_media_object(name));

-- ===========================================================================
-- Setting and removing the photo
-- ===========================================================================

-- Sets the package's photo to an uploaded object (p_storage_path), archiving
-- the previous one, or removes it (p_storage_path null). The app verifies the
-- file's contents before calling; the object must exist, under this package.
-- Returns {"status": "set" | "removed", "replayed": boolean}.
create function public.set_package_photo(
  p_package_id uuid,
  p_storage_path text,
  p_content_type text default null,
  p_alt_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_package public.packages%rowtype;
  v_current public.package_media%rowtype;
begin
  select * into v_package from public.packages where id = p_package_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_package.tenant_id);
  -- One change at a time per package.
  perform 1 from public.packages where id = v_package.id for update;
  select * into v_current from public.package_media where package_id = v_package.id and active;

  if p_storage_path is null then
    if v_current.id is null then
      return jsonb_build_object('status', 'removed', 'replayed', true);
    end if;
    update public.package_media set active = false where id = v_current.id;
    perform private.audit(v_package.tenant_id, 'package', v_package.id, 'package_photo_removed',
      'staff', (select auth.uid()), jsonb_build_object('storage_path', v_current.storage_path));
    return jsonb_build_object('status', 'removed', 'replayed', false);
  end if;

  -- Already this photo (a repeated click or a lost response): nothing changes.
  if v_current.storage_path = p_storage_path then
    return jsonb_build_object('status', 'set', 'replayed', true);
  end if;
  if not private.is_valid_package_media_path(p_storage_path, v_package.tenant_id, v_package.id)
     or coalesce(private.gear_media_type_kind(p_content_type), '') <> 'image'
     or not private.gear_media_extension_matches(p_storage_path, p_content_type)
     or length(btrim(coalesce(p_alt_text, ''))) not between 1 and 300 then
    raise exception 'photo_invalid: a JPEG, PNG, WebP or AVIF photo of this package with a description is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'gear-media' and o.name = p_storage_path) then
    raise exception 'photo_invalid: the upload was not found' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.package_media m where m.storage_path = p_storage_path) then
    raise exception 'photo_invalid: this upload was already used' using errcode = 'invalid_parameter_value';
  end if;

  if v_current.id is not null then
    update public.package_media set active = false where id = v_current.id;
  end if;
  insert into public.package_media (tenant_id, package_id, storage_path, content_type, alt_text)
  values (v_package.tenant_id, v_package.id, p_storage_path, p_content_type, btrim(p_alt_text));
  perform private.audit(v_package.tenant_id, 'package', v_package.id,
    case when v_current.id is null then 'package_photo_added' else 'package_photo_replaced' end,
    'staff', (select auth.uid()), jsonb_build_object('storage_path', p_storage_path));
  return jsonb_build_object('status', 'set', 'replayed', false);
end;
$$;
comment on function public.set_package_photo(uuid, text, text, text) is
  'Sets (archiving the previous one) or removes a package''s photo (staff of the business). Files are kept, so sent offers still show them. Audited.';
revoke execute on function public.set_package_photo(uuid, text, text, text) from public, anon;
grant execute on function public.set_package_photo(uuid, text, text, text) to authenticated;

-- ===========================================================================
-- Snapshot builder: freeze the package's photo
-- ===========================================================================

-- Unchanged from 20261002000500_draft_lifecycle.sql except for the package
-- "image" field (see the header). Replacing keeps its privileges.
create or replace function private.build_offer_snapshot(p_tenant_id uuid, p_offer jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants%rowtype;
  v_package_ids uuid[];
  v_popular_count int;
  v_addon_ids uuid[];
  v_question_ids uuid[];
  v_gear_ids uuid[];
  v_expiry int;
  v_intro text;
  v_template_id uuid;
  v_bad text;
  v_snapshot jsonb;
begin
  select * into v_tenant from public.tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant not found' using errcode = 'no_data_found';
  end if;
  if v_tenant.archived_at is not null then
    perform private.offer_error('tenant is archived');
  end if;

  -- Input shape ----------------------------------------------------------------
  if jsonb_typeof(p_offer) <> 'object' then
    perform private.offer_error('offer must be an object');
  end if;
  if exists (select 1 from jsonb_object_keys(p_offer) k
             where k not in ('template_id', 'intro', 'expiry_days', 'packages', 'addons', 'question_ids')) then
    perform private.offer_error('unknown offer field');
  end if;
  if jsonb_typeof(p_offer -> 'packages') is distinct from 'array'
     or jsonb_typeof(coalesce(p_offer -> 'addons', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_offer -> 'question_ids', '[]')) <> 'array'
     or jsonb_typeof(p_offer -> 'expiry_days') is distinct from 'number' then
    perform private.offer_error('packages, addons, question_ids and expiry_days are required');
  end if;

  if (p_offer ->> 'expiry_days') !~ '^[0-9]{1,3}$' then
    perform private.offer_error('expiry_days must be an integer between 1 and 365');
  end if;
  v_expiry := (p_offer ->> 'expiry_days')::int;
  if v_expiry not between 1 and 365 then
    perform private.offer_error('expiry_days must be an integer between 1 and 365');
  end if;
  v_intro := p_offer ->> 'intro';
  if v_intro is not null and length(v_intro) > 10000 then
    perform private.offer_error('intro is too long');
  end if;
  if p_offer ? 'template_id' and jsonb_typeof(p_offer -> 'template_id') <> 'null'
     and coalesce(p_offer ->> 'template_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform private.offer_error('template_id must be a uuid');
  end if;
  v_template_id := (p_offer ->> 'template_id')::uuid;
  if v_template_id is not null and not exists (
    select 1 from public.proposal_templates t where t.tenant_id = v_tenant.id and t.id = v_template_id
  ) then
    perform private.offer_error('template not found');
  end if;

  -- Packages: exactly three, distinct, active, exactly one most popular -------
  if jsonb_array_length(p_offer -> 'packages') <> 3 then
    perform private.offer_error('exactly three packages must be offered');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_offer -> 'packages') x
    where jsonb_typeof(x) <> 'object'
       or exists (select 1 from jsonb_object_keys(x) k where k not in ('package_id', 'is_popular'))
       or coalesce(x ->> 'package_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(x -> 'is_popular') is distinct from 'boolean'
  ) then
    perform private.offer_error('each package needs a package_id and a boolean is_popular');
  end if;
  select array_agg((x ->> 'package_id')::uuid order by ord),
         count(*) filter (where (x -> 'is_popular') = 'true'::jsonb)
    into v_package_ids, v_popular_count
  from jsonb_array_elements(p_offer -> 'packages') with ordinality as p(x, ord);
  if (select count(distinct u.ref) from unnest(v_package_ids) as u(ref)) <> 3 then
    perform private.offer_error('the three packages must be distinct');
  end if;
  if v_popular_count <> 1 then
    perform private.offer_error('exactly one package must be marked most popular');
  end if;
  -- Note: always alias unnest() columns; an unqualified "id" would bind to
  -- the inner table's id column and make these checks vacuous.
  select string_agg(u.ref::text, ', ') into v_bad
  from unnest(v_package_ids) as u(ref)
  where not exists (select 1 from public.packages pk where pk.tenant_id = v_tenant.id and pk.id = u.ref and pk.active);
  if v_bad is not null then
    perform private.offer_error('packages not found or inactive: ' || v_bad);
  end if;

  -- Addons ----------------------------------------------------------------------
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_offer -> 'addons', '[]')) a
    -- CASE guarantees the format check runs before the casts.
    where case
      when jsonb_typeof(a) <> 'object'
        or exists (select 1 from jsonb_object_keys(a) k where k not in ('gear_item_id', 'recommended_quantity', 'max_quantity'))
        or coalesce(a ->> 'recommended_quantity', '') !~ '^[0-9]{1,3}$'
        or coalesce(a ->> 'max_quantity', '') !~ '^[0-9]{1,3}$'
        or coalesce(a ->> 'gear_item_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then true
      else (a ->> 'max_quantity')::int not between 1 and 100
        or (a ->> 'recommended_quantity')::int > (a ->> 'max_quantity')::int
    end
  ) then
    perform private.offer_error('addons need gear_item_id and integer quantities with 0 <= recommended <= max, 1 <= max <= 100');
  end if;
  select coalesce(array_agg((a ->> 'gear_item_id')::uuid), '{}') into v_addon_ids
  from jsonb_array_elements(coalesce(p_offer -> 'addons', '[]')) a;
  if (select count(distinct u.ref) from unnest(v_addon_ids) as u(ref)) <> cardinality(v_addon_ids) then
    perform private.offer_error('addons must be distinct');
  end if;

  -- Questions ---------------------------------------------------------------------
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_offer -> 'question_ids', '[]')) q
    where jsonb_typeof(q) <> 'string'
       or (q #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    perform private.offer_error('question_ids must be uuids');
  end if;
  select coalesce(array_agg((q #>> '{}')::uuid), '{}') into v_question_ids
  from jsonb_array_elements(coalesce(p_offer -> 'question_ids', '[]')) q;
  if (select count(distinct u.ref) from unnest(v_question_ids) as u(ref)) <> cardinality(v_question_ids) then
    perform private.offer_error('questions must be distinct');
  end if;
  select string_agg(u.ref::text, ', ') into v_bad
  from unnest(v_question_ids) as u(ref)
  where not exists (select 1 from public.logistics_questions q where q.tenant_id = v_tenant.id and q.id = u.ref and q.active);
  if v_bad is not null then
    perform private.offer_error('questions not found or inactive: ' || v_bad);
  end if;

  -- All gear referenced by the offer: included, addons, active rules of offered questions.
  select coalesce(array_agg(distinct gid), '{}') into v_gear_ids
  from (
    select pi.gear_item_id as gid from public.package_items pi
    where pi.tenant_id = v_tenant.id and pi.package_id = any (v_package_ids)
    union
    select unnest(v_addon_ids)
    union
    select r.gear_item_id from public.logistics_rules r
    where r.tenant_id = v_tenant.id and r.active and r.question_id = any (v_question_ids)
  ) g;

  select string_agg(u.ref::text, ', ') into v_bad
  from unnest(v_gear_ids) as u(ref)
  where not exists (select 1 from public.gear_items g where g.tenant_id = v_tenant.id and g.id = u.ref and g.active);
  if v_bad is not null then
    perform private.offer_error('gear items not found or inactive: ' || v_bad);
  end if;

  -- Tax categories must resolve to the tenant's tax configuration.
  select string_agg(distinct cat, ', ') into v_bad
  from (
    select g.tax_category as cat from public.gear_items g where g.tenant_id = v_tenant.id and g.id = any (v_gear_ids)
    union
    select pk.tax_category from public.packages pk where pk.tenant_id = v_tenant.id and pk.id = any (v_package_ids)
  ) c
  where not (v_tenant.tax_categories ? cat);
  if v_bad is not null then
    perform private.offer_error('tax categories not configured for this tenant: ' || v_bad);
  end if;

  -- Freeze ---------------------------------------------------------------------------
  v_snapshot := jsonb_build_object(
    'schema_version', 1,
    'currency', v_tenant.currency,
    'intro', v_intro,
    'expiry_days', v_expiry,
    'branding', jsonb_build_object(
      'display_name', v_tenant.display_name,
      'logo_storage_path', v_tenant.logo_storage_path,
      'brand_colors', v_tenant.brand_colors
    ),
    'tax', jsonb_build_object(
      'rounding', 'per_line_per_tax_half_up',
      'rates', v_tenant.tax_config,
      'categories', v_tenant.tax_categories
    ),
    'packages', (
      select jsonb_agg(jsonb_build_object(
        'key', pk.key,
        'name', pk.name,
        'description', pk.description,
        'base_price_cents', pk.base_price_cents,
        'tax_category', pk.tax_category,
        'is_popular', (sel.x -> 'is_popular') = 'true'::jsonb,
        'included', coalesce((
          select jsonb_agg(jsonb_build_object('gear_key', g.key, 'quantity', pi.quantity) order by g.key)
          from public.package_items pi
          join public.gear_items g on g.tenant_id = pi.tenant_id and g.id = pi.gear_item_id
          where pi.tenant_id = pk.tenant_id and pi.package_id = pk.id
        ), '[]'::jsonb)
      )
      -- The package's own photo, only when it has one, so a package without
      -- one is frozen exactly as before.
      || coalesce((
        select jsonb_build_object('image', jsonb_build_object(
          'storage_path', m.storage_path, 'content_type', m.content_type, 'alt_text', m.alt_text))
        from public.package_media m
        where m.tenant_id = pk.tenant_id and m.package_id = pk.id and m.active
      ), '{}'::jsonb) order by sel.ord)
      from jsonb_array_elements(p_offer -> 'packages') with ordinality as sel(x, ord)
      join public.packages pk on pk.tenant_id = v_tenant.id and pk.id = (sel.x ->> 'package_id')::uuid
    ),
    'gear', (
      select coalesce(jsonb_object_agg(g.key, jsonb_build_object(
        'key', g.key,
        'name', g.name,
        'description', g.description,
        'unit_label', g.unit_label,
        'unit_price_cents', g.default_price_cents,
        'tax_category', g.tax_category,
        'media', coalesce((
          select jsonb_agg(jsonb_build_object(
            'storage_path', m.storage_path, 'kind', m.kind,
            'content_type', m.content_type, 'alt_text', m.alt_text
          ) order by m.sort_order, m.storage_path)
          from public.gear_media m
          where m.tenant_id = g.tenant_id and m.gear_item_id = g.id and m.active
        ), '[]'::jsonb)
      )), '{}'::jsonb)
      from public.gear_items g
      where g.tenant_id = v_tenant.id and g.id = any (v_gear_ids)
    ),
    'addons', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'gear_key', g.key,
        'recommended_quantity', (a.x ->> 'recommended_quantity')::int,
        'max_quantity', (a.x ->> 'max_quantity')::int
      ) order by a.ord), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p_offer -> 'addons', '[]')) with ordinality as a(x, ord)
      join public.gear_items g on g.tenant_id = v_tenant.id and g.id = (a.x ->> 'gear_item_id')::uuid
    ),
    'questions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', q.key,
        'prompt', q.prompt,
        'answer_type', q.answer_type,
        'options', q.options,
        'required', q.required
      ) order by sel.ord), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p_offer -> 'question_ids', '[]')) with ordinality as sel(x, ord)
      join public.logistics_questions q on q.tenant_id = v_tenant.id and q.id = (sel.x #>> '{}')::uuid
    ),
    'rules', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'question_key', q.key,
        'condition', r.condition,
        'gear_key', g.key,
        'required_quantity', r.required_quantity,
        'reason', r.reason
      ) order by q.key, g.key, r.id), '[]'::jsonb)
      from public.logistics_rules r
      join public.logistics_questions q on q.tenant_id = r.tenant_id and q.id = r.question_id
      join public.gear_items g on g.tenant_id = r.tenant_id and g.id = r.gear_item_id
      where r.tenant_id = v_tenant.id and r.active and r.question_id = any (v_question_ids)
    )
  );

  -- Defensive cross-reference check on the built snapshot.
  if exists (
    select 1 from jsonb_array_elements(v_snapshot -> 'rules') r
    where not exists (select 1 from jsonb_array_elements(v_snapshot -> 'questions') q where q ->> 'key' = r ->> 'question_key')
       or not (v_snapshot -> 'gear') ? (r ->> 'gear_key')
  ) then
    perform private.offer_error('a rule references a question or gear item outside the offer');
  end if;

  return v_snapshot;
end;
$$;

