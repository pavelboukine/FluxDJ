-- Flux DJ offers and priced selections (Phase 1, step 4).
-- Spec sections 4 ("Proposals and selected pricing"), 5 (pricing) and 6.
--
-- Scope: draft proposals carrying a frozen offer snapshot, and immutable,
-- versioned client selections with priced lines. Sending, public links,
-- expiry, approval and events.active_proposal_id arrive in step 6.
--
-- Division of responsibility:
--   * create_proposal_offer (this file) validates the offer and freezes a
--     snapshot of catalog data. Later catalog edits cannot change it.
--   * src/lib/pricing (TypeScript) is the single pricing engine: it validates
--     client input against the snapshot and computes lines and taxes.
--   * record_proposal_selection (this file, service_role only) stores a priced
--     selection atomically. A deferred check re-verifies every amount against
--     the frozen snapshot: unit prices, line totals, subtotal, per-line tax
--     rounding and total. Client-supplied money is never stored unchecked.

-- ===========================================================================
-- Tax categories: which configured taxes apply to each category
-- ===========================================================================

-- {"standard": ["GST","QST"], "exempt": []}. Every code must exist in the
-- same tenant's tax_config. An empty list is an explicit "no tax" category.
-- There is deliberately no default category: an unmapped category blocks
-- offer creation instead of silently charging zero tax.
create function private.is_valid_tax_categories(tax_config jsonb, tax_categories jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select jsonb_typeof(tax_categories) = 'object'
     and (select count(*) from jsonb_object_keys(tax_categories)) <= 20
     and not exists (
       select 1 from jsonb_each(tax_categories) as c(key, codes)
       where not private.is_valid_key(c.key)
          or jsonb_typeof(c.codes) <> 'array'
          or exists (
            select 1 from jsonb_array_elements(c.codes) as x(code)
            where jsonb_typeof(x.code) <> 'string'
               or not exists (
                 select 1 from jsonb_array_elements(tax_config) t(item)
                 where t.item ->> 'code' = x.code #>> '{}'
               )
          )
          or (select count(distinct x.code) <> count(*) from jsonb_array_elements(c.codes) x(code))
     );
$$;
grant execute on function private.is_valid_tax_categories(jsonb, jsonb) to authenticated, service_role;

alter table public.tenants
  add column tax_categories jsonb not null default '{}'::jsonb,
  add constraint tenants_tax_categories_valid check (private.is_valid_tax_categories(tax_config, tax_categories));
comment on column public.tenants.tax_categories is
  'Maps tax category keys (used by gear and packages) to tax codes in tax_config. No implicit default.';
grant update (tax_categories) on public.tenants to authenticated;

alter table public.packages
  add column tax_category text not null default 'standard'
    constraint packages_tax_category_valid check (private.is_valid_key(tax_category));
grant insert (tax_category), update (tax_category) on public.packages to authenticated;

-- ===========================================================================
-- Tables
-- ===========================================================================

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  revision integer not null
    constraint proposals_revision_positive check (revision >= 1),
  status text not null default 'draft'
    constraint proposals_status_valid check (status in (
      'draft', 'sent', 'submitted', 'approved', 'expired', 'superseded', 'declined'
    )),
  source_template_id uuid,
  expires_at timestamptz,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  supersedes_id uuid,
  offer_snapshot jsonb not null,
  -- SHA-256 (hex) of the snapshot's canonical Postgres jsonb text. Computed by
  -- trigger on insert; any supplied value is ignored.
  offer_sha256 text not null
    constraint proposals_offer_sha256_format check (offer_sha256 ~ '^[0-9a-f]{64}$'),
  current_selection_version integer not null default 0
    constraint proposals_selection_version_nonnegative check (current_selection_version >= 0),
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposals_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete restrict,
  constraint proposals_template_fk foreign key (tenant_id, source_template_id)
    references public.proposal_templates (tenant_id, id) on delete restrict,
  constraint proposals_created_by_fk foreign key (tenant_id, created_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (created_by_membership_id),
  constraint proposals_event_revision_key unique (event_id, revision),
  constraint proposals_tenant_id_id_key unique (tenant_id, id)
);
alter table public.proposals
  add constraint proposals_supersedes_fk foreign key (tenant_id, supersedes_id)
  references public.proposals (tenant_id, id) on delete restrict;
comment on table public.proposals is
  'A proposal revision for an event. offer_snapshot is frozen at creation and never changes. '
  'Only draft is reachable in step 4; sending and later states arrive in step 6.';
create index proposals_tenant_event_idx on public.proposals (tenant_id, event_id);
create index proposals_tenant_template_idx on public.proposals (tenant_id, source_template_id);
create index proposals_tenant_supersedes_idx on public.proposals (tenant_id, supersedes_id);
create index proposals_tenant_created_by_idx on public.proposals (tenant_id, created_by_membership_id);

create table public.proposal_selections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  proposal_id uuid not null,
  version integer not null
    constraint proposal_selections_version_positive check (version >= 1),
  package_key text not null
    constraint proposal_selections_package_key_valid check (private.is_valid_key(package_key)),
  addon_quantities jsonb not null
    constraint proposal_selections_addons_object check (jsonb_typeof(addon_quantities) = 'object'),
  logistics_answers jsonb not null
    constraint proposal_selections_answers_object check (jsonb_typeof(logistics_answers) = 'object'),
  subtotal_cents bigint not null
    constraint proposal_selections_subtotal_nonnegative check (subtotal_cents >= 0),
  tax_cents bigint not null
    constraint proposal_selections_tax_nonnegative check (tax_cents >= 0),
  total_cents bigint not null,
  currency text not null
    constraint proposal_selections_currency_valid check (currency ~ '^[A-Z]{3}$'),
  tax_breakdown jsonb not null
    constraint proposal_selections_tax_breakdown_array check (jsonb_typeof(tax_breakdown) = 'array'),
  -- Complete computed result from the pricing engine, for approval and
  -- contract generation without recomputation.
  selection_snapshot jsonb not null
    constraint proposal_selections_snapshot_object check (jsonb_typeof(selection_snapshot) = 'object'),
  pricing_version text not null
    constraint proposal_selections_pricing_version_valid check (pricing_version ~ '^[a-z0-9._-]{1,40}$'),
  -- The offer this selection was priced against.
  offer_sha256 text not null
    constraint proposal_selections_offer_sha256_format check (offer_sha256 ~ '^[0-9a-f]{64}$'),
  -- Set once by the submission flow (step 6).
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposal_selections_total_sum check (total_cents = subtotal_cents + tax_cents),
  constraint proposal_selections_proposal_fk foreign key (tenant_id, proposal_id)
    references public.proposals (tenant_id, id) on delete restrict,
  constraint proposal_selections_proposal_version_key unique (proposal_id, version),
  constraint proposal_selections_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.proposal_selections is
  'Immutable, versioned client selection with server-computed pricing. Written only through record_proposal_selection.';
create index proposal_selections_tenant_proposal_idx on public.proposal_selections (tenant_id, proposal_id);

create table public.proposal_selection_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  selection_id uuid not null,
  line_no integer not null
    constraint proposal_selection_lines_line_no_positive check (line_no >= 1),
  -- package: the package base price. included: gear covered by the package
  -- (shown, never charged). optional/required: chargeable extra gear.
  source text not null
    constraint proposal_selection_lines_source_valid check (source in ('package', 'included', 'optional', 'required')),
  item_key text not null
    constraint proposal_selection_lines_item_key_valid check (private.is_valid_key(item_key)),
  name text not null
    constraint proposal_selection_lines_name_length check (length(name) between 1 and 200),
  description text,
  quantity integer not null
    constraint proposal_selection_lines_quantity_range check (quantity between 1 and 10000),
  unit_price_cents bigint not null
    constraint proposal_selection_lines_unit_price_nonnegative check (unit_price_cents >= 0),
  line_total_cents bigint not null,
  -- Minimum chargeable quantity imposed by logistics rules (after package inclusions).
  required_quantity integer not null default 0
    constraint proposal_selection_lines_required_nonnegative check (required_quantity >= 0),
  required_reasons text[] not null default '{}',
  tax_category text not null
    constraint proposal_selection_lines_tax_category_valid check (private.is_valid_key(tax_category)),
  created_at timestamptz not null default now(),
  constraint proposal_selection_lines_total check (line_total_cents = quantity::bigint * unit_price_cents),
  constraint proposal_selection_lines_package_shape check (source <> 'package' or (quantity = 1 and required_quantity = 0)),
  constraint proposal_selection_lines_included_free check (source <> 'included' or (unit_price_cents = 0 and required_quantity = 0)),
  constraint proposal_selection_lines_optional_shape check (source <> 'optional' or required_quantity = 0),
  constraint proposal_selection_lines_required_shape check (
    source <> 'required' or (required_quantity >= 1 and quantity >= required_quantity and cardinality(required_reasons) >= 1)
  ),
  constraint proposal_selection_lines_selection_fk foreign key (tenant_id, selection_id)
    references public.proposal_selections (tenant_id, id) on delete restrict,
  constraint proposal_selection_lines_selection_line_key unique (selection_id, line_no),
  constraint proposal_selection_lines_tenant_id_id_key unique (tenant_id, id)
);
create index proposal_selection_lines_tenant_selection_idx on public.proposal_selection_lines (tenant_id, selection_id);

