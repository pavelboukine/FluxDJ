-- Flux DJ catalog and reusable proposal templates (Phase 1, step 3).
-- Spec section 4 "Catalog and reusable templates" and section 7 (Storage).
--
-- Follows the tenancy-core conventions:
--   * tenant_id on every row, unique (tenant_id, id), composite foreign keys.
--   * id, tenant_id, created_at, stable keys and parent references immutable.
--   * Staff-only RLS; clients and anon get nothing. Public proposal pages will
--     read frozen offer snapshots through a server DTO, never these tables.
--   * Catalog records are archived (active = false), never deleted, so sent
--     offers keep their history. Composition rows (package contents, template
--     contents) may be deleted while editing.
--
-- Not in this migration: offer snapshots, pricing, sent proposals.

-- ===========================================================================
-- Validators
-- ===========================================================================

-- Stable machine keys used in snapshots and selections ("main_speaker").
create function private.is_valid_key(k text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select k ~ '^[a-z][a-z0-9_]{0,63}$';
$$;

-- Allowed gear media types. The extension, MIME type and kind must agree.
-- Byte-level sniffing belongs in the upload handler; the database and the
-- Storage bucket can only check declared types.
create function private.gear_media_type_kind(content_type text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case content_type
    when 'image/jpeg' then 'image'
    when 'image/png'  then 'image'
    when 'image/webp' then 'image'
    when 'image/avif' then 'image'
    when 'video/mp4'  then 'video'
    when 'video/webm' then 'video'
  end;
$$;

create function private.gear_media_extension_matches(object_name text, content_type text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select case content_type
    when 'image/jpeg' then object_name ~ '\.(jpg|jpeg)$'
    when 'image/png'  then object_name ~ '\.png$'
    when 'image/webp' then object_name ~ '\.webp$'
    when 'image/avif' then object_name ~ '\.avif$'
    when 'video/mp4'  then object_name ~ '\.mp4$'
    when 'video/webm' then object_name ~ '\.webm$'
    else false
  end;
$$;

-- Gear media object names: {tenant_id}/gear-items/{gear_item_id}/{uuid}.{ext}
-- A random object UUID per upload means a new upload never replaces an old
-- object that a sent offer may still reference.
create function private.parse_gear_media_path(object_name text)
returns table (tenant_id uuid, gear_item_id uuid)
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
      '/gear-items/'
      '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
      '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      '\.(jpg|jpeg|png|webp|avif|mp4|webm)$'
    ) as m
  ) parsed
  where m is not null;
$$;

create function private.is_valid_gear_media_path(object_name text, p_tenant_id uuid, p_gear_item_id uuid)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select exists (
    select 1 from private.parse_gear_media_path(object_name) p
    where p.tenant_id = p_tenant_id and p.gear_item_id = p_gear_item_id
  );
$$;

-- Question options. Choice questions carry 1-50 unique {value,label} options;
-- boolean and short_text questions carry none.
create function private.is_valid_question_options(answer_type text, options jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when answer_type in ('boolean', 'short_text') then options = '[]'::jsonb
    when answer_type in ('single_choice', 'multi_choice') then
      jsonb_typeof(options) = 'array'
      and jsonb_array_length(options) between 1 and 50
      and not exists (
        select 1 from jsonb_array_elements(options) as o(item)
        where jsonb_typeof(o.item) <> 'object'
           or (select count(*) from jsonb_object_keys(o.item)) <> 2
           or jsonb_typeof(o.item -> 'value') <> 'string'
           or not private.is_valid_key(o.item ->> 'value')
           or jsonb_typeof(o.item -> 'label') <> 'string'
           or length(btrim(o.item ->> 'label')) not between 1 and 200
      )
      and (select count(distinct o.item ->> 'value') = count(*)
           from jsonb_array_elements(options) as o(item))
    else false
  end;
$$;

-- Rule condition shape. V1 supports explicit equality and membership only:
--   {"op":"equals",   "value": true | "option_value"}
--   {"op":"in",       "values": ["option_a","option_b"]}   (single choice)
--   {"op":"contains", "value": "option_value"}             (multi choice)
-- No expressions, SQL or scripting. Compatibility with the question's
-- answer type and options is checked by trigger (needs the question row).
create function private.is_valid_rule_condition(condition jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select jsonb_typeof(condition) = 'object'
     and case condition ->> 'op'
       when 'equals' then
         (select array_agg(k order by k) from jsonb_object_keys(condition) k) = array['op', 'value']
         and (
           jsonb_typeof(condition -> 'value') = 'boolean'
           or (jsonb_typeof(condition -> 'value') = 'string' and private.is_valid_key(condition ->> 'value'))
         )
       when 'contains' then
         (select array_agg(k order by k) from jsonb_object_keys(condition) k) = array['op', 'value']
         and jsonb_typeof(condition -> 'value') = 'string'
         and private.is_valid_key(condition ->> 'value')
       when 'in' then
         (select array_agg(k order by k) from jsonb_object_keys(condition) k) = array['op', 'values']
         and jsonb_typeof(condition -> 'values') = 'array'
         and jsonb_array_length(condition -> 'values') between 1 and 50
         and not exists (
           select 1 from jsonb_array_elements(condition -> 'values') v(item)
           where jsonb_typeof(v.item) <> 'string' or not private.is_valid_key(v.item #>> '{}')
         )
         and (select count(distinct v.item) = count(*) from jsonb_array_elements(condition -> 'values') v(item))
       else false
     end;
$$;

-- Does a (shape-valid) condition make sense for this question?
create function private.rule_condition_fits_question(condition jsonb, answer_type text, options jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  with option_values as (
    select o.item ->> 'value' as value from jsonb_array_elements(options) o(item)
  )
  select case
    when answer_type = 'boolean' then
      condition ->> 'op' = 'equals' and jsonb_typeof(condition -> 'value') = 'boolean'
    when answer_type = 'single_choice' and condition ->> 'op' = 'equals' then
      jsonb_typeof(condition -> 'value') = 'string'
      and (condition ->> 'value') in (select value from option_values)
    when answer_type = 'single_choice' and condition ->> 'op' = 'in' then
      not exists (
        select 1 from jsonb_array_elements_text(condition -> 'values') v(value)
        where v.value not in (select value from option_values)
      )
    when answer_type = 'multi_choice' then
      condition ->> 'op' = 'contains'
      and (condition ->> 'value') in (select value from option_values)
    else false
  end;
$$;

-- CHECK constraints call these with the writer's privileges, so the roles
-- that write rows need EXECUTE (default privileges deny it).
grant execute on function
  private.is_valid_key(text),
  private.gear_media_type_kind(text),
  private.gear_media_extension_matches(text, text),
  private.parse_gear_media_path(text),
  private.is_valid_gear_media_path(text, uuid, uuid),
  private.is_valid_question_options(text, jsonb),
  private.is_valid_rule_condition(jsonb),
  private.rule_condition_fits_question(jsonb, text, jsonb)
  to authenticated, service_role;

-- ===========================================================================
-- Tables
-- ===========================================================================

create table public.gear_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  key text not null
    constraint gear_items_key_valid check (private.is_valid_key(key)),
  name text not null
    constraint gear_items_name_length check (length(btrim(name)) between 1 and 200),
  description text
    constraint gear_items_description_length check (length(description) <= 5000),
  unit_label text not null default 'unit'
    constraint gear_items_unit_label_length check (length(btrim(unit_label)) between 1 and 40),
  default_price_cents bigint not null
    constraint gear_items_price_range check (default_price_cents between 0 and 100000000),
  -- Matched to tenant tax configuration by the pricing step (Phase 1, step 4).
  tax_category text not null default 'standard'
    constraint gear_items_tax_category_valid check (private.is_valid_key(tax_category)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gear_items_tenant_key_key unique (tenant_id, key),
  constraint gear_items_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.gear_items is
  'A sellable catalog unit (e.g. ceremony speaker, pack of four uplights). Archive with active = false; never delete.';
comment on column public.gear_items.key is 'Stable, immutable key used in offer snapshots and selection lines.';

create table public.gear_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  gear_item_id uuid not null,
  storage_path text not null unique,
  kind text not null
    constraint gear_media_kind_valid check (kind in ('image', 'video')),
  content_type text not null,
  alt_text text not null
    constraint gear_media_alt_text_length check (length(btrim(alt_text)) between 1 and 300),
  sort_order integer not null default 0
    constraint gear_media_sort_order_range check (sort_order between 0 and 10000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gear_media_gear_item_fk foreign key (tenant_id, gear_item_id)
    references public.gear_items (tenant_id, id) on delete restrict,
  constraint gear_media_path_valid
    check (private.is_valid_gear_media_path(storage_path, tenant_id, gear_item_id)),
  constraint gear_media_type_matches_kind
    check (private.gear_media_type_kind(content_type) = kind),
  constraint gear_media_extension_matches_type
    check (private.gear_media_extension_matches(storage_path, content_type)),
  constraint gear_media_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.gear_media is
  'Private image/video for a gear item, stored in the gear-media bucket. The object is never overwritten; archive with active = false.';
create index gear_media_tenant_gear_idx on public.gear_media (tenant_id, gear_item_id, sort_order);

create table public.packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  key text not null
    constraint packages_key_valid check (private.is_valid_key(key)),
  name text not null
    constraint packages_name_length check (length(btrim(name)) between 1 and 200),
  description text
    constraint packages_description_length check (length(description) <= 5000),
  base_price_cents bigint not null
    constraint packages_price_range check (base_price_cents between 0 and 100000000),
  sort_order integer not null default 0
    constraint packages_sort_order_range check (sort_order between 0 and 10000),
  -- Catalog default only. "Exactly one most-popular package per offer" is
  -- enforced when an offer is frozen (step 5/6), not across the catalog.
  is_popular boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packages_tenant_key_key unique (tenant_id, key),
  constraint packages_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.packages is 'A package with a base price and included gear. Archive with active = false.';

create table public.package_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  package_id uuid not null,
  gear_item_id uuid not null,
  quantity integer not null
    constraint package_items_quantity_range check (quantity between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint package_items_package_fk foreign key (tenant_id, package_id)
    references public.packages (tenant_id, id) on delete cascade,
  constraint package_items_gear_item_fk foreign key (tenant_id, gear_item_id)
    references public.gear_items (tenant_id, id) on delete restrict,
  constraint package_items_package_gear_key unique (package_id, gear_item_id),
  constraint package_items_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.package_items is
  'Gear included in a package. Included gear is covered by the package base price and is not charged again.';
create index package_items_tenant_gear_idx on public.package_items (tenant_id, gear_item_id);
create index package_items_tenant_package_idx on public.package_items (tenant_id, package_id);

create table public.logistics_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  key text not null
    constraint logistics_questions_key_valid check (private.is_valid_key(key)),
  prompt text not null
    constraint logistics_questions_prompt_length check (length(btrim(prompt)) between 1 and 500),
  answer_type text not null
    constraint logistics_questions_answer_type_valid
    check (answer_type in ('boolean', 'single_choice', 'multi_choice', 'short_text')),
  options jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0
    constraint logistics_questions_sort_order_range check (sort_order between 0 and 10000),
  required boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint logistics_questions_options_valid check (private.is_valid_question_options(answer_type, options)),
  constraint logistics_questions_tenant_key_key unique (tenant_id, key),
  constraint logistics_questions_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.logistics_questions is
  'Requirements question shown on proposals. key and answer_type are immutable because rules and snapshots depend on them.';

create table public.logistics_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  question_id uuid not null,
  condition jsonb not null
    constraint logistics_rules_condition_shape check (private.is_valid_rule_condition(condition)),
  gear_item_id uuid not null,
  required_quantity integer not null
    constraint logistics_rules_quantity_range check (required_quantity between 1 and 100),
  reason text not null
    constraint logistics_rules_reason_length check (length(btrim(reason)) between 1 and 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint logistics_rules_question_fk foreign key (tenant_id, question_id)
    references public.logistics_questions (tenant_id, id) on delete restrict,
  constraint logistics_rules_gear_item_fk foreign key (tenant_id, gear_item_id)
    references public.gear_items (tenant_id, id) on delete restrict,
  constraint logistics_rules_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.logistics_rules is
  'When the answer to question_id matches condition, require required_quantity of gear_item_id. reason is shown to the client.';
create index logistics_rules_tenant_question_idx on public.logistics_rules (tenant_id, question_id);
create index logistics_rules_tenant_gear_idx on public.logistics_rules (tenant_id, gear_item_id);

create table public.proposal_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  name text not null
    constraint proposal_templates_name_length check (length(btrim(name)) between 1 and 200),
  intro text
    constraint proposal_templates_intro_length check (length(intro) <= 10000),
  expiry_days integer not null default 14
    constraint proposal_templates_expiry_range check (expiry_days between 1 and 365),
  default_package_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposal_templates_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.proposal_templates is
  'Reusable proposal starting point. default_package_id must be one of the template''s own packages.';
comment on column public.proposal_templates.default_package_id is
  'Recommended/preselected package. Enforced by FK to proposal_template_packages.';

create table public.proposal_template_packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  template_id uuid not null,
  package_id uuid not null,
  -- Positions 1-3, unique per template: at most three offered packages.
  sort_order integer not null
    constraint proposal_template_packages_position_range check (sort_order between 1 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposal_template_packages_template_fk foreign key (tenant_id, template_id)
    references public.proposal_templates (tenant_id, id) on delete cascade,
  constraint proposal_template_packages_package_fk foreign key (tenant_id, package_id)
    references public.packages (tenant_id, id) on delete restrict,
  constraint proposal_template_packages_template_package_key unique (template_id, package_id),
  constraint proposal_template_packages_template_position_key unique (template_id, sort_order)
    deferrable initially immediate,
  constraint proposal_template_packages_fk_target unique (tenant_id, template_id, package_id),
  constraint proposal_template_packages_tenant_id_id_key unique (tenant_id, id)
);
create index proposal_template_packages_tenant_package_idx on public.proposal_template_packages (tenant_id, package_id);

-- The default package must be offered by the same template (and tenant).
-- MATCH SIMPLE: a null default_package_id is allowed.
alter table public.proposal_templates
  add constraint proposal_templates_default_package_fk
  foreign key (tenant_id, id, default_package_id)
  references public.proposal_template_packages (tenant_id, template_id, package_id)
  on delete no action;

create table public.proposal_template_addons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  template_id uuid not null,
  gear_item_id uuid not null,
  -- Quantity preselected for the client (0 = offered but not preselected).
  recommended_quantity integer not null default 0
    constraint proposal_template_addons_recommended_range check (recommended_quantity between 0 and 100),
  max_quantity integer not null
    constraint proposal_template_addons_max_range check (max_quantity between 1 and 100),
  sort_order integer not null default 0
    constraint proposal_template_addons_sort_order_range check (sort_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposal_template_addons_recommended_le_max check (recommended_quantity <= max_quantity),
  constraint proposal_template_addons_template_fk foreign key (tenant_id, template_id)
    references public.proposal_templates (tenant_id, id) on delete cascade,
  constraint proposal_template_addons_gear_item_fk foreign key (tenant_id, gear_item_id)
    references public.gear_items (tenant_id, id) on delete restrict,
  constraint proposal_template_addons_template_gear_key unique (template_id, gear_item_id),
  constraint proposal_template_addons_tenant_id_id_key unique (tenant_id, id)
);
create index proposal_template_addons_tenant_template_idx on public.proposal_template_addons (tenant_id, template_id);
create index proposal_template_addons_tenant_gear_idx on public.proposal_template_addons (tenant_id, gear_item_id);

create table public.proposal_template_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  template_id uuid not null,
  question_id uuid not null,
  sort_order integer not null default 0
    constraint proposal_template_questions_sort_order_range check (sort_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposal_template_questions_template_fk foreign key (tenant_id, template_id)
    references public.proposal_templates (tenant_id, id) on delete cascade,
  constraint proposal_template_questions_question_fk foreign key (tenant_id, question_id)
    references public.logistics_questions (tenant_id, id) on delete restrict,
  constraint proposal_template_questions_template_question_key unique (template_id, question_id),
  constraint proposal_template_questions_tenant_id_id_key unique (tenant_id, id)
);
create index proposal_template_questions_tenant_template_idx on public.proposal_template_questions (tenant_id, template_id);
create index proposal_template_questions_tenant_question_idx on public.proposal_template_questions (tenant_id, question_id);

-- ===========================================================================
-- Triggers
-- ===========================================================================

create trigger gear_items_set_updated_at before update on public.gear_items
  for each row execute function private.set_updated_at();
create trigger gear_items_immutable before update on public.gear_items
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'key', 'created_at');

create trigger gear_media_set_updated_at before update on public.gear_media
  for each row execute function private.set_updated_at();
create trigger gear_media_immutable before update on public.gear_media
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'gear_item_id', 'storage_path', 'kind', 'content_type', 'created_at');

create trigger packages_set_updated_at before update on public.packages
  for each row execute function private.set_updated_at();
create trigger packages_immutable before update on public.packages
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'key', 'created_at');

create trigger package_items_set_updated_at before update on public.package_items
  for each row execute function private.set_updated_at();
create trigger package_items_immutable before update on public.package_items
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'package_id', 'gear_item_id', 'created_at');

create trigger logistics_questions_set_updated_at before update on public.logistics_questions
  for each row execute function private.set_updated_at();
create trigger logistics_questions_immutable before update on public.logistics_questions
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'key', 'answer_type', 'created_at');

create trigger logistics_rules_set_updated_at before update on public.logistics_rules
  for each row execute function private.set_updated_at();
create trigger logistics_rules_immutable before update on public.logistics_rules
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'question_id', 'created_at');

create trigger proposal_templates_set_updated_at before update on public.proposal_templates
  for each row execute function private.set_updated_at();
create trigger proposal_templates_immutable before update on public.proposal_templates
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_at');

create trigger proposal_template_packages_set_updated_at before update on public.proposal_template_packages
  for each row execute function private.set_updated_at();
create trigger proposal_template_packages_immutable before update on public.proposal_template_packages
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'template_id', 'package_id', 'created_at');

create trigger proposal_template_addons_set_updated_at before update on public.proposal_template_addons
  for each row execute function private.set_updated_at();
create trigger proposal_template_addons_immutable before update on public.proposal_template_addons
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'template_id', 'gear_item_id', 'created_at');

create trigger proposal_template_questions_set_updated_at before update on public.proposal_template_questions
  for each row execute function private.set_updated_at();
create trigger proposal_template_questions_immutable before update on public.proposal_template_questions
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'template_id', 'question_id', 'created_at');

