-- Flux DJ Phase 2, step 1 (part 1): versioned contract templates.
-- Spec section 4 ("contract_templates", "contract_template_versions").
--
-- Model:
--   * contract_templates: a named template owned by one tenant. Archived with
--     active = false, never deleted.
--   * contract_template_versions: numbered versions of a template's text.
--     A version is an editable draft until it is published; once published it
--     is immutable for every role, including service_role, and can never be
--     deleted, so contracts generated from it keep their source.
--     At most one draft per template. "Editing" a published template opens a
--     new draft version copied from the latest version.
--
-- Content is structured plain text: a title and 1-60 sections of
-- {heading, body}. No HTML, markup or expressions are interpreted anywhere.
-- The only dynamic syntax is a placeholder: {{group.name}} from the fixed
-- registry private.contract_placeholders(). Unknown or malformed placeholders
-- are rejected when a draft is saved (and by a CHECK constraint as a backstop).
--
-- All version writes go through the security definer functions below, which
-- check membership. Staff can rename or archive a template directly (RLS).

-- ===========================================================================
-- Placeholder registry (single source of truth; the staff UI reads it)
-- ===========================================================================

-- Every placeholder a template may use. When a template uses a placeholder,
-- generation requires a non-blank value for it; `missing_hint` tells staff
-- what to complete. Values come from the approved selection (commercial
-- terms) or from client, event and business records copied at generation.
create function private.contract_placeholders()
returns table (key text, label text, description text, missing_hint text, sort_order integer)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('business.name', 'Business name', 'Your business name.', 'Business name: set it in your business settings.', 10),
    ('business.display_name', 'Business display name', 'The name clients see on proposals.', 'Business display name: set it in your business settings.', 20),
    ('client.name', 'Client name', 'The event contact marked as signer.', 'Client name: edit the signer''s client record.', 30),
    ('client.email', 'Client email', 'The signer''s email address.', 'Client email: edit the signer''s client record.', 40),
    ('client.phone', 'Client phone', 'The signer''s phone number.', 'Client phone: add a phone number to the signer''s client record.', 50),
    ('event.title', 'Event title', 'The event''s title.', 'Event title: edit the event.', 60),
    ('event.date', 'Event date', 'The event date, for example "Saturday, June 12, 2027".', 'Event date: edit the event.', 70),
    ('venue.name', 'Venue name', 'The event''s venue name.', 'Venue name: add it to the event.', 80),
    ('venue.address', 'Venue address', 'The event''s venue address.', 'Venue address: add it to the event.', 90),
    ('package.name', 'Package', 'The approved package''s name.', 'Package: the approved selection has no package.', 100),
    ('package.price', 'Package price', 'The approved package''s base price.', 'Package price: the approved selection has no package.', 110),
    ('package.included', 'Included gear', 'A list of the gear included in the package.', 'Included gear: unavailable.', 120),
    ('gear.extras', 'Additional gear', 'A list of chargeable extra and required gear, with line totals and reasons. Says "No additional gear." when there is none.', 'Additional gear: unavailable.', 130),
    ('pricing.subtotal', 'Subtotal', 'Approved subtotal before taxes.', 'Subtotal: unavailable.', 140),
    ('pricing.taxes', 'Tax breakdown', 'A list of each configured tax with its rate and amount.', 'Tax breakdown: unavailable.', 150),
    ('pricing.tax_total', 'Total taxes', 'Sum of the approved taxes.', 'Total taxes: unavailable.', 160),
    ('pricing.total', 'Total', 'Approved total including taxes.', 'Total: unavailable.', 170),
    ('pricing.currency', 'Currency', 'Currency code, for example CAD.', 'Currency: unavailable.', 180),
    ('payment.deposit_percent', 'Deposit percentage', 'The deposit share of the total: 50%.', 'Deposit percentage: unavailable.', 190),
    ('payment.deposit', 'Deposit', 'Deposit due on signing: 50% of the total including taxes, rounded half up to the cent.', 'Deposit: unavailable.', 200),
    ('payment.balance', 'Balance', 'Remaining balance: the total minus the deposit.', 'Balance: unavailable.', 210),
    ('payment.balance_due_date', 'Balance due date', 'A date staff enter when generating the contract. Nothing is assumed.', 'Balance due date: enter it when generating the contract.', 220)
  ) as p(key, label, description, missing_hint, sort_order);
