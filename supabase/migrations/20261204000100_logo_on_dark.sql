-- Logo variants: an optional second logo for dark backgrounds.
--
-- A business keeps its one logo (tenants.logo_storage_path, unchanged in
-- meaning) and may add a version made for dark backgrounds, for example a white
-- wordmark beside the usual black one. It is an ordinary registered logo
-- (tenant_logos: uploaded, checked, re-encoded and trimmed exactly like the
-- main one, immutable, in the business's own folder), referenced by the new
-- column tenants.logo_on_dark_storage_path.
--
-- Rules:
--   * It belongs to the same business (composite foreign key, as for the main logo).
--   * It needs a main logo. Removing the main logo removes it too, so a caller
--     from before this release that removes the logo leaves no orphan variant.
--   * Only the owner changes it, through update_tenant_branding, under the same
--     branding version and audit as the rest of branding.
--
-- update_tenant_branding gains p_logo_on_dark_id and p_change_logo_on_dark.
-- Omitted (the deployed app), the variant stays as it is. With
-- p_change_logo_on_dark = true it becomes p_logo_on_dark_id, and null removes
-- it. The function is dropped and recreated because an overload would make the
-- deployed app's calls ambiguous.
--
-- Proposals: build_offer_snapshot_catalog freezes the variant as
-- branding.logo_on_dark_storage_path, and null for a business without one.
-- The key is always present from now on, so its presence is what tells an offer
-- frozen under these rules from one sent before them: the app keeps the logo
-- backdrops an earlier proposal was sent with. The app released with
-- 20261203000100 already accepts the optional, nullable key (its schema is
-- strict, so the key could not appear before that app was live; it is).
-- Frozen offers never change: both paths are immutable registered logos that
-- are never deleted.
--
-- public_tenant_brand returns the variant beside the main logo (new keys only).
-- unused_tenant_logos treats a variant, live or frozen, as in use.
--
-- Emails, PDFs and contracts are unchanged: they read only the main logo.

alter table public.tenants
  add column logo_on_dark_storage_path text,
  add constraint tenants_logo_on_dark_path_length
    check (logo_on_dark_storage_path is null or length(logo_on_dark_storage_path) between 1 and 1024),
  add constraint tenants_logo_on_dark_needs_logo
    check (logo_on_dark_storage_path is null or logo_storage_path is not null),
  add constraint tenants_logo_on_dark_registered
    foreign key (id, logo_on_dark_storage_path) references public.tenant_logos (tenant_id, storage_path) on delete restrict;

comment on column public.tenants.logo_on_dark_storage_path is
  'Optional version of the logo for dark backgrounds (a registered tenant_logos path of this business). Requires logo_storage_path. Changed only by update_tenant_branding.';

drop function public.update_tenant_branding(uuid, integer, uuid, text, integer, text, boolean);

create function public.update_tenant_branding(
  p_tenant_id uuid,
  p_expected_version integer,
  p_logo_id uuid,
  p_primary_color text,
  p_logo_size_percent integer default null,
  p_accent_color text default null,
  p_gradient boolean default null,
  p_logo_on_dark_id uuid default null,
  p_change_logo_on_dark boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  t public.tenants%rowtype;
  v_path text;
  v_dark_path text;
  v_color text := nullif(lower(btrim(coalesce(p_primary_color, ''))), '');
  v_accent text := nullif(lower(btrim(coalesce(p_accent_color, ''))), '');
  v_colors jsonb;
  v_size integer;
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
  if v_accent is not null and v_accent !~ '^#[0-9a-f]{6}$' then
    raise exception 'branding_invalid: the accent colour must be a hex value like #1a2b3c' using errcode = 'invalid_parameter_value';
  end if;
  if p_logo_size_percent is not null and p_logo_size_percent not between 100 and 130 then
    raise exception 'branding_invalid: the logo size must be from 100%% to 130%%' using errcode = 'invalid_parameter_value';
  end if;
  if p_logo_id is not null then
    select l.storage_path into v_path from public.tenant_logos l where l.tenant_id = p_tenant_id and l.id = p_logo_id;
    if v_path is null then
      raise exception 'branding_invalid: that logo is not available' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- The logo for dark backgrounds: kept unless the caller changes it, and never without a main logo.
  if p_change_logo_on_dark is true then
    if p_logo_on_dark_id is not null then
      select l.storage_path into v_dark_path from public.tenant_logos l where l.tenant_id = p_tenant_id and l.id = p_logo_on_dark_id;
      if v_dark_path is null then
        raise exception 'branding_invalid: that logo for dark backgrounds is not available' using errcode = 'invalid_parameter_value';
      end if;
      if v_path is null then
        raise exception 'branding_invalid: add your main logo before a logo for dark backgrounds' using errcode = 'invalid_parameter_value';
      end if;
    end if;
  else
    v_dark_path := case when v_path is null then null else t.logo_on_dark_storage_path end;
  end if;

  v_colors := case when v_color is null then t.brand_colors - 'primary' else t.brand_colors || jsonb_build_object('primary', v_color) end;
  -- An accent is stored whenever one is given, so turning the gradient off keeps the owner's choice.
  if v_accent is not null then
    v_colors := v_colors || jsonb_build_object('accent', v_accent);
  end if;
  -- Null: a caller from before gradients existed. The preference stays as it is.
  if p_gradient then
    if not v_colors ? 'accent' then
      raise exception 'branding_invalid: choose an accent colour to use a gradient' using errcode = 'invalid_parameter_value';
    end if;
    v_colors := v_colors || jsonb_build_object('gradient', 'on');
  elsif p_gradient is not null then
    v_colors := v_colors - 'gradient';
  end if;
  v_size := coalesce(p_logo_size_percent, t.logo_size_percent);

  update public.tenants
    set logo_storage_path = v_path, logo_on_dark_storage_path = v_dark_path, brand_colors = v_colors,
        logo_size_percent = v_size, branding_version = branding_version + 1
    where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'branding_updated', 'staff', (select auth.uid()),
    jsonb_build_object('logo_changed', v_path is distinct from t.logo_storage_path, 'logo_storage_path', v_path,
                       'logo_on_dark_changed', v_dark_path is distinct from t.logo_on_dark_storage_path,
                       'logo_on_dark_storage_path', v_dark_path,
                       'primary_color', v_color, 'accent_color', v_colors ->> 'accent', 'gradient', v_colors ? 'gradient',
                       'logo_size_percent', v_size, 'version', t.branding_version + 1));
  return t.branding_version + 1;
end;
$$;

revoke execute on function public.update_tenant_branding(uuid, integer, uuid, text, integer, text, boolean, uuid, boolean) from public, anon;
grant execute on function public.update_tenant_branding(uuid, integer, uuid, text, integer, text, boolean, uuid, boolean) to authenticated, service_role;

-- Branding for the business's public and client pages: the variant's keys are new, nothing else changes.
create or replace function public.public_tenant_brand(p_tenant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors,
           'logo_storage_path', l.storage_path, 'logo_needs_dark_background', l.needs_dark_background,
           'logo_width', l.width, 'logo_height', l.height, 'logo_size_percent', t.logo_size_percent,
           'logo_on_dark_storage_path', d.storage_path, 'logo_on_dark_width', d.width, 'logo_on_dark_height', d.height)
  from public.tenants t
  left join public.tenant_logos l on l.tenant_id = t.id and l.storage_path = t.logo_storage_path
  left join public.tenant_logos d on d.tenant_id = t.id and d.storage_path = t.logo_on_dark_storage_path
  where t.slug = p_tenant_slug and t.archived_at is null and t.suspended_at is null;
$$;

-- Maintenance: a logo is in use while a business shows it, or a frozen offer holds it, as either variant.
create or replace function private.unused_tenant_logos()
returns table (tenant_id uuid, storage_path text, registered boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.tenant_id, l.storage_path, true, l.created_at
  from public.tenant_logos l
  where not exists (select 1 from public.tenants t
                    where t.id = l.tenant_id and l.storage_path in (t.logo_storage_path, t.logo_on_dark_storage_path))
    and not exists (select 1 from public.proposals p
                    where p.tenant_id = l.tenant_id
                      and l.storage_path in (p.offer_snapshot -> 'branding' ->> 'logo_storage_path',
                                             p.offer_snapshot -> 'branding' ->> 'logo_on_dark_storage_path'))
  union all
  select (split_part(o.name, '/', 1))::uuid, o.name, false, o.created_at
  from storage.objects o
  where o.bucket_id = 'tenant-logos' and split_part(o.name, '/', 1) ~ '^[0-9a-f-]{36}$'
    and not exists (select 1 from public.tenant_logos l where l.storage_path = o.name);
$$;

-- Offers: freeze the logo for dark backgrounds beside the main logo (null without one).
CREATE OR REPLACE FUNCTION private.build_offer_snapshot_catalog(p_tenant_id uuid, p_offer jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_overrides jsonb;
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
             where k not in ('template_id', 'intro', 'expiry_days', 'packages', 'addons', 'question_ids', 'price_overrides')) then
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
  v_overrides := coalesce(p_offer -> 'price_overrides', '[]'::jsonb);
  if not private.is_valid_price_overrides(v_overrides) then
    perform private.offer_error('custom prices need a gear item or package and a price from 0 to 1,000,000.00, each item once');
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
    )
    -- The logo for dark backgrounds, or null. Always present: an offer without the
    -- key was sent before logo variants, and keeps the logo backdrops it had then.
    || jsonb_build_object('logo_on_dark_storage_path', v_tenant.logo_on_dark_storage_path),
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
        -- This proposal's base price when staff set one, else the catalog price.
        'base_price_cents', coalesce(po.unit_price_cents, pk.base_price_cents),
        'tax_category', pk.tax_category,
        'is_popular', (sel.x -> 'is_popular') = 'true'::jsonb,
        'included', coalesce((
          select jsonb_agg(jsonb_build_object('gear_key', g.key, 'quantity', pi.quantity) order by pi.sort_order, g.key)
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
      -- Explicit column names: an unqualified "x" here would bind to sel.x.
      left join lateral (
        select (ov.item ->> 'unit_price_cents')::bigint as unit_price_cents
        from jsonb_array_elements(v_overrides) as ov(item)
        where ov.item ? 'package_id' and (ov.item ->> 'package_id')::uuid = pk.id
      ) po on true
    ),
    'gear', (
      select coalesce(jsonb_object_agg(g.key, jsonb_build_object(
        'key', g.key,
        'name', g.name,
        'description', g.description,
        'unit_label', g.unit_label,
        -- This proposal's price when staff set one, else the catalog price.
        'unit_price_cents', coalesce(o.unit_price_cents, g.default_price_cents),
        'tax_category', g.tax_category,
        'media', coalesce((
          select jsonb_agg(jsonb_build_object(
            'storage_path', m.storage_path, 'kind', m.kind,
            'content_type', m.content_type, 'alt_text', m.alt_text
          ) order by m.sort_order, m.storage_path)
          from public.gear_media m
          where m.tenant_id = g.tenant_id and m.gear_item_id = g.id and m.active
        ), '[]'::jsonb)
      )
      -- Only when set, so other gear is frozen exactly as before.
      || case when c.id is null then '{}'::jsonb
              else jsonb_build_object('category', jsonb_build_object('name', c.name, 'sort_order', c.sort_order)) end
      || case when g.pieces_per_unit = 1 then '{}'::jsonb
              else jsonb_build_object('pieces_per_unit', g.pieces_per_unit, 'piece_label', g.piece_label) end
      ), '{}'::jsonb)
      from public.gear_items g
      left join public.gear_categories c on c.tenant_id = g.tenant_id and c.id = g.category_id
      left join lateral (
        select (ov.item ->> 'unit_price_cents')::bigint as unit_price_cents
        from jsonb_array_elements(v_overrides) as ov(item)
        where ov.item ? 'gear_item_id' and (ov.item ->> 'gear_item_id')::uuid = g.id
      ) o on true
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
$function$;