-- Rule must fit its question's answer type and current options.
-- Security definer so validation sees the question regardless of caller RLS;
-- the composite FK already guarantees the same tenant.
create function private.validate_logistics_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  q record;
begin
  select answer_type, options into q
  from public.logistics_questions
  where tenant_id = new.tenant_id and id = new.question_id;

  if found and not private.rule_condition_fits_question(new.condition, q.answer_type, q.options) then
    raise exception 'rule condition does not match question answer type or options'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger logistics_rules_validate before insert or update on public.logistics_rules
  for each row execute function private.validate_logistics_rule();

-- Editing a question's options must not orphan existing rules.
create function private.validate_question_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.options is distinct from old.options and exists (
    select 1 from public.logistics_rules r
    where r.tenant_id = new.tenant_id
      and r.question_id = new.id
      and not private.rule_condition_fits_question(r.condition, new.answer_type, new.options)
  ) then
    raise exception 'option change would invalidate existing logistics rules'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger logistics_questions_validate_rules before update on public.logistics_questions
  for each row execute function private.validate_question_rules();

revoke execute on function private.validate_logistics_rule() from public, anon, authenticated;
revoke execute on function private.validate_question_rules() from public, anon, authenticated;

-- ===========================================================================
-- Privileges (staff only; no DELETE on catalog records)
-- ===========================================================================

