-- Package archiving as an explicit, confirmed and audited action.
--
-- Why a migration: a package was archived by saving its details form with
-- "Active" unticked, a plain update that left no audit record. Archiving
-- now follows client and event archiving: one function that only changes
-- the package's active flag, records an audit event, and treats a repeat as
-- a no-op. Nothing existing changes; the direct update of packages.active
-- stays granted so the previously deployed app keeps working.
--
--   set_package_archived  archives or restores a package. It changes no
--                         included gear, proposal template, draft or sent
--                         proposal. Existing rules then apply: an archived
--                         package can't be chosen for templates or drafts in
--                         the app, and a proposal that offers it can't be
--                         previewed or sent (build_offer_snapshot refuses
--                         inactive packages). Sent proposals keep their
--                         frozen copy.
--
-- Staff of the business only (private.require_staff_of: others get
-- "not found", a suspended workspace gets workspace_suspended).

create function public.set_package_archived(p_package_id uuid, p_archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_package public.packages%rowtype;
  v_templates integer;
begin
  select * into v_package from public.packages where id = p_package_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_package.tenant_id);
  if p_archived is null then
    raise exception 'archive_invalid: choose archive or restore' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_package from public.packages where id = p_package_id for update;
  -- Already in the requested state (a repeated click or another tab): nothing changes.
  if p_archived = (not v_package.active) then
    return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', true);
  end if;
  update public.packages set active = not p_archived where id = v_package.id;
  select count(distinct tp.template_id) into v_templates
  from public.proposal_template_packages tp
  where tp.tenant_id = v_package.tenant_id and tp.package_id = v_package.id;
  perform private.audit(v_package.tenant_id, 'package', v_package.id, case when p_archived then 'package_archived' else 'package_restored' end,
    'staff', (select auth.uid()), jsonb_build_object('templates', v_templates));
  return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', false, 'templates', v_templates);
end;
$$;
comment on function public.set_package_archived(uuid, boolean) is
  'Archives or restores a package (staff of the business). Sets active only and audits it; included gear, templates and proposals are unchanged.';
revoke execute on function public.set_package_archived(uuid, boolean) from public, anon;
grant execute on function public.set_package_archived(uuid, boolean) to authenticated;
