-- Custom planning questions (20261202000100): a DJ's own sections, stages and
-- moments with their own questions. Staff-only, versioned and tenant-scoped
-- definitions; plans copy them once (template edits never reach a plan);
-- answers are validated against the plan's own copy, save incomplete, count
-- toward progress only for required questions, and are never deleted:
-- removed questions and options that answers use stay, archived; an answered
-- question's type can't change. Client saves keep the manual activation,
-- deadline and revision rules.
begin;
\ir _fixtures.psql
select plan(96);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('planning-custom-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.as_user(who text, stmt text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  execute stmt into r;
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
create function tests.tv() returns int language sql stable as $$
  select version from public.planning_templates where id = tests.id('tpl');
$$;
create function tests.titem(k text) returns uuid language sql stable as $$
  select id from public.planning_template_items where template_id = tests.id('tpl') and key = k;
$$;
create function tests.plan() returns public.event_plans language sql stable as $$
  select * from public.event_plans where event_id = tests.id('ev');
$$;
create function tests.item(k text) returns public.event_plan_items language sql stable as $$
  select i.* from public.event_plan_items i where i.plan_id = (tests.plan()).id and i.key = k;
$$;
create function tests.answers(k text) returns jsonb language sql stable as $$
  select answers from public.event_plan_responses where item_id = (tests.item(k)).id;
$$;
create function tests.rev(k text) returns int language sql stable as $$
  select coalesce((select revision from public.event_plan_responses where item_id = (tests.item(k)).id), 0);
$$;
create function tests.client_save(k text, answers jsonb, rev int default null) returns jsonb language sql as $$
  select tests.as_user('client_y', format('select public.client_save_plan_item(%L, %L, %L, %s, %L)', tests.id('ev'), 'test-bouprod',
    (tests.item(k)).id, coalesce(rev, tests.rev(k)), answers));
$$;
create function tests.staff_save(k text, answers jsonb) returns jsonb language sql as $$
  select tests.as_user('staff_a', format('select public.staff_save_plan_item(%L, %L, %s, %L)', tests.id('ev'), (tests.item(k)).id, tests.rev(k), answers));
$$;
create function tests.set_questions(k text, questions jsonb, who text default 'staff_a') returns jsonb language sql as $$
  select tests.as_user(who, format('select to_jsonb(public.set_event_plan_item_questions(%L, %s, %L))', (tests.item(k)).id, (tests.plan()).structure_version, questions));
$$;
create function tests.staff_structure() returns jsonb language sql as $$
  select tests.as_user('staff_a', format('select public.staff_planning_view(%L)', tests.id('ev'))) -> 'structure';
$$;
create function tests.client_view() returns jsonb language sql as $$
  select tests.as_user('client_y', format('select public.client_planning_view(%L, %L)', tests.id('ev'), 'test-bouprod'));
$$;
create function tests.progress_item(k text) returns jsonb language sql stable as $$
  select x from jsonb_array_elements(private.plan_progress((tests.plan()).id) -> 'items') x where x ->> 'key' = k;
$$;
create function tests.q(questions jsonb, id text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(questions) x where x ->> 'id' = id;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- The questions every test plan starts with.
create function tests.cultural() returns jsonb language sql immutable as $$
  select '[
    {"id": "q_style", "type": "single_choice", "label": "Which traditions should the music include?", "required": true,
     "options": [{"id": "o_greek", "label": "Greek"}, {"id": "o_lebanese", "label": "Lebanese"}, {"id": "o_none", "label": "None"}]},
    {"id": "q_notes", "type": "long_text", "label": "Anything the DJ should know?", "help": "  Optional details.  "},
    {"id": "q_songs", "type": "songs", "label": "Traditional songs", "required": true},
    {"id": "q_when", "type": "time", "label": "When should the cultural set start?"},
    {"id": "q_hora", "type": "yes_no", "label": "Will there be a hora?", "required": true},
    {"id": "q_langs", "type": "multi_choice", "label": "Languages for announcements",
     "options": [{"id": "o_en", "label": "English"}, {"id": "o_fr", "label": "French"}, {"id": "o_gr", "label": "Greek"}]},
    {"id": "q_name", "type": "short_text", "label": "Family name to announce"}
  ]'::jsonb;
$$;

-- ===========================================================================
-- Templates: creating custom items and their questions
-- ===========================================================================
select tests.as_user('staff_a', format('select public.create_planning_template_once(%L, %L, %L, null, %L, null)',
  tests.id('tenant_a'), tests.id('tpl'), 'basics', 'Custom test'));
select tests.as_user('staff_a', format('select to_jsonb(public.add_planning_template_item(%L, %s, %L, null))', tests.id('tpl'), tests.tv(), 'party'));

create temp table t_keys (name text primary key, key text);
grant all on t_keys to authenticated;
insert into t_keys select 'section', tests.as_user('staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L)',
  tests.id('tpl'), tests.tv(), 'general', 'Cultural music')) ->> 'key';
