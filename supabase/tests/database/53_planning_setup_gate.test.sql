-- Planning awaiting setup: a plan booking created with Event basics only
-- (no default template) shows clients "setting up" with safe details only and
-- refuses their saves, while staff keep full access. Applying a template,
-- adding a section or setting planning up as staff ends it; answers are
-- kept. Archived events, other businesses, removed staff and suspended
-- workspaces stay refused; plans from a default template are unchanged.
begin;
\ir _fixtures.psql
select plan(33);

alter function tests.id(text) rename to id_base;
create function tests.id(name text) returns uuid language sql immutable as $$
  select coalesce(tests.id_base(name), md5('setup-gate-test-' || name)::uuid);
$$;
create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- An event for client Y in tenant A; `staff_setup` sets planning up (Event basics only) as staff first.
create function tests.ev(name text, staff_setup boolean default false) returns uuid language plpgsql as $$
declare v_event uuid := tests.id(name);
begin
  insert into public.events (id, tenant_id, title, event_type, event_date, timezone)
  values (tests.id(name), tests.id('tenant_a'), name, 'wedding', current_date + 120, 'America/Toronto');
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), true, true);
  insert into public.event_access (tenant_id, event_id, client_id, user_id) values (tests.id('tenant_a'), tests.id(name), tests.id('a_client_y'), tests.id('client_y'));
  if staff_setup then
    perform tests.login_as(tests.id('staff_a'));
    perform public.setup_event_plan(v_event, null);
    perform tests.su();
  end if;
  return tests.id(name);
end $$;
-- Booked as evaluate_booking does it (which also sets up the plan).
create function tests.book(name text) returns void language plpgsql as $$
begin
  perform set_config('flux.booking_event', tests.id(name)::text, true);
  update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = tests.id(name);
  perform set_config('flux.booking_event', '', true);
end $$;
create function tests.plan(event text) returns public.event_plans language sql stable as $$
  select * from public.event_plans where event_id = tests.id(event);
$$;
create function tests.basics(event text) returns uuid language sql stable as $$
  select i.id from public.event_plan_items i join public.event_plans p on p.id = i.plan_id where p.event_id = tests.id(event) and i.key = 'basics';
$$;
create function tests.rev(event text) returns int language sql stable as $$
  select coalesce((select revision from public.event_plan_responses where item_id = tests.basics(event)), 0);
