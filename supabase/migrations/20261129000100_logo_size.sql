-- How large a business's logo appears in its workspace header and on live client
-- pages. A square logo has far less area than a wide wordmark at the same height, so
-- owners can raise the height limit. 100 means exactly today's limits, so every
-- existing business looks the same until its owner changes this.
--
-- The upper bound comes from the staff header: it is 56px tall, its largest default
-- height is 36px, and a light logo's dark plate adds 8px. 130% (47px + 8px) fits.
--
-- It is presentation only and nothing is frozen from it: proposals and emails keep
-- their own fixed sizes, so sent records don't change.
--
-- update_tenant_branding gains an optional argument. Omitted or null keeps the current
-- size, so the deployed app, which calls it with four arguments, is unaffected. It is
-- dropped and recreated because an overload would make those calls ambiguous.

alter table public.tenants
  add column logo_size_percent integer not null default 100
    constraint tenants_logo_size_percent_range check (logo_size_percent between 100 and 130);
comment on column public.tenants.logo_size_percent is
  'Logo height limit in the workspace header and on live client pages, as a percentage of each surface''s default.';

grant select (logo_size_percent) on public.tenants to authenticated;

drop function public.update_tenant_branding(uuid, integer, uuid, text);

create function public.update_tenant_branding(
  p_tenant_id uuid, p_expected_version integer, p_logo_id uuid, p_primary_color text, p_logo_size_percent integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $_$
declare
  v_role text;
  t public.tenants%rowtype;
  v_path text;
  v_color text := nullif(lower(btrim(coalesce(p_primary_color, ''))), '');
  v_colors jsonb;
  v_size integer;
begin
  select m.role into v_role from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change branding' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.suspended_at is not null then
    raise exception 'workspace_suspended: this workspace is suspended' using errcode = 'PT423';
  end if;
  if p_expected_version is distinct from t.branding_version then
    raise exception 'branding was changed elsewhere' using errcode = 'PT409';
  end if;
  if v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'branding_invalid: the colour must be a hex value like #1a2b3c' using errcode = 'invalid_parameter_value';
  end if;
  if p_logo_size_percent is not null and p_logo_size_percent not between 100 and 130 then
    raise exception 'branding_invalid: the logo size must be from 100%% to 130%%' using errcode = 'invalid_parameter_value';
  end if;
  if p_logo_id is not null then
    select l.storage_path into v_path from public.tenant_logos l where l.tenant_id = p_tenant_id and l.id = p_logo_id;
    if v_path is null then
      raise exception 'branding_invalid: that logo is not available' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  v_colors := case when v_color is null then t.brand_colors - 'primary' else t.brand_colors || jsonb_build_object('primary', v_color) end;
  v_size := coalesce(p_logo_size_percent, t.logo_size_percent);

  update public.tenants
    set logo_storage_path = v_path, brand_colors = v_colors, logo_size_percent = v_size, branding_version = branding_version + 1
    where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'branding_updated', 'staff', (select auth.uid()),
    jsonb_build_object('logo_changed', v_path is distinct from t.logo_storage_path, 'logo_storage_path', v_path,
                       'primary_color', v_color, 'logo_size_percent', v_size, 'version', t.branding_version + 1));
  return t.branding_version + 1;
end;
$_$;
revoke execute on function public.update_tenant_branding(uuid, integer, uuid, text, integer) from public, anon;
grant execute on function public.update_tenant_branding(uuid, integer, uuid, text, integer) to authenticated, service_role;

create or replace function public.public_tenant_brand(p_tenant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors,
           'logo_storage_path', l.storage_path, 'logo_needs_dark_background', l.needs_dark_background,
           'logo_width', l.width, 'logo_height', l.height, 'logo_size_percent', t.logo_size_percent)
  from public.tenants t
  left join public.tenant_logos l on l.tenant_id = t.id and l.storage_path = t.logo_storage_path
  where t.slug = p_tenant_slug and t.archived_at is null and t.suspended_at is null;
$$;