insert into t_keys select 'stage', tests.as_user('staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L)',
  tests.id('tpl'), tests.tv(), 'stage', 'Cultural set')) ->> 'key';
insert into t_keys select 'moment', tests.as_user('staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L, %L)',
  tests.id('tpl'), tests.tv(), 'moment', 'Hora', (select key from t_keys where name = 'stage'))) ->> 'key';
insert into t_keys select 'party_moment', tests.as_user('staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L, %L)',
  tests.id('tpl'), tests.tv(), 'moment', 'Late-night requests', 'party')) ->> 'key';
create function tests.k(name text) returns text language sql stable as $$ select key from t_keys where t_keys.name = k.name $$;
grant execute on function tests.k(text) to authenticated;

select ok((select bool_and(key ~ '^custom_[a-z0-9]{12}$') from t_keys), 'custom items get custom_ keys');
select is((select array_agg(kind || ':' || coalesce(questions::text, 'null') order by kind) from public.planning_template_items
           where template_id = tests.id('tpl') and key in (select key from t_keys)),
  array['general:[]', 'moment:[]', 'moment:[]', 'stage:null'], 'sections and moments start with no questions; a stage holds none');
select is((select p.key from public.planning_template_items m join public.planning_template_items p on p.id = m.parent_id where m.key = tests.k('party_moment')),
  'party', 'a custom moment fits a library stage');
select throws_like(format('select tests.as_user(%L, %L)', 'staff_a',
  format('select to_jsonb(public.add_planning_template_item(%L, %s, %L, %L))', tests.id('tpl'), tests.tv(), 'must_play', tests.k('stage'))),
  '%stage it belongs to%', 'a library moment still only fits its own stages');
select throws_like(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L, %L)',
  tests.id('tpl'), tests.tv(), 'moment', 'Lost', 'ceremony')), '%stage of this template%', 'a custom moment needs a stage of the template');
select throws_like(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L)',
  tests.id('tpl'), tests.tv(), 'subsection', 'Nested')), '%section, a stage or a moment%', 'no other kinds (no nested subsections)');
select throws_like(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L)',
  tests.id('tpl'), tests.tv(), 'general', '   ')), '%1 to 120 characters%', 'a custom item needs a name');
select throws_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.add_custom_planning_template_item(%L, %s, %L, %L)',
  tests.id('tpl'), tests.tv() - 1, 'general', 'Stale')), 'PT409', null, 'a stale template version is refused');
select throws_ok(format('select tests.as_user(%L, %L)', 'client_y', format('select public.add_custom_planning_template_item(%L, %s, %L, %L)',
  tests.id('tpl'), tests.tv(), 'general', 'Client')), 'P0002', null, 'clients cannot add custom items');
