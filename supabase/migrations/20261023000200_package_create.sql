-- Creating a package and its included gear in one step.
--
-- Why a migration: the app inserted the package, then called
-- set_package_items. If the gear failed, a package was left without the
-- chosen gear; if the response was lost, a retry either failed on the key or,
-- with a changed name, created a second package. This function does both in
-- one transaction, so a failure leaves nothing behind, and it takes the new
-- package's id from the caller (generated once per form visit), so a retry
-- after a lost response returns the package already created instead of
-- creating another. Nothing existing changes; the direct insert and
-- set_package_items stay granted, so the previously deployed app keeps
-- working.
--
--   create_package  inserts the package (active, is_popular left at its
--                   default) and its included gear, [{"gear_item_id": uuid,
--                   "quantity": int}], each item once, quantity 1 to 100, in
--                   the same business (the table constraints enforce it).
--                   With an id that already exists in this business, it
--                   returns that package as replayed and changes nothing.
--
-- Staff of the business only (private.require_staff_of: others get
-- "not found", a suspended workspace gets workspace_suspended).

create function public.create_package(
  p_tenant_id uuid,
  p_package_id uuid,
  p_key text,
  p_name text,
  p_description text,
  p_base_price_cents bigint,
  p_tax_category text,
  p_sort_order integer,
  p_items jsonb
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
  if p_package_id is null then
    raise exception 'package_invalid: a request id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or exists (
       select 1 from jsonb_array_elements(p_items) i
       where jsonb_typeof(i) <> 'object'
          or exists (select 1 from jsonb_object_keys(i) k where k not in ('gear_item_id', 'quantity'))
          or coalesce(i ->> 'gear_item_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(i -> 'quantity') is distinct from 'number'
          or (i ->> 'quantity') !~ '^[0-9]+$'
     ) then
    raise exception 'package_invalid: items need a gear_item_id and a whole quantity' using errcode = 'invalid_parameter_value';
  end if;

  -- A retry of a request that already succeeded (its response was lost).
  select tenant_id into v_existing from public.packages where id = p_package_id;
  if found then
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_package_id, 'replayed', true);
  end if;

  insert into public.packages (id, tenant_id, key, name, description, base_price_cents, tax_category, sort_order)
  values (p_package_id, p_tenant_id, p_key, p_name, p_description, p_base_price_cents, p_tax_category, p_sort_order)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    -- The same request, committed concurrently.
    select tenant_id into v_existing from public.packages where id = p_package_id;
    if v_existing is distinct from p_tenant_id then
      raise exception 'not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', p_package_id, 'replayed', true);
  end if;

  insert into public.package_items (tenant_id, package_id, gear_item_id, quantity)
  select p_tenant_id, p_package_id, (i ->> 'gear_item_id')::uuid, (i ->> 'quantity')::int
  from jsonb_array_elements(p_items) i;

  return jsonb_build_object('id', p_package_id, 'replayed', false);
end;
$$;
comment on function public.create_package(uuid, uuid, text, text, text, bigint, text, integer, jsonb) is
  'Creates a package and its included gear atomically (staff of the business). An id that already exists in the business returns that package as replayed.';
revoke execute on function public.create_package(uuid, uuid, text, text, text, bigint, text, integer, jsonb) from public, anon;
grant execute on function public.create_package(uuid, uuid, text, text, text, bigint, text, integer, jsonb) to authenticated;
