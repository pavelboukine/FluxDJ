-- Custom planning questions: a DJ's own sections, stages and moments, each
-- with its own list of questions, beside the built-in library editors.
--
-- Model (no new tables, no nesting beyond the existing structure):
--  * A custom item is a planning item whose key is custom_<random>
--    (private.is_custom_planning_key). It has no library row: its editor is
--    "custom" (general sections and moments) or none (a custom stage only
--    groups moments, as Special dances does). private.planning_item_info gives
--    every item, built-in or custom, its editor; readers use it instead of
--    joining the library directly.
--  * planning_template_items.questions and event_plan_items.questions hold a
--    custom item's ordered question definitions: {id, type, label, help?,
--    required, options?}. Ids are stable; answers are stored by question id
--    in event_plan_responses.answers, as for every other editor.
--  * Types: short_text, long_text, single_choice, multi_choice, yes_no, songs,
--    time. No conditions, files or nested forms.
--  * A plan copies its template's definitions once (copy_template_into_plan),
--    so editing a template never changes existing plans.
--
-- History: on an event plan, a removed question that holds an answer, and a
-- removed option that an answer still selects, stay in the definition marked
-- "archived" (the client no longer sees the question; staff still read it,
-- with its label). Answers are never deleted. Changing an answered question's
-- type is refused (set_event_plan_item_questions); applying a template keeps
-- the plan's type for answered questions.
--
-- Saving: private.normalize_custom_answers validates against the item's own
-- definitions. Incomplete answers save (required questions only count toward
-- progress); invalid values, removed options and unknown questions are
-- refused. Saves keep going through save_plan_item, so revisions, manual
-- activation, deadlines and closed editing apply unchanged.
--
-- Progress: required, non-archived questions are the item's requirements
-- (private.plan_custom_requirements); optional questions don't count.
--
-- Compatibility: additive. Existing items have no questions (null) and every
-- built-in path is unchanged. The deployed app ignores the new "questions"
-- key in the structure and the custom items' answers in "moments"; no
-- custom item exists until the new RPCs create one.

-- ---------------------------------------------------------------------------
-- Keys and item editors
-- ---------------------------------------------------------------------------

create function private.is_custom_planning_key(p_key text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_key ~ '^custom_[a-z0-9]{8,40}$', false);
$$;
comment on function private.is_custom_planning_key(text) is
  'Whether a planning item key belongs to a DJ''s own (custom) item rather than the library.';
revoke all on function private.is_custom_planning_key(text) from public;
-- Used in CHECK constraints below.
grant execute on function private.is_custom_planning_key(text) to authenticated, service_role;

create function private.new_custom_id(p_prefix text) returns text
  language sql volatile set search_path = '' as $$
  select p_prefix || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
$$;
revoke all on function private.new_custom_id(text) from public;

create function private.planning_item_info(p_kind text, p_key text)
  returns table (editor text, removable boolean, library_order integer)
  language sql immutable set search_path = '' as $$
  select l.editor, l.removable, l.library_order from private.planning_library() l where l.key = p_key
  union all
  select case when p_kind = 'stage' then null else 'custom' end, true, 1000 where private.is_custom_planning_key(p_key);
$$;
comment on function private.planning_item_info(text, text) is
  'The editor of a planning item: the library''s for built-in keys, "custom" for a DJ''s own section or moment, none for a custom stage.';
revoke all on function private.planning_item_info(text, text) from public;

-- ---------------------------------------------------------------------------
-- Question definitions
-- ---------------------------------------------------------------------------

alter table public.planning_template_items
  add column questions jsonb,
  add constraint planning_template_items_questions_shape check (
    (questions is not null) = (private.is_custom_planning_key(key) and kind <> 'stage')
    and (questions is null or jsonb_typeof(questions) = 'array'));
alter table public.event_plan_items
  add column questions jsonb,
  add constraint event_plan_items_questions_shape check (
    (questions is not null) = (private.is_custom_planning_key(key) and kind <> 'stage')
    and (questions is null or jsonb_typeof(questions) = 'array'));
comment on column public.planning_template_items.questions is
  'A custom section''s or moment''s questions, in order: [{id, type, label, help?, required, options?}]. Null for library items and custom stages.';
comment on column public.event_plan_items.questions is
  'This plan''s copy of a custom item''s questions. Removed questions and options that answers still use are kept with "archived": true.';

create function private.custom_question_id_ok(p_id text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_id ~ '^[a-z0-9][a-z0-9_-]{0,39}$', false);
$$;
revoke all on function private.custom_question_id_ok(text) from public;

-- Staff-supplied definitions, checked and normalized (missing ids generated).
-- Only active questions and options come in; "archived" is the database's.
create function private.normalize_custom_questions(p_questions jsonb) returns jsonb
  language plpgsql volatile set search_path = '' as $$
declare
  q jsonb;
  o jsonb;
  k text;
  n int := 0;
  m int;
  v_out jsonb := '[]'::jsonb;
  v_ids text[] := '{}'::text[];
  v_id text;
  v_type text;
  v_label text;
  v_help text;
  v_options jsonb;
  v_option_ids text[];
  v_option_labels text[];
  v_option_id text;
  v_option_label text;
  v_question jsonb;
