-- Gear categories, paired-equipment quantities, package gear order and
-- proposal-specific prices.
--
-- Why a migration:
--   * Gear had no grouping, so add-ons were one long mixed list.
--   * A gear item sold as "a pair of moving heads" showed as "1 × Moving
--     Heads": nothing said how many physical pieces one sellable unit holds.
--   * Package gear was frozen in gear-key order; staff couldn't choose it.
--   * Changing a price for one client meant editing the catalog price.
--
-- What changes (nothing existing is rewritten; every new column has a
-- default that reproduces today's behaviour):
--
--   * gear_categories   per-business categories (name, display order). Staff
--                       of the business only. Deleting one leaves its gear
--                       uncategorized. No categories are created here.
--   * gear_items        category_id (optional, same business by composite
--                       foreign key), pieces_per_unit (default 1) and
--                       piece_label ("lights"): what one sellable unit holds.
--                       Prices stay per sellable unit.
--   * package_items     sort_order (default 0). Gear is ordered by sort_order,
--                       then gear key, so existing packages keep their order
--                       until staff reorder them. set_package_items and
--                       create_package accept an optional sort_order per item
--                       (the previously deployed app sends none: unchanged).
--   * draft offers      may carry "price_overrides": [{"gear_item_id": uuid,
--                       "unit_price_cents": int}], prices for this proposal
--                       only. The catalog price is never changed.
--   * build_offer_snapshot freezes the effective price (the override, else the
--                       catalog price) as the gear's unit_price_cents, which is
--                       what pricing, selection verification and contracts
--                       already use. It also freezes, only when set, the gear's
--                       "category" {name, sort_order} and "pieces_per_unit" /
--                       "piece_label", and orders included gear by sort_order.
--                       Gear without these is frozen exactly as before, so the
--                       previously deployed app (which rejects unknown snapshot
--                       fields) keeps working until staff use the new fields.
--   * preview_proposal_draft builds the snapshot an unsaved draft would freeze
--                       (staff of the business, draft not frozen), storing
--                       nothing, so the builder can preview edits before saving.
--
-- Sent offers keep their frozen snapshot: nothing here reads or rewrites them.
-- No RPC signature changes; preview_proposal_draft is new.

-- ===========================================================================
-- Gear categories
-- ===========================================================================

create table public.gear_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  name text not null
    constraint gear_categories_name_length check (length(btrim(name)) between 1 and 60 and name = btrim(name)),
  sort_order integer not null default 0
    constraint gear_categories_sort_order_range check (sort_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gear_categories_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.gear_categories is
  'A business''s gear categories (Audio, Lighting…), for browsing the catalog and grouping add-ons. Deleting one leaves its gear uncategorized.';
create unique index gear_categories_tenant_name_key on public.gear_categories (tenant_id, lower(name));

create trigger gear_categories_set_updated_at before update on public.gear_categories
  for each row execute function private.set_updated_at();
create trigger gear_categories_immutable before update on public.gear_categories
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_at');
create trigger gear_categories_workspace_suspended before insert or update or delete on public.gear_categories
  for each row execute function private.tenant_write_guard();

revoke all on public.gear_categories from anon, authenticated;
grant select, delete on public.gear_categories to authenticated;
grant insert (tenant_id, name, sort_order) on public.gear_categories to authenticated;
grant update (name, sort_order) on public.gear_categories to authenticated;

alter table public.gear_categories enable row level security;
create policy gear_categories_select_staff on public.gear_categories
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
create policy gear_categories_insert_staff on public.gear_categories
  for insert to authenticated with check (tenant_id in (select private.member_tenant_ids()));
create policy gear_categories_update_staff on public.gear_categories
  for update to authenticated
  using (tenant_id in (select private.member_tenant_ids()))
  with check (tenant_id in (select private.member_tenant_ids()));
create policy gear_categories_delete_staff on public.gear_categories
  for delete to authenticated using (tenant_id in (select private.member_tenant_ids()));

-- ===========================================================================
-- Gear: category and what one sellable unit holds
-- ===========================================================================

alter table public.gear_items
  add column category_id uuid,
  add column pieces_per_unit integer not null default 1
    constraint gear_items_pieces_per_unit_range check (pieces_per_unit between 1 and 1000),
  add column piece_label text
    constraint gear_items_piece_label_length check (piece_label is null or length(btrim(piece_label)) between 1 and 40),
  -- Same business by construction; deleting a category uncategorizes its gear.
  add constraint gear_items_category_fk foreign key (tenant_id, category_id)
    references public.gear_categories (tenant_id, id) on delete set null (category_id);
comment on column public.gear_items.pieces_per_unit is
  'Physical pieces in one sellable unit (2 for a pair of moving heads). Display only: the price stays per sellable unit.';
comment on column public.gear_items.piece_label is
  'What the pieces are called, plural ("lights", "tubes"). Shown when pieces_per_unit > 1.';
create index gear_items_tenant_category_idx on public.gear_items (tenant_id, category_id);

grant insert (category_id, pieces_per_unit, piece_label), update (category_id, pieces_per_unit, piece_label)
  on public.gear_items to authenticated;

-- ===========================================================================
-- Package gear order
-- ===========================================================================

alter table public.package_items
  add column sort_order integer not null default 0
    constraint package_items_sort_order_range check (sort_order between 0 and 10000);
comment on column public.package_items.sort_order is
  'Presentation order within the package (then gear key). Frozen into offers as the order of "included".';
grant insert (sort_order), update (sort_order) on public.package_items to authenticated;

-- Replaces a package's included gear: [{"gear_item_id": uuid, "quantity": int,
-- "sort_order": int (optional, default 0)}]. Unchanged apart from sort_order.
create or replace function public.set_package_items(p_package_id uuid, p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.packages where id = p_package_id;
  if v_tenant is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be an array' using errcode = 'invalid_parameter_value';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where i ? 'sort_order' and (jsonb_typeof(i -> 'sort_order') <> 'number' or (i ->> 'sort_order') !~ '^[0-9]{1,5}$')
  ) then
    raise exception 'sort_order must be a whole number' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.package_items where package_id = p_package_id;
  insert into public.package_items (tenant_id, package_id, gear_item_id, quantity, sort_order)
  select v_tenant, p_package_id, (i ->> 'gear_item_id')::uuid, (i ->> 'quantity')::int, coalesce((i ->> 'sort_order')::int, 0)
  from jsonb_array_elements(p_items) i;
