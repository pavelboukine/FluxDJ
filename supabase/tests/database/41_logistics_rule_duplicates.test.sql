-- No two identical active logistics rules (trigger logistics_rules_no_duplicates):
-- inserts, edits and restores that would duplicate an active rule are refused,
-- "any of" order and a one-value "any of" don't matter, archived rules don't
-- count, distinct rules are allowed, and duplicates saved before the trigger
-- are left alone but can be archived or made distinct.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
select plan(12);

create function tests.add_rule(reason text, qty int default 1, cond jsonb default '{"op":"equals","value":"separate_space"}') returns uuid language sql as $$
  insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
  values (tests.id('tenant_a'), tests.id('q_a_ceremony'), cond, tests.id('gear_a_speaker'), qty, reason)
  returning id;
$$;
create function tests.active(r text) returns int language sql as $$
  select count(*)::int from public.logistics_rules where reason = r and active;
$$;

select lives_ok($$ select tests.add_rule('Needs a speaker') $$, 'a rule is added');
select throws_ok($$ select tests.add_rule('Needs a speaker') $$, '23505', 'rule_duplicate: an identical active rule already exists for this question',
  'an identical active rule is refused');
select throws_ok($$ select tests.add_rule('Needs a speaker', 1, '{"op":"in","values":["separate_space"]}') $$, '23505', null,
  'a one-value "any of" is the same as "is"');
select lives_ok($$ select tests.add_rule('Two rooms', 1, '{"op":"in","values":["same_room","separate_space"]}') $$, 'an "any of" rule');
select throws_ok($$ select tests.add_rule('Two rooms', 1, '{"op":"in","values":["separate_space","same_room"]}') $$, '23505', null,
  'the same "any of" in another order is refused');
select lives_ok($$ select tests.add_rule('Needs a speaker', 2) $$, 'a different quantity is a distinct rule');
select lives_ok($$ select tests.add_rule('Needs a speaker, again') $$, 'a different reason is a distinct rule');

-- Edits and restores.
select set_config('tests.r2', (select id::text from public.logistics_rules where reason = 'Needs a speaker' and required_quantity = 2), true);
select throws_ok($$ update public.logistics_rules set required_quantity = 1 where id = current_setting('tests.r2')::uuid $$, '23505', null,
  'editing a rule into a copy of another is refused');
update public.logistics_rules set active = false, required_quantity = 1 where id = current_setting('tests.r2')::uuid;
select throws_ok($$ update public.logistics_rules set active = true where id = current_setting('tests.r2')::uuid $$, '23505', null,
  'restoring an archived copy is refused');
select is(tests.active('Needs a speaker'), 1, 'one active rule remains');

-- Duplicates saved before the trigger.
set local session_replication_role = replica;
select tests.add_rule('Legacy') from generate_series(1, 2);
set local session_replication_role = origin;
select lives_ok($$ update public.logistics_rules set active = false where id = (select id from public.logistics_rules where reason = 'Legacy' limit 1) $$,
  'an earlier duplicate can be archived');
select is(tests.active('Legacy'), 1, 'and none is removed automatically');

select * from finish();
rollback;
