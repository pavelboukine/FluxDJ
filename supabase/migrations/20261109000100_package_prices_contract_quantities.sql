-- Package base prices for one proposal, and contract quantities worded as
-- on the approved proposal.
--
-- Why a migration:
--   * 20261108000100 let staff set this proposal's price for gear, not for a
--     package's base price.
--   * Contracts still described gear as "1 × Moving Heads" while the
--     proposal said "1 pair of Moving Heads (2 lights)".
--
-- What changes (no stored row is rewritten):
--
--   * price_overrides   an entry is either {"gear_item_id", "unit_price_cents"}
--                       (as before) or {"package_id", "unit_price_cents"}: the
--                       package's base price for this proposal only, by its
--                       stable id. Each gear item and each package once.
--   * build_offer_snapshot  freezes the package's effective base price (the
--                       override, else the catalog price) as base_price_cents,
--                       which pricing, selection verification and contracts
--                       already use. No snapshot field is added, so the
--                       previously deployed app reads these offers as before.
--   * gear_quantity_text  the contract's quantity wording. It mirrors
--                       src/lib/catalog/quantity.ts (quantityText); both are
--                       checked against the same cases
--                       (tests/support/quantity-cases.ts). Without frozen
--                       pieces it is "N × Name", exactly as before.
--   * generate_contract_draft  {{package.included}} and {{gear.extras}} use it,
--                       with the gear frozen in the approved offer (never the
--                       live catalog). Only drafts generated from now on are
--                       affected; existing contracts, sent or signed, and their
--                       PDFs are stored documents and never re-rendered.
--                       Placeholder names and template validation are unchanged.
--
-- No RPC signature changes.

-- ===========================================================================
-- Quantity wording (mirror of src/lib/catalog/quantity.ts)
-- ===========================================================================

-- "pair" -> "pairs", "box" -> "boxes", "battery" -> "batteries"; only single words change.
create function private.plural_unit(p_unit text, p_count bigint)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_count = 1 or btrim(p_unit) !~* '^[a-z]+$' then btrim(p_unit)
    when btrim(p_unit) ~* '(s|x|z|ch|sh)$' then btrim(p_unit) || 'es'
    when btrim(p_unit) ~* '[^aeiou]y$' then left(btrim(p_unit), -1) || 'ies'
    else btrim(p_unit) || 's'
  end;
$$;

-- Quantity and name of `p_quantity` sellable units of frozen offer gear:
-- "2 × Speaker", "1 pair of Moving Heads (2 lights)", "2 pairs of Moving
-- Heads (4 lights)", "1 × Uplights (4 lights)" for the default unit. Gear
-- without pieces (older offers, or one piece per unit) reads "N × Name".
create function private.gear_quantity_text(p_gear jsonb, p_name text, p_quantity integer)
returns text
language sql
immutable
set search_path = ''
as $$
  with g as (
    select
      case when jsonb_typeof(p_gear -> 'pieces_per_unit') = 'number' and (p_gear ->> 'pieces_per_unit') ~ '^[0-9]{1,4}$'
                and (p_gear ->> 'pieces_per_unit')::int > 1
           then (p_gear ->> 'pieces_per_unit')::int else 1 end as pieces,
      coalesce(nullif(btrim(p_gear ->> 'piece_label'), ''), 'pieces') as label,
      btrim(coalesce(p_gear ->> 'unit_label', '')) as unit
  )
  select case
    when g.pieces = 1 then p_quantity || ' × ' || p_name
    when g.unit ~* '^[a-z]+$' and lower(g.unit) <> 'unit' then
      p_quantity || ' ' || private.plural_unit(g.unit, p_quantity) || ' of ' || p_name
      || ' (' || (p_quantity::bigint * g.pieces) || ' ' || g.label || ')'
    else p_quantity || ' × ' || p_name || ' (' || (p_quantity::bigint * g.pieces) || ' ' || g.label || ')'
  end
  from g;
$$;

