-- Tax settings, edited by the owner in Settings.
--
--   * tenants.tax_config (array of {code,label,rate_ppm}) and
--     tenants.tax_categories (category key -> list of codes) keep their
--     formats and check constraints. An empty list is an explicit "no tax"
--     category; a missing key is still an error when an offer is built.
--   * update_tax_settings is the only way to change them: owner only, both
--     columns replaced together, an optimistic version (tax_settings_version)
--     so a stale tab cannot overwrite newer settings, and readable errors.
--     The direct column grants are revoked, as for the legal identity.
--   * A category used by active gear or packages cannot be unmapped here,
--     and a tax cannot be removed while a category still lists it.
--   * Only new offers read these columns. Sent offers and contracts keep
--     their frozen snapshots and hashes; nothing here touches them.

alter table public.tenants
  add column tax_settings_version integer not null default 1
    constraint tenants_tax_settings_version_positive check (tax_settings_version >= 1);
comment on column public.tenants.tax_settings_version is
  'Optimistic version for update_tax_settings; increases by one on every tax settings change.';

revoke update (tax_config, tax_categories) on public.tenants from authenticated;

create function public.update_tax_settings(
  p_tenant_id uuid, p_expected_version integer, p_tax_config jsonb, p_tax_categories jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_tenant public.tenants%rowtype;
  v_config jsonb;
  v_bad text;
begin
  select m.role into v_role from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change tax settings' using errcode = 'insufficient_privilege';
  end if;

  select * into v_tenant from public.tenants where id = p_tenant_id for update;
  if v_tenant.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if p_expected_version is null or v_tenant.tax_settings_version <> p_expected_version then
    raise exception 'tax settings were changed elsewhere' using errcode = 'serialization_failure';
  end if;

  -- Taxes ---------------------------------------------------------------------
  if p_tax_config is null or jsonb_typeof(p_tax_config) <> 'array' then
    raise exception 'settings_invalid: the tax list is malformed' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_array_length(p_tax_config) > 5 then
    raise exception 'settings_invalid: at most 5 taxes can be configured' using errcode = 'invalid_parameter_value';
  end if;
  select string_agg(coalesce(t.item ->> 'label', '?'), ', ') into v_bad
  from jsonb_array_elements(p_tax_config) t(item)
  where jsonb_typeof(t.item) <> 'object'
     or jsonb_typeof(t.item -> 'code') <> 'string'
     or (t.item ->> 'code') !~ '^[A-Z0-9_]{1,16}$';
  if v_bad is not null then
    raise exception 'settings_invalid: invalid tax code for %', v_bad using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from jsonb_array_elements(p_tax_config) t(item)
             where jsonb_typeof(t.item -> 'label') <> 'string'
                or length(btrim(t.item ->> 'label')) not between 1 and 40) then
    raise exception 'settings_invalid: each tax needs a name of 1 to 40 characters' using errcode = 'invalid_parameter_value';
  end if;
  select string_agg(btrim(t.item ->> 'label'), ', ') into v_bad
  from jsonb_array_elements(p_tax_config) t(item)
  where jsonb_typeof(t.item -> 'rate_ppm') <> 'number'
     or (t.item ->> 'rate_ppm') !~ '^[0-9]+$'
     or (t.item ->> 'rate_ppm')::numeric > 1000000;
  if v_bad is not null then
    raise exception 'settings_invalid: the rate for % must be from 0%% to 100%% with at most 4 decimals', v_bad
      using errcode = 'invalid_parameter_value';
  end if;
  if (select count(distinct t.item ->> 'code') <> count(*) from jsonb_array_elements(p_tax_config) t(item)) then
    raise exception 'settings_invalid: tax codes must be unique' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(distinct lower(btrim(t.item ->> 'label'))) <> count(*) from jsonb_array_elements(p_tax_config) t(item)) then
    raise exception 'settings_invalid: two taxes have the same name' using errcode = 'invalid_parameter_value';
  end if;
  -- Store exactly {code,label,rate_ppm}, labels trimmed, in the given order.
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', t.item ->> 'code', 'label', btrim(t.item ->> 'label'), 'rate_ppm', (t.item ->> 'rate_ppm')::integer)
           order by t.ord), '[]'::jsonb)
    into v_config
  from jsonb_array_elements(p_tax_config) with ordinality t(item, ord);

  -- Categories ------------------------------------------------------------------
  if p_tax_categories is null or jsonb_typeof(p_tax_categories) <> 'object' then
    raise exception 'settings_invalid: the category mapping is malformed' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from jsonb_object_keys(p_tax_categories)) > 20 then
    raise exception 'settings_invalid: at most 20 tax categories can be configured' using errcode = 'invalid_parameter_value';
  end if;
  select string_agg(c.key, ', ') into v_bad
  from jsonb_each(p_tax_categories) c(key, codes)
  where not private.is_valid_key(c.key)
     or jsonb_typeof(c.codes) <> 'array'
     or exists (select 1 from jsonb_array_elements(c.codes) x(code) where jsonb_typeof(x.code) <> 'string')
     or (select count(distinct x.code) <> count(*) from jsonb_array_elements(c.codes) x(code));
  if v_bad is not null then
    raise exception 'settings_invalid: invalid tax category %', v_bad using errcode = 'invalid_parameter_value';
  end if;
  -- Every code a category lists must remain configured.
  select string_agg(distinct c.key || ' (' || (x.code #>> '{}') || ')', ', ') into v_bad
  from jsonb_each(p_tax_categories) c(key, codes), jsonb_array_elements(c.codes) x(code)
  where not exists (select 1 from jsonb_array_elements(v_config) t(item) where t.item ->> 'code' = x.code #>> '{}');
  if v_bad is not null then
    raise exception 'settings_invalid: these categories use a tax that is not configured: %', v_bad
      using errcode = 'invalid_parameter_value';
  end if;
  -- Categories in use by active gear or packages must stay mapped.
  select string_agg(distinct u.cat, ', ') into v_bad
  from (
    select g.tax_category as cat from public.gear_items g where g.tenant_id = p_tenant_id and g.active
    union
    select pk.tax_category from public.packages pk where pk.tenant_id = p_tenant_id and pk.active
  ) u
  where v_tenant.tax_categories ? u.cat and not (p_tax_categories ? u.cat);
  if v_bad is not null then
    raise exception 'settings_invalid: active gear or packages use these categories, so they must stay configured: %', v_bad
      using errcode = 'invalid_parameter_value';
  end if;

  update public.tenants
    set tax_config = v_config, tax_categories = p_tax_categories,
        tax_settings_version = tax_settings_version + 1
    where id = p_tenant_id;
  perform private.audit(p_tenant_id, 'tenant', p_tenant_id, 'tax_settings_updated', 'staff', (select auth.uid()),
    jsonb_build_object('tax_config', v_config, 'tax_categories', p_tax_categories,
                       'tax_settings_version', v_tenant.tax_settings_version + 1));
  return v_tenant.tax_settings_version + 1;
end;
$$;
revoke execute on function public.update_tax_settings(uuid, integer, jsonb, jsonb) from public, anon;
grant execute on function public.update_tax_settings(uuid, integer, jsonb, jsonb) to authenticated;