$$;

-- Staff-facing list for the template editor. Static data, no tenant rows.
create function public.contract_placeholder_catalog()
returns table (key text, label text, description text, sort_order integer)
language sql
stable
security definer
set search_path = ''
as $$
  select p.key, p.label, p.description, p.sort_order
  from private.contract_placeholders() p
  where (select auth.uid()) is not null
  order by p.sort_order;
$$;

-- Placeholder syntax: {{key}} with optional inner spaces. Keys are lowercase
-- dotted identifiers. Anything else containing "{{" or "}}" is malformed.
create function private.contract_placeholder_pattern()
returns text
language sql
immutable
set search_path = ''
as $$
  select '\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}';
$$;

-- All texts of a template version, in display order.
create function private.contract_template_texts(p_title text, p_sections jsonb)
returns setof text
language sql
immutable
set search_path = ''
as $$
  select p_title
  union all
  select t.value
  from jsonb_array_elements(case when jsonb_typeof(p_sections) = 'array' then p_sections else '[]'::jsonb end)
       with ordinality as s(item, ord),
       lateral (values (1, s.item ->> 'heading'), (2, s.item ->> 'body')) as t(part, value)
  where t.value is not null;
$$;

-- Distinct placeholder keys used by a version, sorted.
create function private.contract_template_placeholders_used(p_title text, p_sections jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct m[1] order by m[1]), '{}')
  from private.contract_template_texts(p_title, p_sections) as t(value),
       lateral regexp_matches(t.value, private.contract_placeholder_pattern(), 'g') as m;
$$;

-- Why a version's content is invalid, or null when it is valid.
create function private.contract_template_problem(p_title text, p_sections jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_ord bigint;
  v_text text;
  v_key text;
  v_stripped text;
begin
  if p_title is null or length(btrim(p_title)) not between 1 and 300 or p_title ~ '[\r\n]' then
    return 'the title must be one line of 1 to 300 characters';
  end if;
  if jsonb_typeof(p_sections) is distinct from 'array' then
    return 'a template needs 1 to 60 sections';
  end if;
  if jsonb_array_length(p_sections) not between 1 and 60 then
    return 'a template needs 1 to 60 sections';
  end if;
  if length(p_sections::text) > 200000 then
    return 'the template is too long';
  end if;
  for v_item, v_ord in select s.item, s.ord from jsonb_array_elements(p_sections) with ordinality as s(item, ord) loop
    -- Separate checks: Postgres does not guarantee OR evaluation order.
    if jsonb_typeof(v_item) <> 'object' then
      return 'section ' || v_ord::text || ' must have a heading and a body';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(v_item) k) is distinct from array['body', 'heading']
       or jsonb_typeof(v_item -> 'heading') <> 'string'
       or jsonb_typeof(v_item -> 'body') <> 'string' then
      return 'section ' || v_ord::text || ' must have a heading and a body';
    end if;
    if length(btrim(v_item ->> 'heading')) not between 1 and 200 or (v_item ->> 'heading') ~ '[\r\n]' then
      return 'section ' || v_ord::text || ': the heading must be one line of 1 to 200 characters';
    end if;
    if length(btrim(v_item ->> 'body')) not between 1 and 20000 then
      return 'section ' || v_ord::text || ' (' || (v_item ->> 'heading') || '): the text must be 1 to 20,000 characters';
    end if;
    -- "## " starts a new section in the editor, so it cannot begin a body line.
    if (v_item ->> 'body') ~ '(^|\n)## ' then
      return 'section ' || v_ord::text || ' (' || (v_item ->> 'heading') || '): a line cannot start with "## "';
    end if;
  end loop;

  for v_text in select t from private.contract_template_texts(p_title, p_sections) t loop
    for v_key in select m[1] from regexp_matches(v_text, private.contract_placeholder_pattern(), 'g') m loop
      if not exists (select 1 from private.contract_placeholders() p where p.key = v_key) then
        return 'unknown placeholder {{' || v_key || '}}';
      end if;
    end loop;
    v_stripped := regexp_replace(v_text, private.contract_placeholder_pattern(), '', 'g');
    if v_stripped ~ '\{\{|\}\}' then
      return 'malformed placeholder near "'
        || btrim((regexp_match(v_stripped, '(.{0,20}(?:\{\{|\}\}).{0,20})'))[1])
        || '". Use the form {{client.name}}';
    end if;
  end loop;
  return null;