begin
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    perform private.planning_error('questions must be a list');
  end if;
  if jsonb_array_length(p_questions) > 30 then
    perform private.planning_error('keep this to 30 questions or fewer');
  end if;
  for q in select x from jsonb_array_elements(p_questions) x loop
    n := n + 1;
    if jsonb_typeof(q) <> 'object' then
      perform private.planning_error('question ' || n || ' needs a type and a label');
    end if;
    for k in select jsonb_object_keys(q) loop
      if k not in ('id', 'type', 'label', 'help', 'required', 'options') then
        perform private.planning_error('question ' || n || ' has an unknown setting (' || k || ')');
      end if;
    end loop;
    if q ? 'id' and jsonb_typeof(q -> 'id') <> 'null' then
      if jsonb_typeof(q -> 'id') <> 'string' or not private.custom_question_id_ok(q ->> 'id') then
        perform private.planning_error('question ' || n || ' has an invalid id');
      end if;
      v_id := q ->> 'id';
    else
      v_id := private.new_custom_id('q');
    end if;
    if v_id = any (v_ids) then
      perform private.planning_error('question ' || n || ' repeats the id of another question');
    end if;
    v_ids := v_ids || v_id;
    v_type := q ->> 'type';
    if jsonb_typeof(q -> 'type') is distinct from 'string'
       or v_type not in ('short_text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'songs', 'time') then
      perform private.planning_error('question ' || n || ' needs a type: short answer, paragraph, single choice, multiple choice, yes/no, songs or time');
    end if;
    if jsonb_typeof(q -> 'label') is distinct from 'string' or length(btrim(q ->> 'label')) not between 1 and 200 then
      perform private.planning_error('question ' || n || ' needs a question of 1 to 200 characters');
    end if;
    v_label := btrim(q ->> 'label');
    v_help := null;
    if q ? 'help' and jsonb_typeof(q -> 'help') <> 'null' then
      if jsonb_typeof(q -> 'help') <> 'string' or length(btrim(q ->> 'help')) > 500 then
        perform private.planning_error('question ' || n || ': keep the help text under 500 characters');
      end if;
      v_help := nullif(btrim(q ->> 'help'), '');
    end if;
    if q ? 'required' and jsonb_typeof(q -> 'required') not in ('boolean', 'null') then
      perform private.planning_error('question ' || n || ': required is yes or no');
    end if;
    v_question := jsonb_build_object('id', v_id, 'type', v_type, 'label', v_label,
                                     'required', coalesce((q ->> 'required')::boolean, false));
    if v_help is not null then
      v_question := v_question || jsonb_build_object('help', v_help);
    end if;

    if v_type in ('single_choice', 'multi_choice') then
      if jsonb_typeof(q -> 'options') is distinct from 'array'
         or jsonb_array_length(q -> 'options') not between 2 and 12 then
        perform private.planning_error('question ' || n || ' needs 2 to 12 options');
      end if;
      v_options := '[]'::jsonb;
      v_option_ids := '{}'::text[];
      v_option_labels := '{}'::text[];
      m := 0;
      for o in select x from jsonb_array_elements(q -> 'options') x loop
        m := m + 1;
        if jsonb_typeof(o) <> 'object' then
          perform private.planning_error('question ' || n || ', option ' || m || ' needs a label');
        end if;
        for k in select jsonb_object_keys(o) loop
          if k not in ('id', 'label') then
            perform private.planning_error('question ' || n || ', option ' || m || ' has an unknown setting (' || k || ')');
          end if;
        end loop;
        if o ? 'id' and jsonb_typeof(o -> 'id') <> 'null' then
          if jsonb_typeof(o -> 'id') <> 'string' or not private.custom_question_id_ok(o ->> 'id') then
            perform private.planning_error('question ' || n || ', option ' || m || ' has an invalid id');
          end if;
          v_option_id := o ->> 'id';
        else
          v_option_id := private.new_custom_id('o');
        end if;
        if jsonb_typeof(o -> 'label') is distinct from 'string' or length(btrim(o ->> 'label')) not between 1 and 120 then
          perform private.planning_error('question ' || n || ', option ' || m || ' needs 1 to 120 characters');
        end if;
        v_option_label := btrim(o ->> 'label');
        if v_option_id = any (v_option_ids) then
          perform private.planning_error('question ' || n || ' repeats an option id');
        end if;
        if lower(v_option_label) = any (v_option_labels) then
          perform private.planning_error('question ' || n || ' lists "' || v_option_label || '" twice');
        end if;
        v_option_ids := v_option_ids || v_option_id;
        v_option_labels := v_option_labels || lower(v_option_label);
        v_options := v_options || jsonb_build_array(jsonb_build_object('id', v_option_id, 'label', v_option_label));
      end loop;
      v_question := v_question || jsonb_build_object('options', v_options);
    elsif q ? 'options' and jsonb_typeof(q -> 'options') <> 'null' then
      perform private.planning_error('question ' || n || ': only choice questions have options');
    end if;
    v_out := v_out || jsonb_build_array(v_question);
  end loop;
  return v_out;
end;
$$;
comment on function private.normalize_custom_questions(jsonb) is
  'Checks and normalizes custom question definitions from staff (types, labels, help, required, 2 to 12 options for choices). Raises planning_invalid.';
revoke all on function private.normalize_custom_questions(jsonb) from public;

-- A plan's new definitions (already normalized) merged with its current ones
-- and its answers: removed questions and options that answers still use are
-- kept, archived. p_strict refuses changing an answered question's type;
-- otherwise (applying a template) the plan's type and options are kept.
create function private.merge_custom_questions(p_old jsonb, p_new jsonb, p_answers jsonb, p_strict boolean) returns jsonb
  language plpgsql volatile set search_path = '' as $$
declare
  v_out jsonb := '[]'::jsonb;
  q jsonb;
  v_old jsonb;
  o jsonb;
  v_answer jsonb;
  v_new_ids text[];
begin
  p_old := coalesce(p_old, '[]'::jsonb);
  p_answers := coalesce(p_answers, '{}'::jsonb);
  for q in select x from jsonb_array_elements(p_new) x loop
    v_old := (select x from jsonb_array_elements(p_old) x where x ->> 'id' = q ->> 'id' limit 1);
    v_answer := p_answers -> (q ->> 'id');
    if v_old is not null and v_answer is not null then
      if v_old ->> 'type' <> q ->> 'type' then
        if p_strict then
          perform private.planning_error('"' || (v_old ->> 'label') || '" already has an answer, so its type can''t change. Add a new question instead');
        end if;
        q := (q - 'options') || jsonb_build_object('type', v_old -> 'type')
             || case when v_old ? 'options' then jsonb_build_object('options', v_old -> 'options') else '{}'::jsonb end;
      elsif q ? 'options' then
        -- Options the answer still selects stay, archived, so the answer keeps its meaning.
        for o in select x from jsonb_array_elements(coalesce(v_old -> 'options', '[]'::jsonb)) x loop
          continue when exists (select 1 from jsonb_array_elements(q -> 'options') y where y ->> 'id' = o ->> 'id');
          if v_answer = to_jsonb(o ->> 'id') or (jsonb_typeof(v_answer) = 'array' and v_answer ? (o ->> 'id')) then
            q := jsonb_set(q, '{options}', (q -> 'options') || jsonb_build_array((o - 'archived') || '{"archived": true}'::jsonb));
          end if;
        end loop;
      end if;
    end if;
    v_out := v_out || jsonb_build_array(q);
  end loop;
  -- Removed questions that hold an answer stay, archived, after the active ones.
  select array_agg(x ->> 'id') into v_new_ids from jsonb_array_elements(p_new) x;
  for v_old in select x from jsonb_array_elements(p_old) x loop
    continue when v_old ->> 'id' = any (coalesce(v_new_ids, '{}'::text[]));
    if p_answers ? (v_old ->> 'id') then
      v_out := v_out || jsonb_build_array((v_old - 'archived') || '{"archived": true}'::jsonb);
    end if;
  end loop;
  return v_out;
end;
$$;
comment on function private.merge_custom_questions(jsonb, jsonb, jsonb, boolean) is
  'New custom question definitions for a plan item, keeping removed questions and options that answers still use (archived). Strict: an answered question''s type can''t change.';
revoke all on function private.merge_custom_questions(jsonb, jsonb, jsonb, boolean) from public;

-- What a reader is shown. Clients: no archived questions (their saved answers
-- are kept but no longer asked); archived options stay so a saved choice
-- still reads as chosen. Staff: everything.
create function private.custom_questions_view(p_questions jsonb, p_include_archived boolean) returns jsonb
  language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(q order by ord), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) with ordinality x(q, ord)
  where p_include_archived or not coalesce((q ->> 'archived')::boolean, false);
