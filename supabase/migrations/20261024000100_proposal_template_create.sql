-- Creating a proposal template with its packages, add-ons and questions in
-- one step.
--
-- Why a migration: the app inserted the template alone (its contents were
-- chosen afterwards), and that insert has no natural key, so a retry after a
-- lost response created a second template. Choosing the packages and
-- questions in the same form would also have split one action across two
-- writes. This function does it in one transaction and takes the new
-- template's id from the caller (generated once per form visit), so a retry
-- returns the template already created instead of creating another. Nothing
-- existing changes; the direct insert and set_proposal_template_composition
-- stay granted, so the previously deployed app keeps working.
--
--   create_proposal_template  inserts the template (active) and its contents
--                             through set_proposal_template_composition (the
--                             same rules: positions 1-3, each package once, a
--                             recommended package among them or none, add-ons
--                             and questions in the given order, all in the
--                             same business). With an id that already exists
--                             in this business, it returns that template as
--                             replayed and changes nothing.
--
-- Staff of the business only (private.require_staff_of: others get
-- "not found", a suspended workspace gets workspace_suspended).

create function public.create_proposal_template(
  p_tenant_id uuid,
  p_template_id uuid,
  p_name text,
  p_intro text,
  p_expiry_days integer,
  p_package_ids jsonb,
  p_default_package_id uuid,
  p_addons jsonb,
  p_question_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_inserted uuid;
begin
  perform private.require_staff_of(p_tenant_id);
  if p_template_id is null then
    raise exception 'template_invalid: a request id is required' using errcode = 'invalid_parameter_value';
  end if;

  -- A retry of a request that already succeeded (its response was lost).
  select tenant_id into v_existing from public.proposal_templates where id = p_template_id;
  if found then
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_template_id, 'replayed', true);
  end if;

  insert into public.proposal_templates (id, tenant_id, name, intro, expiry_days)
  values (p_template_id, p_tenant_id, p_name, p_intro, p_expiry_days)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    -- The same request, committed concurrently.
    select tenant_id into v_existing from public.proposal_templates where id = p_template_id;
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_template_id, 'replayed', true);
  end if;

  -- The template's contents, with the same checks as editing them.
  perform public.set_proposal_template_composition(p_template_id, p_package_ids, p_default_package_id, p_addons, p_question_ids);

  return jsonb_build_object('id', p_template_id, 'replayed', false);
end;
$$;
comment on function public.create_proposal_template(uuid, uuid, text, text, integer, jsonb, uuid, jsonb, jsonb) is
  'Creates a proposal template and its packages, add-ons and questions atomically (staff of the business). An id that already exists in the business returns that template as replayed.';
revoke execute on function public.create_proposal_template(uuid, uuid, text, text, integer, jsonb, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.create_proposal_template(uuid, uuid, text, text, integer, jsonb, uuid, jsonb, jsonb) to authenticated;