-- ===========================================================================
-- Triggers: hashing and immutability
-- ===========================================================================

create function private.proposals_compute_offer_hash()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.offer_sha256 := encode(pg_catalog.sha256(convert_to(new.offer_snapshot::text, 'UTF8')), 'hex');
  return new;
end;
$$;
create trigger proposals_compute_offer_hash before insert on public.proposals
  for each row execute function private.proposals_compute_offer_hash();

create trigger proposals_set_updated_at before update on public.proposals
  for each row execute function private.set_updated_at();
create trigger proposals_immutable before update on public.proposals
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'revision', 'source_template_id', 'supersedes_id',
    'offer_snapshot', 'offer_sha256', 'created_by_membership_id', 'created_at');

create trigger proposal_selections_set_updated_at before update on public.proposal_selections
  for each row execute function private.set_updated_at();
create trigger proposal_selections_immutable before update on public.proposal_selections
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'proposal_id', 'version', 'package_key', 'addon_quantities', 'logistics_answers',
    'subtotal_cents', 'tax_cents', 'total_cents', 'currency', 'tax_breakdown', 'selection_snapshot',
    'pricing_version', 'offer_sha256', 'created_at');

-- submitted_at is one-way.
create function private.proposal_selections_submitted_once()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'proposal_selections.submitted_at cannot change once set'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger proposal_selections_submitted_once before update on public.proposal_selections
  for each row execute function private.proposal_selections_submitted_once();

