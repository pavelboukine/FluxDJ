-- Creating a contract template in one retry-safe step.
--
-- Why a migration: create_contract_template has no natural key, so a retry
-- after a lost response, a double submission or two concurrent submissions of
-- the same form (writing a template, copying one, or creating one from an
-- imported Word document) created a second template. Like create_package,
-- create_proposal_template and create_planning_template_once, this function
-- takes the new template's id from the caller (generated once per form visit)
-- and creates the template and its first draft version in one transaction, so
-- the same request returns the template already created. Nothing existing
-- changes: create_contract_template stays granted, so the previously deployed
-- app keeps working.
--
--   create_contract_template_once(tenant, template id, name, title, sections)
--     Same checks and result as create_contract_template: a name of 1-200
--     characters, content valid for private.contract_template_problem (known
--     placeholders only), an active template with draft version 1. With an id
--     that already exists in this business, it returns that template as
--     replayed and changes nothing, whatever the other arguments (the first
--     request wins, as for packages and proposal and planning templates).
--
-- Staff of the business only (private.require_staff_of: others get
-- "not found", a suspended workspace gets workspace_suspended).

create function public.create_contract_template_once(
  p_tenant_id uuid,
  p_template_id uuid,
  p_name text,
  p_title text,
  p_sections jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_problem text;
  v_existing uuid;
  v_inserted uuid;
begin
  v_membership_id := private.require_staff_of(p_tenant_id);
  if p_template_id is null then
    perform private.contract_error('a request id is required');
  end if;

  -- A retry of a request that already succeeded (its response was lost).
  select tenant_id into v_existing from public.contract_templates where id = p_template_id;
  if found then
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_template_id, 'replayed', true);
  end if;

  if p_name is null or length(btrim(p_name)) not between 1 and 200 then
    perform private.contract_error('the name must be 1 to 200 characters');
  end if;
  v_problem := private.contract_template_problem(p_title, p_sections);
  if v_problem is not null then
    perform private.contract_error(v_problem);
  end if;

  insert into public.contract_templates (id, tenant_id, name, created_by_membership_id)
  values (p_template_id, p_tenant_id, btrim(p_name), v_membership_id)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    -- The same request, committed concurrently.
    select tenant_id into v_existing from public.contract_templates where id = p_template_id;
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_template_id, 'replayed', true);
  end if;

  insert into public.contract_template_versions (tenant_id, template_id, version_number, title, sections, created_by_membership_id)
  values (p_tenant_id, p_template_id, 1, btrim(p_title), p_sections, v_membership_id);
  return jsonb_build_object('id', p_template_id, 'replayed', false);
end;
$$;
comment on function public.create_contract_template_once(uuid, uuid, text, text, jsonb) is
  'Creates a contract template and its first draft version atomically (staff of the business). An id that already exists in the business returns that template as replayed.';
revoke execute on function public.create_contract_template_once(uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function public.create_contract_template_once(uuid, uuid, text, text, jsonb) to authenticated;