select throws_ok(format('select tests.as_user(%L, %L)', 'owner_b', format('select public.add_custom_planning_template_item(%L, %s, %L, %L)',
  tests.id('tpl'), tests.tv(), 'general', 'Other')), 'P0002', null, 'nor staff of another business');
select throws_ok(format('select tests.as_user(%L, %L)', 'owner_b', format('select public.set_planning_template_item_questions(%L, %s, %L)',
  tests.titem(tests.k('section')), tests.tv(), '[]')), 'P0002', null, 'nor change its questions');
select throws_ok(format('select public.set_planning_template_item_questions(%L, %s, %L)', tests.titem(tests.k('section')), tests.tv(), '[]'),
  'P0002', null, 'nor anyone signed out');

-- Definitions are checked.
create function tests.bad(questions text) returns text language sql as $$
  select format('select tests.as_user(%L, %L)', 'staff_a', format('select public.set_planning_template_item_questions(%L, %s, %L)',
    tests.titem(tests.k('section')), tests.tv(), questions));
$$;
grant execute on function tests.bad(text) to authenticated;
select throws_like(tests.bad('[{"type": "rating", "label": "Stars"}]'), '%needs a type%', 'only the seven question types');
select throws_like(tests.bad('[{"type": "short_text", "label": " "}]'), '%1 to 200 characters%', 'a question needs its wording');
select throws_like(tests.bad('[{"type": "single_choice", "label": "One", "options": [{"label": "Only"}]}]'), '%2 to 12 options%', 'a choice needs 2 to 12 options');
select throws_like(tests.bad('[{"type": "multi_choice", "label": "Dup", "options": [{"label": "Greek"}, {"label": "greek"}]}]'), '%twice%', 'options are distinct');
select throws_like(tests.bad('[{"type": "short_text", "label": "Text", "options": [{"label": "A"}, {"label": "B"}]}]'), '%only choice questions%', 'only choices have options');
select throws_like(tests.bad('[{"type": "short_text", "label": "If", "show_when": "q1"}]'), '%unknown setting%', 'no conditions or other settings');
select throws_like(tests.bad('[{"id": "q", "type": "yes_no", "label": "A"}, {"id": "q", "type": "yes_no", "label": "B"}]'), '%repeats the id%', 'question ids are unique');
select throws_like(tests.bad((select jsonb_agg(jsonb_build_object('type', 'yes_no', 'label', 'Q' || n))::text from generate_series(1, 31) n)),
  '%30 questions or fewer%', 'at most 30 questions');
select throws_like(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.set_planning_template_item_questions(%L, %s, %L)',
  tests.titem('basics'), tests.tv(), '[]')), '%only your own sections%', 'library items keep their built-in questions');
select throws_ok($$ update public.planning_template_items set questions = '[]' where id = tests.titem('basics') $$, '23514', null,
  'a library item cannot hold questions, even written directly');
select throws_ok(format($$ update public.planning_template_items set questions = '[]' where id = %L $$, tests.titem(tests.k('stage'))), '23514', null,
  'nor a custom stage');

select lives_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.set_planning_template_item_questions(%L, %s, %L)',
  tests.titem(tests.k('section')), tests.tv(), tests.cultural())), 'staff set a custom section''s questions');
select is(jsonb_array_length((select questions from public.planning_template_items where id = tests.titem(tests.k('section')))), 7, 'all seven types are stored');
select is(tests.q((select questions from public.planning_template_items where id = tests.titem(tests.k('section'))), 'q_notes'),
  '{"id": "q_notes", "type": "long_text", "label": "Anything the DJ should know?", "help": "Optional details.", "required": false}'::jsonb,
  'definitions are normalized: help trimmed, required defaults to no');
select lives_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.set_planning_template_item_questions(%L, %s, %L)',
  tests.titem(tests.k('moment')), tests.tv(), '[{"type": "yes_no", "label": "Should guests join in?"}, {"type": "songs", "label": "Hora songs"}]')),
  'a custom moment gets questions without ids');
