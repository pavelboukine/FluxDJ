-- Branded emails and provider delivery feedback.
--
-- Branding (email_outbox.branding)
--   * Frozen per row at the first delivery attempt (freeze_email_branding,
--     service role), like the sender: every retry renders the same header,
--     colour and logo, so provider idempotency keys stay valid.
--   * Proposal emails use the branding frozen into the proposal's offer when
--     it was sent (offer_snapshot.branding); everything else uses the
--     business's branding at the first attempt. Platform emails have no
--     business and are never frozen here.
--   * Only the logo's storage path is recorded, always one of the business's
--     own registered logos (a foreign key makes tenants.logo_storage_path one;
--     the offer snapshot copied it). The worker reads the file server-side and
--     attaches a resized copy as an inline (CID) image; no URL is emailed.
--
-- Provider feedback (email_outbox.provider_status, provider_status_at,
-- provider_detail)
--   * "sent" keeps meaning the provider accepted the email. Delivery,
--     delays, bounces, complaints, provider failures and suppressions arrive
--     later from Resend webhooks (verified by the app) through
--     record_email_provider_event, matched by provider_message_id.
--   * The status only moves forward by rank (delayed < delivered < failed,
--     bounced, suppressed < complained), so duplicate and out-of-order events
--     change nothing. Opens and clicks are not recorded (scanners trigger them).
--   * Nothing retries automatically after a bounce: the worker only retries
--     failed submissions, and retry_email_outbox only failed rows.
-- Nothing existing changes meaning; older apps ignore the new columns.

alter table public.email_outbox
  add column branding jsonb
    constraint email_outbox_branding_object check (branding is null or jsonb_typeof(branding) = 'object'),
  add column provider_status text
    constraint email_outbox_provider_status_valid check (provider_status in ('delayed', 'delivered', 'failed', 'bounced', 'suppressed', 'complained')),
  add column provider_status_at timestamptz,
  add column provider_detail text
    constraint email_outbox_provider_detail_length check (length(provider_detail) <= 200),
  add constraint email_outbox_provider_status_complete check ((provider_status is null) = (provider_status_at is null));
comment on column public.email_outbox.branding is
  'Header branding frozen at the first delivery attempt: display_name, primary colour and the business''s own logo path. See freeze_email_branding.';
comment on column public.email_outbox.provider_status is
  'Latest delivery outcome reported by the provider''s webhooks after acceptance (status = sent). Null: only acceptance is known.';
create index email_outbox_provider_message_idx on public.email_outbox (provider_message_id) where provider_message_id is not null;

-- Once set, branding never changes (retries must render the same email).
create function private.email_outbox_branding_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.branding is not null and new.branding is distinct from old.branding then
    raise exception 'email_outbox.branding is frozen once set' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger email_outbox_branding_frozen before update of branding on public.email_outbox
  for each row execute function private.email_outbox_branding_frozen();

-- Returns the row's branding, freezing it first if this is its first attempt
-- (status "sending", i.e. claimed by this worker). Service role only.
create function public.freeze_email_branding(p_id uuid)
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
  v_branding := jsonb_strip_nulls(jsonb_build_object(
    -- Emails with a frozen sender keep its display name, so header and sender agree.
    'display_name', coalesce(o.sender ->> 'display_name', v_name),
    'primary_color', v_color,
    'source', v_source,
    'logo', v_logo));

  update public.email_outbox set branding = v_branding
    where id = o.id and branding is null and status = 'sending'
    returning branding into v_branding;
  -- Not claimed (or frozen meanwhile): return what is stored, if anything.
  return coalesce(v_branding, (select e.branding from public.email_outbox e where e.id = o.id));
end;
$$;
revoke execute on function public.freeze_email_branding(uuid) from public, anon, authenticated;
grant execute on function public.freeze_email_branding(uuid) to service_role;

-- Records a provider webhook event for the email it reported (service role,
-- after the app verified the webhook signature). Unknown ids are ignored
-- (another environment's emails, or emails purged later). Returns whether a
-- row's status changed.
create function public.record_email_provider_event(p_provider_message_id text, p_status text, p_occurred_at timestamptz, p_detail text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rank integer := case p_status when 'delayed' then 1 when 'delivered' then 2 when 'failed' then 3 when 'bounced' then 3
                                  when 'suppressed' then 3 when 'complained' then 4 end;
begin
  if p_provider_message_id is null or length(p_provider_message_id) not between 1 and 200 or v_rank is null or p_occurred_at is null then
    raise exception 'invalid provider event' using errcode = 'invalid_parameter_value';
  end if;
  update public.email_outbox o
    set provider_status = p_status, provider_status_at = p_occurred_at, provider_detail = left(nullif(btrim(p_detail), ''), 200)
    where o.provider_message_id = p_provider_message_id
      and (o.provider_status is null
           or v_rank > case o.provider_status when 'delayed' then 1 when 'delivered' then 2 when 'complained' then 4 else 3 end
           or (v_rank = 1 and o.provider_status = 'delayed' and p_occurred_at > o.provider_status_at));
  return found;
end;
$$;
revoke execute on function public.record_email_provider_event(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_email_provider_event(text, text, timestamptz, text) to service_role;