end;
$$;

grant execute on function
  private.contract_placeholders(),
  private.contract_placeholder_pattern(),
  private.contract_template_texts(text, jsonb),
  private.contract_template_placeholders_used(text, jsonb),
  private.contract_template_problem(text, jsonb)
  to authenticated, service_role;

create function private.contract_error(p_message text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  raise exception 'contract_template_invalid: %', p_message using errcode = 'invalid_parameter_value';
end;
$$;
revoke execute on function private.contract_error(text) from public, anon, authenticated;

-- ===========================================================================
-- Tables
-- ===========================================================================

create table public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  name text not null
    constraint contract_templates_name_length check (length(btrim(name)) between 1 and 200),
  active boolean not null default true,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_templates_created_by_fk foreign key (tenant_id, created_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (created_by_membership_id),
  constraint contract_templates_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.contract_templates is
  'A named contract template of one DJ business. Its text lives in contract_template_versions. Archive with active = false; never deleted.';
create index contract_templates_tenant_idx on public.contract_templates (tenant_id, active, name);
create index contract_templates_tenant_created_by_idx on public.contract_templates (tenant_id, created_by_membership_id);

create table public.contract_template_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  template_id uuid not null,
  version_number integer not null
    constraint contract_template_versions_number_positive check (version_number >= 1),
  title text not null,
  -- [{"heading": text, "body": text}, ...]; plain text only.
  sections jsonb not null,
  -- Distinct placeholder keys the content uses (maintained by trigger).
  placeholders text[] not null default '{}',
  -- Optimistic concurrency for draft edits.
  draft_version integer not null default 0
    constraint contract_template_versions_draft_version_nonnegative check (draft_version >= 0),
  published_at timestamptz,
  published_by_membership_id uuid,
  -- SHA-256 (hex) of the UTF-8 bytes of the canonical Postgres jsonb text of
  -- {"title": title, "sections": sections}. Computed by the database when the
  -- version is published.
  content_sha256 text
    constraint contract_template_versions_sha256_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_template_versions_content_valid check (private.contract_template_problem(title, sections) is null),
  constraint contract_template_versions_published_hash check ((published_at is null) = (content_sha256 is null)),
  constraint contract_template_versions_template_fk foreign key (tenant_id, template_id)
    references public.contract_templates (tenant_id, id) on delete restrict,
  constraint contract_template_versions_published_by_fk foreign key (tenant_id, published_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (published_by_membership_id),
  constraint contract_template_versions_created_by_fk foreign key (tenant_id, created_by_membership_id)
    references public.tenant_memberships (tenant_id, id) on delete set null (created_by_membership_id),
  constraint contract_template_versions_template_number_key unique (template_id, version_number),
  constraint contract_template_versions_tenant_template_id_key unique (tenant_id, template_id, id),
  constraint contract_template_versions_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.contract_template_versions is
  'Numbered text versions of a contract template. Drafts are editable; published versions are immutable and never deleted.';
create unique index contract_template_versions_one_draft_idx
  on public.contract_template_versions (template_id) where published_at is null;
create index contract_template_versions_tenant_template_idx on public.contract_template_versions (tenant_id, template_id, version_number);
create index contract_template_versions_tenant_published_by_idx on public.contract_template_versions (tenant_id, published_by_membership_id);
create index contract_template_versions_tenant_created_by_idx on public.contract_template_versions (tenant_id, created_by_membership_id);

-- ===========================================================================
-- Triggers
-- ===========================================================================

create trigger contract_templates_set_updated_at before update on public.contract_templates
  for each row execute function private.set_updated_at();
create trigger contract_templates_immutable before update on public.contract_templates
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_by_membership_id', 'created_at');
create trigger contract_templates_no_delete before delete on public.contract_templates
  for each row execute function private.reject_change();

create trigger contract_template_versions_set_updated_at before update on public.contract_template_versions
  for each row execute function private.set_updated_at();
create trigger contract_template_versions_immutable before update on public.contract_template_versions
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'template_id', 'version_number', 'created_by_membership_id', 'created_at');
create trigger contract_template_versions_no_delete before delete on public.contract_template_versions
  for each row execute function private.reject_change();

-- Versions are created as drafts; publishing happens once and freezes the
-- row. The database stamps the time and computes the hash.
create function private.contract_template_versions_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.published_at is not null then
    raise exception 'published contract template versions are immutable; open a new draft version instead'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' and new.published_at is not null then
    raise exception 'contract template versions are created as drafts and published separately'
      using errcode = 'check_violation';
  end if;
  new.placeholders := private.contract_template_placeholders_used(new.title, new.sections);
  if new.published_at is not null then
    new.published_at := now();
    new.content_sha256 := encode(pg_catalog.sha256(convert_to(
      jsonb_build_object('title', new.title, 'sections', new.sections)::text, 'UTF8')), 'hex');
  else
    new.content_sha256 := null;
    new.published_by_membership_id := null;
  end if;
  return new;
end;
$$;
create trigger contract_template_versions_lifecycle before insert or update on public.contract_template_versions
  for each row execute function private.contract_template_versions_lifecycle();

-- ===========================================================================
-- Staff functions (membership checked inside)
-- ===========================================================================

-- Creates a template and its first draft version in one transaction.
create function public.create_contract_template(p_tenant_id uuid, p_name text, p_title text, p_sections jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_template_id uuid;
  v_problem text;
begin
  v_membership_id := private.require_staff_of(p_tenant_id);
  if p_name is null or length(btrim(p_name)) not between 1 and 200 then
    perform private.contract_error('the name must be 1 to 200 characters');
  end if;
  v_problem := private.contract_template_problem(p_title, p_sections);
  if v_problem is not null then
    perform private.contract_error(v_problem);
  end if;

  insert into public.contract_templates (tenant_id, name, created_by_membership_id)
  values (p_tenant_id, btrim(p_name), v_membership_id)
  returning id into v_template_id;
  insert into public.contract_template_versions (tenant_id, template_id, version_number, title, sections, created_by_membership_id)
  values (p_tenant_id, v_template_id, 1, btrim(p_title), p_sections, v_membership_id);
  return v_template_id;
end;
$$;

-- Saves a draft version in place. A stale p_expected_draft_version (another
-- tab saved first) fails with SQLSTATE 40001. Published versions are refused.
create function public.save_contract_template_draft(
  p_version_id uuid, p_expected_draft_version integer, p_title text, p_sections jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.contract_template_versions%rowtype;
  v_problem text;
begin
  select * into v_version from public.contract_template_versions where id = p_version_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_version.tenant_id);
  if v_version.published_at is not null then
    perform private.contract_error('this version is published and cannot be edited; open a new draft version');
  end if;
  if v_version.draft_version <> p_expected_draft_version then
    raise exception 'draft_version_conflict: expected %, current %', p_expected_draft_version, v_version.draft_version
      using errcode = 'serialization_failure';
  end if;
  v_problem := private.contract_template_problem(p_title, p_sections);
  if v_problem is not null then
    perform private.contract_error(v_problem);
  end if;

  update public.contract_template_versions
    set title = btrim(p_title), sections = p_sections, draft_version = draft_version + 1
    where id = v_version.id;
  return v_version.draft_version + 1;
end;
$$;

-- Publishes the saved draft exactly as last saved. p_expected_draft_version
-- must match, so unsaved or newer edits from another tab are never published
-- by surprise. Publishing again returns the same result.
create function public.publish_contract_template_version(p_version_id uuid, p_expected_draft_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.contract_template_versions%rowtype;
  v_membership_id uuid;
begin
  select * into v_version from public.contract_template_versions where id = p_version_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_version.tenant_id);
  if v_version.published_at is not null then
    return jsonb_build_object('status', 'published', 'version_number', v_version.version_number,
                              'content_sha256', v_version.content_sha256, 'replayed', true);
  end if;
  if v_version.draft_version <> p_expected_draft_version then
    raise exception 'draft_version_conflict: expected %, current %', p_expected_draft_version, v_version.draft_version
      using errcode = 'serialization_failure';
  end if;

  update public.contract_template_versions
    set published_at = now(), published_by_membership_id = v_membership_id
    where id = v_version.id
    returning * into v_version;
  perform private.audit(v_version.tenant_id, 'contract_template', v_version.template_id, 'version_published', 'staff',
    (select auth.uid()), jsonb_build_object('version_id', v_version.id, 'version_number', v_version.version_number,
                                            'content_sha256', v_version.content_sha256));
  return jsonb_build_object('status', 'published', 'version_number', v_version.version_number,
                            'content_sha256', v_version.content_sha256, 'replayed', false);
end;
$$;

-- Returns the template's draft version, creating one copied from the latest
-- version when there is none. This is how a published template is edited:
-- the published version itself never changes.
create function public.open_contract_template_draft(p_template_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.contract_templates%rowtype;
  v_membership_id uuid;
  v_latest public.contract_template_versions%rowtype;
  v_id uuid;
begin
  select * into v_template from public.contract_templates where id = p_template_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_template.tenant_id);

  select v.id into v_id from public.contract_template_versions v
  where v.template_id = v_template.id and v.published_at is null;
  if v_id is not null then
    return v_id;
  end if;

  select * into v_latest from public.contract_template_versions v
  where v.template_id = v_template.id order by v.version_number desc limit 1;
  insert into public.contract_template_versions (tenant_id, template_id, version_number, title, sections, created_by_membership_id)
  values (v_template.tenant_id, v_template.id, v_latest.version_number + 1, v_latest.title, v_latest.sections, v_membership_id)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function
  public.contract_placeholder_catalog(),
  public.create_contract_template(uuid, text, text, jsonb),
  public.save_contract_template_draft(uuid, integer, text, jsonb),
  public.publish_contract_template_version(uuid, integer),
  public.open_contract_template_draft(uuid)
  from public, anon;
grant execute on function
  public.contract_placeholder_catalog(),
  public.create_contract_template(uuid, text, text, jsonb),
  public.save_contract_template_draft(uuid, integer, text, jsonb),
  public.publish_contract_template_version(uuid, integer),
  public.open_contract_template_draft(uuid)
  to authenticated;

-- ===========================================================================
-- Privileges and RLS: staff of the owning tenant only
-- ===========================================================================

revoke all on public.contract_templates, public.contract_template_versions from anon, authenticated;
grant select on public.contract_templates, public.contract_template_versions to authenticated;
-- Templates are created through create_contract_template; staff may rename or archive.
grant update (name, active) on public.contract_templates to authenticated;

alter table public.contract_templates enable row level security;
alter table public.contract_template_versions enable row level security;

create policy contract_templates_select_staff on public.contract_templates
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
create policy contract_templates_update_staff on public.contract_templates
  for update to authenticated
  using (tenant_id in (select private.member_tenant_ids()))
  with check (tenant_id in (select private.member_tenant_ids()));
create policy contract_template_versions_select_staff on public.contract_template_versions
  for select to authenticated using (tenant_id in (select private.member_tenant_ids()));
