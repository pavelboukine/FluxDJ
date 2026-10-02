-- Catalog integrity enforced by the database itself: cross-tenant composite
-- foreign keys, immutable keys, constrained logistics rules, template shape
-- and media metadata. Mostly run as a privileged role (RLS bypassed) to prove
-- the schema rejects bad data even when application code is wrong.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
select plan(42);

-- ---------------------------------------------------------------------------
-- Cross-tenant references
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.package_items (tenant_id, package_id, gear_item_id, quantity)
     values (tests.id('tenant_a'), tests.id('pkg_a_basic'), tests.id('gear_b_speaker'), 1) $$,
  '23503', null, 'package cannot include another tenant''s gear');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_mic'), '{"op":"equals","value":true}', tests.id('gear_b_speaker'), 1, 'x') $$,
  '23503', null, 'rule cannot require another tenant''s gear');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_b_ceremony'), '{"op":"equals","value":true}', tests.id('gear_a_speaker'), 1, 'x') $$,
  '23503', null, 'rule cannot use another tenant''s question');
select throws_ok(
  $$ insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
     values (tests.id('tenant_a'), tests.id('tmpl_a'), tests.id('pkg_b_basic'), 3) $$,
  '23503', null, 'template cannot offer another tenant''s package');
select throws_ok(
  $$ insert into public.proposal_template_addons (tenant_id, template_id, gear_item_id, max_quantity)
     values (tests.id('tenant_a'), tests.id('tmpl_a'), tests.id('gear_b_speaker'), 1) $$,
  '23503', null, 'template cannot recommend another tenant''s gear');
select throws_ok(
  $$ insert into public.proposal_template_questions (tenant_id, template_id, question_id)
     values (tests.id('tenant_a'), tests.id('tmpl_a'), tests.id('q_b_ceremony')) $$,
  '23503', null, 'template cannot ask another tenant''s question');
select throws_ok(
  $$ insert into public.gear_media (tenant_id, gear_item_id, storage_path, kind, content_type, alt_text)
     values (tests.id('tenant_a'), tests.id('gear_b_speaker'), tests.media_path('tenant_a', 'gear_b_speaker', 'obj_a', 'png'), 'image', 'image/png', 'x') $$,
  '23503', null, 'media cannot attach to another tenant''s gear');

-- Under RLS, using own tenant_id with a foreign child is still rejected.
select tests.login_as(tests.id('owner_a'));
select throws_ok(
  $$ insert into public.package_items (tenant_id, package_id, gear_item_id, quantity)
     values (tests.id('tenant_a'), tests.id('pkg_a_basic'), tests.id('gear_b_speaker'), 1) $$,
  '23503', null, 'owner A cannot reference tenant B gear even under own tenant_id');
reset role;

-- ---------------------------------------------------------------------------
-- Template default package must be one of the template's own packages.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.proposal_templates set default_package_id = tests.id('pkg_a_plus') where id = tests.id('tmpl_a2') $$,
  '23503', null, 'default package must be offered by the same template');
select throws_ok(
  $$ update public.proposal_templates set default_package_id = tests.id('pkg_b_basic') where id = tests.id('tmpl_a') $$,
  '23503', null, 'default package cannot belong to another tenant');
select throws_ok(
  $$ delete from public.proposal_template_packages where template_id = tests.id('tmpl_a') and package_id = tests.id('pkg_a_plus') $$,
  '23503', null, 'cannot remove the default package from its template without changing the default');
select throws_ok(
  $$ insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
     values (tests.id('tenant_a'), tests.id('tmpl_a2'), tests.id('pkg_a_plus'), 4) $$,
  '23514', null, 'a template offers at most three packages (positions 1-3)');
select throws_ok(
  $$ insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
     values (tests.id('tenant_a'), tests.id('tmpl_a2'), tests.id('pkg_a_plus'), 1) $$,
  '23505', null, 'package positions are unique within a template');
select throws_ok(
  $$ insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order)
     values (tests.id('tenant_a'), tests.id('tmpl_a'), tests.id('pkg_a_basic'), 3) $$,
  '23505', null, 'a package appears once per template');
select throws_ok(
  $$ update public.proposal_template_addons set recommended_quantity = 5 where template_id = tests.id('tmpl_a') $$,
  '23514', null, 'recommended addon quantity cannot exceed its maximum');

-- ---------------------------------------------------------------------------
-- Immutable stable keys and references.
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.gear_items set key = 'renamed' where id = tests.id('gear_a_speaker') $$,
  '23514', null, 'gear key is immutable');
select throws_ok($$ update public.packages set key = 'renamed' where id = tests.id('pkg_a_plus') $$,
  '23514', null, 'package key is immutable');
select throws_ok($$ update public.logistics_questions set answer_type = 'short_text', options = '[]' where id = tests.id('q_a_mic') $$,
  '23514', null, 'question answer type is immutable');
select throws_ok($$ update public.gear_media set storage_path = tests.media_path('tenant_a', 'gear_a_speaker', 'obj_b', 'jpg') where id = tests.id('media_a') $$,
  '23514', null, 'media storage path is immutable (no re-pointing sent media)');
select throws_ok($$ update public.package_items set gear_item_id = tests.id('gear_a_uplights') where package_id = tests.id('pkg_a_plus') $$,
  '23514', null, 'package item gear reference is immutable');

-- ---------------------------------------------------------------------------
-- Logistics questions and rules: explicit, constrained conditions only.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.logistics_questions (tenant_id, key, prompt, answer_type, options)
     values (tests.id('tenant_a'), 'venue', 'Venue type?', 'single_choice', '[]') $$,
  '23514', null, 'choice questions need options');
