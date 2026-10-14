-- Creating a planning template in one retry-safe step (create_planning_template_once):
-- who may call it, what each starting point creates, and that the same id
-- returns the template already created. Concurrency is covered by
-- tests/integration/planning-template-create.test.ts.
begin;
\ir _fixtures.psql
select plan(22);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('planning-create-once-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.create(req text, start text, name text, source text default null, description text default null,
                             who text default 'staff_a', tenant text default 'tenant_a') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.create_planning_template_once(tests.id(tenant), tests.id(req), start, case when source is null then null else tests.id(source) end, name, description);
  perform tests.su();
  return r;
end $$;
create function tests.keys(req text, k text) returns text[] language sql as $$
  select array_agg(i.key order by i.position) from public.planning_template_items i where i.template_id = tests.id(req) and i.kind = k;
$$;
-- Each item as kind:parent key:position:key:label, fully ordered (positions repeat across stages).
create function tests.outline(req text) returns text[] language sql as $$
  select array_agg(x order by x) from (
    select i.kind || ':' || coalesce(p.key, '') || ':' || i.position || ':' || i.key || ':' || i.label as x
    from public.planning_template_items i left join public.planning_template_items p on p.id = i.parent_id
    where i.template_id = tests.id(req)) o;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Access ------------------------------------------------------------------------
select tests.login_as_anon();
select throws_ok($$ select public.create_planning_template_once(tests.id('tenant_a'), tests.id('req_anon'), 'basics', null, 'Anon', null) $$,
  '42501', null, 'anon cannot create a template');
select tests.su();
select throws_ok($$ select tests.create('req_b', 'wedding', 'Theirs', who => 'owner_b') $$, 'P0002', 'not found', 'another business cannot create one here');
select throws_ok($$ select tests.create('req_c', 'wedding', 'Mine', who => 'client_x') $$, 'P0002', 'not found', 'nor can a client');
select throws_like($$ select tests.create(null, 'wedding', 'No id') $$, '%a request id is required%', 'a request id is required');
select throws_like($$ select tests.create('req_bad', 'gala', 'Gala') $$, '%choose a starting point%', 'only the supported starting points');
select throws_like($$ select tests.create('req_long', 'basics', repeat('x', 121)) $$, '%1 to 120 characters%', 'names are validated as before');

-- Each starting point ---------------------------------------------------------------
select is(tests.create('req_wed', 'wedding', ' Wedding (French) '), jsonb_build_object('id', tests.id('req_wed'), 'replayed', false),
  'staff create a template from the Wedding outline');
select is((select array[name, coalesce(starter_key, 'none'), coalesce(default_event_type, 'none')] from public.planning_templates where id = tests.id('req_wed')),
  array['Wedding (French)', 'none', 'none'], 'named, not the installed starter, no default');
select ok((select description like 'Ceremony to closing%' from public.planning_templates where id = tests.id('req_wed')), 'with the outline''s description');
select is(tests.keys('req_wed', 'stage'), array['ceremony', 'cocktail', 'reception_entrance', 'dinner', 'special_dances', 'party', 'closing'],
  'the outline''s stages in order');
select is((select count(*)::int from public.planning_template_items where template_id = tests.id('req_wed') and kind = 'moment'), 26, 'and its moments');

select tests.create('req_party', 'simple_party', 'Birthday', description => 'Small birthdays');
select is(tests.keys('req_party', 'moment'), array['must_play', 'do_not_play'], 'Simple Party: must play, then do not play');
select is((select description from public.planning_templates where id = tests.id('req_party')), 'Small birthdays', 'a given description is kept');

select tests.create('req_basics', 'basics', 'Corporate');
select is((select array_agg(key) from public.planning_template_items where template_id = tests.id('req_basics')), array['basics'], 'Event basics only');

select tests.su();
update public.planning_template_items set label = 'Dance party' where template_id = tests.id('req_wed') and key = 'party';
select tests.create('req_copy', 'copy', 'Wedding (copy)', source => 'req_wed', description => 'ignored');
select is(tests.outline('req_copy'), tests.outline('req_wed'), 'a copy has the same items, labels, order and parents');
select is((select description from public.planning_templates where id = tests.id('req_copy')),
          (select description from public.planning_templates where id = tests.id('req_wed')), 'and keeps its description');
select throws_ok($$ select tests.create('req_copy_b', 'copy', 'Theirs', source => 'req_b_source') $$, 'P0002', 'not found', 'a missing source is not found');
select tests.su();
insert into public.planning_templates (id, tenant_id, name) values (tests.id('tpl_b'), tests.id('tenant_b'), 'Other DJ template');
select throws_ok($$ select tests.create('req_copy_foreign', 'copy', 'Theirs', source => 'tpl_b') $$, 'P0002', 'not found',
  'another business''s template cannot be copied');

-- The same request again --------------------------------------------------------------
select is(tests.create('req_wed', 'basics', 'Something else', description => 'Different'), jsonb_build_object('id', tests.id('req_wed'), 'replayed', true),
  'the same id, even with other inputs, returns the template already created');
select is((select name || '|' || (select count(*) from public.planning_template_items where template_id = tests.id('req_wed'))
           from public.planning_templates where id = tests.id('req_wed')), 'Wedding (French)|36', 'and changes nothing');
select throws_ok($$ select tests.create('req_wed', 'wedding', 'Claim', who => 'owner_b', tenant => 'tenant_b') $$, 'P0002', 'not found',
  'another business cannot claim the id');

-- Suspended workspace -------------------------------------------------------------
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select throws_like($$ select tests.create('req_suspended', 'wedding', 'Suspended') $$, '%workspace_suspended%', 'a suspended workspace cannot create templates');

select * from finish();
rollback;
