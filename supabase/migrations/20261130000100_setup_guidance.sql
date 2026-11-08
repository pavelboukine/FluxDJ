-- Which workflows the setup guide and the dashboard remind a business about.
--
--   proposals_and_contracts (default): proposal and contract setup.
--   contracts_only: contract setup only (a business that books directly).
--   none: no setup reminders (a business planning events booked elsewhere).
--
-- There is no "proposals without contracts": a proposal booking always ends in
-- a contract, so the three values are every coherent choice.
--
-- Guidance only. No function reads it for proposals, contracts, deposits,
-- bookings or planning, and it is independent of proposals_by_default (which
-- only pre-fills Create event). Each proposal and contract is still checked
-- when it's sent, whatever this says. Every existing business keeps today's
-- reminders through the default.
--
-- Owners change it through update_setup_guidance, like the proposal default:
-- a single choice with no version, so the last save wins.

alter table public.tenants
  add column setup_guidance text not null default 'proposals_and_contracts',
  add constraint tenants_setup_guidance_valid check (setup_guidance in ('proposals_and_contracts', 'contracts_only', 'none'));
comment on column public.tenants.setup_guidance is
  'Which workflows setup reminders cover: proposals_and_contracts (default), contracts_only or none. Guidance only: never read for sending, booking or planning.';

grant select (setup_guidance) on public.tenants to authenticated;

create function public.update_setup_guidance(p_tenant_id uuid, p_guidance text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_role text;
  t public.tenants%rowtype;
begin
  if p_guidance is null or p_guidance not in ('proposals_and_contracts', 'contracts_only', 'none') then
    raise exception 'settings_invalid: choose your setup guidance' using errcode = 'invalid_parameter_value';
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
  if t.setup_guidance = p_guidance then
    return p_guidance;
  end if;
  update public.tenants set setup_guidance = p_guidance where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'setup_guidance_changed', 'staff', (select auth.uid()),
    jsonb_build_object('from', t.setup_guidance, 'to', p_guidance));
  return p_guidance;
end;
$$;
revoke execute on function public.update_setup_guidance(uuid, text) from public, anon;
grant execute on function public.update_setup_guidance(uuid, text) to authenticated, service_role;