select throws_ok(
  $$ insert into public.logistics_questions (tenant_id, key, prompt, answer_type, options)
     values (tests.id('tenant_a'), 'venue', 'Venue type?', 'single_choice', '[{"value":"a","label":"A"},{"value":"a","label":"Again"}]') $$,
  '23514', null, 'option values must be unique');
select throws_ok(
  $$ insert into public.logistics_questions (tenant_id, key, prompt, answer_type, options)
     values (tests.id('tenant_a'), 'outdoor', 'Outdoor?', 'boolean', '[{"value":"yes","label":"Yes"}]') $$,
  '23514', null, 'boolean questions carry no options');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_ceremony'), '{"op":"expr","value":"answer == 1 or true"}', tests.id('gear_a_speaker'), 1, 'x') $$,
  '23514', null, 'arbitrary expression operators are rejected');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_ceremony'), '{"op":"equals","value":"same_room","js":"alert(1)"}', tests.id('gear_a_speaker'), 1, 'x') $$,
  '23514', null, 'extra condition keys are rejected');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_ceremony'), '{"op":"equals","value":"rooftop"}', tests.id('gear_a_speaker'), 1, 'x') $$,
  '23514', null, 'rule value must be one of the question''s options');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_mic'), '{"op":"equals","value":"yes"}', tests.id('gear_a_speaker'), 1, 'x') $$,
  '23514', null, 'boolean question rules compare to true/false');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_extras'), '{"op":"equals","value":"fog"}', tests.id('gear_a_speaker'), 1, 'x') $$,
  '23514', null, 'multi-choice rules use contains, not equals');
select throws_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_ceremony'), '{"op":"equals","value":"separate_space"}', tests.id('gear_a_speaker'), 0, 'x') $$,
  '23514', null, 'required quantity must be positive');
select lives_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_ceremony'), '{"op":"in","values":["same_room","separate_space"]}', tests.id('gear_a_uplights'), 1, 'Ceremony décor lighting.') $$,
  'membership rule on a single-choice question is accepted');
select lives_ok(
  $$ insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
     values (tests.id('tenant_a'), tests.id('q_a_extras'), '{"op":"contains","value":"uplights"}', tests.id('gear_a_uplights'), 1, 'Requested uplights.') $$,
  'contains rule on a multi-choice question is accepted');
select throws_ok(
  $$ update public.logistics_rules set condition = '{"op":"equals","value":"nowhere"}' where id = tests.id('rule_a_ceremony') $$,
  '23514', null, 'editing a rule re-validates it against the question');
select throws_ok(
  $$ update public.logistics_questions set options = '[{"value":"none","label":"No ceremony"},{"value":"same_room","label":"Same room"}]'
     where id = tests.id('q_a_ceremony') $$,
  '23514', null, 'removing an option that a rule depends on is rejected');
select lives_ok(
  $$ update public.logistics_questions set options = options || '[{"value":"outdoors","label":"Outdoors"}]'
     where id = tests.id('q_a_ceremony') $$,
  'adding an option is allowed');

-- ---------------------------------------------------------------------------
-- Money, keys and media metadata.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.gear_items (tenant_id, key, name, default_price_cents) values (tests.id('tenant_a'), 'neg', 'Neg', -1) $$,
  '23514', null, 'gear price cannot be negative');
select throws_ok(
  $$ insert into public.packages (tenant_id, key, name, base_price_cents) values (tests.id('tenant_a'), 'neg', 'Neg', -100) $$,
  '23514', null, 'package price cannot be negative');
select throws_ok(
  $$ insert into public.gear_items (tenant_id, key, name, default_price_cents) values (tests.id('tenant_a'), 'additional_speaker', 'Dup', 1) $$,
  '23505', null, 'gear keys are unique per tenant');
select lives_ok(
  $$ insert into public.gear_items (tenant_id, key, name, default_price_cents) values (tests.id('tenant_b'), 'additional_speaker', 'Same key, other DJ', 1) $$,
  'the same key may exist in another tenant');
select throws_ok(
  $$ insert into public.package_items (tenant_id, package_id, gear_item_id, quantity) values (tests.id('tenant_a'), tests.id('pkg_a_basic'), tests.id('gear_a_speaker'), 0) $$,
  '23514', null, 'included quantity must be positive');
select throws_ok(
  $$ insert into public.gear_media (tenant_id, gear_item_id, storage_path, kind, content_type, alt_text)
     values (tests.id('tenant_a'), tests.id('gear_a_speaker'), tests.media_path('tenant_a', 'gear_a_speaker', 'obj_b', 'jpg'), 'video', 'image/jpeg', 'x') $$,
  '23514', null, 'media kind must match content type');
select throws_ok(
  $$ insert into public.gear_media (tenant_id, gear_item_id, storage_path, kind, content_type, alt_text)
     values (tests.id('tenant_a'), tests.id('gear_a_speaker'), tests.media_path('tenant_a', 'gear_a_speaker', 'obj_b', 'png'), 'image', 'image/jpeg', 'x') $$,
  '23514', null, 'file extension must match content type');
select throws_ok(
  $$ insert into public.gear_media (tenant_id, gear_item_id, storage_path, kind, content_type, alt_text)
     values (tests.id('tenant_a'), tests.id('gear_a_speaker'), 'shared/speaker.jpg', 'image', 'image/jpeg', 'x') $$,
  '23514', null, 'media path must be under the tenant and gear item');

select * from finish();
rollback;
