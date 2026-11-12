-- Optional gradient branding: a business's accent colour and an explicit
-- "use a gradient" preference, both inside tenants.brand_colors.
--
--   {"primary": "#RRGGBB", "accent": "#RRGGBB", "gradient": "on"}
--
-- Why a preference and not "an accent is set": brand_colors has always allowed
-- an accent, so businesses and frozen proposals can already hold one that was
-- never a choice about gradients. The preference is therefore its own key, and
-- only "on" is stored: absent means solid, which is every business today.
--
-- It lives in brand_colors, not in a column, because send_proposal freezes that
-- whole object into the offer snapshot. A proposal sent with a gradient keeps
-- it, one sent before keeps its solid colour, and no reader changes.
--
-- Emails and PDFs read only the primary colour and are unchanged.
--
-- update_tenant_branding gains two optional arguments. Omitted or null keeps the
-- current accent and preference, so the deployed app, which calls it with five
-- arguments, is unaffected. It is dropped and recreated because an overload
-- would make those calls ambiguous.

create or replace function private.is_valid_brand_colors(colors jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(colors) = 'object'
     and not exists (
       select 1
       from jsonb_each(colors) as e(key, value)
       where case
         when e.key = 'gradient' then e.value is distinct from '"on"'::jsonb
         when e.key in ('primary', 'accent', 'background', 'foreground', 'muted')
           then jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^#[0-9A-Fa-f]{6}$'
         else true
       end
     )
     -- A gradient always has its second colour.
     and (not colors ? 'gradient' or colors ? 'accent');
$$;

drop function public.update_tenant_branding(uuid, integer, uuid, text, integer);

create function public.update_tenant_branding(
  p_tenant_id uuid, p_expected_version integer, p_logo_id uuid, p_primary_color text, p_logo_size_percent integer default null,
  p_accent_color text default null, p_gradient boolean default null
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
  v_accent text := nullif(lower(btrim(coalesce(p_accent_color, ''))), '');
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
  if v_accent is not null and v_accent !~ '^#[0-9a-f]{6}$' then
    raise exception 'branding_invalid: the accent colour must be a hex value like #1a2b3c' using errcode = 'invalid_parameter_value';
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
  -- An accent is stored whenever one is given, so turning the gradient off keeps the owner's choice.
  if v_accent is not null then
    v_colors := v_colors || jsonb_build_object('accent', v_accent);
  end if;
  -- Null: a caller from before gradients existed. The preference stays as it is.
  if p_gradient then
    if not v_colors ? 'accent' then
      raise exception 'branding_invalid: choose an accent colour to use a gradient' using errcode = 'invalid_parameter_value';
    end if;
    v_colors := v_colors || jsonb_build_object('gradient', 'on');
  elsif p_gradient is not null then
    v_colors := v_colors - 'gradient';
  end if;
  v_size := coalesce(p_logo_size_percent, t.logo_size_percent);

  update public.tenants
    set logo_storage_path = v_path, brand_colors = v_colors, logo_size_percent = v_size, branding_version = branding_version + 1
    where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'branding_updated', 'staff', (select auth.uid()),
    jsonb_build_object('logo_changed', v_path is distinct from t.logo_storage_path, 'logo_storage_path', v_path,
                       'primary_color', v_color, 'accent_color', v_colors ->> 'accent', 'gradient', v_colors ? 'gradient',
                       'logo_size_percent', v_size, 'version', t.branding_version + 1));
  return t.branding_version + 1;
end;
$_$;
revoke execute on function public.update_tenant_branding(uuid, integer, uuid, text, integer, text, boolean) from public, anon;
grant execute on function public.update_tenant_branding(uuid, integer, uuid, text, integer, text, boolean) to authenticated, service_role;