$$;
revoke all on function private.custom_questions_view(jsonb, boolean) from public;

-- ---------------------------------------------------------------------------
-- Answers and progress
-- ---------------------------------------------------------------------------

-- A custom item's answers, by question id, checked against its definitions.
-- Unanswered questions are simply absent: incomplete answers always save.
-- An archived question keeps its stored answer whatever is sent.
create function private.normalize_custom_answers(p_questions jsonb, p_answers jsonb, p_stored jsonb) returns jsonb
  language plpgsql stable set search_path = '' as $_$
declare
  a jsonb := '{}'::jsonb;
  q jsonb;
  k text;
  v jsonb;
  e jsonb;
  v_id text;
  v_field text;
  v_stored jsonb;
  v_allowed text[];
  v_seen text[];
  v_text text;
  v_limit int;
  v_music jsonb;
  v_time jsonb;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'field', null, 'message', 'Reload the page and try again.');
  end if;
  p_questions := coalesce(p_questions, '[]'::jsonb);
  p_stored := coalesce(p_stored, '{}'::jsonb);
  for k in select jsonb_object_keys(p_answers) loop
    if not exists (select 1 from jsonb_array_elements(p_questions) x where x ->> 'id' = k) then
      return jsonb_build_object('ok', false, 'field', null,
        'message', 'These questions were changed. Reload the page to see the latest version, then try again.');
    end if;
  end loop;

  for q in select x from jsonb_array_elements(p_questions) x loop
    v_id := q ->> 'id';
    v_field := 'q:' || v_id;
    v_stored := p_stored -> v_id;
    if coalesce((q ->> 'archived')::boolean, false) then
      if v_stored is not null then
        a := a || jsonb_build_object(v_id, v_stored);
      end if;
      continue;
    end if;
    v := p_answers -> v_id;
    continue when v is null or jsonb_typeof(v) = 'null';

    if q ->> 'type' in ('short_text', 'long_text') then
      if jsonb_typeof(v) <> 'string' then
        return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Reload the page and try again.');
      end if;
      v_text := btrim(v #>> '{}');
      v_limit := case when q ->> 'type' = 'short_text' then 500 else 4000 end;
      if length(v_text) > v_limit then
        return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Keep this under ' || to_char(v_limit, 'FM9,999') || ' characters.');
      end if;
      if v_text <> '' then
        a := a || jsonb_build_object(v_id, v_text);
      end if;

    elsif q ->> 'type' = 'yes_no' then
      if jsonb_typeof(v) <> 'boolean' then
        return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Choose yes or no.');
      end if;
      a := a || jsonb_build_object(v_id, v);

    elsif q ->> 'type' in ('single_choice', 'multi_choice') then
      -- Offered options, plus archived ones this answer already held.
      select coalesce(array_agg(o ->> 'id'), '{}'::text[]) into v_allowed
      from jsonb_array_elements(coalesce(q -> 'options', '[]'::jsonb)) o
      where not coalesce((o ->> 'archived')::boolean, false)
         or v_stored = to_jsonb(o ->> 'id')
         or (jsonb_typeof(v_stored) = 'array' and v_stored ? (o ->> 'id'));
      if q ->> 'type' = 'single_choice' then
        if jsonb_typeof(v) <> 'string' then
          return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Reload the page and try again.');
        end if;
        if not ((v #>> '{}') = any (v_allowed)) then
          return jsonb_build_object('ok', false, 'field', v_field,
            'message', 'That choice isn''t offered any more. Reload the page to see the current choices.');
        end if;
        a := a || jsonb_build_object(v_id, v);
      else
        if jsonb_typeof(v) <> 'array' then
          return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Reload the page and try again.');
        end if;
        v_seen := '{}'::text[];
        for e in select x from jsonb_array_elements(v) x loop
          if jsonb_typeof(e) <> 'string' or (e #>> '{}') = any (v_seen) then
            return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Reload the page and try again.');
          end if;
          if not ((e #>> '{}') = any (v_allowed)) then
            return jsonb_build_object('ok', false, 'field', v_field,
              'message', 'A choice here isn''t offered any more. Reload the page to see the current choices.');
          end if;
          v_seen := v_seen || (e #>> '{}');
        end loop;
        if cardinality(v_seen) > 0 then
          a := a || jsonb_build_object(v_id, to_jsonb(v_seen));
        end if;
      end if;

    elsif q ->> 'type' = 'songs' then
      if jsonb_typeof(v) <> 'array' then
        return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Reload the page and try again.');
      end if;
      -- The same rules as a moment's songs (up to 12; title and artist needed, an optional cue, https links, lengths),
      -- entered with the same song list.
      v_music := private.normalize_plan_music('moment_songs', jsonb_build_object('songs', v));
      if not (v_music ->> 'ok')::boolean then
        return v_music;
      end if;
      if v_music -> 'answers' ? 'songs' then
        a := a || jsonb_build_object(v_id, v_music -> 'answers' -> 'songs');
      end if;

    elsif q ->> 'type' = 'time' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_object_keys(v) x where x not in ('time', 'next_day')) then
        return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Reload the page and try again.');
      end if;
      continue when v -> 'time' is null or jsonb_typeof(v -> 'time') = 'null' or (v ->> 'time') = '';
      if jsonb_typeof(v -> 'time') <> 'string' or (v ->> 'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Enter a time such as 18:30.');
      end if;
      if v ? 'next_day' and jsonb_typeof(v -> 'next_day') not in ('boolean', 'null') then
        return jsonb_build_object('ok', false, 'field', v_field, 'message', 'Reload the page and try again.');
      end if;
      v_time := jsonb_build_object('time', v ->> 'time');
      if (v ->> 'next_day')::boolean then
        v_time := v_time || jsonb_build_object('next_day', true);
      end if;
      a := a || jsonb_build_object(v_id, v_time);
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'answers', a);
end;
$_$;
comment on function private.normalize_custom_answers(jsonb, jsonb, jsonb) is
  'Validates a custom item''s answers against its question definitions. Unanswered questions are absent; archived questions keep their stored answer.';
revoke all on function private.normalize_custom_answers(jsonb, jsonb, jsonb) from public;

create function private.plan_custom_requirements(p_questions jsonb, p_answers jsonb) returns jsonb
  language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', q ->> 'id',
           'state', case when coalesce(p_answers, '{}'::jsonb) ? (q ->> 'id') then 'answered' else 'unanswered' end) order by ord), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) with ordinality x(q, ord)
  where coalesce((q ->> 'required')::boolean, false) and not coalesce((q ->> 'archived')::boolean, false);
$$;
comment on function private.plan_custom_requirements(jsonb, jsonb) is
  'Progress requirements of a custom item: one per required question still asked.';
revoke all on function private.plan_custom_requirements(jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Structure checks and readers
-- ---------------------------------------------------------------------------

create or replace function private.planning_item_check() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_parent_keys text[];
  v_parent_kind text;
  v_parent_key text;
  v_custom boolean := private.is_custom_planning_key(new.key);
begin
  if not v_custom then
    select l.kind, l.parent_keys into v_kind, v_parent_keys from private.planning_library() l where l.key = new.key;
    if not found or v_kind <> new.kind then
      raise exception 'planning item % is not a % in the library', new.key, new.kind using errcode = 'check_violation';
    end if;
  end if;
  if new.kind = 'moment' then
    if tg_table_name = 'planning_template_items' then
      select p.kind, p.key into v_parent_kind, v_parent_key from public.planning_template_items p
      where p.tenant_id = new.tenant_id and p.template_id = new.template_id and p.id = new.parent_id;
    else
      select p.kind, p.key into v_parent_kind, v_parent_key from public.event_plan_items p
      where p.tenant_id = new.tenant_id and p.plan_id = new.plan_id and p.id = new.parent_id;
    end if;
    -- A custom moment fits any stage; a library moment only its own stages.
    if v_parent_kind is distinct from 'stage' or not (v_custom or v_parent_key = any (v_parent_keys)) then
      raise exception 'planning moment % cannot be placed under %', new.key, coalesce(v_parent_key, 'nothing')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.plan_structure(p_plan_id uuid, p_include_disabled boolean) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'general', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'key', g.key, 'label', g.label, 'editor', l.editor, 'removable', l.removable,
                                          'disabled', g.disabled_at is not null)
                       || case when g.questions is null then '{}'::jsonb
                               else jsonb_build_object('questions', private.custom_questions_view(g.questions, p_include_disabled)) end
                       order by g.position, g.id)
      from public.event_plan_items g cross join lateral private.planning_item_info(g.kind, g.key) l
      where g.plan_id = p_plan_id and g.kind = 'general' and (p_include_disabled or g.disabled_at is null)), '[]'::jsonb),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'label', s.label, 'editor', sl.editor, 'disabled', s.disabled_at is not null,
        'moments', coalesce((
          select jsonb_agg(jsonb_build_object('id', m.id, 'key', m.key, 'label', m.label, 'editor', ml.editor,
                                              'disabled', m.disabled_at is not null)
                           || case when m.questions is null then '{}'::jsonb
                                   else jsonb_build_object('questions', private.custom_questions_view(m.questions, p_include_disabled)) end
                           order by m.position, m.id)
          from public.event_plan_items m cross join lateral private.planning_item_info(m.kind, m.key) ml
          where m.plan_id = p_plan_id and m.parent_id = s.id and (p_include_disabled or m.disabled_at is null)), '[]'::jsonb))
        order by s.position, s.id)
      from public.event_plan_items s cross join lateral private.planning_item_info(s.kind, s.key) sl
      where s.plan_id = p_plan_id and s.kind = 'stage' and (p_include_disabled or s.disabled_at is null)), '[]'::jsonb));