select ok((select bool_and(q ->> 'id' ~ '^q[0-9a-f]{12}$') from public.planning_template_items i, jsonb_array_elements(i.questions) q
           where i.id = tests.titem(tests.k('moment'))), 'missing ids are generated');
select lives_ok(format('select tests.as_user(%L, %L)', 'staff_a', format('select public.set_planning_template_item_questions(%L, %s, %L)',
  tests.titem(tests.k('party_moment')), tests.tv(), '[{"id": "q_any", "type": "short_text", "label": "Anything else?"}]')),
  'a custom moment in a library stage gets an optional question');

-- Copies of the template carry the questions.
insert into t_keys select 'duplicate', tests.as_user('staff_a', format('select to_jsonb(public.duplicate_planning_template(%L, %L))', tests.id('tpl'), 'Custom copy')) #>> '{}';
select is((select questions from public.planning_template_items where template_id = tests.k('duplicate')::uuid and key = tests.k('section')),
  (select questions from public.planning_template_items where id = tests.titem(tests.k('section'))), 'duplicating a template copies its questions');
select tests.as_user('staff_a', format('select public.create_planning_template_once(%L, %L, %L, %L, %L, null)',
  tests.id('tenant_a'), tests.id('tpl_copy'), 'copy', tests.id('tpl'), 'Custom copy 2'));
select is((select questions from public.planning_template_items where template_id = tests.id('tpl_copy') and key = tests.k('moment')),
  (select questions from public.planning_template_items where id = tests.titem(tests.k('moment'))), 'and so does starting a template from a copy');

-- ===========================================================================
-- Plans: a snapshot of the template's questions
-- ===========================================================================
insert into public.events (id, tenant_id, title, event_type, event_date, timezone, booking_source)
values (tests.id('ev'), tests.id('tenant_a'), 'Custom wedding', 'wedding', current_date + 120, 'America/Toronto', 'flux');
insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id('ev'), tests.id('a_client_y'), true, true);
insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id('ev'), tests.id('a_client_y'), tests.id('client_y'));
select tests.as_user('staff_a', format('select public.setup_event_plan(%L, %L)', tests.id('ev'), tests.id('tpl')));
set local session_replication_role = replica;
update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id('ev');
set local session_replication_role = origin;

select is((tests.item(tests.k('section'))).questions, (select questions from public.planning_template_items where id = tests.titem(tests.k('section'))),
  'setting up a plan copies the template''s questions');
select tests.as_user('staff_a', format('select public.set_planning_template_item_questions(%L, %s, %L)',
  tests.titem(tests.k('section')), tests.tv(), '[{"id": "q_style", "type": "short_text", "label": "Changed later"}]'));
select is(jsonb_array_length((tests.item(tests.k('section'))).questions), 7, 'later template edits never reach the plan');

select is((select x - 'id' from jsonb_array_elements(tests.staff_structure() -> 'general') x where x ->> 'key' = tests.k('section')),
  jsonb_build_object('key', tests.k('section'), 'label', 'Cultural music', 'editor', 'custom', 'removable', true, 'disabled', false,
                     'questions', (tests.item(tests.k('section'))).questions),
  'staff see a custom section with the custom editor and its questions');
select is((select jsonb_build_object('editor', x -> 'editor', 'moments', x -> 'moments' -> 0 -> 'editor', 'has_questions', x ? 'questions')
           from jsonb_array_elements(tests.staff_structure() -> 'stages') x where x ->> 'key' = tests.k('stage')),
  '{"editor": null, "moments": "custom", "has_questions": false}'::jsonb, 'a custom stage only groups its custom moments');
select is(tests.client_view() ->> 'state', 'setting_up', 'clients see nothing before planning is opened');
select is(tests.client_save(tests.k('section'), '{"q_name": "Papadopoulos"}') ->> 'status', 'unavailable', 'and cannot save custom answers');