end;
$$;

-- Unchanged from 20261023000200_package_create.sql apart from the optional
-- sort_order per item. Replacing keeps its privileges.
create or replace function public.create_package(
  p_tenant_id uuid,
  p_package_id uuid,
  p_key text,
  p_name text,
  p_description text,
  p_base_price_cents bigint,
  p_tax_category text,
  p_sort_order integer,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_inserted uuid;
begin
  perform private.require_staff_of(p_tenant_id);
  if p_package_id is null then
    raise exception 'package_invalid: a request id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or exists (
       select 1 from jsonb_array_elements(p_items) i
       where jsonb_typeof(i) <> 'object'
          or exists (select 1 from jsonb_object_keys(i) k where k not in ('gear_item_id', 'quantity', 'sort_order'))
          or coalesce(i ->> 'gear_item_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(i -> 'quantity') is distinct from 'number'
          or (i ->> 'quantity') !~ '^[0-9]+$'
          or (i ? 'sort_order' and (jsonb_typeof(i -> 'sort_order') <> 'number' or (i ->> 'sort_order') !~ '^[0-9]{1,5}$'))
     ) then
    raise exception 'package_invalid: items need a gear_item_id and a whole quantity' using errcode = 'invalid_parameter_value';
  end if;

  -- A retry of a request that already succeeded (its response was lost).
  select tenant_id into v_existing from public.packages where id = p_package_id;
  if found then
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_package_id, 'replayed', true);
  end if;

  insert into public.packages (id, tenant_id, key, name, description, base_price_cents, tax_category, sort_order)
  values (p_package_id, p_tenant_id, p_key, p_name, p_description, p_base_price_cents, p_tax_category, p_sort_order)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    -- The same request, committed concurrently.
    select tenant_id into v_existing from public.packages where id = p_package_id;
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_package_id, 'replayed', true);
  end if;

  insert into public.package_items (tenant_id, package_id, gear_item_id, quantity, sort_order)
  select p_tenant_id, p_package_id, (i ->> 'gear_item_id')::uuid, (i ->> 'quantity')::int, coalesce((i ->> 'sort_order')::int, 0)
  from jsonb_array_elements(p_items) i;

  return jsonb_build_object('id', p_package_id, 'replayed', false);
end;
$$;

-- ===========================================================================
-- Draft offers: proposal-specific prices
-- ===========================================================================