$$;

-- Answers of visible moment-style items (participants, MC, general sections
-- and now custom sections and moments), keyed by item id.
create or replace function private.plan_moment_answers(p_plan_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(i.id, jsonb_build_object('answers', coalesce(r.answers, '{}'::jsonb), 'revision', coalesce(r.revision, 0))), '{}'::jsonb)
  from public.event_plan_items i
  cross join lateral private.planning_item_info(i.kind, i.key) l
  left join public.event_plan_items p on p.tenant_id = i.tenant_id and p.plan_id = i.plan_id and p.id = i.parent_id
  left join public.event_plan_responses r on r.tenant_id = i.tenant_id and r.item_id = i.id
  where i.plan_id = p_plan_id and i.disabled_at is null and (p.id is null or p.disabled_at is null)
    and (private.is_moment_editor(l.editor) or l.editor = 'custom');
$$;

create or replace function private.plan_progress(p_plan_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan public.event_plans%rowtype;
  v_venue text;
  v_basics jsonb;
  v_venue_known boolean;
  v_ceremony jsonb;
  v_entrance text;
  v_entrance_saved boolean;
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
  select resp.answers into v_basics from public.event_plan_items i
    join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key = 'basics';
  v_venue_known := v_venue is not null or coalesce(v_basics, '{}'::jsonb) ? 'venue_details';
  -- The visible Ceremony's details, for arrival answers that reuse them.
  select resp.answers into v_ceremony from public.event_plan_items i
    join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key = 'ceremony' and i.disabled_at is null;
  -- The grand entrance decision, and whether its moments already hold answers
  -- (older plans answered them before the decision existed).
  select private.plan_grand_entrance(coalesce(resp.answers, '{}'::jsonb)) into v_entrance from public.event_plan_items i
    left join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key = 'reception_entrance';
  select exists (select 1 from public.event_plan_items i
    join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.key in ('introductions', 'entrance_music') and i.disabled_at is null
      and resp.answers <> '{}'::jsonb) into v_entrance_saved;
  for r in
    select i.id, i.key, i.kind, l.editor, i.questions, resp.answers
    from public.event_plan_items i
    cross join lateral private.planning_item_info(i.kind, i.key) l
    left join public.event_plan_items p on p.tenant_id = i.tenant_id and p.plan_id = i.plan_id and p.id = i.parent_id
    left join public.event_plan_responses resp on resp.tenant_id = i.tenant_id and resp.item_id = i.id
    where i.plan_id = v_plan.id and i.disabled_at is null and (p.id is null or p.disabled_at is null)
    order by l.library_order, i.position, i.id
  loop
    -- Covered by another editor: nothing of its own to count.
    continue when r.editor in ('stage_details', 'included');
    -- A stage without fields of its own (Guest arrival, Speeches and program,
    -- Special dances, a custom stage) only holds moments, which count themselves.
    continue when r.kind = 'stage' and r.editor is null;
    -- The grand entrance's moments count only while it is planned (or, before
    -- any decision, once they hold answers). Otherwise they are left out of
    -- progress altogether, keeping what is saved.
    continue when r.key in ('introductions', 'entrance_music')
      and (v_entrance in ('none', 'undecided') or (v_entrance is null and not v_entrance_saved));
    if r.editor = 'custom' then
      v_req := private.plan_custom_requirements(r.questions, r.answers);
    elsif r.editor = 'basics' then
      v_req := private.plan_basics_requirements(r.answers, v_venue);
    elsif r.editor = 'contacts' then
      v_req := private.plan_contacts_requirements(v_plan.id, r.answers);
    elsif r.editor = 'arrival' then
      v_req := private.plan_arrival_requirements(r.answers, v_venue_known, v_ceremony);
    elsif r.editor = 'preferences' then
      v_req := private.plan_preferences_requirements(r.answers, v_basics);
    elsif private.is_moment_editor(r.editor) then
      v_req := private.plan_moment_requirements(r.editor, r.answers);
    elsif private.is_music_editor(r.editor) then
      v_req := private.plan_music_requirements(r.editor, r.answers);
    elsif r.editor like 'stage\_%' then
      v_req := private.plan_stage_requirements(r.editor, r.answers, v_venue_known, v_basics);
    else
      v_req := null;
    end if;
    if v_req is not null then
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