-- Selection lines never change and are never removed.
create function private.reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are immutable', tg_table_name using errcode = 'check_violation';
end;
$$;
create trigger proposal_selection_lines_immutable before update or delete on public.proposal_selection_lines
  for each row execute function private.reject_change();
create trigger proposal_selections_no_delete before delete on public.proposal_selections
  for each row execute function private.reject_change();
create trigger proposals_no_delete before delete on public.proposals
  for each row execute function private.reject_change();

-- ===========================================================================
-- Deferred verification of selection money against the frozen offer
-- ===========================================================================

-- Tax policy (must match src/lib/pricing/tax.ts): for each line and each tax
-- code applying to the line's category, round half up to the cent:
--   (line_total_cents * rate_ppm + 500000) / 1000000   (integer division)
-- then sum the rounded amounts per code.
create function private.verify_proposal_selection(p_selection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.proposal_selections%rowtype;
  offer jsonb;
  offer_hash text;
  problem text;
begin
  select * into s from public.proposal_selections where id = p_selection_id;
  if not found then
    return;
  end if;

  select p.offer_snapshot, p.offer_sha256 into offer, offer_hash
  from public.proposals p
  where p.tenant_id = s.tenant_id and p.id = s.proposal_id;

  problem := case
    when s.offer_sha256 <> offer_hash then 'selection was priced against a different offer'
    when s.currency <> offer ->> 'currency' then 'currency does not match the offer'
    when not exists (select 1 from jsonb_array_elements(offer -> 'packages') pk where pk ->> 'key' = s.package_key)
      then 'package is not part of the offer'
    when (select count(*) from public.proposal_selection_lines l
          where l.selection_id = s.id and l.source = 'package') <> 1
      then 'exactly one package line is required'
    when exists (select 1 from public.proposal_selection_lines l
                 where l.selection_id = s.id and l.source = 'package' and l.item_key <> s.package_key)
      then 'package line does not match the selected package'
    else null
  end;

  -- Unit prices and tax categories must come from the frozen offer.
  if problem is null then
    select 'line ' || l.line_no || ' (' || l.item_key || ') does not match the frozen offer'
      into problem
    from public.proposal_selection_lines l
    left join lateral (
      select (pk ->> 'base_price_cents')::bigint as price, pk ->> 'tax_category' as tax_category
      from jsonb_array_elements(offer -> 'packages') pk
      where pk ->> 'key' = l.item_key
    ) pkg on l.source = 'package'
    left join lateral (
      select (offer -> 'gear' -> l.item_key ->> 'unit_price_cents')::bigint as price,
             offer -> 'gear' -> l.item_key ->> 'tax_category' as tax_category
    ) gear on l.source in ('optional', 'required', 'included')
    left join lateral (
      select (inc ->> 'quantity')::int as quantity
      from jsonb_array_elements(offer -> 'packages') pk,
           jsonb_array_elements(pk -> 'included') inc
      where pk ->> 'key' = s.package_key and inc ->> 'gear_key' = l.item_key
    ) incl on l.source = 'included'
    where l.selection_id = s.id
      and case l.source
        when 'package' then pkg.price is distinct from l.unit_price_cents
                         or pkg.tax_category is distinct from l.tax_category
        when 'included' then incl.quantity is distinct from l.quantity
                          or gear.tax_category is distinct from l.tax_category
        else gear.price is distinct from l.unit_price_cents
          or gear.tax_category is distinct from l.tax_category
      end
    order by l.line_no
    limit 1;
  end if;

  if problem is null and s.subtotal_cents <> (
    select coalesce(sum(l.line_total_cents), 0) from public.proposal_selection_lines l where l.selection_id = s.id
  ) then
    problem := 'subtotal does not equal the sum of line totals';
  end if;

  -- Recompute taxes with the frozen rates and the documented rounding policy.
  if problem is null then
    with rates as (
      select r ->> 'code' as code, r ->> 'label' as label, (r ->> 'rate_ppm')::bigint as rate_ppm,
             ord
      from jsonb_array_elements(offer -> 'tax' -> 'rates') with ordinality as x(r, ord)
    ),
    expected as (
      select rates.code, rates.label, rates.rate_ppm, rates.ord,
             coalesce(sum(l.line_total_cents) filter (where applies), 0) as taxable_cents,
             coalesce(sum((l.line_total_cents * rates.rate_ppm + 500000) / 1000000) filter (where applies), 0) as amount_cents
      from rates
      left join public.proposal_selection_lines l on l.selection_id = s.id
      left join lateral (
        select exists (
          select 1 from jsonb_array_elements_text(offer -> 'tax' -> 'categories' -> l.tax_category) c(code)
          where c.code = rates.code
        ) as applies
      ) a on true
      group by rates.code, rates.label, rates.rate_ppm, rates.ord
    ),
    expected_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', code, 'label', label, 'rate_ppm', rate_ppm,
               'taxable_cents', taxable_cents, 'amount_cents', amount_cents) order by ord), '[]'::jsonb) as breakdown,
             coalesce(sum(amount_cents), 0) as total_tax
      from expected
    )
    select case
      when s.tax_breakdown <> e.breakdown then 'tax breakdown does not match the frozen rates and rounding policy'
      when s.tax_cents <> e.total_tax then 'tax total does not equal the sum of rounded taxes'
    end
    into problem
    from expected_json e;
  end if;

  if problem is not null then
    raise exception 'invalid priced selection: %', problem using errcode = 'check_violation';
  end if;