-- [{"gear_item_id": uuid, "unit_price_cents": 0..100000000}], at most 100,
-- each gear item once.
create function private.is_valid_price_overrides(overrides jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select jsonb_typeof(overrides) = 'array'
     and jsonb_array_length(overrides) <= 100
     and not exists (
       select 1 from jsonb_array_elements(overrides) o
       where case
         when jsonb_typeof(o) <> 'object'
           or (select array_agg(k order by k) from jsonb_object_keys(o) k) is distinct from array['gear_item_id', 'unit_price_cents']
           or jsonb_typeof(o -> 'gear_item_id') <> 'string'
           or not private.is_uuid_text(o ->> 'gear_item_id')
           or jsonb_typeof(o -> 'unit_price_cents') <> 'number'
           or (o ->> 'unit_price_cents') !~ '^[0-9]{1,9}$'
           then true
         else (o ->> 'unit_price_cents')::bigint > 100000000
       end
     )
     and (select count(distinct o ->> 'gear_item_id') = count(*) from jsonb_array_elements(overrides) o);
$$;

-- Unchanged from 20261002000500_draft_lifecycle.sql apart from price_overrides.
create or replace function private.is_valid_draft_offer(draft jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select jsonb_typeof(draft) = 'object'
     and not exists (select 1 from jsonb_object_keys(draft) k
                     where k not in ('template_id', 'intro', 'expiry_days', 'packages', 'addons', 'question_ids', 'price_overrides'))
     and coalesce(jsonb_typeof(draft -> 'template_id') in ('string', 'null'), true)
     and (jsonb_typeof(draft -> 'template_id') is distinct from 'string' or private.is_uuid_text(draft ->> 'template_id'))
     and coalesce(jsonb_typeof(draft -> 'intro') in ('string', 'null'), true)
     and coalesce(length(draft ->> 'intro') <= 10000, true)
     and coalesce(jsonb_typeof(draft -> 'expiry_days') in ('number', 'null'), true)
     and coalesce(jsonb_typeof(draft -> 'packages') = 'array' and jsonb_array_length(draft -> 'packages') <= 3, true)
     and coalesce(jsonb_typeof(draft -> 'addons') = 'array' and jsonb_array_length(draft -> 'addons') <= 100, true)
     and coalesce(jsonb_typeof(draft -> 'question_ids') = 'array' and jsonb_array_length(draft -> 'question_ids') <= 100, true)
     and coalesce(private.is_valid_price_overrides(draft -> 'price_overrides'), true);
$$;

-- CHECK constraints call these with the writer's privileges.
grant execute on function private.is_valid_price_overrides(jsonb) to authenticated, service_role;

-- ===========================================================================
-- Snapshot builder
-- ===========================================================================

-- Unchanged from 20261106000100_package_photos.sql except for:
--   * "price_overrides" in the input (shape-checked; an override for gear
--     outside the offer has no effect and is not frozen),
--   * the gear's unit_price_cents is the effective price,
--   * gear "category" and "pieces_per_unit"/"piece_label", only when set,
--   * included gear ordered by package_items.sort_order, then gear key.
-- Replacing keeps its privileges.
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
    perform private.offer_error('custom prices need a gear item and a price from 0 to 1,000,000.00, each item once');
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
        select (x ->> 'unit_price_cents')::bigint as unit_price_cents
        from jsonb_array_elements(v_overrides) x
        where (x ->> 'gear_item_id')::uuid = g.id
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
$$;

-- ===========================================================================
-- Previewing unsaved draft edits
-- ===========================================================================

-- The snapshot an edited (not yet saved) draft would freeze, with the same
-- validation as sending. Stores nothing and takes no locks, so it can never
-- overwrite or race a save. Staff of the proposal's business only; the
-- proposal must still be an unfrozen draft. Every catalog lookup is limited
-- to that business, so ids from another business are simply "not found".
create function public.preview_proposal_draft(p_proposal_id uuid, p_offer jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_proposal.tenant_id);
  if v_proposal.status <> 'draft' or v_proposal.offer_snapshot is not null then
    raise exception 'the offer is frozen and cannot be edited' using errcode = 'invalid_parameter_value';
  end if;
  if p_offer is null or not private.is_valid_draft_offer(p_offer) then
    perform private.offer_error('draft offer has an invalid shape');
  end if;
  return private.build_offer_snapshot(v_proposal.tenant_id, p_offer);
end;
$$;
comment on function public.preview_proposal_draft(uuid, jsonb) is
  'The snapshot an unsaved draft offer would freeze (staff of the business, draft only). Stores nothing.';
revoke execute on function public.preview_proposal_draft(uuid, jsonb) from public, anon;
grant execute on function public.preview_proposal_draft(uuid, jsonb) to authenticated;