create or replace function private.save_plan_item(p_plan_id uuid, p_item_id uuid, p_expected_revision integer, p_answers jsonb, p_actor text, p_user_id uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item public.event_plan_items%rowtype;
  v_editor text;
  v_resp public.event_plan_responses%rowtype;
  v_norm jsonb;
  v_links jsonb;
  v_replay_safe boolean;
begin
  select * into v_item from public.event_plan_items where plan_id = p_plan_id and id = p_item_id;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select l.editor into v_editor from private.planning_item_info(v_item.kind, v_item.key) l;
  if v_editor is null or v_editor in ('stage_details', 'included') or v_item.disabled_at is not null
     or exists (select 1 from public.event_plan_items p where p.id = v_item.parent_id and p.disabled_at is not null) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  if v_editor = 'custom' then
    -- Checked against this plan's own questions; answers to removed questions are kept as stored.
    -- Every caller holds the plan row lock, so the definitions and stored answers can't change meanwhile.
    v_norm := private.normalize_custom_answers(v_item.questions, p_answers,
                (select r.answers from public.event_plan_responses r where r.item_id = v_item.id));
  else
    v_norm := private.normalize_plan_answers(v_editor, p_answers);
  end if;
  if not (v_norm ->> 'ok')::boolean then
    return jsonb_build_object('status', 'invalid', 'field', v_norm -> 'field', 'message', v_norm ->> 'message');
  end if;
  v_replay_safe := private.is_music_editor(v_editor) or private.is_moment_editor(v_editor) or v_editor = 'custom';
  select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
  v_links := coalesce(private.check_plan_song_links(p_plan_id, v_item.key, v_resp.answers, v_norm -> 'answers'),
                      private.check_plan_contact_refs(p_plan_id, v_editor, v_norm -> 'answers'),
                      private.check_plan_vendor_reach(v_editor, v_resp.answers, v_norm -> 'answers'));
  if v_links is not null then
    return v_links;
  end if;
  if v_resp.id is null then
    if p_expected_revision is distinct from 0 then
      return jsonb_build_object('status', 'conflict');
    end if;
    insert into public.event_plan_responses (tenant_id, plan_id, item_id, answers, updated_by_actor, updated_by_user_id)
    values (v_item.tenant_id, p_plan_id, v_item.id, v_norm -> 'answers', p_actor, p_user_id)
    on conflict (item_id) do nothing
    returning * into v_resp;
    if v_resp.id is null then
      -- A concurrent first save won: the same answers are this save, already stored.
      select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
      if not (v_replay_safe and v_resp.answers = v_norm -> 'answers') then
        return jsonb_build_object('status', 'conflict');
      end if;
    end if;
  elsif p_expected_revision is distinct from v_resp.revision then
    -- A retried or doubled save (same entry ids) is already stored.
    if not (v_replay_safe and v_resp.answers = v_norm -> 'answers') then
      return jsonb_build_object('status', 'conflict');
    end if;
  elsif v_resp.answers is distinct from v_norm -> 'answers' or not v_replay_safe then
    update public.event_plan_responses
      set answers = v_norm -> 'answers', revision = revision + 1, updated_by_actor = p_actor, updated_by_user_id = p_user_id
      where id = v_resp.id returning * into v_resp;
  end if;
  return jsonb_build_object('status', 'saved', 'revision', v_resp.revision, 'answers', v_resp.answers,
                            'progress', private.plan_progress(p_plan_id), 'timeline_warnings', private.plan_timeline_warnings(p_plan_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Copying: templates to plans, templates to templates
-- ---------------------------------------------------------------------------

create or replace function private.copy_template_into_plan(p_template_id uuid, p_plan_id uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.event_plans where id = p_plan_id;
  -- The plan keeps its own copy of custom questions: later template edits never reach it.
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, label, position, source_template_item_id, questions)
  select v_tenant, p_plan_id, ti.kind, ti.key, ti.label, ti.position, ti.id, ti.questions
  from public.planning_template_items ti
  where ti.tenant_id = v_tenant and ti.template_id = p_template_id and ti.parent_id is null;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, parent_id, label, position, source_template_item_id, questions)
  select v_tenant, p_plan_id, ti.kind, ti.key, pi.id, ti.label, ti.position, ti.id, ti.questions
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

-- One template's items (custom questions included) into another, empty one.
create function private.copy_template_items(p_from uuid, p_to uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position, questions)
  select i.tenant_id, p_to, i.kind, i.key, i.label, i.position, i.questions
  from public.planning_template_items i where i.template_id = p_from and i.parent_id is null;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position, questions)
  select i.tenant_id, p_to, i.kind, i.key, np.id, i.label, i.position, i.questions
  from public.planning_template_items i
  join public.planning_template_items op on op.id = i.parent_id
  join public.planning_template_items np on np.template_id = p_to and np.key = op.key
  where i.template_id = p_from and i.parent_id is not null;
end;
$$;
revoke all on function private.copy_template_items(uuid, uuid) from public;

create or replace function public.duplicate_planning_template(p_template_id uuid, p_name text) returns uuid
  language plpgsql security definer set search_path = '' as $$
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
  perform private.copy_template_items(t.id, v_id);
  perform private.audit(t.tenant_id, 'planning_template', v_id, 'duplicated', 'staff', (select auth.uid()),
    jsonb_build_object('from_template_id', t.id));
  return v_id;
end;
$$;

create or replace function public.create_planning_template_once(p_tenant_id uuid, p_template_id uuid, p_start text, p_source_template_id uuid, p_name text, p_description text)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d record;
  v_source public.planning_templates%rowtype;
  v_existing uuid;
  v_inserted uuid;
begin
  perform private.require_staff_of(p_tenant_id);
  if p_template_id is null then
    perform private.planning_error('a request id is required');
  end if;

  -- A retry of a request that already succeeded (its response was lost).
  select tenant_id into v_existing from public.planning_templates where id = p_template_id;
  if found then
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_template_id, 'replayed', true);
  end if;

  if p_start is null or p_start not in ('basics', 'wedding', 'simple_party', 'copy') then
    perform private.planning_error('choose a starting point');
  end if;
  if p_start = 'copy' then
    select * into v_source from public.planning_templates t where t.tenant_id = p_tenant_id and t.id = p_source_template_id;
    if not found then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
  end if;
  select * into d from private.planning_template_details(
    p_name,
    case p_start
      when 'copy' then v_source.description
      when 'wedding' then coalesce(nullif(btrim(coalesce(p_description, '')), ''),
        'Ceremony to closing, in the order of the day. Rename or remove anything a couple doesn''t need.')
      when 'simple_party' then coalesce(nullif(btrim(coalesce(p_description, '')), ''),
        'Event basics plus must-play and do-not-play songs. For birthdays and other simple parties.')
      else p_description end);

  insert into public.planning_templates (id, tenant_id, name, description)
  values (p_template_id, p_tenant_id, d.name, d.description)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    -- The same request, committed concurrently.
    select tenant_id into v_existing from public.planning_templates where id = p_template_id;
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_template_id, 'replayed', true);
  end if;

  if p_start = 'copy' then
    perform private.copy_template_items(v_source.id, p_template_id);
    perform private.audit(p_tenant_id, 'planning_template', p_template_id, 'duplicated', 'staff', (select auth.uid()),
      jsonb_build_object('from_template_id', v_source.id));
  elsif p_start = 'basics' then
    insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position)
    select p_tenant_id, p_template_id, l.kind, l.key, l.default_label, 1 from private.planning_library() l where l.key = 'basics';
    perform private.audit(p_tenant_id, 'planning_template', p_template_id, 'created', 'staff', (select auth.uid()), '{}'::jsonb);
  else
    insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position)
    select p_tenant_id, p_template_id, l.kind, l.key, l.default_label, s.item_position
    from private.starter_planning_items(p_start) s
    join private.planning_library() l on l.key = s.key
    where s.parent_key is null;
    insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position)
    select p_tenant_id, p_template_id, l.kind, l.key, p.id, l.default_label, s.item_position
    from private.starter_planning_items(p_start) s
    join private.planning_library() l on l.key = s.key
    join public.planning_template_items p on p.template_id = p_template_id and p.key = s.parent_key
    where s.parent_key is not null;
    perform private.audit(p_tenant_id, 'planning_template', p_template_id, 'created', 'staff', (select auth.uid()),
      jsonb_build_object('starter', p_start));
  end if;

  return jsonb_build_object('id', p_template_id, 'replayed', false);