revoke all on public.gear_items, public.gear_media, public.packages, public.package_items,
  public.logistics_questions, public.logistics_rules, public.proposal_templates,
  public.proposal_template_packages, public.proposal_template_addons,
  public.proposal_template_questions
  from anon, authenticated;

grant select on public.gear_items to authenticated;
grant insert (tenant_id, key, name, description, unit_label, default_price_cents, tax_category, active)
  on public.gear_items to authenticated;
grant update (name, description, unit_label, default_price_cents, tax_category, active)
  on public.gear_items to authenticated;

grant select on public.gear_media to authenticated;
grant insert (tenant_id, gear_item_id, storage_path, kind, content_type, alt_text, sort_order)
  on public.gear_media to authenticated;
grant update (alt_text, sort_order, active) on public.gear_media to authenticated;

grant select on public.packages to authenticated;
grant insert (tenant_id, key, name, description, base_price_cents, sort_order, is_popular, active)
  on public.packages to authenticated;
grant update (name, description, base_price_cents, sort_order, is_popular, active)
  on public.packages to authenticated;

grant select, delete on public.package_items to authenticated;
grant insert (tenant_id, package_id, gear_item_id, quantity) on public.package_items to authenticated;
grant update (quantity) on public.package_items to authenticated;

grant select on public.logistics_questions to authenticated;
grant insert (tenant_id, key, prompt, answer_type, options, sort_order, required, active)
  on public.logistics_questions to authenticated;