-- ===========================================================================
-- Saving: incomplete answers save, invalid ones are refused
-- ===========================================================================
select tests.open_planning(tests.id('ev'));

select is((select x -> 'questions' from jsonb_array_elements(tests.client_view() -> 'structure' -> 'general') x where x ->> 'key' = tests.k('section')),
  (tests.item(tests.k('section'))).questions, 'once open, the client sees the questions');
select is(tests.client_save(tests.k('section'), '{"q_name": "  Papadopoulos ", "q_notes": ""}') -> 'answers', '{"q_name": "Papadopoulos"}'::jsonb,
  'an incomplete answer saves (only an optional question, trimmed; empty answers are left out)');
select is(tests.progress_item(tests.k('section')) - 'item_id' - 'requirements',
  jsonb_build_object('key', tests.k('section'), 'state', 'in_progress', 'met', 0, 'total', 3), 'progress counts the three required questions');

select is(tests.client_save(tests.k('section'), '{"q_style": "o_italian"}') ->> 'field', 'q:q_style', 'an option that isn''t offered is refused');
select is(tests.client_save(tests.k('section'), '{"q_style": ["o_greek"]}') ->> 'status', 'invalid', 'a single choice is one value');
select is(tests.client_save(tests.k('section'), '{"q_langs": ["o_en", "o_en"]}') ->> 'status', 'invalid', 'a multiple choice has no duplicates');
select is(tests.client_save(tests.k('section'), '{"q_hora": "yes"}') ->> 'message', 'Choose yes or no.', 'yes/no is a boolean');
select is(tests.client_save(tests.k('section'), '{"q_when": {"time": "25:00"}}') ->> 'message', 'Enter a time such as 18:30.', 'a time is HH:MM');
select is(tests.client_save(tests.k('section'), format('{"q_name": "%s"}', repeat('x', 501))::jsonb) ->> 'message',
  'Keep this under 500 characters.', 'a short answer has a limit');
select is(tests.client_save(tests.k('section'), '{"q_songs": [{"id": "6f1c1a52-2f41-4d8e-9a39-0d0d6f9a1a01", "title": "Zorba"}]}') ->> 'field',
  'song:6f1c1a52-2f41-4d8e-9a39-0d0d6f9a1a01:artist', 'songs are checked like every music list');
select is(tests.client_save(tests.k('section'), '{"q_songs": [{"id": "6f1c1a52-2f41-4d8e-9a39-0d0d6f9a1a01", "title": "Zorba", "artist": "Theodorakis", "link": "http://x"}]}') ->> 'field',
  'song:6f1c1a52-2f41-4d8e-9a39-0d0d6f9a1a01:link', 'song links must be https');
select is(tests.client_save(tests.k('section'), '{"q_unknown": "x"}') ->> 'message',
  'These questions were changed. Reload the page to see the latest version, then try again.', 'an answer to a question the item doesn''t have is refused');
select is(tests.answers(tests.k('section')), '{"q_name": "Papadopoulos"}'::jsonb, 'refused saves change nothing');

select is(tests.client_save(tests.k('section'), '{"q_name": "Papadopoulos", "q_style": "o_greek", "q_hora": false, "q_langs": ["o_fr", "o_en"],
    "q_when": {"time": "23:30", "next_day": false},
    "q_songs": [{"id": "6f1c1a52-2f41-4d8e-9a39-0d0d6f9a1a01", "title": " Zorba ", "artist": "Theodorakis", "notes": ""}]}') -> 'answers',
  '{"q_name": "Papadopoulos", "q_style": "o_greek", "q_hora": false, "q_langs": ["o_fr", "o_en"], "q_when": {"time": "23:30"},
    "q_songs": [{"id": "6f1c1a52-2f41-4d8e-9a39-0d0d6f9a1a01", "title": "Zorba", "artist": "Theodorakis"}]}'::jsonb,
  'every type saves in its normal form (No is an answer; an unchecked next day is left out)');
