-- Planning foundation: reusable planning templates, one plan per event copied
-- from a template, initialization at booking, client and staff access, a
-- small Event basics editor and server-side progress.
--
-- Structure. Planning follows the event in order: general sections (event
-- basics, contacts and vendors, DJ preferences) sit outside the chronological
-- stages (ceremony, cocktail, ... closing), and each stage holds its moments.
-- Every stage, moment and general section comes from a fixed library
-- (private.planning_library): a stable key, a kind, the stages a moment may
-- belong to, a default label and, once built, the editor that answers it.
-- Keys identify; labels are display text staff may rename; position orders
-- siblings. No form designer, expressions or executable rules.
--
-- Templates (planning_templates, planning_template_items) belong to one
-- business. Staff create, edit, duplicate and archive them; starter
-- definitions (Wedding, Simple Party) are added only by an explicit staff
-- action, idempotently (one per starter key per business). Templates describe
-- structure only: no prices, services or gear.
--
-- Event plans (event_plans, event_plan_items) are copies. A plan never reads
-- its template again, so editing a template changes no existing plan. Staff
-- customize a plan's items: rename, reorder, add from the library, and
-- disable/restore instead of deleting, so saved answers are kept. A disabled
-- stage hides its moments; restoring it shows them again in their order.
-- Applying another template is explicit (confirmed) and non-destructive:
-- items with the same key keep their id and answers; items the template
-- lacks are disabled, never deleted.
--
-- Initialization. A plan is created once per event (unique event_id, under
-- the event row lock):
--   * when the event is booked: an AFTER trigger on the booking transition
--     (booking_confirmed_at set, which only private.evaluate_booking does)
--     runs in the booking transaction. It takes no proposal or contract
--     locks, so the existing lock order (event, proposal, contract) holds;
--   * for events already booked when this migration runs (backfill);
--   * earlier, when staff set planning up before booking.
-- Template choice, in order: the template staff chose (setup before booking),
-- else the business's active template marked as the default for the event's
-- event_type (an explicit staff setting; event_type values are the app's
-- documented list), else a minimal plan with Event basics only (origin
-- 'fallback'), which staff are prompted to configure. Titles are never used
-- to guess. Re-running initialization never overwrites a plan or its edits.
--
-- Imported information. When the event has a signed contract, the plan keeps
-- an immutable copy (event_plan_imports) of the frozen proposal questions
-- (key, wording, type, options) and the submitted answers of the exact
-- selection that contract was generated from, with the contract, proposal,
-- selection and offer hash as provenance. Never the current catalog or
-- another proposal. Nothing is mapped into planning fields: no question key
-- has a documented planning meaning yet, and labels are never interpreted.
-- Clients see these answers read-only ("Already provided"). Staff-entered
-- event details (date, venue) are read live from the event and shown, not
-- re-asked. Missing answers stay "Not answered".
--
-- Answers (event_plan_responses): one row per plan item that has an editor,
-- validated JSON per editor, with a revision for optimistic concurrency. Only
-- Event basics has an editor now (private.normalize_plan_basics). Planning
-- writes never touch proposals, contracts, evidence, PDFs, payments or
-- booking fields.
--
-- Access. Staff of the business read every planning table (RLS) and change
-- planning only through the functions below. Clients have no table access:
-- client_planning_view, client_save_plan_basics and my_plans check verified
-- event access (private.client_event_ids), a booked event (booking stays
-- after payment corrections), and that neither the event nor the business is
-- archived. Clients can't change templates or structure.
--
-- Progress (private.plan_progress) is computed in the database from saved,
-- validated answers and the event's own details, over enabled items whose
-- editor exists. Items without an editor are "not available" and excluded;
-- the result says it covers available sections only. "Not applicable" is an
-- explicit answer, distinct from unanswered.

-- ===========================================================================
-- Library
-- ===========================================================================

-- editor: the editor that answers the item, or null while it is not built.
-- removable: false only for Event basics, which every template and plan has.
create function private.planning_library()
returns table (kind text, key text, parent_keys text[], default_label text, description text, editor text,
               removable boolean, library_order integer)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('general', 'basics',           null::text[], 'Event basics', 'Guest count, timing and access details for the DJ.', 'basics', false, 10),
    ('general', 'contacts_vendors', null::text[], 'Contacts and vendors', 'Day-of contacts and other vendors.', null::text, true, 20),
    ('general', 'dj_preferences',   null::text[], 'DJ expectations and overall preferences', 'Overall style, volume and what matters most.', null::text, true, 30),

    ('stage', 'arrival',            null::text[], 'Guest arrival', 'Welcome and arrival of guests.', null::text, true, 100),
    ('stage', 'ceremony',           null::text[], 'Ceremony', null::text, null::text, true, 110),
    ('stage', 'cocktail',           null::text[], 'Cocktail', null::text, null::text, true, 120),
    ('stage', 'reception_entrance', null::text[], 'Reception entrance', null::text, null::text, true, 130),
    ('stage', 'program',            null::text[], 'Speeches and program', 'Formal part of the event.', null::text, true, 135),
    ('stage', 'dinner',             null::text[], 'Dinner', null::text, null::text, true, 140),
    ('stage', 'special_dances',     null::text[], 'Special dances', null::text, null::text, true, 150),
    ('stage', 'party',              null::text[], 'Party', null::text, null::text, true, 160),
    ('stage', 'closing',            null::text[], 'Closing', null::text, null::text, true, 170),

    ('moment', 'arrival_details',      array['arrival'], 'Arrival details', null::text, null::text, true, 200),
    ('moment', 'arrival_music',        array['arrival'], 'Background music', null::text, null::text, true, 201),
    ('moment', 'ceremony_details',     array['ceremony'], 'Ceremony details', null::text, null::text, true, 210),
    ('moment', 'pre_ceremony_music',   array['ceremony'], 'Pre-ceremony music', null::text, null::text, true, 211),
    ('moment', 'processional',         array['ceremony'], 'Processional participants', null::text, null::text, true, 212),
    ('moment', 'couple_entrance',      array['ceremony'], 'Couple entrance', null::text, null::text, true, 213),
    ('moment', 'ceremony_signing',     array['ceremony'], 'Signing', null::text, null::text, true, 214),
    ('moment', 'recessional',          array['ceremony'], 'Recessional', null::text, null::text, true, 215),
    ('moment', 'cocktail_details',     array['cocktail'], 'Location and timing', null::text, null::text, true, 220),
    ('moment', 'cocktail_music',       array['cocktail'], 'Background music', null::text, null::text, true, 221),
    ('moment', 'mc',                   array['reception_entrance'], 'MC', null::text, null::text, true, 230),
    ('moment', 'introductions',        array['reception_entrance'], 'Introductions', null::text, null::text, true, 231),
    ('moment', 'entrance_participants', array['reception_entrance'], 'Participants and names', null::text, null::text, true, 232),
    ('moment', 'entrance_music',       array['reception_entrance'], 'Entrance music', null::text, null::text, true, 233),
    ('moment', 'program_details',      array['program'], 'Program details', null::text, null::text, true, 235),
    ('moment', 'dinner_details',       array['dinner'], 'Timing', null::text, null::text, true, 240),
    ('moment', 'dinner_music',         array['dinner'], 'Background music', null::text, null::text, true, 241),
    ('moment', 'speeches',             array['dinner', 'program', 'party'], 'Speeches and toasts', null::text, null::text, true, 242),
    ('moment', 'dinner_activities',    array['dinner'], 'Activities', null::text, null::text, true, 243),
    ('moment', 'cake_cutting',         array['dinner', 'party'], 'Cake cutting', null::text, null::text, true, 244),
    ('moment', 'first_dance',          array['special_dances'], 'First dance', null::text, null::text, true, 250),
    ('moment', 'family_dances',        array['special_dances'], 'Family dances', 'Dances with parents or other family members.', null::text, true, 251),
    ('moment', 'other_dances',         array['special_dances'], 'Other special dances', null::text, null::text, true, 252),
    ('moment', 'music_preferences',    array['party'], 'Music preferences', null::text, null::text, true, 260),
    ('moment', 'must_play',            array['party'], 'Must play', null::text, null::text, true, 261),
    ('moment', 'play_if_possible',     array['party'], 'Play if possible', null::text, null::text, true, 262),
    ('moment', 'do_not_play',          array['party'], 'Do not play', null::text, null::text, true, 263),
    ('moment', 'dedications',          array['party'], 'Dedications', null::text, null::text, true, 264),
    ('moment', 'party_activities',     array['party'], 'Optional activities', 'For example a bouquet toss.', null::text, true, 265),
    ('moment', 'last_dances',          array['closing'], 'Last dances', null::text, null::text, true, 270),
    ('moment', 'final_song',           array['closing'], 'Final song', null::text, null::text, true, 271),
    ('moment', 'closing_instructions', array['closing'], 'Closing instructions', null::text, null::text, true, 272)
  ) as l(kind, key, parent_keys, default_label, description, editor, removable, library_order);
$$;