grant update (prompt, options, sort_order, required, active) on public.logistics_questions to authenticated;

grant select on public.logistics_rules to authenticated;
grant insert (tenant_id, question_id, condition, gear_item_id, required_quantity, reason, active)
  on public.logistics_rules to authenticated;
grant update (condition, gear_item_id, required_quantity, reason, active) on public.logistics_rules to authenticated;

grant select on public.proposal_templates to authenticated;
grant insert (tenant_id, name, intro, expiry_days, active) on public.proposal_templates to authenticated;
grant update (name, intro, expiry_days, default_package_id, active) on public.proposal_templates to authenticated;

grant select, delete on public.proposal_template_packages to authenticated;
grant insert (tenant_id, template_id, package_id, sort_order) on public.proposal_template_packages to authenticated;
grant update (sort_order) on public.proposal_template_packages to authenticated;

grant select, delete on public.proposal_template_addons to authenticated;
grant insert (tenant_id, template_id, gear_item_id, recommended_quantity, max_quantity, sort_order)
  on public.proposal_template_addons to authenticated;
grant update (recommended_quantity, max_quantity, sort_order) on public.proposal_template_addons to authenticated;

grant select, delete on public.proposal_template_questions to authenticated;
grant insert (tenant_id, template_id, question_id, sort_order) on public.proposal_template_questions to authenticated;
grant update (sort_order) on public.proposal_template_questions to authenticated;