end;
$$;
revoke execute on function private.verify_proposal_selection(uuid) from public, anon, authenticated;

create function private.verify_selection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'proposal_selections' then
    perform private.verify_proposal_selection(new.id);
  else
    perform private.verify_proposal_selection(new.selection_id);
  end if;
  return null;
end;
$$;
revoke execute on function private.verify_selection_trigger() from public, anon, authenticated;

-- Checked at commit, after the selection and all its lines exist. Adding a
-- line to an existing selection later re-runs the check and fails.
create constraint trigger proposal_selections_verify
  after insert on public.proposal_selections
  deferrable initially deferred
  for each row execute function private.verify_selection_trigger();
create constraint trigger proposal_selection_lines_verify
  after insert on public.proposal_selection_lines
  deferrable initially deferred
  for each row execute function private.verify_selection_trigger();

-- ===========================================================================
-- Offer creation
-- ===========================================================================

create function private.offer_error(message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'offer_invalid: %', message using errcode = 'invalid_parameter_value';
end;
$$;

-- Builds and stores a draft proposal with a frozen offer snapshot.
--
-- p_offer:
-- {
--   "template_id": uuid | null,            -- provenance only
--   "intro": text | null,
--   "expiry_days": 1..365,
--   "packages": [ {"package_id": uuid, "is_popular": bool} x3 ],  -- display order
--   "addons":   [ {"gear_item_id": uuid, "recommended_quantity": int, "max_quantity": int} ],
--   "question_ids": [ uuid ]
-- }
--
-- Enforced: caller is staff of the event's tenant; exactly three distinct
-- packages with exactly one most popular; every referenced package, gear item
-- (included, addon or rule-required) and question is active; every frozen rule
-- references a question in the offer and its gear is in the snapshot; every
-- tax category used resolves to the frozen tax configuration.
create function public.create_proposal_offer(p_event_id uuid, p_offer jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_tenant public.tenants%rowtype;
  v_membership_id uuid;
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
  v_revision int;
  v_proposal_id uuid;
begin
  -- Authorization ------------------------------------------------------------
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;

  select m.id into v_membership_id
  from public.tenant_memberships m
  where m.tenant_id = v_event.tenant_id and m.user_id = (select auth.uid());
  if v_membership_id is null then
    -- Same message as a missing event: do not reveal other tenants' ids.
    raise exception 'event not found' using errcode = 'no_data_found';
  end if;

  select * into v_tenant from public.tenants where id = v_event.tenant_id;
  if v_tenant.archived_at is not null then
    perform private.offer_error('tenant is archived');
  end if;
  if v_event.lifecycle_status in ('cancelled', 'completed') then
    perform private.offer_error('event is ' || v_event.lifecycle_status);
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
      ) order by sel.ord)
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

  select coalesce(max(p.revision), 0) + 1 into v_revision
  from public.proposals p where p.event_id = v_event.id;

  insert into public.proposals (
    tenant_id, event_id, revision, status, source_template_id,
    offer_snapshot, offer_sha256, created_by_membership_id
  ) values (
    v_tenant.id, v_event.id, v_revision, 'draft', v_template_id,
    v_snapshot, repeat('0', 64), v_membership_id
  )
  returning id into v_proposal_id;

  return v_proposal_id;
