-- A business's preference for whether a new event starts with the proposal step.
-- It only sets the starting value of a checkbox on Create event: no event stores
-- it or reads it later, so changing it never affects an existing event, and no
-- business is prevented from using proposals. Every existing business keeps today's
-- behaviour through the default. No function reads this for booking, contracts or
-- deposits.
--
-- Owners change it through update_proposal_default, like the booking policy. It
-- has no version: it is a single on/off preference, so the last save wins.

alter table public.tenants
  add column proposals_by_default boolean not null default true;
comment on column public.tenants.proposals_by_default is
  'Whether Create event starts with "Send a proposal first" on. A starting value only; each event still chooses for itself.';

grant select (proposals_by_default) on public.tenants to authenticated;

create function public.update_proposal_default(p_tenant_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_role text;
  t public.tenants%rowtype;
begin
  if p_enabled is null then
    raise exception 'settings_invalid: choose whether new events start with a proposal' using errcode = 'invalid_parameter_value';
  end if;
  -- Refuses non-members, removed members and suspended workspaces.
  v_membership_id := private.require_staff_of(p_tenant_id);
  select m.role into v_role from public.tenant_memberships m where m.id = v_membership_id;
  if v_role <> 'owner' then
    raise exception 'only the owner can change this setting' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if t.proposals_by_default = p_enabled then
    return p_enabled;
  end if;
  update public.tenants set proposals_by_default = p_enabled where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'proposal_default_changed', 'staff', (select auth.uid()), jsonb_build_object('proposals_by_default', p_enabled));
  return p_enabled;
end;
$$;
revoke execute on function public.update_proposal_default(uuid, boolean) from public, anon;
grant execute on function public.update_proposal_default(uuid, boolean) to authenticated, service_role;