revoke execute on function private.plural_unit(text, bigint), private.gear_quantity_text(jsonb, text, integer) from public, anon, authenticated;

-- ===========================================================================
-- Draft offers: package base prices
-- ===========================================================================

-- [{"gear_item_id" | "package_id": uuid, "unit_price_cents": 0..100000000}],
-- at most 100, each gear item and each package once. Replaces the
-- 20261108000100 version (a superset: every stored draft stays valid).
create or replace function private.is_valid_price_overrides(overrides jsonb)
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
         when jsonb_typeof(o) <> 'object' then true
         when (select array_agg(k order by k) from jsonb_object_keys(o) k) is distinct from array['gear_item_id', 'unit_price_cents']
          and (select array_agg(k order by k) from jsonb_object_keys(o) k) is distinct from array['package_id', 'unit_price_cents'] then true
         when jsonb_typeof(coalesce(o -> 'gear_item_id', o -> 'package_id')) <> 'string'
           or not private.is_uuid_text(coalesce(o ->> 'gear_item_id', o ->> 'package_id'))
           or jsonb_typeof(o -> 'unit_price_cents') <> 'number'
           or (o ->> 'unit_price_cents') !~ '^[0-9]{1,9}$'
           then true
         else (o ->> 'unit_price_cents')::bigint > 100000000
       end
     )
     and (select count(distinct o ->> 'gear_item_id') = count(o ->> 'gear_item_id')
            and count(distinct o ->> 'package_id') = count(o ->> 'package_id')
          from jsonb_array_elements(overrides) o);
$$;

-- ===========================================================================
-- Snapshot builder
-- ===========================================================================