end;
$$;
revoke execute on function public.create_proposal_offer(uuid, jsonb) from public, anon;
grant execute on function public.create_proposal_offer(uuid, jsonb) to authenticated;

-- Prefill an offer from a template. Read-only and RLS-scoped (invoker rights):
-- staff only see their own templates. The template's default package becomes
-- the single most-popular package.
create function public.proposal_offer_input_from_template(p_template_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'template_id', t.id,
    'intro', t.intro,
    'expiry_days', t.expiry_days,
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'package_id', tp.package_id,
        'is_popular', tp.package_id = t.default_package_id
      ) order by tp.sort_order)
      from public.proposal_template_packages tp
      where tp.tenant_id = t.tenant_id and tp.template_id = t.id
    ), '[]'::jsonb),
    'addons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'gear_item_id', ta.gear_item_id,
        'recommended_quantity', ta.recommended_quantity,
        'max_quantity', ta.max_quantity
      ) order by ta.sort_order, ta.gear_item_id)
      from public.proposal_template_addons ta
      where ta.tenant_id = t.tenant_id and ta.template_id = t.id
    ), '[]'::jsonb),
    'question_ids', coalesce((
      select jsonb_agg(tq.question_id order by tq.sort_order, tq.question_id)
      from public.proposal_template_questions tq
      where tq.tenant_id = t.tenant_id and tq.template_id = t.id
    ), '[]'::jsonb)
  )
  from public.proposal_templates t
  where t.id = p_template_id;
