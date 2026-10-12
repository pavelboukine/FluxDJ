-- Owner-editable reply-to address, and the reply-to frozen per email.
--
--   update_reply_to_email(tenant, address or null)
--     Owner only (checked here; staff get a permission error, others "not
--     found"), audited, validated with private.is_valid_email and
--     normalized to lower case; null or blank clears it. A suspended
--     workspace is refused by tenants_suspension_guard. The direct column
--     grant to signed-in users is revoked: it was never used by the app and
--     changed the address without an audit record.
--   Where it is used (unchanged): Reply-To of the business's client emails,
--     and the address staff notifications go to
--     (private.staff_notification_email; the owner's sign-in email otherwise).
--
--   freeze_email_branding now also records the reply-to at the email's first
--     attempt ("reply_to", null when none), so a retry is the same email even
--     if the owner changes the address meanwhile (Resend idempotency keys
--     need an identical request). Emails with a frozen sender (signed copies,
--     booking confirmations) keep the sender's reply-to. Rows frozen before
--     this migration have no "reply_to" key; the worker then uses the
--     business's current address, as before. Nothing else changes.

revoke update (reply_to_email) on public.tenants from authenticated;

create function public.update_reply_to_email(p_tenant_id uuid, p_reply_to text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  t public.tenants%rowtype;
  v_address text := nullif(lower(btrim(coalesce(p_reply_to, ''))), '');
begin
  select m.role into v_role from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid()) and m.removed_at is null;
  if v_role is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_role <> 'owner' then
    raise exception 'only the owner can change the reply-to address' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tenants where id = p_tenant_id for update;
  if t.archived_at is not null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if v_address is not null and (length(v_address) > 320 or not coalesce(private.is_valid_email(v_address), false)) then
    raise exception 'settings_invalid: enter a valid reply-to email address' using errcode = 'invalid_parameter_value';
  end if;
  if v_address is not distinct from t.reply_to_email then
    return v_address;
  end if;
  update public.tenants set reply_to_email = v_address where id = t.id;
  perform private.audit(t.id, 'tenant', t.id, 'reply_to_changed', 'staff', (select auth.uid()),
    jsonb_build_object('set', v_address is not null));
  return v_address;
end;
$$;
revoke execute on function public.update_reply_to_email(uuid, text) from public, anon;
grant execute on function public.update_reply_to_email(uuid, text) to authenticated;

-- Unchanged apart from also freezing the reply-to.
create or replace function public.freeze_email_branding(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.email_outbox%rowtype;
  v_name text;
  v_color text;
  v_path text;
  v_source text;
  v_logo jsonb;
  v_reply text;
  v_branding jsonb;
begin
  select * into o from public.email_outbox where id = p_id;
  if not found or o.tenant_id is null then
    return null;
  end if;
  if o.branding is not null then
    return o.branding;
  end if;

  if o.entity_type = 'proposal' then
    select p.offer_snapshot -> 'branding' ->> 'display_name', p.offer_snapshot -> 'branding' -> 'brand_colors' ->> 'primary',
           p.offer_snapshot -> 'branding' ->> 'logo_storage_path', 'proposal'
      into v_name, v_color, v_path, v_source
    from public.proposals p
    where p.tenant_id = o.tenant_id and p.id = o.entity_id and p.offer_snapshot ? 'branding';
  end if;
  if v_source is null then
    select t.display_name, t.brand_colors ->> 'primary', t.logo_storage_path, 'business'
      into v_name, v_color, v_path, v_source
    from public.tenants t where t.id = o.tenant_id;
  end if;
  -- Only a registered logo of this business (never another business's file).
  if v_path is not null then
    select jsonb_build_object('path', l.storage_path, 'needs_dark_background', l.needs_dark_background, 'width', l.width, 'height', l.height)
      into v_logo
    from public.tenant_logos l where l.tenant_id = o.tenant_id and l.storage_path = v_path;
  end if;
  -- A frozen sender's reply-to wins; otherwise the business's address now.
  v_reply := case when o.sender ? 'reply_to' then o.sender ->> 'reply_to'
                  else (select t.reply_to_email from public.tenants t where t.id = o.tenant_id) end;
  v_branding := jsonb_strip_nulls(jsonb_build_object(
    -- Emails with a frozen sender keep its display name, so header and sender agree.
    'display_name', coalesce(o.sender ->> 'display_name', v_name),
    'primary_color', v_color,
    'source', v_source,
    'logo', v_logo)) || jsonb_build_object('reply_to', v_reply);

  update public.email_outbox set branding = v_branding
    where id = o.id and branding is null and status = 'sending'
    returning branding into v_branding;
  -- Not claimed (or frozen meanwhile): return what is stored, if anything.
  return coalesce(v_branding, (select e.branding from public.email_outbox e where e.id = o.id));
end;
$$;