$$;
create function tests.view(event text, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb; v_event uuid := tests.id(event);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_planning_view(v_event, 'test-bouprod');
  perform tests.su();
  return r;
end $$;
create function tests.save(event text, who text default 'client_y') returns jsonb language plpgsql as $$
declare r jsonb; v_event uuid := tests.id(event); v_item uuid := tests.basics(event); v_rev int := tests.rev(event);
begin
  perform tests.login_as(tests.id(who));
  r := public.client_save_plan_item(v_event, 'test-bouprod', v_item, v_rev, '{"guest_count":90}');
  perform tests.su();
  return r;
end $$;
create function tests.save_basics(event text) returns jsonb language plpgsql as $$
declare r jsonb; v_event uuid := tests.id(event); v_rev int := tests.rev(event);
begin
  perform tests.login_as(tests.id('client_y'));
  r := public.client_save_plan_basics(v_event, 'test-bouprod', v_rev, '{"guest_count":90}');
  perform tests.su();
  return r;
end $$;
-- Staff apply a template; errors propagate after resetting the role.
create function tests.apply(event text, template uuid, who text default 'staff_a') returns jsonb language plpgsql as $$
declare r jsonb; v_event uuid := tests.id(event); v_version int := (tests.plan(event)).structure_version;
begin
  perform tests.login_as(tests.id(who));
  r := public.apply_event_plan_template(v_event, template, v_version, true);
  perform tests.su();
  return r;
exception when others then
  perform tests.su();
  raise;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ===========================================================================
-- Booked with Event basics only (no default template): awaiting setup
-- ===========================================================================
select tests.ev('gate_basics'); select tests.book('gate_basics');
select is(array[(tests.plan('gate_basics')).origin, (tests.plan('gate_basics')).initialized_via], array['fallback', 'booking'],
  'booking without a default template sets planning up with Event basics only');
select is(tests.view('gate_basics') ->> 'state', 'setting_up', 'the client sees that planning is being set up');
select is((select array_agg(k order by k) from jsonb_object_keys(tests.view('gate_basics')) k), array['brand', 'event', 'state'],
  'with only the brand and event details: no structure, answers, editing or progress');
select is(tests.view('gate_basics') -> 'event' ->> 'title', 'gate_basics', 'the event details are the safe ones');
select is(tests.save('gate_basics') ->> 'status', 'unavailable', 'client_save_plan_item is refused');
select is(tests.save_basics('gate_basics') ->> 'status', 'unavailable', 'client_save_plan_basics is refused');
select is((select count(*)::int from public.event_plan_responses where plan_id = (tests.plan('gate_basics')).id), 0, 'and nothing is stored');

select tests.login_as(tests.id('staff_a'));
select ok(public.staff_planning_view(tests.id('gate_basics')) -> 'plan' is not null, 'staff still see the plan');
select is(public.staff_save_plan_item(tests.id('gate_basics'), tests.basics('gate_basics'), 0, '{"guest_count":120}') ->> 'status', 'saved',
  'staff can still fill Event basics');
select tests.su();
select is(tests.view('gate_basics') ->> 'state', 'setting_up', 'a staff answer alone doesn''t set planning up');
select is(tests.view('gate_basics', 'stranger') ->> 'state', 'unavailable', 'a user without access gets nothing, not "setting up"');
select is(tests.view('gate_basics', 'client_x') ->> 'state', 'unavailable', 'nor does a client of another event');
select is(public.client_planning_view(tests.id('gate_basics'), 'test-other-dj') ->> 'state', 'unavailable', 'or the wrong business slug');

-- ===========================================================================
-- Staff apply a template: planning is ready, answers kept
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select public.install_starter_planning_templates(tests.id('tenant_a'));
select tests.su();
select id as wedding from public.planning_templates where tenant_id = tests.id('tenant_a') and starter_key = 'wedding' \gset tpl_

select throws_ok(format('select tests.apply(%L, %L, %L)', 'gate_basics', :'tpl_wedding', 'owner_b'), 'P0002', null,
  'another business''s staff cannot set this event''s planning up');
select is(tests.apply('gate_basics', :'tpl_wedding') ->> 'status', 'applied', 'staff apply a template');
select is((tests.plan('gate_basics')).origin, 'template', 'the plan comes from the template now');
select is(tests.view('gate_basics') ->> 'state', 'available', 'the client sees the plan');
select ok(jsonb_array_length(tests.view('gate_basics') -> 'structure' -> 'stages') > 0, 'with the template''s stages');
select is((tests.view('gate_basics') -> 'basics' -> 'answers' ->> 'guest_count')::int, 120, 'Event basics answers are kept');
select is(tests.save('gate_basics') ->> 'status', 'saved', 'and the client can save');
select is(tests.save_basics('gate_basics') ->> 'status', 'saved', 'Event basics too');

-- Hiding everything again keeps it set up (the template was chosen).
update public.event_plan_items set disabled_at = now() where plan_id = (tests.plan('gate_basics')).id and key <> 'basics';
select is(tests.view('gate_basics') ->> 'state', 'available', 'a template-based plan is never "setting up" again');

-- ===========================================================================
-- Other ways planning is set up
-- ===========================================================================
select tests.ev('gate_staff_basics', true); select tests.book('gate_staff_basics');
select is(array[(tests.plan('gate_staff_basics')).origin, (tests.plan('gate_staff_basics')).initialized_via], array['fallback', 'staff'],
  'staff can choose Event basics only themselves');
select is(tests.view('gate_staff_basics') ->> 'state', 'available', 'which the client can fill');

select tests.ev('gate_added'); select tests.book('gate_added');
select tests.login_as(tests.id('staff_a'));
select public.add_event_plan_item(tests.id('gate_added'), (tests.plan('gate_added')).structure_version, 'party', null);
select tests.su();
select is(tests.view('gate_added') ->> 'state', 'available', 'adding a stage one by one also sets planning up');

update public.planning_templates set default_event_type = 'wedding' where id = :'tpl_wedding';
select tests.ev('gate_default'); select tests.book('gate_default');
select is((tests.plan('gate_default')).origin, 'template', 'booking with a default template copies it, as before');
select is(tests.view('gate_default') ->> 'state', 'available', 'and the client can plan at once');
update public.planning_templates set default_event_type = null where id = :'tpl_wedding';

select tests.ev('gate_unbooked');
select is(tests.view('gate_unbooked') ->> 'state', 'unavailable', 'an event that isn''t booked keeps its booking gate');

-- ===========================================================================
-- Archived events, removed staff, suspended workspaces
-- ===========================================================================
select tests.ev('gate_archived'); select tests.book('gate_archived');
select tests.login_as(tests.id('staff_a'));
select public.set_event_archived(tests.id('gate_archived'), true);
select tests.su();
select is(tests.view('gate_archived') ->> 'state', 'unavailable', 'an archived event is unavailable to the client');
select throws_like(format('select tests.apply(%L, %L)', 'gate_archived', :'tpl_wedding'), '%archived%',
  'and staff cannot set its planning up until it is unarchived');

select tests.ev('gate_removed'); select tests.book('gate_removed');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok(format('select tests.apply(%L, %L)', 'gate_removed', :'tpl_wedding'), 'P0002', null, 'removed staff cannot set planning up');
set local session_replication_role = replica;
update public.tenant_memberships set removed_at = null, removed_by = null where user_id = tests.id('staff_a') and tenant_id = tests.id('tenant_a');
update public.tenants set suspended_at = now() where id = tests.id('tenant_a');
set local session_replication_role = origin;
select throws_ok(format('select tests.apply(%L, %L)', 'gate_removed', :'tpl_wedding'), 'PT423', null, 'nor can staff of a suspended workspace');

select is(has_function_privilege('authenticated', 'private.plan_awaiting_setup(public.event_plans)', 'execute'), false,
  'clients and staff cannot call the setup check directly');

select * from finish();
rollback;