$$;
revoke execute on function public.proposal_offer_input_from_template(uuid) from public, anon;
grant execute on function public.proposal_offer_input_from_template(uuid) to authenticated;

-- ===========================================================================
-- Recording a priced selection (trusted server code only)
-- ===========================================================================

-- p_selection is the output of the TypeScript pricing engine
-- (toSelectionRecord). The deferred verification re-checks every amount
-- against the frozen offer at commit. Optimistic concurrency: the caller
-- passes the version it last saw; a mismatch fails with SQLSTATE 40001.
create function public.record_proposal_selection(
  p_proposal_id uuid,
  p_expected_version integer,
  p_selection jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_selection_id uuid;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal not found' using errcode = 'no_data_found';
  end if;
  -- Step 6 narrows this to sent, unexpired proposals with a valid session.
  if v_proposal.status not in ('draft', 'sent') then
    raise exception 'proposal is %', v_proposal.status using errcode = 'invalid_parameter_value';
  end if;
  if v_proposal.current_selection_version <> p_expected_version then
    raise exception 'selection_version_conflict: expected %, current %',
      p_expected_version, v_proposal.current_selection_version
      using errcode = 'serialization_failure';
  end if;

  insert into public.proposal_selections (
    tenant_id, proposal_id, version, package_key, addon_quantities, logistics_answers,
    subtotal_cents, tax_cents, total_cents, currency, tax_breakdown, selection_snapshot,
    pricing_version, offer_sha256
  ) values (
    v_proposal.tenant_id, v_proposal.id, p_expected_version + 1,
    p_selection ->> 'package_key',
    p_selection -> 'addon_quantities',
    p_selection -> 'logistics_answers',
    (p_selection ->> 'subtotal_cents')::bigint,
    (p_selection ->> 'tax_cents')::bigint,
    (p_selection ->> 'total_cents')::bigint,
    p_selection ->> 'currency',
    p_selection -> 'tax_breakdown',
    p_selection,
    p_selection ->> 'pricing_version',
    p_selection ->> 'offer_sha256'
  )
  returning id into v_selection_id;

  insert into public.proposal_selection_lines (
    tenant_id, selection_id, line_no, source, item_key, name, description, quantity,
    unit_price_cents, line_total_cents, required_quantity, required_reasons, tax_category
  )
  select v_proposal.tenant_id, v_selection_id, l.ord::int,
         l.x ->> 'source', l.x ->> 'item_key', l.x ->> 'name', l.x ->> 'description',
         (l.x ->> 'quantity')::int, (l.x ->> 'unit_price_cents')::bigint, (l.x ->> 'line_total_cents')::bigint,
         coalesce((l.x ->> 'required_quantity')::int, 0),
         coalesce(array(select jsonb_array_elements_text(l.x -> 'required_reasons')), '{}'),
         l.x ->> 'tax_category'
  from jsonb_array_elements(p_selection -> 'lines') with ordinality as l(x, ord);

  update public.proposals
    set current_selection_version = p_expected_version + 1
    where id = v_proposal.id;

  return v_selection_id;
end;
$$;
revoke execute on function public.record_proposal_selection(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.record_proposal_selection(uuid, integer, jsonb) to service_role;

-- ===========================================================================
-- Privileges and RLS: staff read; all writes go through the functions above.
-- ===========================================================================

revoke all on public.proposals, public.proposal_selections, public.proposal_selection_lines
  from anon, authenticated;
grant select on public.proposals, public.proposal_selections, public.proposal_selection_lines to authenticated;

alter table public.proposals enable row level security;
alter table public.proposal_selections enable row level security;
alter table public.proposal_selection_lines enable row level security;

create policy proposals_select_staff on public.proposals
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));
create policy proposal_selections_select_staff on public.proposal_selections
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));
create policy proposal_selection_lines_select_staff on public.proposal_selection_lines
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));