-- Staff screens list the library to add items. Not secret; still staff-only
-- in practice (clients never call it).
create function public.planning_library()
returns table (kind text, key text, parent_keys text[], default_label text, description text, editor text,
               removable boolean, library_order integer)
language sql
stable
set search_path = ''
as $$
  select * from private.planning_library() order by library_order;
$$;

-- Starter outlines: (key, parent key, position). Labels are the library
-- defaults. They are outlines, not promises that every editor exists.
create function private.starter_planning_items(p_starter text)
returns table (key text, parent_key text, item_position integer)
language sql
immutable
set search_path = ''
as $$
  select s.key, s.parent_key, s.item_position from (values
    ('wedding', 'basics', null, 1), ('wedding', 'contacts_vendors', null, 2), ('wedding', 'dj_preferences', null, 3),
    ('wedding', 'ceremony', null, 1), ('wedding', 'cocktail', null, 2), ('wedding', 'reception_entrance', null, 3),
    ('wedding', 'dinner', null, 4), ('wedding', 'special_dances', null, 5), ('wedding', 'party', null, 6), ('wedding', 'closing', null, 7),
    ('wedding', 'ceremony_details', 'ceremony', 1), ('wedding', 'pre_ceremony_music', 'ceremony', 2), ('wedding', 'processional', 'ceremony', 3),
    ('wedding', 'couple_entrance', 'ceremony', 4), ('wedding', 'ceremony_signing', 'ceremony', 5), ('wedding', 'recessional', 'ceremony', 6),
    ('wedding', 'cocktail_details', 'cocktail', 1), ('wedding', 'cocktail_music', 'cocktail', 2),
    ('wedding', 'mc', 'reception_entrance', 1), ('wedding', 'introductions', 'reception_entrance', 2),
    ('wedding', 'entrance_participants', 'reception_entrance', 3), ('wedding', 'entrance_music', 'reception_entrance', 4),
    ('wedding', 'dinner_details', 'dinner', 1), ('wedding', 'dinner_music', 'dinner', 2), ('wedding', 'speeches', 'dinner', 3),
    ('wedding', 'dinner_activities', 'dinner', 4), ('wedding', 'cake_cutting', 'dinner', 5),
    ('wedding', 'first_dance', 'special_dances', 1), ('wedding', 'family_dances', 'special_dances', 2), ('wedding', 'other_dances', 'special_dances', 3),
    ('wedding', 'music_preferences', 'party', 1), ('wedding', 'must_play', 'party', 2), ('wedding', 'play_if_possible', 'party', 3),
    ('wedding', 'do_not_play', 'party', 4), ('wedding', 'dedications', 'party', 5), ('wedding', 'party_activities', 'party', 6),
    ('wedding', 'last_dances', 'closing', 1), ('wedding', 'final_song', 'closing', 2), ('wedding', 'closing_instructions', 'closing', 3),
    ('simple_party', 'basics', null, 1),
    ('simple_party', 'party', null, 1),
    ('simple_party', 'must_play', 'party', 1), ('simple_party', 'do_not_play', 'party', 2)
  ) as s(starter, key, parent_key, item_position)
  where s.starter = p_starter;
$$;

grant execute on function private.planning_library(), private.starter_planning_items(text) to authenticated, service_role;
revoke execute on function public.planning_library() from public, anon;
grant execute on function public.planning_library() to authenticated;

create function private.planning_error(p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'planning_invalid: %', p_message using errcode = 'invalid_parameter_value';
end;
$$;

-- ===========================================================================
-- Tables
-- ===========================================================================

create table public.planning_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  name text not null
    constraint planning_templates_name_length check (length(btrim(name)) between 1 and 120),
  description text
    constraint planning_templates_description_length check (length(description) <= 1000),
  -- Set only on templates installed from a starter definition (one each).
  starter_key text
    constraint planning_templates_starter_key_valid check (starter_key in ('wedding', 'simple_party')),
  -- Explicit staff setting: used for events of this type booked without a chosen template.
  default_event_type text
    constraint planning_templates_default_event_type_valid check (default_event_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  version integer not null default 1
    constraint planning_templates_version_positive check (version >= 1),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint planning_templates_tenant_starter_key unique (tenant_id, starter_key),
  constraint planning_templates_tenant_id_id_key unique (tenant_id, id),
  constraint planning_templates_archived_not_default check (archived_at is null or default_event_type is null)
);
comment on table public.planning_templates is
  'Reusable planning structure of one business. Structure only: no prices, services or gear. Archived, never deleted.';
create unique index planning_templates_one_default_idx
  on public.planning_templates (tenant_id, default_event_type) where default_event_type is not null;

create table public.planning_template_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  template_id uuid not null,
  kind text not null
    constraint planning_template_items_kind_valid check (kind in ('general', 'stage', 'moment')),
  key text not null
    constraint planning_template_items_key_valid check (private.is_valid_key(key)),
  parent_id uuid,
  label text not null
    constraint planning_template_items_label_length check (length(btrim(label)) between 1 and 120),
  position integer not null
    constraint planning_template_items_position_range check (position between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint planning_template_items_parent_shape check ((kind = 'moment') = (parent_id is not null)),
  constraint planning_template_items_template_fk foreign key (tenant_id, template_id)
    references public.planning_templates (tenant_id, id) on delete cascade,
  constraint planning_template_items_template_key unique (template_id, key),
  constraint planning_template_items_tenant_template_id_key unique (tenant_id, template_id, id),
  constraint planning_template_items_tenant_id_id_key unique (tenant_id, id)
);
alter table public.planning_template_items
  add constraint planning_template_items_parent_fk foreign key (tenant_id, template_id, parent_id)
  references public.planning_template_items (tenant_id, template_id, id) on delete cascade;
comment on table public.planning_template_items is
  'A library item in a template. key comes from private.planning_library() and is unique per template; label is display text.';
create index planning_template_items_parent_idx on public.planning_template_items (tenant_id, template_id, parent_id);

create table public.event_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  event_id uuid not null,
  -- Provenance only. The plan never reads its template again.
  source_template_id uuid,
  source_template_name text,
  source_template_version integer,
  origin text not null
    constraint event_plans_origin_valid check (origin in ('template', 'fallback')),
  initialized_via text not null
    constraint event_plans_initialized_via_valid check (initialized_via in ('booking', 'backfill', 'staff')),
  structure_version integer not null default 1
    constraint event_plans_structure_version_positive check (structure_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_plans_event_key unique (event_id),
  constraint event_plans_event_fk foreign key (tenant_id, event_id)
    references public.events (tenant_id, id) on delete restrict,
  constraint event_plans_template_fk foreign key (tenant_id, source_template_id)
    references public.planning_templates (tenant_id, id) on delete restrict,
  constraint event_plans_tenant_id_id_key unique (tenant_id, id),
  constraint event_plans_origin_matches check ((origin = 'template') = (source_template_id is not null))
);
comment on table public.event_plans is
  'One planning instance per event, copied from a template (or a minimal fallback). Created at booking or by staff.';
create index event_plans_tenant_template_idx on public.event_plans (tenant_id, source_template_id);

create table public.event_plan_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  plan_id uuid not null,
  kind text not null
    constraint event_plan_items_kind_valid check (kind in ('general', 'stage', 'moment')),
  key text not null
    constraint event_plan_items_key_valid check (private.is_valid_key(key)),
  parent_id uuid,
  label text not null
    constraint event_plan_items_label_length check (length(btrim(label)) between 1 and 120),
  position integer not null
    constraint event_plan_items_position_range check (position between 0 and 10000),
  -- Disabled items are hidden from the client and from progress; their
  -- answers are kept and they can be restored.
  disabled_at timestamptz,
  source_template_item_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_plan_items_parent_shape check ((kind = 'moment') = (parent_id is not null)),
  constraint event_plan_items_basics_enabled check (key <> 'basics' or disabled_at is null),
  constraint event_plan_items_plan_fk foreign key (tenant_id, plan_id)
    references public.event_plans (tenant_id, id) on delete restrict,
  constraint event_plan_items_plan_key unique (plan_id, key),
  constraint event_plan_items_tenant_plan_id_key unique (tenant_id, plan_id, id),
  constraint event_plan_items_tenant_id_id_key unique (tenant_id, id)
);
alter table public.event_plan_items
  add constraint event_plan_items_parent_fk foreign key (tenant_id, plan_id, parent_id)
  references public.event_plan_items (tenant_id, plan_id, id) on delete restrict;
comment on table public.event_plan_items is
  'A library item in one event''s plan. Never deleted: disabled and restored, so answers survive.';
create index event_plan_items_parent_idx on public.event_plan_items (tenant_id, plan_id, parent_id);