-- ===========================================================================
-- Row-level security: staff of the row's tenant, nothing else.
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'gear_items', 'gear_media', 'packages', 'package_items', 'logistics_questions',
    'logistics_rules', 'proposal_templates', 'proposal_template_packages',
    'proposal_template_addons', 'proposal_template_questions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (tenant_id in (select private.member_tenant_ids()))', t || '_select_staff', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check (tenant_id in (select private.member_tenant_ids()))', t || '_insert_staff', t);
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (tenant_id in (select private.member_tenant_ids()))
         with check (tenant_id in (select private.member_tenant_ids()))', t || '_update_staff', t);
  end loop;

  -- Composition rows may be removed while editing.
  foreach t in array array[
    'package_items', 'proposal_template_packages', 'proposal_template_addons', 'proposal_template_questions'
  ] loop
    execute format(
      'create policy %I on public.%I for delete to authenticated
         using (tenant_id in (select private.member_tenant_ids()))', t || '_delete_staff', t);
  end loop;
end;
$$;

-- ===========================================================================
-- Storage: private gear media bucket
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gear-media', 'gear-media', false,
  104857600, -- 100 MiB; must not exceed the project-wide Storage limit
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4', 'video/webm']
)
on conflict (id) do nothing;

-- Staff may read objects belonging to their tenant.
create function private.can_read_gear_media_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.parse_gear_media_path(object_name) p
    where p.tenant_id in (select private.member_tenant_ids())
  );
$$;

-- Staff may upload only under a gear item that exists in their tenant.
create function private.can_upload_gear_media_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.parse_gear_media_path(object_name) p
    join public.gear_items g on g.tenant_id = p.tenant_id and g.id = p.gear_item_id
    where p.tenant_id in (select private.member_tenant_ids())
  );
$$;

revoke execute on function private.can_read_gear_media_object(text) from public, anon;
revoke execute on function private.can_upload_gear_media_object(text) from public, anon;
grant execute on function private.can_read_gear_media_object(text) to authenticated;
grant execute on function private.can_upload_gear_media_object(text) to authenticated;

-- Clients and anon have no policies: proposal media will be served through
-- short-lived signed URLs issued by the server after authorization.
-- No UPDATE or DELETE policies: objects are never overwritten (upsert fails)
-- and are not removed by staff, because sent offers may reference them.
create policy gear_media_objects_select_staff on storage.objects
  for select to authenticated
  using (bucket_id = 'gear-media' and private.can_read_gear_media_object(name));

create policy gear_media_objects_insert_staff on storage.objects
  for insert to authenticated
  with check (bucket_id = 'gear-media' and private.can_upload_gear_media_object(name));