select is(tests.progress_item(tests.k('section')) -> 'state', '"complete"', 'all required questions answered: the section is complete');
select is(tests.progress_item(tests.k('section')) -> 'requirements',
  '[{"key": "q_style", "state": "answered"}, {"key": "q_songs", "state": "answered"}, {"key": "q_hora", "state": "answered"}]'::jsonb,
  'requirements are the required questions, in order');
select is(tests.client_save(tests.k('section'), '{"q_name": "Other"}', 1) ->> 'status', 'conflict', 'a stale revision is a conflict');
select is(tests.client_save(tests.k('section'), tests.answers(tests.k('section')), 1) ->> 'status', 'saved', 'a retried identical save is accepted');
select is(tests.staff_save(tests.k('section'), tests.answers(tests.k('section')) || '{"q_when": {"time": "00:30", "next_day": true}}') -> 'answers' -> 'q_when',
  '{"time": "00:30", "next_day": true}'::jsonb, 'staff save custom answers too, with a next-day time');

-- Items without required questions, and custom stages.
select is(tests.progress_item(tests.k('party_moment')) - 'item_id' - 'key',
  '{"state": "complete", "met": 0, "total": 0, "requirements": []}'::jsonb, 'optional questions never hold progress back');
select ok(tests.progress_item(tests.k('stage')) is null, 'a custom stage has no progress of its own');
select is(tests.progress_item(tests.k('moment')) -> 'total', '0', 'a moment with only optional questions adds nothing to the total');