end;
$$;

create or replace function public.apply_event_plan_template(p_event_id uuid, p_template_id uuid, p_expected_version integer, p_confirm boolean)
  returns jsonb language plpgsql security definer set search_path = '' as $$
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

  -- Top level, then moments (their stages exist by then). A kept custom item
  -- takes the template's questions, keeping removed ones that hold answers and
  -- the plan's type for answered questions.
  update public.event_plan_items i
    set label = ti.label, position = ti.position, disabled_at = null,
        questions = case when ti.questions is null then i.questions
                         else private.merge_custom_questions(i.questions, ti.questions,
                                (select r.answers from public.event_plan_responses r where r.item_id = i.id), false) end
    from public.planning_template_items ti
    where ti.template_id = t.id and ti.parent_id is null and i.plan_id = p.id and i.key = ti.key;
  get diagnostics v_count = row_count;
  v_kept := v_kept + v_count;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, label, position, source_template_item_id, questions)
  select p.tenant_id, p.id, ti.kind, ti.key, ti.label, ti.position, ti.id, ti.questions
  from public.planning_template_items ti
  where ti.template_id = t.id and ti.parent_id is null
    and not exists (select 1 from public.event_plan_items i where i.plan_id = p.id and i.key = ti.key);
  get diagnostics v_count = row_count;
  v_added := v_added + v_count;

  update public.event_plan_items i
    set label = ti.label, position = ti.position, disabled_at = null, parent_id = pi.id,
        questions = case when ti.questions is null then i.questions
                         else private.merge_custom_questions(i.questions, ti.questions,
                                (select r.answers from public.event_plan_responses r where r.item_id = i.id), false) end
    from public.planning_template_items ti
    join public.planning_template_items tp on tp.id = ti.parent_id
    join public.event_plan_items pi on pi.plan_id = p.id and pi.key = tp.key
    where ti.template_id = t.id and i.plan_id = p.id and i.key = ti.key;
  get diagnostics v_count = row_count;
  v_kept := v_kept + v_count;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, parent_id, label, position, source_template_item_id, questions)
  select p.tenant_id, p.id, ti.kind, ti.key, pi.id, ti.label, ti.position, ti.id, ti.questions
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

