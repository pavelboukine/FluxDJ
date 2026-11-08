-- The deposit percentage and the legal identity become separate saves. Business
-- Settings shows them on different pages, so neither save may depend on, or
-- resubmit, the other's values:
--
--   update_deposit_percent     writes tenants.deposit_percent and nothing else.
--   update_business_identity   writes the legal name, address and contact email,
--                              and never the deposit.
--
-- Nothing reads these columns differently. Contracts still freeze the percentage
-- when they are generated, the send review still flags a draft whose percentage
-- no longer matches, and direct contracts still read the required deposit.
--
-- update_business_settings is unchanged: the deployed app calls it until this
-- release ships, because production gets the migration first. A later migration
-- can drop it once no deployed code calls it.

create function public.update_deposit_percent(p_tenant_id uuid, p_deposit_percent integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_role text;
  t public.tenants%rowtype;
begin
  -- Refuses non-members, removed members and suspended workspaces.
  v_membership_id := private.require_staff_of(p_tenant_id);
  select m.role into v_role from public.tenant_memberships m where m.id = v_membership_id;
  if v_role <> 'owner' then
    raise exception 'only the owner can change the deposit percentage' using errcode = 'insufficient_privilege';
  end if;
  if p_deposit_percent is null or p_deposit_percent not between 0 and 100 then
    raise exception 'settings_invalid: the deposit must be a whole percentage from 0 to 100' using errcode = 'invalid_parameter_value';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if t.deposit_percent = p_deposit_percent then
    return p_deposit_percent;
  end if;
  update public.tenants set deposit_percent = p_deposit_percent where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'deposit_percent_changed', 'staff', (select auth.uid()),
    jsonb_build_object('from', t.deposit_percent, 'to', p_deposit_percent));
  return p_deposit_percent;
end;
$$;
revoke execute on function public.update_deposit_percent(uuid, integer) from public, anon;
grant execute on function public.update_deposit_percent(uuid, integer) to authenticated, service_role;

create function public.update_business_identity(
  p_tenant_id uuid, p_legal_name text, p_business_address text, p_contact_email text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_role text;
  t public.tenants%rowtype;
begin
  -- Refuses non-members, removed members and suspended workspaces.
  v_membership_id := private.require_staff_of(p_tenant_id);
  select m.role into v_role from public.tenant_memberships m where m.id = v_membership_id;
  if v_role <> 'owner' then
    raise exception 'only the owner can change business settings' using errcode = 'insufficient_privilege';
  end if;
  if p_legal_name is null or length(btrim(p_legal_name)) not between 1 and 200 then
    raise exception 'settings_invalid: the legal business name must be 1 to 200 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_business_address is null or length(btrim(p_business_address)) not between 1 and 500 then
    raise exception 'settings_invalid: the business address must be 1 to 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_contact_email is null or not private.is_valid_email(lower(btrim(p_contact_email))) then
    raise exception 'settings_invalid: enter a valid contact email' using errcode = 'invalid_parameter_value';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  update public.tenants
    set business_name = btrim(p_legal_name), business_address = btrim(p_business_address),
        contact_email = lower(btrim(p_contact_email))
    where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'business_settings_updated', 'staff', (select auth.uid()), '{}'::jsonb);
end;
$$;
revoke execute on function public.update_business_identity(uuid, text, text, text) from public, anon;
grant execute on function public.update_business_identity(uuid, text, text, text) to authenticated, service_role;