create table public.event_plan_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  plan_id uuid not null,
  item_id uuid not null,
  schema_version integer not null default 1
    constraint event_plan_responses_schema_version_positive check (schema_version >= 1),
  answers jsonb not null default '{}'::jsonb
    constraint event_plan_responses_answers_object check (jsonb_typeof(answers) = 'object'),
  revision integer not null default 1
    constraint event_plan_responses_revision_positive check (revision >= 1),
  -- Staff-only: never returned to clients.
  updated_by_actor text not null
    constraint event_plan_responses_actor_valid check (updated_by_actor in ('client', 'staff')),
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_plan_responses_item_key unique (item_id),
  constraint event_plan_responses_item_fk foreign key (tenant_id, plan_id, item_id)
    references public.event_plan_items (tenant_id, plan_id, id) on delete restrict,
  constraint event_plan_responses_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.event_plan_responses is
  'Validated answers for one plan item. Written only through the save functions, with a revision check.';
create index event_plan_responses_tenant_plan_idx on public.event_plan_responses (tenant_id, plan_id);

create table public.event_plan_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  plan_id uuid not null,
  source text not null default 'signed_contract_selection'
    constraint event_plan_imports_source_valid check (source = 'signed_contract_selection'),
  contract_id uuid not null,
  proposal_id uuid not null,
  selection_id uuid not null,
  offer_sha256 text not null
    constraint event_plan_imports_offer_sha256_format check (offer_sha256 ~ '^[0-9a-f]{64}$'),
  -- Frozen questions of that proposal (key, prompt, answer_type, options, required).
  questions jsonb not null
    constraint event_plan_imports_questions_array check (jsonb_typeof(questions) = 'array'),
  -- The submitted answers of that selection, keyed by question key.
  answers jsonb not null
    constraint event_plan_imports_answers_object check (jsonb_typeof(answers) = 'object'),
  captured_at timestamptz not null default now(),
  constraint event_plan_imports_plan_contract_key unique (plan_id, contract_id),
  constraint event_plan_imports_plan_fk foreign key (tenant_id, plan_id)
    references public.event_plans (tenant_id, id) on delete restrict,
  constraint event_plan_imports_contract_fk foreign key (tenant_id, contract_id)
    references public.contracts (tenant_id, id) on delete restrict,
  constraint event_plan_imports_proposal_fk foreign key (tenant_id, proposal_id)
    references public.proposals (tenant_id, id) on delete restrict,
  constraint event_plan_imports_selection_fk foreign key (tenant_id, selection_id)
    references public.proposal_selections (tenant_id, id) on delete restrict,
  constraint event_plan_imports_tenant_id_id_key unique (tenant_id, id)
);
comment on table public.event_plan_imports is
  'Immutable copy of the frozen proposal questions and submitted answers behind the signed contract, with provenance.';
create index event_plan_imports_tenant_contract_idx on public.event_plan_imports (tenant_id, contract_id);
create index event_plan_imports_tenant_proposal_idx on public.event_plan_imports (tenant_id, proposal_id);
create index event_plan_imports_tenant_selection_idx on public.event_plan_imports (tenant_id, selection_id);

-- ===========================================================================
-- Triggers
-- ===========================================================================

create trigger planning_templates_set_updated_at before update on public.planning_templates
  for each row execute function private.set_updated_at();
create trigger planning_templates_immutable before update on public.planning_templates
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'starter_key', 'created_at');

create trigger planning_template_items_set_updated_at before update on public.planning_template_items
  for each row execute function private.set_updated_at();
create trigger planning_template_items_immutable before update on public.planning_template_items
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'template_id', 'kind', 'key', 'parent_id', 'created_at');

create trigger event_plans_set_updated_at before update on public.event_plans
  for each row execute function private.set_updated_at();
create trigger event_plans_immutable before update on public.event_plans
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'event_id', 'initialized_via', 'created_at');
create trigger event_plans_no_delete before delete on public.event_plans
  for each row execute function private.reject_change();

create trigger event_plan_items_set_updated_at before update on public.event_plan_items
  for each row execute function private.set_updated_at();
create trigger event_plan_items_immutable before update on public.event_plan_items
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'plan_id', 'kind', 'key', 'source_template_item_id', 'created_at');
create trigger event_plan_items_no_delete before delete on public.event_plan_items
  for each row execute function private.reject_change();

create trigger event_plan_responses_set_updated_at before update on public.event_plan_responses
  for each row execute function private.set_updated_at();
create trigger event_plan_responses_immutable before update on public.event_plan_responses
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'plan_id', 'item_id', 'created_at');
create trigger event_plan_responses_no_delete before delete on public.event_plan_responses
  for each row execute function private.reject_change();

create trigger event_plan_imports_immutable before update or delete on public.event_plan_imports
  for each row execute function private.reject_change();

-- Every item is a library item of the right kind; a moment sits under a stage
-- it is allowed in, in the same template or plan.
create function private.planning_item_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lib record;
  v_parent_kind text;
  v_parent_key text;
begin
  select l.kind, l.parent_keys into v_lib from private.planning_library() l where l.key = new.key;
  if not found or v_lib.kind <> new.kind then
    raise exception 'planning item % is not a % in the library', new.key, new.kind using errcode = 'check_violation';
  end if;
  if new.kind = 'moment' then
    if tg_table_name = 'planning_template_items' then
      select p.kind, p.key into v_parent_kind, v_parent_key from public.planning_template_items p
      where p.tenant_id = new.tenant_id and p.template_id = new.template_id and p.id = new.parent_id;
    else
      select p.kind, p.key into v_parent_kind, v_parent_key from public.event_plan_items p
      where p.tenant_id = new.tenant_id and p.plan_id = new.plan_id and p.id = new.parent_id;
    end if;
    if v_parent_kind is distinct from 'stage' or not (v_parent_key = any (v_lib.parent_keys)) then
      raise exception 'planning moment % cannot be placed under %', new.key, coalesce(v_parent_key, 'nothing')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.planning_item_check() from public, anon, authenticated;
create trigger planning_template_items_check before insert or update on public.planning_template_items
  for each row execute function private.planning_item_check();
create trigger event_plan_items_check before insert or update on public.event_plan_items
  for each row execute function private.planning_item_check();

-- ===========================================================================
-- Privileges and RLS: staff of the business read; nobody writes directly.
-- ===========================================================================

revoke all on public.planning_templates, public.planning_template_items, public.event_plans,
  public.event_plan_items, public.event_plan_responses, public.event_plan_imports from anon, authenticated;
grant select on public.planning_templates, public.planning_template_items, public.event_plans,
  public.event_plan_items, public.event_plan_responses, public.event_plan_imports to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['planning_templates', 'planning_template_items', 'event_plans', 'event_plan_items',
                           'event_plan_responses', 'event_plan_imports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (tenant_id in (select private.member_tenant_ids()))', t || '_select_staff', t);
  end loop;
end;
$$;

-- ===========================================================================
-- Template functions (staff)
-- ===========================================================================

-- Locks a template for an edit by staff of its business, checking the version
-- (stale tabs get a conflict) and that it is not archived.
create function private.lock_planning_template(p_template_id uuid, p_expected_version integer)
returns public.planning_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.planning_templates%rowtype;
begin
  select * into t from public.planning_templates where id = p_template_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(t.tenant_id);
  select * into t from public.planning_templates where id = t.id for update;
  if p_expected_version is null or t.version <> p_expected_version then
    raise exception 'planning template was changed elsewhere' using errcode = 'serialization_failure';
  end if;
  if t.archived_at is not null then
    perform private.planning_error('this template is archived. Unarchive it before editing');
  end if;
  return t;
end;
$$;