-- ---------------------------------------------------------------------------
-- Staff RPCs: create custom items and set their questions
-- ---------------------------------------------------------------------------

create function public.add_custom_planning_template_item(p_template_id uuid, p_expected_version integer, p_kind text, p_label text, p_parent_key text default null)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.planning_templates%rowtype;
  v_parent public.planning_template_items%rowtype;
  v_key text := private.new_custom_id('custom_');
  v_id uuid;
begin
  t := private.lock_planning_template(p_template_id, p_expected_version);
  if p_kind is null or p_kind not in ('general', 'stage', 'moment') then
    perform private.planning_error('choose a section, a stage or a moment');
  end if;
  if p_kind = 'moment' then
    select * into v_parent from public.planning_template_items i where i.template_id = t.id and i.key = p_parent_key and i.kind = 'stage';
    if not found then
      perform private.planning_error('add the moment to a stage of this template');
    end if;
  end if;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position, questions)
  values (t.tenant_id, t.id, p_kind, v_key, v_parent.id, private.planning_label(p_label),
    (select coalesce(max(s.position), 0) + 1 from public.planning_template_items s
     where s.template_id = t.id and s.kind = p_kind and s.parent_id is not distinct from v_parent.id),
    case when p_kind = 'stage' then null else '[]'::jsonb end)
  returning id into v_id;
  return jsonb_build_object('version', private.bump_planning_template(t.id), 'item_id', v_id, 'key', v_key);