-- ===========================================================================
-- History: renamed, reordered, removed questions and options
-- ===========================================================================
-- Rename q_name, move q_hora first, drop q_notes (never answered) and q_when (answered), drop option o_greek (chosen).
select lives_ok(format('select tests.set_questions(%L, %L)', tests.k('section'), '[
    {"id": "q_hora", "type": "yes_no", "label": "Will there be a hora?", "required": true},
    {"id": "q_style", "type": "single_choice", "label": "Which traditions should the music include?", "required": true,
     "options": [{"id": "o_lebanese", "label": "Lebanese"}, {"id": "o_none", "label": "None"}, {"id": "o_armenian", "label": "Armenian"}]},
    {"id": "q_songs", "type": "songs", "label": "Traditional songs", "required": true},
    {"id": "q_langs", "type": "multi_choice", "label": "Languages for announcements",
     "options": [{"id": "o_en", "label": "English"}, {"id": "o_gr", "label": "Greek"}]},
    {"id": "q_name", "type": "short_text", "label": "Family name, as announced"}
  ]'), 'staff rename, reorder and remove questions and options on an answered plan');
select is((select array_agg(q ->> 'id' || coalesce(':' || (q ->> 'archived'), '') order by o) from jsonb_array_elements((tests.item(tests.k('section'))).questions) with ordinality x(q, o)),
  array['q_hora', 'q_style', 'q_songs', 'q_langs', 'q_name', 'q_when:true'],
  'the new order, with the removed answered question kept (archived) and the unanswered one gone');
select is(tests.q((tests.item(tests.k('section'))).questions, 'q_style') -> 'options' -> 3, '{"id": "o_greek", "label": "Greek", "archived": true}'::jsonb,
  'a removed option an answer still chooses is kept, archived, with its label');
select is(tests.q((tests.item(tests.k('section'))).questions, 'q_langs') -> 'options' -> 2, '{"id": "o_fr", "label": "French", "archived": true}'::jsonb,
  'in multiple choices too');
select is(tests.q((tests.item(tests.k('section'))).questions, 'q_name') ->> 'label', 'Family name, as announced', 'renamed in place');
select is(tests.answers(tests.k('section')) ->> 'q_name', 'Papadopoulos', 'a renamed question keeps its answer');
select ok(tests.answers(tests.k('section')) ? 'q_when', 'a removed question''s answer is never deleted');
select is((select array_agg(q ->> 'id' order by o) from jsonb_array_elements((select x -> 'questions' from jsonb_array_elements(tests.client_view() -> 'structure' -> 'general') x
           where x ->> 'key' = tests.k('section'))) with ordinality y(q, o)),
  array['q_hora', 'q_style', 'q_songs', 'q_langs', 'q_name'], 'clients no longer see the removed question');
select is(tests.progress_item(tests.k('section')) -> 'total', '3', 'nor does it count toward progress');
select is(tests.client_save(tests.k('section'), tests.answers(tests.k('section')) || '{"q_when": {"time": "12:00"}}') -> 'answers' -> 'q_when',
  '{"time": "00:30", "next_day": true}'::jsonb, 'a removed question''s answer stays as stored whatever a save sends');
select is(tests.client_save(tests.k('section'), tests.answers(tests.k('section'))) -> 'answers' ->> 'q_style', 'o_greek',
  'a kept choice of a removed option still saves unchanged');
select is(tests.client_save(tests.k('section'), tests.answers(tests.k('section')) || '{"q_langs": ["o_fr", "o_gr"]}') -> 'answers' -> 'q_langs',
  '["o_fr", "o_gr"]'::jsonb, 'and a multiple choice keeps it while adding offered options');
select is(tests.client_save(tests.k('section'), tests.answers(tests.k('section')) || '{"q_style": "o_armenian"}') -> 'answers' ->> 'q_style', 'o_armenian',
  'switching to an offered option is fine');
select is(tests.client_save(tests.k('section'), tests.answers(tests.k('section')) || '{"q_style": "o_greek"}') ->> 'message',
  'That choice isn''t offered any more. Reload the page to see the current choices.', 'but a removed option can''t be chosen again');

select throws_like(format('select tests.set_questions(%L, %L)', tests.k('section'),
  '[{"id": "q_hora", "type": "short_text", "label": "Hora?"}]'), '%already has an answer, so its type can''t change%',
  'an answered question''s type can''t change');
select lives_ok(format('select tests.set_questions(%L, %L)', tests.k('moment'), (select jsonb_agg(
    case when x ->> 'type' = 'yes_no' then x || '{"type": "short_text"}' else x end) from jsonb_array_elements((tests.item(tests.k('moment'))).questions) x)),
  'an unanswered question''s type can');
select lives_ok(format('select tests.set_questions(%L, %L)', tests.k('section'), '[
    {"id": "q_hora", "type": "yes_no", "label": "Will there be a hora?", "required": true},
    {"id": "q_style", "type": "single_choice", "label": "Which traditions should the music include?", "required": true,
     "options": [{"id": "o_lebanese", "label": "Lebanese"}, {"id": "o_none", "label": "None"}, {"id": "o_armenian", "label": "Armenian"}]},
    {"id": "q_songs", "type": "songs", "label": "Traditional songs", "required": true},
    {"id": "q_langs", "type": "multi_choice", "label": "Languages for announcements",
     "options": [{"id": "o_en", "label": "English"}, {"id": "o_gr", "label": "Greek"}]},
    {"id": "q_name", "type": "short_text", "label": "Family name, as announced"},
    {"id": "q_when", "type": "time", "label": "Start of the cultural set"}
  ]'), 'a removed question can be asked again with its id');
select is(tests.q((tests.item(tests.k('section'))).questions, 'q_when'), '{"id": "q_when", "type": "time", "label": "Start of the cultural set", "required": false}'::jsonb,
  'it is no longer archived, and its answer is back in use');
select throws_ok(format('select tests.as_user(%L, format(%L, %L, %s, %L))', 'staff_a', 'select to_jsonb(public.set_event_plan_item_questions(%L, %s, %L))',
  (tests.item(tests.k('section'))).id, (tests.plan()).structure_version - 1, '[]'), 'PT409', null, 'a stale structure version is refused');
select throws_ok(format('select tests.set_questions(%L, %L, %L)', tests.k('section'), '[]', 'owner_b'), 'P0002', null,
  'staff of another business can''t change a plan''s questions');
select throws_ok(format('select tests.set_questions(%L, %L, %L)', tests.k('section'), '[]', 'client_y'), 'P0002', null, 'nor can clients');

-- Applying the template again: the plan's answered types are kept, answers untouched.
select tests.as_user('staff_a', format('select public.apply_event_plan_template(%L, %L, %s, true)', tests.id('ev'), tests.id('tpl'), (tests.plan()).structure_version));
select is(tests.q((tests.item(tests.k('section'))).questions, 'q_style') ->> 'type', 'single_choice',
  'applying a template that changed an answered question''s type keeps the plan''s type');
select is(tests.q((tests.item(tests.k('section'))).questions, 'q_style') ->> 'label', 'Changed later', 'while taking its new wording');
select is((select array_agg(q ->> 'id' order by o) from jsonb_array_elements((tests.item(tests.k('section'))).questions) with ordinality x(q, o)
           where q ->> 'archived' = 'true'), array['q_hora', 'q_songs', 'q_langs', 'q_name', 'q_when'],
  'and keeps every answered question the template no longer asks, archived');
select ok(tests.answers(tests.k('section')) ?& array['q_hora', 'q_style', 'q_songs', 'q_langs', 'q_name', 'q_when'], 'no answer is lost');

-- Event-only custom items, hiding and archiving.
select ok(tests.as_user('staff_a', format('select public.add_custom_event_plan_item(%L, %s, %L, %L, %L)', tests.id('ev'), (tests.plan()).structure_version,
  'moment', 'Money dance', 'party')) ->> 'key' ~ '^custom_', 'staff add a custom moment to one event''s plan');
select is((select i.questions from public.event_plan_items i where i.plan_id = (tests.plan()).id and i.label = 'Money dance' and i.parent_id = (tests.item('party')).id),
  '[]'::jsonb, 'under the chosen stage, with no questions yet');
select is((select count(*)::int from public.planning_template_items where template_id = tests.id('tpl') and label = 'Money dance'), 0, 'the template is unchanged');
select lives_ok(format('select tests.as_user(%L, format(%L, %L, %s))', 'staff_a', 'select to_jsonb(public.set_event_plan_item_enabled(%L, %s, false))',
  (tests.item(tests.k('section'))).id, (tests.plan()).structure_version), 'staff hide the custom section');
select is(tests.client_save(tests.k('section'), tests.answers(tests.k('section'))) ->> 'status', 'unavailable', 'a hidden custom section can''t be saved');
select ok(tests.answers(tests.k('section')) ? 'q_style', 'and keeps its answers');
select lives_ok(format('select tests.as_user(%L, format(%L, %L, %s))', 'staff_a', 'select to_jsonb(public.set_event_plan_item_enabled(%L, %s, true))',
  (tests.item(tests.k('section'))).id, (tests.plan()).structure_version), 'and restore it');
select lives_ok($$ select tests.as_user('staff_a', format('select public.set_event_archived(%L, true)', tests.id('ev'))) $$, 'staff archive the event');
select throws_like(format('select tests.set_questions(%L, %L)', tests.k('section'), '[]'), '%archived%', 'questions can''t change on an archived event');
select lives_ok($$ select tests.as_user('staff_a', format('select public.set_event_archived(%L, false)', tests.id('ev'))) $$, 'and unarchive it');

-- Closed client editing still applies.
select private.set_plan_cutoff_columns(tests.id('ev'), clock_timestamp() - interval '1 minute', null);
select is(tests.client_save(tests.k('party_moment'), '{"q_any": "Play Dalida"}') ->> 'status', 'locked', 'after the deadline custom answers are locked like any other');
select is(tests.staff_save(tests.k('party_moment'), '{"q_any": "Play Dalida"}') ->> 'status', 'saved', 'while staff keep editing');

select * from finish();
rollback;
