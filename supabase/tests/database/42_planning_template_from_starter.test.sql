-- Creating a named planning template from the Wedding or Simple Party outline:
-- the starter's items and order, an ordinary (non-starter) template, repeatable,
-- staff of the business only, and the installed starter untouched.
begin;
\ir _fixtures.psql
select plan(16);

create function tests.keys(p_template uuid, p_kind text) returns text[] language sql as $$
  select array_agg(i.key order by i.position) from public.planning_template_items i where i.template_id = p_template and i.kind = p_kind;
$$;
grant execute on function tests.keys(uuid, text) to authenticated;

select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select id as installed from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'wedding' \gset
select version as installed_version from public.planning_templates where id = :'installed' \gset

select public.create_planning_template_from_starter(tests.id('tenant_a'), 'wedding', '  Wedding (French) ', null) as fr \gset
select is((select array[name, coalesce(starter_key, 'none'), coalesce(default_event_type, 'none')] from public.planning_templates where id = :'fr'),
  array['Wedding (French)', 'none', 'none'], 'named (trimmed), not the installed starter, and no event-type default');
select ok((select description like 'Ceremony to closing%' from public.planning_templates where id = :'fr'), 'without a description it takes the outline''s');
select is(tests.keys(:'fr', 'stage'), tests.keys(:'installed', 'stage'), 'the stages and their order match the Wedding outline');
select is(tests.keys(:'fr', 'general'), array['basics', 'contacts_vendors', 'dj_preferences'], 'with the general sections in order');
select is((select count(*)::int from public.planning_template_items where template_id = :'fr' and kind = 'moment'),
          (select count(*)::int from public.planning_template_items where template_id = :'installed' and kind = 'moment'), 'and every moment');
select is((select array_agg(i.key order by i.position) from public.planning_template_items i join public.planning_template_items p on p.id = i.parent_id
           where i.template_id = :'fr' and p.key = 'ceremony'),
  array['ceremony_details', 'pre_ceremony_music', 'processional', 'ceremony_signing', 'recessional'], 'moments sit under their stage, in order (no separate Couple entrance)');
select is((select count(*)::int from public.planning_template_items where template_id = :'fr' and label <> (select l.default_label from private.planning_library() l where l.key = planning_template_items.key)),
  0, 'labels are the library defaults');
select is((select array_agg(key || ':' || label order by key) from public.planning_template_items where template_id = :'fr' and key in ('ceremony_details', 'cocktail_details', 'dinner_details', 'closing_instructions')),
  array['ceremony_details:Ceremony details', 'closing_instructions:Closing details', 'cocktail_details:Cocktail details', 'dinner_details:Dinner details'],
  'each stage''s details are named "<stage> details" (same keys as before)');
select is((select array_agg(i.key order by i.position) from public.planning_template_items i join public.planning_template_items p on p.id = i.parent_id
           where i.template_id = :'fr' and p.key = 'reception_entrance'), array['mc', 'introductions'],
  'the reception entrance holds MC and the grand entrance order only');
select is((select version from public.planning_templates where id = :'installed'), :installed_version, 'the installed starter is untouched');

select public.create_planning_template_from_starter(tests.id('tenant_a'), 'simple_party', 'Birthday', 'Small birthdays') as party \gset
select is(tests.keys(:'party', 'moment'), array['must_play', 'do_not_play'], 'Simple Party: must play, then do not play');
select is((select description from public.planning_templates where id = :'party'), 'Small birthdays', 'a given description is kept');
select lives_ok(format('select public.create_planning_template_from_starter(%L, %L, %L, null)', tests.id('tenant_a'), 'wedding', 'Wedding (English)'),
  'the same outline can be used again');

select throws_like(format('select public.create_planning_template_from_starter(%L, %L, %L, null)', tests.id('tenant_a'), 'gala', 'Gala'),
  '%Wedding or Simple Party%', 'only the two outlines exist');

select tests.login_as(tests.id('owner_b'));
select throws_ok(format('select public.create_planning_template_from_starter(%L, %L, %L, null)', tests.id('tenant_a'), 'wedding', 'Mine'),
  'P0002', 'not found', 'another business cannot create templates here');
select tests.login_as(tests.id('client_x'));
select throws_ok(format('select public.create_planning_template_from_starter(%L, %L, %L, null)', tests.id('tenant_a'), 'wedding', 'Mine'),
  'P0002', 'not found', 'nor can clients');

select * from finish();
rollback;