end;
$$;
comment on function public.add_custom_planning_template_item(uuid, integer, text, text, text) is
  'Adds a DJ''s own section, stage or moment (any stage) to a template, with no questions yet. Staff only, with the template''s version.';
revoke all on function public.add_custom_planning_template_item(uuid, integer, text, text, text) from public;
grant execute on function public.add_custom_planning_template_item(uuid, integer, text, text, text) to authenticated, service_role;

create function public.set_planning_template_item_questions(p_item_id uuid, p_expected_version integer, p_questions jsonb)
  returns integer language plpgsql security definer set search_path = '' as $$
declare
  i public.planning_template_items%rowtype;
  t public.planning_templates%rowtype;
begin
  select * into i from public.planning_template_items where id = p_item_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  t := private.lock_planning_template(i.template_id, p_expected_version);
  if i.questions is null then
    perform private.planning_error('only your own sections and moments have questions you can change');
  end if;
  -- Templates hold no answers: the list is replaced as given. Plans copied
  -- from the template keep their own questions.
  update public.planning_template_items set questions = private.normalize_custom_questions(p_questions) where id = i.id;
  return private.bump_planning_template(t.id);
end;
$$;
comment on function public.set_planning_template_item_questions(uuid, integer, jsonb) is
  'Replaces the questions of a template''s custom section or moment. Existing event plans keep their own copy.';
revoke all on function public.set_planning_template_item_questions(uuid, integer, jsonb) from public;
grant execute on function public.set_planning_template_item_questions(uuid, integer, jsonb) to authenticated, service_role;

create function public.add_custom_event_plan_item(p_event_id uuid, p_expected_version integer, p_kind text, p_label text, p_parent_key text default null)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.event_plans%rowtype;
  v_parent public.event_plan_items%rowtype;
  v_key text := private.new_custom_id('custom_');
  v_id uuid;
begin
  p := private.lock_plan_for_staff(p_event_id, p_expected_version);
  if p_kind is null or p_kind not in ('general', 'stage', 'moment') then
    perform private.planning_error('choose a section, a stage or a moment');
  end if;
  if p_kind = 'moment' then
    select * into v_parent from public.event_plan_items i where i.plan_id = p.id and i.key = p_parent_key and i.kind = 'stage';
    if not found then
      perform private.planning_error('add the moment to a stage of this plan');
    end if;
  end if;
  insert into public.event_plan_items (tenant_id, plan_id, kind, key, parent_id, label, position, questions)
  values (p.tenant_id, p.id, p_kind, v_key, v_parent.id, private.planning_label(p_label),
    (select coalesce(max(s.position), 0) + 1 from public.event_plan_items s
     where s.plan_id = p.id and s.kind = p_kind and s.parent_id is not distinct from v_parent.id),
    case when p_kind = 'stage' then null else '[]'::jsonb end)
  returning id into v_id;
  return jsonb_build_object('structure_version', private.bump_plan_structure(p.id, 'added', v_key), 'item_id', v_id, 'key', v_key);
end;
$$;
comment on function public.add_custom_event_plan_item(uuid, integer, text, text, text) is
  'Adds a DJ''s own section, stage or moment to one event''s plan. Staff only, with the plan''s structure version; refused for archived events.';
revoke all on function public.add_custom_event_plan_item(uuid, integer, text, text, text) from public;
grant execute on function public.add_custom_event_plan_item(uuid, integer, text, text, text) to authenticated, service_role;

create function public.set_event_plan_item_questions(p_item_id uuid, p_expected_version integer, p_questions jsonb)
  returns integer language plpgsql security definer set search_path = '' as $$
declare
  i public.event_plan_items%rowtype;
  v_answers jsonb;
begin
  i := private.lock_plan_item_for_staff(p_item_id, p_expected_version);
  if i.questions is null then
    perform private.planning_error('only your own sections and moments have questions you can change');
  end if;
  select r.answers into v_answers from public.event_plan_responses r where r.item_id = i.id for update;
  update public.event_plan_items
    set questions = private.merge_custom_questions(i.questions, private.normalize_custom_questions(p_questions), v_answers, true)
    where id = i.id;
  return private.bump_plan_structure(i.plan_id, 'questions_changed', i.key);
end;
$$;
comment on function public.set_event_plan_item_questions(uuid, integer, jsonb) is
  'Replaces the questions of a plan''s custom section or moment. Answers are never deleted: removed questions and options they use are kept, archived; an answered question''s type can''t change.';
revoke all on function public.set_event_plan_item_questions(uuid, integer, jsonb) from public;
grant execute on function public.set_event_plan_item_questions(uuid, integer, jsonb) to authenticated, service_role;