-- Unchanged from 20261108000100_gear_categories_custom_prices.sql except that
-- a package override sets the package's base_price_cents, gear overrides
-- match gear entries only, and the override rows have explicit column names
-- (an unqualified "x" would bind to an outer query's column). Replacing keeps
-- its privileges.
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
$$;

-- ===========================================================================
-- Contract generation
-- ===========================================================================

-- Unchanged from 20261004000200_business_settings_send_review.sql except for
-- the quantity wording of {{package.included}} and {{gear.extras}}, read from
-- the approved offer's frozen gear. Replacing keeps its privileges.
create or replace function public.generate_contract_draft(
  p_approval_id uuid,
  p_template_version_id uuid,
  p_balance_due_date date default null,
  p_replace_contract_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.proposal_approvals%rowtype;
  v_membership_id uuid;
  v_event_id uuid;
  v_event public.events%rowtype;
  v_proposal public.proposals%rowtype;
  v_selection public.proposal_selections%rowtype;
  v_tenant public.tenants%rowtype;
  v_version public.contract_template_versions%rowtype;
  v_template_active boolean;
  v_signer record;
  v_has_signer boolean;
  v_package record;
  v_deposit bigint;
  v_balance bigint;
  v_values jsonb;
  v_missing jsonb;
  v_rendered jsonb;
  v_commercial jsonb;
  v_parties jsonb;
  v_hash text;
  v_existing public.contracts%rowtype;
  v_has_existing boolean;
  v_replaced uuid;
  v_id uuid;
begin
  select * into v_approval from public.proposal_approvals where id = p_approval_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_approval.tenant_id);

  -- Lock order everywhere: event, then proposal. The event lock serializes
  -- generation, so concurrent clicks cannot create two drafts.
  select p.event_id into v_event_id from public.proposals p
  where p.tenant_id = v_approval.tenant_id and p.id = v_approval.proposal_id;
  select * into v_event from public.events where tenant_id = v_approval.tenant_id and id = v_event_id for update;
  select * into v_proposal from public.proposals where tenant_id = v_approval.tenant_id and id = v_approval.proposal_id for update;
  select * into v_selection from public.proposal_selections where tenant_id = v_approval.tenant_id and id = v_approval.selection_id;
  select * into v_tenant from public.tenants where id = v_approval.tenant_id;

  if v_proposal.status <> 'approved' or v_event.active_proposal_id is distinct from v_proposal.id then
    raise exception 'contract_stale_approval: this approval is no longer current because a revised offer replaced it'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_event.lifecycle_status <> 'awaiting_signature' then
    raise exception 'contract_not_allowed: the event is %', replace(v_event.lifecycle_status, '_', ' ')
      using errcode = 'invalid_parameter_value';
  end if;
  if v_tenant.archived_at is not null then
    raise exception 'contract_not_allowed: the business is archived' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_version from public.contract_template_versions
  where tenant_id = v_tenant.id and id = p_template_version_id;
  if not found then
    perform private.contract_error('template version not found');
  end if;
  if v_version.published_at is null then
    perform private.contract_error('publish this template version before generating a contract');
  end if;
  select t.active into v_template_active from public.contract_templates t
  where t.tenant_id = v_tenant.id and t.id = v_version.template_id;
  if not v_template_active then
    perform private.contract_error('this template is archived');
  end if;

  if p_balance_due_date is not null then
    if not ('payment.balance_due_date' = any (v_version.placeholders)) then
      raise exception 'contract_input_invalid: this template version has no balance due date, so leave it blank'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_balance_due_date < (now() at time zone v_event.timezone)::date then
      raise exception 'contract_input_invalid: the balance due date is in the past' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- Parties, copied now -------------------------------------------------------
  select c.id, c.name, c.email, c.phone, c.archived_at into v_signer
  from public.event_clients ec
  join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where ec.tenant_id = v_event.tenant_id and ec.event_id = v_event.id and ec.can_sign;
  v_has_signer := found;

  -- Commercial terms, from the approved selection only -------------------------
  select l.item_key, l.name, l.unit_price_cents into v_package
  from public.proposal_selection_lines l
  where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source = 'package';

  -- The tenant's deposit percentage, frozen below; deposit rounded half up
  -- to the cent from the approved total; balance = total - deposit.
  v_deposit := private.contract_deposit_cents(v_selection.total_cents, v_tenant.deposit_percent);
  v_balance := v_selection.total_cents - v_deposit;

  v_values := jsonb_build_object(
    'business.name', nullif(btrim(v_tenant.business_name), ''),
    'business.legal_name', nullif(btrim(v_tenant.business_name), ''),
    'business.address', nullif(btrim(v_tenant.business_address), ''),
    'business.email', nullif(btrim(v_tenant.contact_email), ''),
    'business.display_name', nullif(btrim(v_tenant.display_name), ''),
    'client.name', case when v_has_signer then nullif(btrim(v_signer.name), '') end,
    'client.email', case when v_has_signer then nullif(btrim(v_signer.email), '') end,
    'client.phone', case when v_has_signer then nullif(btrim(v_signer.phone), '') end,
    'event.title', nullif(btrim(v_event.title), ''),
    'event.date', to_char(v_event.event_date, 'FMDay, FMMonth FMDD, YYYY'),
    'venue.name', nullif(btrim(v_event.venue_name), ''),
    'venue.address', nullif(btrim(v_event.venue_address), ''),
    'package.name', v_package.name,
    'package.price', private.format_cents(v_package.unit_price_cents, v_selection.currency),
    -- Quantities read as on the approved proposal, from its frozen gear
    -- ("1 pair of Moving Heads (2 lights)"); older offers read as before.
    'package.included', coalesce((
      select string_agg('- ' || private.gear_quantity_text(v_proposal.offer_snapshot -> 'gear' -> l.item_key, l.name, l.quantity), E'\n' order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source = 'included'
    ), 'No gear is listed as included in the package.'),
    'gear.extras', coalesce((
      select string_agg(
        '- ' || private.gear_quantity_text(v_proposal.offer_snapshot -> 'gear' -> l.item_key, l.name, l.quantity)
        || ': ' || private.format_cents(l.line_total_cents, v_selection.currency)
        || case when l.source = 'required' then ' (required: ' || array_to_string(l.required_reasons, '; ') || ')' else '' end,
        E'\n' order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source in ('optional', 'required')
    ), 'No additional gear.'),
    'pricing.subtotal', private.format_cents(v_selection.subtotal_cents, v_selection.currency),
    'pricing.taxes', coalesce((
      select string_agg(
        '- ' || (t ->> 'label') || ' (' || private.format_rate_ppm((t ->> 'rate_ppm')::bigint) || '): '
        || private.format_cents((t ->> 'amount_cents')::bigint, v_selection.currency),
        E'\n' order by ord)
      from jsonb_array_elements(v_selection.tax_breakdown) with ordinality as x(t, ord)
    ), 'No taxes apply.'),
    'pricing.tax_total', private.format_cents(v_selection.tax_cents, v_selection.currency),
    'pricing.total', private.format_cents(v_selection.total_cents, v_selection.currency),
    'pricing.currency', v_selection.currency,
    'payment.deposit_percent', v_tenant.deposit_percent::text || '%',
    'payment.deposit', private.format_cents(v_deposit, v_selection.currency),
    'payment.balance', private.format_cents(v_balance, v_selection.currency),
    'payment.balance_due_date', to_char(p_balance_due_date, 'FMMonth FMDD, YYYY')
  );

  -- Every placeholder the template uses needs a real value, and a signer is
  -- always required. Nothing is stored when anything is missing.
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'label', p.label, 'hint', p.missing_hint) order by p.sort_order), '[]')
    into v_missing
  from private.contract_placeholders() p
  where p.key = any (v_version.placeholders) and v_values ->> p.key is null;
  if not v_has_signer then
    v_missing := jsonb_build_array(jsonb_build_object('key', 'signer', 'label', 'Signer',
      'hint', 'Signer: mark one of the event''s contacts as the signer.')) || v_missing;
  elsif v_signer.archived_at is not null then
    v_missing := jsonb_build_array(jsonb_build_object('key', 'signer', 'label', 'Signer',
      'hint', 'Signer: the signer''s client record is archived. Restore it or choose another signer.')) || v_missing;
  end if;
  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object('status', 'incomplete', 'missing', v_missing);
  end if;

  v_rendered := jsonb_build_object(
    'schema_version', 1,
    'title', private.render_contract_text(v_version.title, v_values),
    'sections', (
      select jsonb_agg(jsonb_build_object(
        'heading', private.render_contract_text(s ->> 'heading', v_values),
        'body', private.render_contract_text(s ->> 'body', v_values)) order by ord)
      from jsonb_array_elements(v_version.sections) with ordinality as x(s, ord)
    )
  );
  v_commercial := jsonb_build_object(
    'schema_version', 1,
    'currency', v_selection.currency,
    'package', jsonb_build_object('key', v_package.item_key, 'name', v_package.name, 'base_price_cents', v_package.unit_price_cents),
    'lines', (
      select jsonb_agg(jsonb_build_object(
        'line_no', l.line_no, 'source', l.source, 'item_key', l.item_key, 'name', l.name, 'description', l.description,
        'quantity', l.quantity, 'unit_price_cents', l.unit_price_cents, 'line_total_cents', l.line_total_cents,
        'required_quantity', l.required_quantity, 'required_reasons', to_jsonb(l.required_reasons),
        'tax_category', l.tax_category) order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id
    ),
    'subtotal_cents', v_selection.subtotal_cents,
    'tax_breakdown', v_selection.tax_breakdown,
    'tax_cents', v_selection.tax_cents,
    'total_cents', v_selection.total_cents,
    'payment', jsonb_build_object(
      'deposit_percent', v_tenant.deposit_percent,
      'deposit_basis_points', v_tenant.deposit_percent * 100,
      'deposit_rounding', 'half_up_to_cent',
      'deposit_due', 'on_signing',
      'deposit_cents', v_deposit,
      'balance_cents', v_balance,
      'balance_due_date', p_balance_due_date
    ),
    'source', jsonb_build_object(
      'proposal_id', v_proposal.id, 'proposal_revision', v_proposal.revision, 'offer_sha256', v_proposal.offer_sha256,
      'selection_id', v_selection.id, 'selection_version', v_selection.version,
      'approval_id', v_approval.id, 'selection_sha256', v_approval.selection_sha256, 'approved_at', v_approval.approved_at
    )
  );
  v_parties := jsonb_build_object(
    'business', jsonb_build_object(
      'name', v_tenant.business_name, 'display_name', v_tenant.display_name, 'legal_name', v_tenant.business_name,
      'address', v_tenant.business_address, 'contact_email', v_tenant.contact_email),
    'client', jsonb_build_object('client_id', v_signer.id, 'name', v_signer.name, 'email', v_signer.email, 'phone', v_signer.phone),
    'event', jsonb_build_object(
      'event_id', v_event.id, 'title', v_event.title, 'event_type', v_event.event_type, 'date', v_event.event_date,
      'timezone', v_event.timezone, 'venue_name', v_event.venue_name, 'venue_address', v_event.venue_address)
  );
  v_hash := private.contract_content_sha256(v_rendered, v_commercial, v_parties, v_version.id, v_version.content_sha256);

  -- One draft per event: repeat or replace explicitly ---------------------------
  select * into v_existing from public.contracts
  where tenant_id = v_event.tenant_id and event_id = v_event.id and status = 'draft'
  for update;
  v_has_existing := found;

  if v_has_existing then
    if v_existing.content_sha256 = v_hash
       and (p_replace_contract_id is null or p_replace_contract_id in (v_existing.id, v_existing.replaces_id)) then
      return jsonb_build_object('status', 'replayed', 'contract_id', v_existing.id);
    end if;
    if p_replace_contract_id is null then
      return jsonb_build_object('status', 'draft_exists', 'contract_id', v_existing.id);
    end if;
    if p_replace_contract_id <> v_existing.id then
      return jsonb_build_object('status', 'conflict', 'contract_id', v_existing.id);
    end if;
    update public.contracts set status = 'replaced' where id = v_existing.id;
    v_replaced := v_existing.id;
  elsif p_replace_contract_id is not null then
    return jsonb_build_object('status', 'conflict', 'contract_id', null);
  end if;

  insert into public.contracts (
    tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
    template_content_sha256, replaces_id, signer_client_id, signer_name, signer_email, currency,
    total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, rendered_content, commercial_snapshot,
    party_snapshot, content_sha256, generated_by_membership_id, generated_by_user_id
  ) values (
    v_tenant.id, v_event.id, v_proposal.id, v_selection.id, v_approval.id, v_version.template_id, v_version.id,
    v_version.content_sha256, v_replaced, v_signer.id, v_signer.name, v_signer.email, v_selection.currency,
    v_selection.total_cents, v_tenant.deposit_percent, v_deposit, v_balance, p_balance_due_date, v_rendered, v_commercial,
    v_parties, v_hash, v_membership_id, (select auth.uid())
  )
  returning id, content_sha256 into v_id, v_hash;

  perform private.audit(v_tenant.id, 'contract', v_id, case when v_replaced is null then 'draft_generated' else 'draft_regenerated' end,
    'staff', (select auth.uid()),
    jsonb_build_object('event_id', v_event.id, 'approval_id', v_approval.id, 'template_version_id', v_version.id,
                       'content_sha256', v_hash, 'replaces_id', v_replaced));
  if v_replaced is not null then
    perform private.audit(v_tenant.id, 'contract', v_replaced, 'draft_replaced', 'staff', (select auth.uid()),
      jsonb_build_object('replaced_by', v_id));
  end if;

  return jsonb_build_object('status', 'created', 'contract_id', v_id, 'content_sha256', v_hash, 'replaced_id', v_replaced);
end;
$$;
