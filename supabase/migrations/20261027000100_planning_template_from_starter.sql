-- Creating a planning template from the Wedding or Simple Party outline.
--
-- Why a migration: until now a business got the starter outlines only through
-- install_starter_planning_templates, which adds both starters at once, under
-- fixed names, and only once per business (starter_key is unique). A DJ who
-- wants a second wedding template ("Wedding (French)") or a party template
-- with their own name had to install both and duplicate one. This function
-- creates one ordinary template, named by staff, with the starter's items
-- (library default labels, the starter's order), in one transaction.
--
--   create_planning_template_from_starter(tenant, starter, name, description)
--     starter: 'wedding' | 'simple_party' (private.starter_planning_items).
--     description: optional; without one, the starter's own description.
--     The new template has no starter_key (it's a copy, so it doesn't count as
--     "the" installed starter) and no event-type default.
--
-- Nothing existing changes: the starter definitions, install, create and
-- duplicate keep their behavior, and plans never read templates again.
-- Staff of the business only (private.require_staff_of: others get
-- "not found", a suspended workspace gets workspace_suspended).

create function public.create_planning_template_from_starter(p_tenant_id uuid, p_starter text, p_name text, p_description text)
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
  if p_starter is null or p_starter not in ('wedding', 'simple_party') then
    perform private.planning_error('choose the Wedding or Simple Party outline');
  end if;
  select * into d from private.planning_template_details(
    p_name,
    coalesce(nullif(btrim(coalesce(p_description, '')), ''),
      case p_starter
        when 'wedding' then 'Ceremony to closing, in the order of the day. Rename or remove anything a couple doesn''t need.'
        else 'Event basics plus must-play and do-not-play songs. For birthdays and other simple parties.' end));
  insert into public.planning_templates (tenant_id, name, description) values (p_tenant_id, d.name, d.description)
  returning id into v_id;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, label, position)
  select p_tenant_id, v_id, l.kind, l.key, l.default_label, s.item_position
  from private.starter_planning_items(p_starter) s
  join private.planning_library() l on l.key = s.key
  where s.parent_key is null;
  insert into public.planning_template_items (tenant_id, template_id, kind, key, parent_id, label, position)
  select p_tenant_id, v_id, l.kind, l.key, p.id, l.default_label, s.item_position
  from private.starter_planning_items(p_starter) s
  join private.planning_library() l on l.key = s.key
  join public.planning_template_items p on p.template_id = v_id and p.key = s.parent_key
  where s.parent_key is not null;
  perform private.audit(p_tenant_id, 'planning_template', v_id, 'created', 'staff', (select auth.uid()),
    jsonb_build_object('starter', p_starter));
  return v_id;
end;
$$;

revoke execute on function public.create_planning_template_from_starter(uuid, text, text, text) from public, anon;
grant execute on function public.create_planning_template_from_starter(uuid, text, text, text) to authenticated;
