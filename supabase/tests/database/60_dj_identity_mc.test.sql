-- DJ identity and planning question refinements (20261121000100): the
-- business and event DJ names (shape, who may set them, isolation), the
-- client view's resolved dj_name (event, else business, else null, never the
-- display name), MC duties shared with another MC (name needed, details
-- kept), legacy "No MC" and "Occasional announcements" answers still valid,
-- the new "A little interaction" choice, and saved answers left untouched.
begin;
\ir _fixtures.psql
select plan(35);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('dj-identity-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tests.new_event(name text) returns uuid language plpgsql as $$
begin
  insert into public.events (id, tenant_id, title, event_type, event_date) values (tests.id(name), tests.id('tenant_a'), name, 'wedding', '2027-09-01');
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  perform set_config('flux.booking_event', tests.id(name)::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id(name);
  perform set_config('flux.booking_event', '', true);
  return tests.id(name);
end $$;
create function tests.item(event text, item_key text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(event) and i.key = item_key;
$$;
create function tests.rev(event text, item_key text) returns int language sql stable as $$
  select coalesce((select revision from public.event_plan_responses where item_id = tests.item(event, item_key)), 0);
$$;
create function tests.save(event text, item_key text, answers jsonb, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb; v_rev int := tests.rev(event, item_key); v_item uuid := tests.item(event, item_key);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_save_plan_item(tests.id(event), 'test-bouprod', v_item, v_rev, answers);
  perform tests.su();
  return r;
end $$;
create function tests.view(event text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id('client_y'));
  r := public.client_planning_view(tests.id(event), 'test-bouprod');
  perform tests.su();
  return r;
end $$;
create function tests.reqs(result jsonb, item_key text) returns text[] language sql immutable as $$
  select array_agg((q ->> 'key') || ':' || (q ->> 'state') || case when (q ->> 'discuss')::boolean then ':discuss' else '' end order by o)
  from jsonb_array_elements(result -> 'progress' -> 'items') i, jsonb_array_elements(i -> 'requirements') with ordinality as x(q, o)
  where i ->> 'key' = item_key;
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select public.update_planning_template(t.id, t.version, t.name, t.description, 'wedding')
from public.planning_templates t where t.tenant_id = tests.id('tenant_a') and t.starter_key = 'wedding';
select tests.su();
select tests.new_event('dj_wed');

-- ===========================================================================
-- DJ names
-- ===========================================================================
select throws_ok($$ update public.tenants set dj_name = '  ' where id = tests.id('tenant_a') $$, '23514', null, 'a blank business DJ name is refused by the table');
select throws_ok($$ update public.events set dj_name = ' DJ Sam' where id = tests.id('dj_wed') $$, '23514', null, 'an untrimmed event DJ name is refused by the table');

select is(tests.view('dj_wed') -> 'dj_name', 'null'::jsonb, 'with no DJ name anywhere, the client view has none (planning then says "your DJ")');
select is(tests.view('dj_wed') -> 'brand' ->> 'display_name', 'BOUPROD', 'the business display name stays the brand');

select tests.login_as(tests.id('owner_a'));
select is(public.update_planning_dj_name(tests.id('tenant_a'), '  DJ   Boukine '), 'DJ Boukine', 'the owner sets the business DJ name, trimmed and collapsed');
select tests.su();
select is((select dj_name from public.tenants where id = tests.id('tenant_a')), 'DJ Boukine', 'it is stored on the business');
select is((select metadata from public.audit_events where entity_id = tests.id('tenant_a') and action = 'dj_name_changed' order by occurred_at desc limit 1),
  '{"set": true}'::jsonb, 'the change is audited without the name');
select is(tests.view('dj_wed') ->> 'dj_name', 'DJ Boukine', 'the client view names the business DJ when the event names none');

select tests.login_as(tests.id('staff_a'));
select throws_ok($$ select public.update_planning_dj_name(tests.id('tenant_a'), 'DJ Staff') $$, '42501', null, 'staff cannot change the business DJ name');
select tests.login_as(tests.id('owner_b'));
select throws_ok($$ select public.update_planning_dj_name(tests.id('tenant_a'), 'DJ Other') $$, 'P0002', null, 'another business cannot change it');
select tests.login_as(tests.id('client_y'));
select throws_ok($$ select public.update_planning_dj_name(tests.id('tenant_a'), 'DJ Client') $$, 'P0002', null, 'a client cannot change it');
select throws_ok($$ update public.tenants set dj_name = 'DJ Client' where id = tests.id('tenant_a') $$, '42501', null, 'nobody writes the business DJ name directly');
select tests.login_as(tests.id('owner_a'));
select throws_like($$ select public.update_planning_dj_name(tests.id('tenant_a'), repeat('x', 81)) $$, '%under 80 characters%', 'a name over 80 characters is refused');
select tests.su();
select is((select dj_name from public.tenants where id = tests.id('tenant_a')), 'DJ Boukine', 'refused changes leave the name as it was');

-- The event's own DJ: staff of the business only.
select tests.login_as(tests.id('staff_a'));
select lives_ok($$ update public.events set dj_name = 'DJ Sam' where id = tests.id('dj_wed') $$, 'staff name the DJ handling an event');
select tests.login_as(tests.id('owner_b'));
update public.events set dj_name = 'DJ Intruder' where id = tests.id('dj_wed');
select tests.login_as(tests.id('client_y'));
update public.events set dj_name = 'DJ Client' where id = tests.id('dj_wed');
select tests.su();
select is((select dj_name from public.events where id = tests.id('dj_wed')), 'DJ Sam', 'another business and the client cannot change it');
select is(tests.view('dj_wed') ->> 'dj_name', 'DJ Sam', 'the event''s DJ overrides the business DJ in the client view');

select tests.login_as(tests.id('owner_a'));
select is(public.update_planning_dj_name(tests.id('tenant_a'), '   '), null, 'an empty name clears the business DJ name');
select tests.login_as(tests.id('staff_a'));
update public.events set dj_name = null where id = tests.id('dj_wed');
select tests.su();
select is(tests.view('dj_wed') -> 'dj_name', 'null'::jsonb, 'cleared names fall back to none, never to the display name');

-- ===========================================================================
-- MC duties
-- ===========================================================================
select is(tests.reqs(tests.save('dj_wed', 'mc', '{"mc":"shared"}'), 'mc'), array['mc:unanswered'], 'shared duties need the other MC''s name');
select tests.save('dj_wed', 'mc', '{"mc":"shared","name":"  Kiara Okafor ","contact":"kiara@example.test","notes":"Kiara does the speeches"}') as s \gset mc_
select is(tests.reqs(:'mc_s'::jsonb, 'mc'), array['mc:answered'], 'with the name, shared duties are answered');
select is(:'mc_s'::jsonb -> 'answers', '{"mc":"shared","name":"Kiara Okafor","contact":"kiara@example.test","notes":"Kiara does the speeches"}'::jsonb,
  'shared duties keep the other MC''s name and contact');
select is(tests.save('dj_wed', 'mc', '{"mc":"other","name":"Kiara Okafor"}') -> 'answers', '{"mc":"other","name":"Kiara Okafor"}'::jsonb, 'someone else as MC is unchanged');
select is(tests.save('dj_wed', 'mc', '{"mc":"dj","name":"Kiara Okafor","contact":"kiara@example.test"}') -> 'answers', '{"mc":"dj"}'::jsonb,
  'the DJ as MC keeps no other MC''s details');
select is(tests.reqs(tests.save('dj_wed', 'mc', '{"mc":"discuss"}'), 'mc'), array['mc:unanswered:discuss'], '"discuss" stays open');
select is(tests.save('dj_wed', 'mc', '{"mc":"shared","name":"Kiara","pronunciation":"kee-AR-ah"}') -> 'answers' ->> 'pronunciation', 'kee-AR-ah',
  'an earlier pronunciation guide saved back with shared duties is kept');
select is(tests.save('dj_wed', 'mc', '{"mc":"cohost"}') ->> 'field', 'mc', 'unknown choices are refused');

-- A legacy "No MC" answer: stored as it was, still valid and not applicable, until changed.
update public.event_plan_responses set answers = '{"mc":"none","notes":"No announcements"}'::jsonb where item_id = tests.item('dj_wed', 'mc');
select is(tests.reqs(tests.view('dj_wed'), 'mc'), array['mc:not_applicable'], 'a saved "No MC" still reads as not applicable');
select is((select answers from public.event_plan_responses where item_id = tests.item('dj_wed', 'mc')), '{"mc":"none","notes":"No announcements"}'::jsonb,
  'reading never rewrites it');
select is(tests.save('dj_wed', 'mc', '{"mc":"none","notes":"No announcements, please"}') -> 'answers', '{"mc":"none","notes":"No announcements, please"}'::jsonb,
  'saving other changes with "No MC" still selected keeps it');
select is(tests.save('dj_wed', 'mc', '{"mc":"shared","name":"Kiara"}') -> 'answers', '{"mc":"shared","name":"Kiara"}'::jsonb, 'and it can be updated to a current choice');

-- ===========================================================================
-- DJ microphone interaction
-- ===========================================================================
select is(tests.save('dj_wed', 'dj_preferences', '{"interaction":"a_little"}') -> 'answers', '{"interaction":"a_little"}'::jsonb, '"A little interaction" is saved');
select is((tests.reqs(tests.view('dj_wed'), 'dj_preferences'))[1], 'interaction:answered', 'and answers the question');
select is(tests.save('dj_wed', 'dj_preferences', '{"interaction":"occasional","lyrics":"clean"}') -> 'answers', '{"interaction":"occasional","lyrics":"clean"}'::jsonb,
  'a legacy "Occasional announcements" answer still saves with other changes');
select is(tests.save('dj_wed', 'dj_preferences', '{"interaction":"chatty"}') ->> 'field', 'interaction', 'unknown interaction choices are refused');

select * from finish();
rollback;