create function private.bump_planning_template(p_template_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.planning_templates set version = version + 1 where id = p_template_id returning version;
$$;

-- Dense positions 1..n among siblings (same parent; top level split by kind).
create function private.renumber_template_siblings(p_template_id uuid, p_parent_id uuid, p_kind text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.planning_template_items i set position = r.rn
  from (select s.id, row_number() over (order by s.position, s.id)::int as rn
        from public.planning_template_items s
        where s.template_id = p_template_id and s.kind = p_kind and s.parent_id is not distinct from p_parent_id) r
  where i.id = r.id and i.position <> r.rn;
$$;

create function private.planning_label(p_label text)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_label is null or length(btrim(p_label)) not between 1 and 120 then
    perform private.planning_error('labels need 1 to 120 characters');
  end if;
  return btrim(p_label);
end;
$$;

create function private.planning_template_details(p_name text, p_description text)
returns table (name text, description text)
language plpgsql
set search_path = ''
as $$
begin
  if p_name is null or length(btrim(p_name)) not between 1 and 120 then
    perform private.planning_error('the name needs 1 to 120 characters');
  end if;
  if p_description is not null and length(btrim(p_description)) > 1000 then
    perform private.planning_error('the description is limited to 1,000 characters');
  end if;
  name := btrim(p_name);
  description := nullif(btrim(coalesce(p_description, '')), '');
  return next;
end;
$$;

create function public.create_planning_template(p_tenant_id uuid, p_name text, p_description text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_id uuid;
begin
  perform private.require_staff_of(p_tenant_id);
  select * into d from private.planning_template_details(p_name, p_description);
  insert into public.planning_templates (tenant_id, name, description) values (p_tenant_id, d.name, d.description)
  returning id into v_id;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position)
  select p_tenant_id, v_id, l.kind, l.key, l.default_label, 1 from private.planning_library() l where l.key = 'basics';
  perform private.audit(p_tenant_id, 'planning_template', v_id, 'created', 'staff', (select auth.uid()), '{}'::jsonb);
  return v_id;
end;
$$;

-- Adds the starter templates the business doesn't have yet. Idempotent and
-- safe to run concurrently: one template per starter key per business. A
-- starter that was archived is left archived (unarchive it instead).
create function public.install_starter_planning_templates(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_starter text;
  v_id uuid;
  v_created text[] := '{}'::text[];
  v_existing text[] := '{}'::text[];
begin
  perform private.require_staff_of(p_tenant_id);
  foreach v_starter in array array['wedding', 'simple_party'] loop
    v_id := null;
    insert into public.planning_templates (tenant_id, name, description, starter_key)
    values (p_tenant_id,
      case v_starter when 'wedding' then 'Wedding' else 'Simple Party' end,
      case v_starter
        when 'wedding' then 'Ceremony to closing, in the order of the day. Rename or remove anything a couple doesn''t need.'
        else 'Event basics plus must-play and do-not-play songs. For birthdays and other simple parties.' end,
      v_starter)
    on conflict (tenant_id, starter_key) do nothing
    returning id into v_id;
    if v_id is null then
      v_existing := v_existing || v_starter;
      continue;
    end if;
    insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position)
    select p_tenant_id, v_id, l.kind, l.key, l.default_label, s.item_position
    from private.starter_planning_items(v_starter) s
    join private.planning_library() l on l.key = s.key
    where s.parent_key is null;
    insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position)
    select p_tenant_id, v_id, l.kind, l.key, p.id, l.default_label, s.item_position
    from private.starter_planning_items(v_starter) s
    join private.planning_library() l on l.key = s.key
    join public.planning_template_items p on p.template_id = v_id and p.key = s.parent_key
    where s.parent_key is not null;
    perform private.audit(p_tenant_id, 'planning_template', v_id, 'starter_installed', 'staff', (select auth.uid()),
      jsonb_build_object('starter', v_starter));
    v_created := v_created || v_starter;
  end loop;
  return jsonb_build_object('created', to_jsonb(v_created), 'existing', to_jsonb(v_existing));
end;
$$;

create function public.update_planning_template(
  p_template_id uuid, p_expected_version integer, p_name text, p_description text, p_default_event_type text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.planning_templates%rowtype;
  d record;
  v_type text := nullif(btrim(coalesce(p_default_event_type, '')), '');
begin
  t := private.lock_planning_template(p_template_id, p_expected_version);
  select * into d from private.planning_template_details(p_name, p_description);
  if v_type is not null and v_type !~ '^[a-z][a-z0-9_]{0,39}$' then
    perform private.planning_error('choose an event type from the list');
  end if;
  if v_type is not null and exists (
    select 1 from public.planning_templates o
    where o.tenant_id = t.tenant_id and o.default_event_type = v_type and o.id <> t.id) then
    perform private.planning_error('another template is already the default for that event type. Clear it there first');
  end if;
  update public.planning_templates
    set name = d.name, description = d.description, default_event_type = v_type, version = version + 1
    where id = t.id returning * into t;
  return t.version;
end;
$$;

create function public.duplicate_planning_template(p_template_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.planning_templates%rowtype;
  d record;
  v_id uuid;
begin
  select * into t from public.planning_templates where id = p_template_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(t.tenant_id);
  select * into d from private.planning_template_details(p_name, t.description);
  insert into public.planning_templates (tenant_id, name, description) values (t.tenant_id, d.name, d.description)
  returning id into v_id;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position)
  select i.tenant_id, v_id, i.kind, i.key, i.label, i.position
  from public.planning_template_items i where i.template_id = t.id and i.parent_id is null;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position)
  select i.tenant_id, v_id, i.kind, i.key, np.id, i.label, i.position
  from public.planning_template_items i
  join public.planning_template_items op on op.id = i.parent_id
  join public.planning_template_items np on np.template_id = v_id and np.key = op.key
  where i.template_id = t.id and i.parent_id is not null;
  perform private.audit(t.tenant_id, 'planning_template', v_id, 'duplicated', 'staff', (select auth.uid()),
    jsonb_build_object('from_template_id', t.id));
  return v_id;
end;
$$;

-- Archiving keeps the template (plans copied from it are unaffected) and
-- clears its event-type default. Unarchiving makes it selectable again.
create function public.set_planning_template_archived(p_template_id uuid, p_archived boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.planning_templates%rowtype;
begin
  select * into t from public.planning_templates where id = p_template_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(t.tenant_id);
  select * into t from public.planning_templates where id = t.id for update;
  if coalesce(p_archived, false) = (t.archived_at is not null) then
    return t.version;
  end if;
  update public.planning_templates
    set archived_at = case when p_archived then now() end,
        default_event_type = case when p_archived then null else default_event_type end,
        version = version + 1
    where id = t.id returning * into t;
  perform private.audit(t.tenant_id, 'planning_template', t.id, case when p_archived then 'archived' else 'unarchived' end,
    'staff', (select auth.uid()), '{}'::jsonb);
  return t.version;
end;
$$;

create function public.add_planning_template_item(p_template_id uuid, p_expected_version integer, p_key text, p_parent_key text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.planning_templates%rowtype;
  v_lib record;
  v_parent public.planning_template_items%rowtype;
begin
  t := private.lock_planning_template(p_template_id, p_expected_version);
  select * into v_lib from private.planning_library() l where l.key = p_key;
  if not found then
    perform private.planning_error('choose an item from the library');
  end if;
  if exists (select 1 from public.planning_template_items i where i.template_id = t.id and i.key = p_key) then
    perform private.planning_error('this item is already in the template');
  end if;
  if v_lib.kind = 'moment' then
    select * into v_parent from public.planning_template_items i where i.template_id = t.id and i.key = p_parent_key and i.kind = 'stage';
    if not found or not (p_parent_key = any (v_lib.parent_keys)) then
      perform private.planning_error('add the moment to a stage it belongs to');
    end if;
  end if;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position)
  values (t.tenant_id, t.id, v_lib.kind, v_lib.key, v_parent.id, v_lib.default_label,
    (select coalesce(max(s.position), 0) + 1 from public.planning_template_items s
     where s.template_id = t.id and s.kind = v_lib.kind and s.parent_id is not distinct from v_parent.id));
  return private.bump_planning_template(t.id);
end;
$$;

create function public.rename_planning_template_item(p_item_id uuid, p_expected_version integer, p_label text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.planning_template_items%rowtype;
  t public.planning_templates%rowtype;
begin
  select * into i from public.planning_template_items where id = p_item_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  t := private.lock_planning_template(i.template_id, p_expected_version);
  update public.planning_template_items set label = private.planning_label(p_label) where id = i.id;
  return private.bump_planning_template(t.id);
end;
$$;

create function public.move_planning_template_item(p_item_id uuid, p_expected_version integer, p_direction text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.planning_template_items%rowtype;
  t public.planning_templates%rowtype;
  v_other public.planning_template_items%rowtype;
begin
  select * into i from public.planning_template_items where id = p_item_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  t := private.lock_planning_template(i.template_id, p_expected_version);
  if p_direction is null or p_direction not in ('up', 'down') then
    perform private.planning_error('move up or down');
  end if;
  if i.kind = 'general' then
    perform private.planning_error('general sections keep their order; only stages and moments move');
  end if;
  perform private.renumber_template_siblings(t.id, i.parent_id, i.kind);
  select * into i from public.planning_template_items where id = i.id;
  select * into v_other from public.planning_template_items s
  where s.template_id = t.id and s.kind = i.kind and s.parent_id is not distinct from i.parent_id
    and case when p_direction = 'up' then s.position < i.position else s.position > i.position end
  order by case when p_direction = 'up' then -s.position else s.position end
  limit 1;
  if not found then
    perform private.planning_error(case when p_direction = 'up' then 'this item is already first' else 'this item is already last' end);
  end if;
  update public.planning_template_items set position = v_other.position where id = i.id;
  update public.planning_template_items set position = i.position where id = v_other.id;
  return private.bump_planning_template(t.id);
end;
$$;

-- Removes an item from the template (a stage takes its moments with it).
-- Plans already copied from the template keep theirs.
create function public.remove_planning_template_item(p_item_id uuid, p_expected_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.planning_template_items%rowtype;
  t public.planning_templates%rowtype;
begin
  select * into i from public.planning_template_items where id = p_item_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  t := private.lock_planning_template(i.template_id, p_expected_version);
  if i.key = 'basics' then
    perform private.planning_error('Event basics is part of every template');
  end if;
  delete from public.planning_template_items where id = i.id;
  perform private.renumber_template_siblings(t.id, i.parent_id, i.kind);
  return private.bump_planning_template(t.id);
end;
$$;

-- ===========================================================================
-- Event plans: initialization and imports
-- ===========================================================================

-- Copies the frozen questions and submitted answers behind the event's signed
-- contract into the plan, once per contract. Never reads the catalog.
create function private.capture_plan_import(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.event_plans%rowtype;
  c public.contracts%rowtype;
begin
  select * into v_plan from public.event_plans where id = p_plan_id;
  select k.* into c from public.contracts k
  where k.tenant_id = v_plan.tenant_id and k.event_id = v_plan.event_id and k.status = 'signed'
  order by k.signed_at desc limit 1;
  if not found then
    return;
  end if;
  insert into public.event_plan_imports (tenant_id, plan_id, contract_id, proposal_id, selection_id, offer_sha256, questions, answers)
  select c.tenant_id, v_plan.id, c.id, p.id, s.id, p.offer_sha256,
         coalesce(p.offer_snapshot -> 'questions', '[]'::jsonb), s.logistics_answers
  from public.proposals p
  join public.proposal_selections s on s.tenant_id = p.tenant_id and s.proposal_id = p.id and s.id = c.selection_id
  where p.tenant_id = c.tenant_id and p.id = c.proposal_id
  on conflict (plan_id, contract_id) do nothing;
end;
$$;

-- Copies a template's items into an (empty) plan.
create function private.copy_template_into_plan(p_template_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.event_plans where id = p_plan_id;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, label, position, source_template_item_id)
  select v_tenant, p_plan_id, ti.kind, ti.key, ti.label, ti.position, ti.id
  from public.planning_template_items ti
  where ti.tenant_id = v_tenant and ti.template_id = p_template_id and ti.parent_id is null;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, parent_id, label, position, source_template_item_id)
  select v_tenant, p_plan_id, ti.kind, ti.key, pi.id, ti.label, ti.position, ti.id
  from public.planning_template_items ti
  join public.planning_template_items tp on tp.id = ti.parent_id
  join public.event_plan_items pi on pi.plan_id = p_plan_id and pi.key = tp.key
  where ti.tenant_id = v_tenant and ti.template_id = p_template_id and ti.parent_id is not null;
  -- Every plan has Event basics.
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, label, position)
  select v_tenant, p_plan_id, l.kind, l.key, l.default_label, 0 from private.planning_library() l
  where l.key = 'basics' and not exists (select 1 from public.event_plan_items i where i.plan_id = p_plan_id and i.key = 'basics');
end;
$$;

-- Creates the event's plan if it has none, then records imports. Idempotent:
-- an existing plan is returned untouched. Locks the event first (callers in
-- the booking transaction already hold it), so concurrent calls create one.
-- p_template_id: the template staff chose, or null (event-type default, else
-- the Event basics fallback).
create function private.ensure_event_plan(p_event_id uuid, p_template_id uuid, p_via text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
  v_template public.planning_templates%rowtype;
begin
  select * into e from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  if not found then
    if p_template_id is not null then
      select * into v_template from public.planning_templates t where t.tenant_id = e.tenant_id and t.id = p_template_id;
      if not found then
        raise exception 'not found' using errcode = 'no_data_found';
      end if;
      if v_template.archived_at is not null then
        perform private.planning_error('this template is archived. Unarchive it or choose another');
      end if;
    else
      select * into v_template from public.planning_templates t
      where t.tenant_id = e.tenant_id and t.archived_at is null and t.default_event_type = e.event_type;
    end if;
    insert into public.event_plans (tenant_id, event_id, source_template_id, source_template_name, source_template_version,
                                    origin, initialized_via)
    values (e.tenant_id, e.id, v_template.id, v_template.name, v_template.version,
            case when v_template.id is null then 'fallback' else 'template' end, p_via)
    on conflict (event_id) do nothing
    returning * into v_plan;
    if v_plan.id is null then
      select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
    else
      perform private.copy_template_into_plan(v_template.id, v_plan.id);
      perform private.audit(e.tenant_id, 'event', e.id, 'planning_initialized', case when p_via = 'staff' then 'staff' else 'system' end,
        case when p_via = 'staff' then (select auth.uid()) end,
        jsonb_build_object('plan_id', v_plan.id, 'origin', v_plan.origin, 'template_id', v_template.id, 'via', p_via));
    end if;
  end if;
  perform private.capture_plan_import(v_plan.id);
  return v_plan.id;
end;
$$;

-- Booking initializes planning in the same transaction. Only
-- private.evaluate_booking sets booking_confirmed_at, under the event lock.
create function private.events_initialize_planning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.booking_confirmed_at is not null and old.booking_confirmed_at is null then
    perform private.ensure_event_plan(new.id, null, 'booking');
  end if;
  return null;
end;
$$;
create trigger events_initialize_planning after update of booking_confirmed_at on public.events
  for each row execute function private.events_initialize_planning();

-- ===========================================================================
-- Event basics: validation and requirements
-- ===========================================================================

-- Validates and normalizes Event basics answers (schema version 1). Fields
-- are optional for saving; completeness is a separate question. Returns
-- {"ok":true,"answers":{...}} or {"ok":false,"field":...,"message":...}.
--   guest_count            integer 1..5000
--   start_time, end_time   "HH:MM" local time; an end earlier than the start
--                          means after midnight; equal times are refused
--   venue_details          where the event is, when the event has no venue yet
--   venue_room             room or space within the venue
--   access_notes           parking, loading and access for the DJ
--   access_notes_none      true: explicitly no special instructions
--   announcement_language  french | english | bilingual | other
create function private.normalize_plan_basics(p_answers jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  a jsonb := '{}'::jsonb;
  v jsonb;
  k text;
  s text;
  v_limit int;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if k not in ('guest_count', 'start_time', 'end_time', 'venue_details', 'venue_room', 'access_notes', 'access_notes_none',
                 'announcement_language') then
      return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
    end if;
  end loop;

  v := p_answers -> 'guest_count';
  if v is not null and jsonb_typeof(v) <> 'null' then
    if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,4}$' or (v #>> '{}')::int not between 1 and 5000 then
      return jsonb_build_object('ok', false, 'field', 'guest_count', 'message', 'Enter a guest count between 1 and 5,000.');
    end if;
    a := a || jsonb_build_object('guest_count', (v #>> '{}')::int);
  end if;

  foreach k in array array['start_time', 'end_time'] loop
    v := p_answers -> k;
    if v is not null and jsonb_typeof(v) <> 'null' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        return jsonb_build_object('ok', false, 'field', k, 'message', 'Enter a time such as 18:30.');
      end if;
      a := a || jsonb_build_object(k, v #>> '{}');
    end if;
  end loop;
  if a ? 'start_time' and a ? 'end_time' and a ->> 'start_time' = a ->> 'end_time' then
    return jsonb_build_object('ok', false, 'field', 'end_time', 'message', 'The end time must differ from the start time.');
  end if;

  foreach k in array array['venue_details', 'venue_room', 'access_notes'] loop
    v := p_answers -> k;
    if v is not null and jsonb_typeof(v) <> 'null' then
      if jsonb_typeof(v) <> 'string' then
        return jsonb_build_object('ok', false, 'field', k, 'message', 'Reload the page and try again.');
      end if;
      s := btrim(v #>> '{}');
      v_limit := case k when 'venue_room' then 200 when 'venue_details' then 500 else 2000 end;
      if length(s) > v_limit then
        return jsonb_build_object('ok', false, 'field', k, 'message',
          'Keep this under ' || to_char(v_limit, 'FM9,999') || ' characters.');
      end if;
      if s <> '' then
        a := a || jsonb_build_object(k, s);
      end if;
    end if;
  end loop;

  v := p_answers -> 'access_notes_none';
  if v is not null and jsonb_typeof(v) <> 'null' then
    if jsonb_typeof(v) <> 'boolean' then
      return jsonb_build_object('ok', false, 'field', 'access_notes_none', 'message', 'Reload the page and try again.');
    end if;
    if v = 'true'::jsonb then
      if a ? 'access_notes' then
        return jsonb_build_object('ok', false, 'field', 'access_notes',
          'message', 'Describe the access details or choose "No special instructions", not both.');
      end if;
      a := a || jsonb_build_object('access_notes_none', true);
    end if;
  end if;

  v := p_answers -> 'announcement_language';
  if v is not null and jsonb_typeof(v) <> 'null' then
    if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('french', 'english', 'bilingual', 'other') then
      return jsonb_build_object('ok', false, 'field', 'announcement_language', 'message', 'Choose a language from the list.');
    end if;
    a := a || jsonb_build_object('announcement_language', v #>> '{}');
  end if;

  return jsonb_build_object('ok', true, 'answers', a);
end;
$$;

-- What Event basics needs to be complete. Each requirement is
--   answered        saved in planning
--   imported        supplied by the event's own details (staff-entered venue)
--   not_applicable  explicitly not needed (counts as done; differs from unanswered)
--   unanswered
create function private.plan_basics_requirements(p_answers jsonb, p_event_venue_name text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_array(
    jsonb_build_object('key', 'guest_count', 'state', case when a ? 'guest_count' then 'answered' else 'unanswered' end),
    jsonb_build_object('key', 'start_time', 'state', case when a ? 'start_time' then 'answered' else 'unanswered' end),
    jsonb_build_object('key', 'end_time', 'state', case when a ? 'end_time' then 'answered' else 'unanswered' end),
    jsonb_build_object('key', 'venue', 'state', case when p_event_venue_name is not null then 'imported'
                                                     when a ? 'venue_details' then 'answered' else 'unanswered' end),
    jsonb_build_object('key', 'access', 'state', case when a ? 'access_notes' then 'answered'
                                                      when a ? 'access_notes_none' then 'not_applicable' else 'unanswered' end))
  from (select coalesce(p_answers, '{}'::jsonb) as a) x;
$$;

grant execute on function private.normalize_plan_basics(jsonb), private.plan_basics_requirements(jsonb, text),
  private.planning_label(text), private.planning_template_details(text, text), private.planning_error(text)
  to authenticated, service_role;

-- ===========================================================================
-- Progress
-- ===========================================================================

-- Progress over enabled items whose editor exists. Items without an editor
-- are reported as not_available and excluded from the percentage. The
-- next editors add their own requirement branches here.
create function private.plan_progress(p_plan_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.event_plans%rowtype;
  v_venue text;
  r record;
  v_req jsonb;
  v_items jsonb := '[]'::jsonb;
  v_state text;
  v_item_total int;
  v_item_met int;
  v_total int := 0;
  v_met int := 0;
  v_available int := 0;
  v_complete int := 0;
  v_unavailable int := 0;
begin
  select * into v_plan from public.event_plans where id = p_plan_id;
  select e.venue_name into v_venue from public.events e where e.tenant_id = v_plan.tenant_id and e.id = v_plan.event_id;
  for r in
    select i.id, i.key, l.editor, resp.answers
    from public.event_plan_items i
    join private.planning_library() l on l.key = i.key
    left join public.event_plan_items p on p.tenant_id = i.tenant_id and p.plan_id = i.plan_id and p.id = i.parent_id
    left join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.disabled_at is null and (p.id is null or p.disabled_at is null)
    order by l.library_order
  loop
    if r.editor = 'basics' then
      v_req := private.plan_basics_requirements(r.answers, v_venue);
      select count(*)::int, (count(*) filter (where x ->> 'state' <> 'unanswered'))::int into v_item_total, v_item_met
      from jsonb_array_elements(v_req) x;
      v_state := case when v_item_met = v_item_total then 'complete'
                      when coalesce(r.answers, '{}'::jsonb) <> '{}'::jsonb then 'in_progress'
                      else 'not_started' end;
      v_total := v_total + v_item_total;
      v_met := v_met + v_item_met;
      v_available := v_available + 1;
      v_complete := v_complete + case when v_state = 'complete' then 1 else 0 end;
    else
      v_req := '[]'::jsonb;
      v_item_total := 0;
      v_item_met := 0;
      v_state := 'not_available';
      v_unavailable := v_unavailable + 1;
    end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_id', r.id, 'key', r.key, 'state', v_state, 'requirements', v_req, 'met', v_item_met, 'total', v_item_total));
  end loop;
  return jsonb_build_object(
    'scope', 'available_sections_only',
    'items', v_items,
    'requirements_total', v_total,
    'requirements_met', v_met,
    'percent', case when v_total = 0 then null else (v_met * 100) / v_total end,
    'available_sections', v_available,
    'complete_sections', v_complete,
    'unavailable_sections', v_unavailable);
end;
$$;

-- The plan's structure as JSON: general sections and stages (with moments) in
-- order. Clients get enabled items only; staff also get disabled ones.
create function private.plan_structure(p_plan_id uuid, p_include_disabled boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'general', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'key', g.key, 'label', g.label, 'editor', l.editor, 'removable', l.removable,
                                          'disabled', g.disabled_at is not null) order by g.position, g.id)
      from public.event_plan_items g join private.planning_library() l on l.key = g.key
      where g.plan_id = p_plan_id and g.kind = 'general' and (p_include_disabled or g.disabled_at is null)), '[]'::jsonb),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'label', s.label, 'disabled', s.disabled_at is not null,
        'moments', coalesce((
          select jsonb_agg(jsonb_build_object('id', m.id, 'key', m.key, 'label', m.label, 'editor', ml.editor,
                                              'disabled', m.disabled_at is not null) order by m.position, m.id)
          from public.event_plan_items m join private.planning_library() ml on ml.key = m.key
          where m.plan_id = p_plan_id and m.parent_id = s.id and (p_include_disabled or m.disabled_at is null)), '[]'::jsonb))
        order by s.position, s.id)
      from public.event_plan_items s
      where s.plan_id = p_plan_id and s.kind = 'stage' and (p_include_disabled or s.disabled_at is null)), '[]'::jsonb));
$$;

create function private.plan_latest_import(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('captured_at', i.captured_at, 'questions', i.questions, 'answers', i.answers)
  from public.event_plan_imports i where i.plan_id = p_plan_id
  order by i.captured_at desc limit 1;
$$;

-- ===========================================================================
-- Client access
-- ===========================================================================

-- Whether the signed-in user may open the event's planning now: verified,
-- active event access, booked (payment corrections never unbook), nothing
-- archived, and a plan exists.
create function private.client_can_access_plan(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.events e
    join public.tenants t on t.id = e.tenant_id
    join public.event_plans p on p.tenant_id = e.tenant_id and p.event_id = e.id
    where e.id = p_event_id
      and e.id in (select private.client_event_ids())
      and e.archived_at is null and t.archived_at is null
      and e.booking_confirmed_at is not null and e.lifecycle_status in ('booked', 'completed')
  );
$$;

-- The client's planning: safe event details, enabled structure, Event basics
-- answers, frozen imported answers and progress. Never internal notes,
-- payments, staff identities, disabled items or template details.
create function public.client_planning_view(p_event_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  t public.tenants%rowtype;
  v_plan public.event_plans%rowtype;
  v_basics record;
begin
  select ev.* into e from public.events ev join public.tenants tt on tt.id = ev.tenant_id
  where ev.id = p_event_id and tt.slug = p_tenant_slug;
  if not found or not private.client_can_access_plan(e.id) then
    return jsonb_build_object('state', 'unavailable');
  end if;
  select * into t from public.tenants where id = e.tenant_id;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  select i.id, r.answers, r.revision into v_basics
  from public.event_plan_items i left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = v_plan.id and i.key = 'basics';
  return jsonb_build_object(
    'state', 'available',
    'brand', jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors),
    'event', jsonb_build_object('id', e.id, 'title', e.title, 'event_type', e.event_type, 'event_date', e.event_date,
                                'timezone', e.timezone, 'venue_name', e.venue_name, 'venue_address', e.venue_address),
    'structure', private.plan_structure(v_plan.id, false),
    'basics', jsonb_build_object('item_id', v_basics.id, 'answers', coalesce(v_basics.answers, '{}'::jsonb),
                                 'revision', coalesce(v_basics.revision, 0)),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

-- Planning the signed-in client can open (client home).
create function public.my_plans()
returns table (tenant_slug text, tenant_display_name text, event_id uuid, event_title text, event_date date, contract_id uuid,
               requirements_total integer, requirements_met integer)
language sql
stable
security definer
set search_path = ''
as $$
  select t.slug, t.display_name, e.id, e.title, e.event_date,
         (select k.id from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed'
          order by k.signed_at desc limit 1),
         (x.progress ->> 'requirements_total')::int, (x.progress ->> 'requirements_met')::int
  from public.event_plans p
  join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  join public.tenants t on t.id = e.tenant_id
  cross join lateral (select private.plan_progress(p.id) as progress) x
  where e.id in (select private.client_event_ids()) and private.client_can_access_plan(e.id)
  order by e.event_date, e.id;
$$;

-- ===========================================================================
-- Saving Event basics (clients and staff)
-- ===========================================================================

-- Saves the plan's Event basics with an optimistic revision (0 = never
-- saved). The caller has locked the event (share) and the plan (update).
-- Returns {"status":"saved","revision","answers","progress"},
-- {"status":"conflict"} or {"status":"invalid","field","message"}.
create function private.save_plan_basics(p_plan_id uuid, p_expected_revision integer, p_answers jsonb, p_actor text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.event_plan_items%rowtype;
  v_resp public.event_plan_responses%rowtype;
  v_norm jsonb;
begin
  select * into v_item from public.event_plan_items where plan_id = p_plan_id and key = 'basics';
  v_norm := private.normalize_plan_basics(p_answers);
  if not (v_norm ->> 'ok')::boolean then
    return jsonb_build_object('status', 'invalid', 'field', v_norm -> 'field', 'message', v_norm ->> 'message');
  end if;
  select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
  if not found then
    if p_expected_revision is distinct from 0 then
      return jsonb_build_object('status', 'conflict');
    end if;
    insert into public.event_plan_responses (tenant_id, plan_id, item_id, answers, updated_by_actor, updated_by_user_id)
    values (v_item.tenant_id, p_plan_id, v_item.id, v_norm -> 'answers', p_actor, p_user_id)
    on conflict (item_id) do nothing
    returning * into v_resp;
    if v_resp.id is null then
      return jsonb_build_object('status', 'conflict');
    end if;
  else
    if p_expected_revision is distinct from v_resp.revision then
      return jsonb_build_object('status', 'conflict');
    end if;
    update public.event_plan_responses
      set answers = v_norm -> 'answers', revision = revision + 1, updated_by_actor = p_actor, updated_by_user_id = p_user_id
      where id = v_resp.id returning * into v_resp;
  end if;
  return jsonb_build_object('status', 'saved', 'revision', v_resp.revision, 'answers', v_resp.answers,
                            'progress', private.plan_progress(p_plan_id));
end;
$$;

-- Client save, with the client's own session. Same access rule as the view.
create function public.client_save_plan_basics(p_event_id uuid, p_tenant_slug text, p_expected_revision integer, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
begin
  if (select auth.uid()) is null then
    return jsonb_build_object('status', 'signed_out');
  end if;
  select ev.* into e from public.events ev join public.tenants tt on tt.id = ev.tenant_id
  where ev.id = p_event_id and tt.slug = p_tenant_slug;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;
  -- Lock order: event, then plan. Archiving waits for this save, or this
  -- save sees the archive.
  select * into e from public.events where id = e.id for share;
  if not private.client_can_access_plan(e.id) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id for update;
  return private.save_plan_basics(v_plan.id, p_expected_revision, p_answers, 'client', (select auth.uid()));
end;
$$;

-- ===========================================================================
-- Staff: plan setup, structure and Event basics
-- ===========================================================================

-- Locks an event's plan for staff: membership, not archived, plan exists,
-- expected structure version. Lock order: event (share), then plan.
create function private.lock_plan_for_staff(p_event_id uuid, p_expected_version integer)
returns public.event_plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  p public.event_plans%rowtype;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = e.id for share;
  if e.archived_at is not null then
    perform private.planning_error('the event is archived. Unarchive it before changing its planning');
  end if;
  select * into p from public.event_plans where tenant_id = e.tenant_id and event_id = e.id for update;
  if not found then
    perform private.planning_error('planning isn''t set up for this event yet');
  end if;
  if p_expected_version is not null and p.structure_version <> p_expected_version then
    raise exception 'planning structure was changed elsewhere' using errcode = 'serialization_failure';
  end if;
  return p;
end;
$$;

create function private.bump_plan_structure(p_plan_id uuid, p_op text, p_item_key text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
begin
  update public.event_plans set structure_version = structure_version + 1 where id = p_plan_id returning * into p;
  perform private.audit(p.tenant_id, 'event', p.event_id, 'planning_structure_changed', 'staff', (select auth.uid()),
    jsonb_build_object('plan_id', p.id, 'op', p_op, 'key', p_item_key));
  return p.structure_version;
end;
$$;

create function private.renumber_plan_siblings(p_plan_id uuid, p_parent_id uuid, p_kind text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.event_plan_items i set position = r.rn
  from (select s.id, row_number() over (order by s.position, s.id)::int as rn
        from public.event_plan_items s
        where s.plan_id = p_plan_id and s.kind = p_kind and s.parent_id is not distinct from p_parent_id) r
  where i.id = r.id and i.position <> r.rn;
$$;

-- Sets planning up now (before booking if useful), from the chosen template
-- or, with none, the event-type default or Event basics. Idempotent: an
-- existing plan is returned unchanged ({"status":"exists"}); use
-- apply_event_plan_template to change it.
create function public.setup_event_plan(p_event_id uuid, p_template_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_existing uuid;
  v_plan uuid;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = e.id for update;
  if e.archived_at is not null then
    perform private.planning_error('the event is archived. Unarchive it before changing its planning');
  end if;
  select id into v_existing from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  if v_existing is not null then
    return jsonb_build_object('status', 'exists', 'plan_id', v_existing);
  end if;
  v_plan := private.ensure_event_plan(e.id, p_template_id, 'staff');
  return jsonb_build_object('status', 'created', 'plan_id', v_plan);
end;
$$;

-- Applies a template to an existing plan, explicitly confirmed and without
-- losing answers: items whose key is in the template keep their id and
-- answers and take the template's label, place and order; new ones are added;
-- items the template lacks are disabled (restorable), never deleted.
create function public.apply_event_plan_template(p_event_id uuid, p_template_id uuid, p_expected_version integer, p_confirm boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
  t public.planning_templates%rowtype;
  v_added int := 0;
  v_kept int := 0;
  v_hidden int := 0;
  v_count int;
  g record;
begin
  p := private.lock_plan_for_staff(p_event_id, p_expected_version);
  select * into t from public.planning_templates where tenant_id = p.tenant_id and id = p_template_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if t.archived_at is not null then
    perform private.planning_error('this template is archived. Unarchive it or choose another');
  end if;
  if p_confirm is not true then
    perform private.planning_error('confirm that you want to replace the planning structure');
  end if;

  -- Top level, then moments (their stages exist by then).
  update public.event_plan_items i
    set label = ti.label, position = ti.position, disabled_at = null
    from public.planning_template_items ti
    where ti.template_id = t.id and ti.parent_id is null and i.plan_id = p.id and i.key = ti.key;
  get diagnostics v_count = row_count;
  v_kept := v_kept + v_count;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, label, position, source_template_item_id)
  select p.tenant_id, p.id, ti.kind, ti.key, ti.label, ti.position, ti.id
  from public.planning_template_items ti
  where ti.template_id = t.id and ti.parent_id is null
    and not exists (select 1 from public.event_plan_items i where i.plan_id = p.id and i.key = ti.key);
  get diagnostics v_count = row_count;
  v_added := v_added + v_count;

  update public.event_plan_items i
    set label = ti.label, position = ti.position, disabled_at = null, parent_id = pi.id
    from public.planning_template_items ti
    join public.planning_template_items tp on tp.id = ti.parent_id
    join public.event_plan_items pi on pi.plan_id = p.id and pi.key = tp.key
    where ti.template_id = t.id and i.plan_id = p.id and i.key = ti.key;
  get diagnostics v_count = row_count;
  v_kept := v_kept + v_count;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, parent_id, label, position, source_template_item_id)
  select p.tenant_id, p.id, ti.kind, ti.key, pi.id, ti.label, ti.position, ti.id
  from public.planning_template_items ti
  join public.planning_template_items tp on tp.id = ti.parent_id
  join public.event_plan_items pi on pi.plan_id = p.id and pi.key = tp.key
  where ti.template_id = t.id
    and not exists (select 1 from public.event_plan_items i where i.plan_id = p.id and i.key = ti.key);
  get diagnostics v_count = row_count;
  v_added := v_added + v_count;

  -- Everything else is hidden, after the template's items, in its old order.
  update public.event_plan_items i
    set disabled_at = coalesce(i.disabled_at, now()), position = least(10000, 5000 + i.position)
    where i.plan_id = p.id and i.key <> 'basics'
      and not exists (select 1 from public.planning_template_items ti where ti.template_id = t.id and ti.key = i.key);
  get diagnostics v_hidden = row_count;
  for g in select distinct i.parent_id, i.kind from public.event_plan_items i where i.plan_id = p.id loop
    perform private.renumber_plan_siblings(p.id, g.parent_id, g.kind);
  end loop;

  update public.event_plans
    set source_template_id = t.id, source_template_name = t.name, source_template_version = t.version, origin = 'template',
        structure_version = structure_version + 1
    where id = p.id returning * into p;
  perform private.audit(p.tenant_id, 'event', p.event_id, 'planning_template_applied', 'staff', (select auth.uid()),
    jsonb_build_object('plan_id', p.id, 'template_id', t.id, 'kept', v_kept, 'added', v_added, 'hidden', v_hidden));
  return jsonb_build_object('status', 'applied', 'structure_version', p.structure_version,
                            'kept', v_kept, 'added', v_added, 'hidden', v_hidden);
end;
$$;

-- Adds a library item to the plan, or restores it if it is there but disabled.
create function public.add_event_plan_item(p_event_id uuid, p_expected_version integer, p_key text, p_parent_key text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
  v_lib record;
  v_existing public.event_plan_items%rowtype;
  v_parent public.event_plan_items%rowtype;
begin
  p := private.lock_plan_for_staff(p_event_id, p_expected_version);
  select * into v_lib from private.planning_library() l where l.key = p_key;
  if not found then
    perform private.planning_error('choose an item from the library');
  end if;
  select * into v_existing from public.event_plan_items i where i.plan_id = p.id and i.key = p_key;
  if found then
    if v_existing.disabled_at is null then
      perform private.planning_error('this item is already in the plan');
    end if;
    update public.event_plan_items set disabled_at = null where id = v_existing.id;
    return private.bump_plan_structure(p.id, 'restored', p_key);
  end if;
  if v_lib.kind = 'moment' then
    select * into v_parent from public.event_plan_items i where i.plan_id = p.id and i.key = p_parent_key and i.kind = 'stage';
    if not found or not (p_parent_key = any (v_lib.parent_keys)) then
      perform private.planning_error('add the moment to a stage it belongs to');
    end if;
  end if;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, parent_id, label, position)
  values (p.tenant_id, p.id, v_lib.kind, v_lib.key, v_parent.id, v_lib.default_label,
    (select coalesce(max(s.position), 0) + 1 from public.event_plan_items s
     where s.plan_id = p.id and s.kind = v_lib.kind and s.parent_id is not distinct from v_parent.id));
  return private.bump_plan_structure(p.id, 'added', p_key);
end;
$$;

-- Item-level staff changes share this lookup: the item, its plan locked.
create function private.lock_plan_item_for_staff(p_item_id uuid, p_expected_version integer)
returns public.event_plan_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.event_plan_items%rowtype;
  v_event uuid;
begin
  select * into i from public.event_plan_items where id = p_item_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  select event_id into v_event from public.event_plans where id = i.plan_id;
  perform private.lock_plan_for_staff(v_event, p_expected_version);
  select * into i from public.event_plan_items where id = i.id;
  return i;
end;
$$;

create function public.rename_event_plan_item(p_item_id uuid, p_expected_version integer, p_label text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.event_plan_items%rowtype;
begin
  i := private.lock_plan_item_for_staff(p_item_id, p_expected_version);
  update public.event_plan_items set label = private.planning_label(p_label) where id = i.id;
  return private.bump_plan_structure(i.plan_id, 'renamed', i.key);
end;
$$;

create function public.move_event_plan_item(p_item_id uuid, p_expected_version integer, p_direction text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.event_plan_items%rowtype;
  v_other public.event_plan_items%rowtype;
begin
  i := private.lock_plan_item_for_staff(p_item_id, p_expected_version);
  if p_direction is null or p_direction not in ('up', 'down') then
    perform private.planning_error('move up or down');
  end if;
  if i.kind = 'general' then
    perform private.planning_error('general sections keep their order; only stages and moments move');
  end if;
  perform private.renumber_plan_siblings(i.plan_id, i.parent_id, i.kind);
  select * into i from public.event_plan_items where id = i.id;
  select * into v_other from public.event_plan_items s
  where s.plan_id = i.plan_id and s.kind = i.kind and s.parent_id is not distinct from i.parent_id
    and case when p_direction = 'up' then s.position < i.position else s.position > i.position end
  order by case when p_direction = 'up' then -s.position else s.position end
  limit 1;
  if not found then
    perform private.planning_error(case when p_direction = 'up' then 'this item is already first' else 'this item is already last' end);
  end if;
  update public.event_plan_items set position = v_other.position where id = i.id;
  update public.event_plan_items set position = i.position where id = v_other.id;
  return private.bump_plan_structure(i.plan_id, 'moved_' || p_direction, i.key);
end;
$$;

-- Disables (hides from the client and progress, keeping answers) or restores
-- an item. A disabled stage hides its moments; their own state and order are
-- kept, so restoring the stage shows them as they were.
create function public.set_event_plan_item_enabled(p_item_id uuid, p_expected_version integer, p_enabled boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.event_plan_items%rowtype;
begin
  i := private.lock_plan_item_for_staff(p_item_id, p_expected_version);
  if i.key = 'basics' then
    perform private.planning_error('Event basics is part of every plan');
  end if;
  if p_enabled is null then
    perform private.planning_error('choose to hide or restore the item');
  end if;
  if p_enabled = (i.disabled_at is null) then
    return (select structure_version from public.event_plans where id = i.plan_id);
  end if;
  update public.event_plan_items set disabled_at = case when p_enabled then null else now() end where id = i.id;
  return private.bump_plan_structure(i.plan_id, case when p_enabled then 'restored' else 'disabled' end, i.key);
end;
$$;

create function public.staff_save_plan_basics(p_event_id uuid, p_expected_revision integer, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.event_plans%rowtype;
begin
  p := private.lock_plan_for_staff(p_event_id, null);
  return private.save_plan_basics(p.id, p_expected_revision, p_answers, 'staff', (select auth.uid()));
end;
$$;

-- Staff view of an event's planning: like the client view plus disabled
-- items, provenance and who saved Event basics last (client or staff).
create function public.staff_planning_view(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_plan public.event_plans%rowtype;
  v_basics record;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into v_plan from public.event_plans where tenant_id = e.tenant_id and event_id = e.id;
  if not found then
    return jsonb_build_object('plan', null);
  end if;
  select i.id, r.answers, r.revision, r.updated_by_actor, r.updated_at into v_basics
  from public.event_plan_items i left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = v_plan.id and i.key = 'basics';
  return jsonb_build_object(
    'plan', jsonb_build_object(
      'id', v_plan.id, 'origin', v_plan.origin, 'initialized_via', v_plan.initialized_via, 'created_at', v_plan.created_at,
      'source_template_id', v_plan.source_template_id, 'source_template_name', v_plan.source_template_name,
      'structure_version', v_plan.structure_version),
    'structure', private.plan_structure(v_plan.id, true),
    'basics', jsonb_build_object('item_id', v_basics.id, 'answers', coalesce(v_basics.answers, '{}'::jsonb),
                                 'revision', coalesce(v_basics.revision, 0), 'updated_by', v_basics.updated_by_actor,
                                 'updated_at', v_basics.updated_at),
    'imported', private.plan_latest_import(v_plan.id),
    'progress', private.plan_progress(v_plan.id));
end;
$$;

-- ===========================================================================
-- Function privileges
-- ===========================================================================

revoke execute on function
  private.lock_planning_template(uuid, integer),
  private.bump_planning_template(uuid),
  private.renumber_template_siblings(uuid, uuid, text),
  private.capture_plan_import(uuid),
  private.copy_template_into_plan(uuid, uuid),
  private.ensure_event_plan(uuid, uuid, text),
  private.events_initialize_planning(),
  private.plan_progress(uuid),
  private.plan_structure(uuid, boolean),
  private.plan_latest_import(uuid),
  private.client_can_access_plan(uuid),
  private.save_plan_basics(uuid, integer, jsonb, text, uuid),
  private.lock_plan_for_staff(uuid, integer),
  private.bump_plan_structure(uuid, text, text),
  private.renumber_plan_siblings(uuid, uuid, text),
  private.lock_plan_item_for_staff(uuid, integer)
  from public, anon, authenticated;

revoke execute on function
  public.create_planning_template(uuid, text, text),
  public.install_starter_planning_templates(uuid),
  public.update_planning_template(uuid, integer, text, text, text),
  public.duplicate_planning_template(uuid, text),
  public.set_planning_template_archived(uuid, boolean),
  public.add_planning_template_item(uuid, integer, text, text),
  public.rename_planning_template_item(uuid, integer, text),
  public.move_planning_template_item(uuid, integer, text),
  public.remove_planning_template_item(uuid, integer),
  public.client_planning_view(uuid, text),
  public.my_plans(),
  public.client_save_plan_basics(uuid, text, integer, jsonb),
  public.setup_event_plan(uuid, uuid),
  public.apply_event_plan_template(uuid, uuid, integer, boolean),
  public.add_event_plan_item(uuid, integer, text, text),
  public.rename_event_plan_item(uuid, integer, text),
  public.move_event_plan_item(uuid, integer, text),
  public.set_event_plan_item_enabled(uuid, integer, boolean),
  public.staff_save_plan_basics(uuid, integer, jsonb),
  public.staff_planning_view(uuid)
  from public, anon;
grant execute on function
  public.create_planning_template(uuid, text, text),
  public.install_starter_planning_templates(uuid),
  public.update_planning_template(uuid, integer, text, text, text),
  public.duplicate_planning_template(uuid, text),
  public.set_planning_template_archived(uuid, boolean),
  public.add_planning_template_item(uuid, integer, text, text),
  public.rename_planning_template_item(uuid, integer, text),
  public.move_planning_template_item(uuid, integer, text),
  public.remove_planning_template_item(uuid, integer),
  public.client_planning_view(uuid, text),
  public.my_plans(),
  public.client_save_plan_basics(uuid, text, integer, jsonb),
  public.setup_event_plan(uuid, uuid),
  public.apply_event_plan_template(uuid, uuid, integer, boolean),
  public.add_event_plan_item(uuid, integer, text, text),
  public.rename_event_plan_item(uuid, integer, text),
  public.move_event_plan_item(uuid, integer, text),
  public.set_event_plan_item_enabled(uuid, integer, boolean),
  public.staff_save_plan_basics(uuid, integer, jsonb),
  public.staff_planning_view(uuid)
  to authenticated;

-- ===========================================================================
-- Backfill: events booked before planning existed get a plan now (Event
-- basics fallback; no business has planning templates yet), with imports.
-- ===========================================================================

select private.ensure_event_plan(e.id, null, 'backfill')
from public.events e
where e.booking_confirmed_at is not null
order by e.tenant_id, e.id;
