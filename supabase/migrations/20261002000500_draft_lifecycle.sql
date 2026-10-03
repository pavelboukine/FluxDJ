-- Flux DJ draft lifecycle (Phase 1, step 5).
--
-- Step 4 froze an offer snapshot the moment a proposal was created, so every
-- edit would have produced a new frozen revision. This migration separates
-- editing from freezing:
--
--   * One mutable draft per event: proposals.draft_offer holds the editable
--     offer input (packages, addons, questions, intro, expiry) with an
--     optimistic draft_version. No snapshot exists while drafting.
--   * preview_proposal_offer builds the snapshot in memory with exactly the
--     validation used for freezing, and stores nothing.
--   * freeze_proposal_offer (service_role only) stores the snapshot once. The
--     send flow (step 6) calls it in the same transaction that sends.
--   * proposal_selection_drafts holds one mutable selection per proposal for
--     client editing (step 6). proposal_selections remains immutable and is
--     now reserved for submissions.

-- ===========================================================================
-- Proposals: mutable draft, freeze once
-- ===========================================================================

alter table public.proposals
  alter column offer_snapshot drop not null,
  alter column offer_sha256 drop not null,
  add column draft_offer jsonb not null default '{}'::jsonb,
  add column draft_version integer not null default 0
    constraint proposals_draft_version_nonnegative check (draft_version >= 0),
  add column offer_frozen_at timestamptz,
  add constraint proposals_snapshot_hash_together check ((offer_snapshot is null) = (offer_sha256 is null)),
  add constraint proposals_snapshot_frozen_at_together check ((offer_snapshot is null) = (offer_frozen_at is null)),
  add constraint proposals_non_draft_frozen check (status = 'draft' or offer_snapshot is not null);
comment on column public.proposals.draft_offer is
  'Editable offer input while drafting. Frozen into offer_snapshot once, by freeze_proposal_offer.';

-- At most one draft per event, so editing never accumulates proposals.
create unique index proposals_one_draft_per_event_idx on public.proposals (event_id) where status = 'draft';

