-- Creating a planning template in one retry-safe step.
--
-- Why a migration: the create page chose between three functions
-- (create_planning_template, create_planning_template_from_starter and
-- duplicate_planning_template). None has a natural key, so a retry after a
-- lost response, a double submission or two concurrent submissions of the
-- same form created a second template. Like create_package and
-- create_proposal_template, this function takes the new template's id from
-- the caller (generated once per form visit) and does everything in one
-- transaction, so the same request returns the template already created.
-- Nothing existing changes: the three functions stay granted, so the
-- previously deployed app keeps working.
--
--   create_planning_template_once(tenant, template id, start, source, name, description)
--     start 'basics'                  Event basics only (as create_planning_template)
--     start 'wedding' | 'simple_party' the starter outline as a new named template
--                                     (as create_planning_template_from_starter;
--                                     an empty description takes the outline's)
--     start 'copy' with source        a copy of one of the business's templates
--                                     (as duplicate_planning_template: its labels,
--                                     order and description; p_description is ignored)
--     The new template is never "the" installed starter (no starter_key) and has
--     no event-type default. With an id that already exists in this business, it
--     returns that template as replayed and changes nothing, whatever the other
--     arguments (the first request wins, as for packages and proposal templates).
--
-- Staff of the business only (private.require_staff_of: others get
-- "not found", a suspended workspace gets workspace_suspended); a source
-- template from another business is "not found".

create function public.create_planning_template_once(
  p_tenant_id uuid,
  p_template_id uuid,
  p_start text,
  p_source_template_id uuid,
  p_name text,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position)
    select i.tenant_id, p_template_id, i.kind, i.key, i.label, i.position
    from public.planning_template_items i where i.template_id = v_source.id and i.parent_id is null;
    insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position)
    select i.tenant_id, p_template_id, i.kind, i.key, np.id, i.label, i.position
    from public.planning_template_items i
    join public.planning_template_items op on op.id = i.parent_id
    join public.planning_template_items np on np.template_id = p_template_id and np.key = op.key
    where i.template_id = v_source.id and i.parent_id is not null;
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
comment on function public.create_planning_template_once(uuid, uuid, text, uuid, text, text) is
  'Creates a planning template (Event basics only, a starter outline, or a copy) atomically (staff of the business). An id that already exists in the business returns that template as replayed.';
revoke execute on function public.create_planning_template_once(uuid, uuid, text, uuid, text, text) from public, anon;
grant execute on function public.create_planning_template_once(uuid, uuid, text, uuid, text, text) to authenticated;