create function private.is_uuid_text(value text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

-- Structural check for drafts. Completeness (three packages, one popular,
-- active records, tax categories) is checked by preview and freeze, so a
-- half-built draft can still be saved.
create function private.is_valid_draft_offer(draft jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select jsonb_typeof(draft) = 'object'
     and not exists (select 1 from jsonb_object_keys(draft) k
                     where k not in ('template_id', 'intro', 'expiry_days', 'packages', 'addons', 'question_ids'))
     and coalesce(jsonb_typeof(draft -> 'template_id') in ('string', 'null'), true)
     and (jsonb_typeof(draft -> 'template_id') is distinct from 'string' or private.is_uuid_text(draft ->> 'template_id'))
     and coalesce(jsonb_typeof(draft -> 'intro') in ('string', 'null'), true)
     and coalesce(length(draft ->> 'intro') <= 10000, true)
     and coalesce(jsonb_typeof(draft -> 'expiry_days') in ('number', 'null'), true)
     and coalesce(jsonb_typeof(draft -> 'packages') = 'array' and jsonb_array_length(draft -> 'packages') <= 3, true)
     and coalesce(jsonb_typeof(draft -> 'addons') = 'array' and jsonb_array_length(draft -> 'addons') <= 100, true)
     and coalesce(jsonb_typeof(draft -> 'question_ids') = 'array' and jsonb_array_length(draft -> 'question_ids') <= 100, true);
$$;
grant execute on function private.is_uuid_text(text), private.is_valid_draft_offer(jsonb) to authenticated, service_role;

alter table public.proposals
  add constraint proposals_draft_offer_valid check (private.is_valid_draft_offer(draft_offer));

-- Replace the step 4 immutability rules: the snapshot now starts empty and is
-- set exactly once; the draft can change only until then.
drop trigger proposals_immutable on public.proposals;
drop trigger proposals_compute_offer_hash on public.proposals;
drop function private.proposals_compute_offer_hash();

create trigger proposals_immutable before update on public.proposals
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'event_id', 'revision', 'supersedes_id', 'created_by_membership_id', 'created_at');

create function private.proposals_freeze_once()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.offer_snapshot is not null then
      raise exception 'proposals are created as drafts; freeze with freeze_proposal_offer'
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
       or new.source_template_id is distinct from old.source_template_id then
      raise exception 'the offer is frozen and cannot change' using errcode = 'check_violation';
    end if;
  elsif new.offer_snapshot is not null then
    -- Freezing now: the database computes the hash and timestamp.
    new.offer_sha256 := encode(pg_catalog.sha256(convert_to(new.offer_snapshot::text, 'UTF8')), 'hex');
    new.offer_frozen_at := now();
  else
    new.offer_sha256 := null;
    new.offer_frozen_at := null;
  end if;
  return new;
end;
$$;
create trigger proposals_freeze_once before insert or update on public.proposals
  for each row execute function private.proposals_freeze_once();

-- ===========================================================================
-- Snapshot builder shared by preview and freeze
-- ===========================================================================

-- offer_error only raises; declaring it STABLE lets STABLE callers use it.
alter function private.offer_error(text) stable;

-- Validates an offer input for a tenant and returns the snapshot it would
-- freeze. Raises SQLSTATE 22023 "offer_invalid: ..." on the first problem.
-- No authorization here: callers check membership or run as service_role.
create function private.build_offer_snapshot(p_tenant_id uuid, p_offer jsonb)
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

  return v_snapshot;
end;
$$;
revoke execute on function private.build_offer_snapshot(uuid, jsonb) from public, anon, authenticated;

-- Membership check shared by the staff-facing functions. Returns the
-- caller's membership id, or raises "not found" without revealing whether
-- the row exists in another tenant.
create function private.require_staff_of(p_tenant_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
begin
  select m.id into v_membership_id
  from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_membership_id is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  return v_membership_id;
end;
$$;
revoke execute on function private.require_staff_of(uuid) from public, anon, authenticated;

-- ===========================================================================
-- Draft functions (staff)
-- ===========================================================================

drop function public.create_proposal_offer(uuid, jsonb);

-- Opens the event's draft proposal, or returns the existing one. Never
-- freezes anything and never creates a second draft for the same event.
create function public.open_proposal_draft(p_event_id uuid, p_offer jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_membership_id uuid;
  v_existing uuid;
  v_revision int;
  v_offer jsonb := coalesce(p_offer, '{}'::jsonb);
  v_id uuid;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_event.tenant_id);

  select p.id into v_existing from public.proposals p where p.event_id = v_event.id and p.status = 'draft';
  if v_existing is not null then
    return v_existing;
  end if;

  if v_event.lifecycle_status in ('cancelled', 'completed') then
    perform private.offer_error('event is ' || v_event.lifecycle_status);
  end if;
  if not private.is_valid_draft_offer(v_offer) then
    perform private.offer_error('draft offer has an invalid shape');
  end if;

  select coalesce(max(p.revision), 0) + 1 into v_revision from public.proposals p where p.event_id = v_event.id;

  insert into public.proposals (tenant_id, event_id, revision, status, draft_offer, source_template_id, created_by_membership_id)
  values (
    v_event.tenant_id, v_event.id, v_revision, 'draft', v_offer,
    case when private.is_uuid_text(v_offer ->> 'template_id') then (v_offer ->> 'template_id')::uuid end,
    v_membership_id
  )
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.open_proposal_draft(uuid, jsonb) from public, anon;
grant execute on function public.open_proposal_draft(uuid, jsonb) to authenticated;

-- Saves the editable draft in place. Optimistic concurrency: a stale
-- p_expected_version (another tab saved first) fails with SQLSTATE 40001.
create function public.update_proposal_draft(p_proposal_id uuid, p_expected_version integer, p_offer jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_proposal.tenant_id);

  if v_proposal.status <> 'draft' or v_proposal.offer_snapshot is not null then
    raise exception 'the offer is frozen and cannot be edited' using errcode = 'invalid_parameter_value';
  end if;
  if v_proposal.draft_version <> p_expected_version then
    raise exception 'draft_version_conflict: expected %, current %', p_expected_version, v_proposal.draft_version
      using errcode = 'serialization_failure';
  end if;
  if not private.is_valid_draft_offer(p_offer) then
    perform private.offer_error('draft offer has an invalid shape');
  end if;
  if private.is_uuid_text(p_offer ->> 'template_id') and not exists (
    select 1 from public.proposal_templates t
    where t.tenant_id = v_proposal.tenant_id and t.id = (p_offer ->> 'template_id')::uuid
  ) then
    perform private.offer_error('template not found');
  end if;

  update public.proposals
    set draft_offer = p_offer,
        draft_version = draft_version + 1,
        source_template_id = case when private.is_uuid_text(p_offer ->> 'template_id') then (p_offer ->> 'template_id')::uuid end
    where id = v_proposal.id;
  return v_proposal.draft_version + 1;
end;
$$;
revoke execute on function public.update_proposal_draft(uuid, integer, jsonb) from public, anon;
grant execute on function public.update_proposal_draft(uuid, integer, jsonb) to authenticated;

-- Returns the snapshot the current draft would freeze, without storing it.
-- For a frozen proposal, returns the frozen snapshot.
create function public.preview_proposal_offer(p_proposal_id uuid)
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
  if v_proposal.offer_snapshot is not null then
    return v_proposal.offer_snapshot;
  end if;
  return private.build_offer_snapshot(v_proposal.tenant_id, v_proposal.draft_offer);
end;
$$;
revoke execute on function public.preview_proposal_offer(uuid) from public, anon;
grant execute on function public.preview_proposal_offer(uuid) to authenticated;

-- Freezes the draft's offer exactly once. Trusted server code only: the send
-- flow (step 6) calls it together with link issue and status change.
create function public.freeze_proposal_offer(p_proposal_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_event public.events%rowtype;
  v_sha text;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_proposal.offer_snapshot is not null then
    return v_proposal.offer_sha256; -- idempotent
  end if;
  select * into v_event from public.events where tenant_id = v_proposal.tenant_id and id = v_proposal.event_id;
  if v_event.lifecycle_status in ('cancelled', 'completed') then
    perform private.offer_error('event is ' || v_event.lifecycle_status);
  end if;

  update public.proposals
    set offer_snapshot = private.build_offer_snapshot(v_proposal.tenant_id, v_proposal.draft_offer)
    where id = v_proposal.id
    returning offer_sha256 into v_sha;
  return v_sha;
end;
$$;
revoke execute on function public.freeze_proposal_offer(uuid) from public, anon, authenticated;
grant execute on function public.freeze_proposal_offer(uuid) to service_role;

-- ===========================================================================
-- Selections: one mutable draft per proposal; immutable rows = submissions
-- ===========================================================================

create table public.proposal_selection_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  proposal_id uuid not null,
  -- Raw, structurally valid choices. Never prices: prices are always
  -- recomputed from the frozen offer.
  package_key text
    constraint proposal_selection_drafts_package_key_valid check (private.is_valid_key(package_key)),
  addon_quantities jsonb not null default '{}'::jsonb
    constraint proposal_selection_drafts_addons_object check (jsonb_typeof(addon_quantities) = 'object'),
  logistics_answers jsonb not null default '{}'::jsonb
    constraint proposal_selection_drafts_answers_object check (jsonb_typeof(logistics_answers) = 'object'),
  version integer not null default 0
    constraint proposal_selection_drafts_version_nonnegative check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposal_selection_drafts_proposal_fk foreign key (tenant_id, proposal_id)
    references public.proposals (tenant_id, id) on delete restrict,
  constraint proposal_selection_drafts_proposal_key unique (proposal_id),
  constraint proposal_selection_drafts_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.proposal_selection_drafts is
  'The single editable selection for a proposal (client autosave). Submissions are copied into immutable proposal_selections.';
create index proposal_selection_drafts_tenant_proposal_idx on public.proposal_selection_drafts (tenant_id, proposal_id);

create trigger proposal_selection_drafts_set_updated_at before update on public.proposal_selection_drafts
  for each row execute function private.set_updated_at();
create trigger proposal_selection_drafts_immutable before update on public.proposal_selection_drafts
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'proposal_id', 'created_at');

-- Saves the editable selection in place (trusted server code; the step 6
-- client flow validates the session and input first). Requires a frozen
-- offer. Optimistic concurrency via p_expected_version (SQLSTATE 40001).
create function public.save_proposal_selection_draft(
  p_proposal_id uuid,
  p_expected_version integer,
  p_package_key text,
  p_addon_quantities jsonb,
  p_logistics_answers jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_current int;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_proposal.offer_snapshot is null then
    raise exception 'the offer is not frozen yet' using errcode = 'invalid_parameter_value';
  end if;

  select version into v_current from public.proposal_selection_drafts where proposal_id = v_proposal.id;
  if coalesce(v_current, 0) <> p_expected_version then
    raise exception 'selection_draft_version_conflict: expected %, current %', p_expected_version, coalesce(v_current, 0)
      using errcode = 'serialization_failure';
  end if;

  insert into public.proposal_selection_drafts (tenant_id, proposal_id, package_key, addon_quantities, logistics_answers, version)
  values (v_proposal.tenant_id, v_proposal.id, p_package_key, coalesce(p_addon_quantities, '{}'), coalesce(p_logistics_answers, '{}'), 1)
  on conflict (proposal_id) do update
    set package_key = excluded.package_key,
        addon_quantities = excluded.addon_quantities,
        logistics_answers = excluded.logistics_answers,
        version = public.proposal_selection_drafts.version + 1;
  return p_expected_version + 1;
end;
$$;
revoke execute on function public.save_proposal_selection_draft(uuid, integer, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_proposal_selection_draft(uuid, integer, text, jsonb, jsonb) to service_role;

revoke all on public.proposal_selection_drafts from anon, authenticated;
grant select on public.proposal_selection_drafts to authenticated;
alter table public.proposal_selection_drafts enable row level security;
create policy proposal_selection_drafts_select_staff on public.proposal_selection_drafts
  for select to authenticated
  using (tenant_id in (select private.member_tenant_ids()));

-- Submissions: each recorded selection is an immutable submission of a
-- frozen offer, stamped with submitted_at by the database.
create or replace function public.record_proposal_selection(
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
  if v_proposal.offer_snapshot is null then
    raise exception 'the offer is not frozen yet' using errcode = 'invalid_parameter_value';
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
    pricing_version, offer_sha256, submitted_at
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
    p_selection ->> 'offer_sha256',
    now()
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

alter table public.proposal_selections
  add constraint proposal_selections_submitted check (submitted_at is not null);

-- ===========================================================================
-- Atomic catalog composition editing (invoker rights: RLS applies)
-- ===========================================================================

-- Replaces a package's included gear: [{"gear_item_id": uuid, "quantity": int}].
create function public.set_package_items(p_package_id uuid, p_items jsonb)
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
  delete from public.package_items where package_id = p_package_id;
  insert into public.package_items (tenant_id, package_id, gear_item_id, quantity)
  select v_tenant, p_package_id, (i ->> 'gear_item_id')::uuid, (i ->> 'quantity')::int
  from jsonb_array_elements(p_items) i;
end;
$$;
revoke execute on function public.set_package_items(uuid, jsonb) from public, anon;
grant execute on function public.set_package_items(uuid, jsonb) to authenticated;

-- Replaces a template's packages (positions 1-3), default package, addons and
-- questions in one transaction.
create function public.set_proposal_template_composition(
  p_template_id uuid,
  p_package_ids jsonb,
  p_default_package_id uuid,
  p_addons jsonb,
  p_question_ids jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.proposal_templates where id = p_template_id;
  if v_tenant is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if jsonb_typeof(p_package_ids) <> 'array' or jsonb_typeof(p_addons) <> 'array' or jsonb_typeof(p_question_ids) <> 'array' then
    raise exception 'packages, addons and questions must be arrays' using errcode = 'invalid_parameter_value';
  end if;

  update public.proposal_templates set default_package_id = null where id = p_template_id;
  delete from public.proposal_template_packages where template_id = p_template_id;
  delete from public.proposal_template_addons where template_id = p_template_id;
  delete from public.proposal_template_questions where template_id = p_template_id;

  insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
  select v_tenant, p_template_id, (x #>> '{}')::uuid, ord::int
  from jsonb_array_elements(p_package_ids) with ordinality as p(x, ord);

  insert into public.proposal_template_addons (tenant_id, template_id, gear_item_id, recommended_quantity, max_quantity, sort_order)
  select v_tenant, p_template_id, (a ->> 'gear_item_id')::uuid, (a ->> 'recommended_quantity')::int, (a ->> 'max_quantity')::int, ord::int
  from jsonb_array_elements(p_addons) with ordinality as x(a, ord);

  insert into public.proposal_template_questions (tenant_id, template_id, question_id, sort_order)
  select v_tenant, p_template_id, (x #>> '{}')::uuid, ord::int
  from jsonb_array_elements(p_question_ids) with ordinality as q(x, ord);

  update public.proposal_templates set default_package_id = p_default_package_id where id = p_template_id;
end;
$$;
revoke execute on function public.set_proposal_template_composition(uuid, jsonb, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.set_proposal_template_composition(uuid, jsonb, uuid, jsonb, jsonb) to authenticated;
