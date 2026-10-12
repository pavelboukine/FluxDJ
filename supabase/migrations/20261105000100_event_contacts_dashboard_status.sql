-- Stabilization: atomic event contacts, event-scoped contact removal, and the
-- dashboard's event status from the event's records.
--
--   add_event_contact     adds a client to an event, optionally as the
--                         primary contact and/or the signer, in one
--                         transaction under the event's row lock. The roles
--                         being taken are moved off their current holder in
--                         the same transaction, so a failure (a duplicate
--                         contact, an archived or foreign client) leaves the
--                         previous primary and signer exactly as they were.
--                         Taking the primary role names the primary the
--                         caller saw (p_expected_primary_client_id); if it
--                         changed meanwhile, nothing is written (PT409).
--                         Previously the app demoted the current primary and
--                         signer in one request and inserted in another.
--   remove_event_contact  removes one contact of one event: the row must
--                         belong to that event and business, so a contact of
--                         another event is never removed by a mismatched
--                         request.
--   staff_dashboard       unchanged except that each upcoming event also
--                         carries the active proposal's state (expired once
--                         past its expiry), whether a proposal draft exists
--                         and the current contract's status, as
--                         staff_event_list does, so the dashboard shows the
--                         same derived status as the events list. Every
--                         earlier key is unchanged.
--
-- Both contact functions are for staff of the business only
-- (private.require_staff_of: others get "not found", removed staff too, a
-- suspended workspace gets PT423) and are audited. Contacts stay editable on
-- archived events, as before; a contact never gains client access by being
-- added (access still comes only from a sent proposal or contract). Frozen
-- contracts are untouched: a contract keeps the signer it was generated with,
-- and the send check still reports a changed or missing signer. The direct
-- table grants stay so the previously deployed app keeps working.

create function public.add_event_contact(
  p_event_id uuid,
  p_client_id uuid,
  p_make_primary boolean default false,
  p_make_signer boolean default false,
  p_expected_primary_client_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  c public.clients%rowtype;
  v_primary uuid;
  v_id uuid;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  -- One contact change per event at a time: concurrent requests queue here.
  select * into e from public.events where id = p_event_id for update;

  select * into c from public.clients where tenant_id = e.tenant_id and id = p_client_id;
  if not found then
    raise exception 'contact_invalid: that client wasn''t found in this business' using errcode = 'invalid_parameter_value';
  end if;
  if c.archived_at is not null then
    raise exception 'contact_invalid: that client is archived; restore them first or choose another client' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.event_clients ec where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.client_id = c.id) then
    raise exception 'contact_invalid: % is already a contact on this event', c.name using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(p_make_primary, false) then
    select ec.client_id into v_primary from public.event_clients ec where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary;
    if v_primary is distinct from p_expected_primary_client_id then
      raise exception 'contact_conflict: the primary contact changed since this page was loaded; reload and try again' using errcode = 'PT409';
    end if;
    update public.event_clients set is_primary = false where tenant_id = e.tenant_id and event_id = e.id and is_primary;
  end if;
  if coalesce(p_make_signer, false) then
    update public.event_clients set can_sign = false where tenant_id = e.tenant_id and event_id = e.id and can_sign;
  end if;
  insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign)
  values (e.tenant_id, e.id, c.id, coalesce(p_make_primary, false), coalesce(p_make_signer, false))
  returning id into v_id;

  perform private.audit(e.tenant_id, 'event', e.id, 'contact_added', 'staff', (select auth.uid()),
    jsonb_build_object('client_id', c.id, 'primary', coalesce(p_make_primary, false), 'signer', coalesce(p_make_signer, false)));
  return jsonb_build_object('event_client_id', v_id);
end;
$$;
comment on function public.add_event_contact(uuid, uuid, boolean, boolean, uuid) is
  'Adds a client to an event (optionally as primary contact and/or signer) atomically, under the event lock. Staff of the business only.';
revoke execute on function public.add_event_contact(uuid, uuid, boolean, boolean, uuid) from public, anon;
grant execute on function public.add_event_contact(uuid, uuid, boolean, boolean, uuid) to authenticated;

create function public.remove_event_contact(p_event_id uuid, p_event_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
  r public.event_clients%rowtype;
begin
  select * into e from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = p_event_id for update;
  -- Only a contact of this event in this business.
  delete from public.event_clients
  where id = p_event_client_id and tenant_id = e.tenant_id and event_id = e.id
  returning * into r;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.audit(e.tenant_id, 'event', e.id, 'contact_removed', 'staff', (select auth.uid()),
    jsonb_build_object('client_id', r.client_id, 'primary', r.is_primary, 'signer', r.can_sign));
  return jsonb_build_object('removed', true);
end;
$$;
comment on function public.remove_event_contact(uuid, uuid) is
  'Removes one contact from one event (the row must belong to that event and business). Staff of the business only.';
revoke execute on function public.remove_event_contact(uuid, uuid) from public, anon;
grant execute on function public.remove_event_contact(uuid, uuid) to authenticated;

-- ===========================================================================
-- Dashboard: the records the derived event status needs (keys added only)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.staff_dashboard(p_tenant_id uuid, p_upcoming_limit integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_at timestamptz := now();
  v_limit integer := least(greatest(coalesce(p_upcoming_limit, 8), 1), 50);
  v_upcoming jsonb;
  v_more boolean;
  t public.tenants%rowtype;
begin
  perform private.require_staff_of(p_tenant_id);
  select * into t from public.tenants where id = p_tenant_id;

  with upcoming as (
    select e.id, e.title, e.event_date, e.timezone, e.venue_name, e.lifecycle_status,
           (select c.name from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
            where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary limit 1) as client_name,
           exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed') as contract_signed,
           (select case when ap.status = 'sent' and ap.expires_at is not null and ap.expires_at <= v_at then 'expired' else ap.status end
            from public.proposals ap where ap.tenant_id = e.tenant_id and ap.id = e.active_proposal_id) as proposal_status,
           exists (select 1 from public.proposals d where d.tenant_id = e.tenant_id and d.event_id = e.id and d.status = 'draft') as proposal_draft,
           (select k.status from public.contracts k
            where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status in ('signed', 'sent', 'draft')
            order by case k.status when 'signed' then 1 when 'sent' then 2 else 3 end limit 1) as contract_status
    from public.events e
    where e.tenant_id = p_tenant_id and e.archived_at is null
      and e.event_date >= (v_at at time zone e.timezone)::date
    order by e.event_date, e.title, e.id
    limit v_limit + 1
  )
  select coalesce(jsonb_agg(to_jsonb(u) order by u.event_date, u.title, u.id), '[]'::jsonb) into v_upcoming from upcoming u;
  v_more := jsonb_array_length(v_upcoming) > v_limit;
  if v_more then
    v_upcoming := v_upcoming - v_limit;
  end if;

  return jsonb_build_object(
    'now', v_at,
    'planning_window_days', 7,
    'upcoming', v_upcoming,
    'upcoming_more', v_more,
    'submitted', coalesce((
      select jsonb_agg(jsonb_build_object(
               'proposal_id', p.id, 'event_id', e.id, 'title', e.title, 'event_date', e.event_date, 'revision', p.revision,
               'submitted_at', (select max(s.submitted_at) from public.proposal_selections s where s.tenant_id = p.tenant_id and s.proposal_id = p.id))
             order by e.event_date, e.title)
      from public.proposals p
      join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id and e.active_proposal_id = p.id
      where p.tenant_id = p_tenant_id and p.status = 'submitted'
        and e.archived_at is null and e.lifecycle_status not in ('cancelled', 'completed')), '[]'::jsonb),
    'awaiting_deposit', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', e.id, 'title', e.title, 'event_date', e.event_date,
               'currency', s.summary ->> 'currency',
               'deposit_outstanding_cents', (s.summary ->> 'deposit_outstanding_cents')::bigint)
             order by e.event_date, e.title)
      from public.events e
      cross join lateral (select private.event_payment_summary(e.id) as summary) s
      where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'awaiting_deposit'), '[]'::jsonb),
    'booking_check', coalesce((
      select jsonb_agg(jsonb_build_object('event_id', e.id, 'title', e.title, 'event_date', e.event_date) order by e.event_date, e.title)
      from public.events e
      where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'awaiting_signature'
        and exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id
                    and k.status = 'signed' and k.booking_policy is null)), '[]'::jsonb),
    'planning', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', x.id, 'title', x.title, 'event_date', x.event_date, 'timezone', x.timezone,
               'state', x.state, 'deadline', x.deadline, 'closes_at', x.closes_at,
               'requirements_met', (x.progress ->> 'requirements_met')::int,
               'requirements_total', (x.progress ->> 'requirements_total')::int)
             order by coalesce(x.closes_at, x.deadline), x.title)
      from (
        select c.*, private.plan_progress(c.plan_id) as progress
        from (
          select e.id, e.title, e.event_date, e.timezone, ep.id as plan_id, d.deadline,
                 private.plan_editing_state(d.deadline, e.planning_override_until, v_at, e.planning_client_closed_at) as state,
                 case private.plan_editing_state(d.deadline, e.planning_override_until, v_at, e.planning_client_closed_at)
                   when 'open' then d.deadline
                   when 'reopened' then e.planning_override_until end as closes_at
          from public.events e
          join public.event_plans ep on ep.tenant_id = e.tenant_id and ep.event_id = e.id
          cross join lateral (select private.plan_deadline(e, ep) as deadline) d
          where e.tenant_id = p_tenant_id and e.archived_at is null and e.lifecycle_status = 'booked'
            and e.event_date >= (v_at at time zone e.timezone)::date
        ) c
        where c.state <> 'open' or c.deadline <= v_at + interval '7 days'
      ) x
      where (x.progress ->> 'requirements_met')::int < (x.progress ->> 'requirements_total')::int), '[]'::jsonb),
    'failed_emails', (select count(*) from public.email_outbox o where o.tenant_id = p_tenant_id and o.status = 'failed'),
    'setup', jsonb_build_object(
      'identity_saved', t.business_address is not null and t.contact_email is not null,
      'tax_categories', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(t.tax_categories) k), '[]'::jsonb),
      'used_tax_categories', coalesce((
        select jsonb_agg(distinct u.cat)
        from (select g.tax_category as cat from public.gear_items g where g.tenant_id = p_tenant_id and g.active
              union
              select pk.tax_category from public.packages pk where pk.tenant_id = p_tenant_id and pk.active) u), '[]'::jsonb),
      'active_packages', (select count(*) from public.packages pk where pk.tenant_id = p_tenant_id and pk.active),
      'usable_proposal_templates', (
        select count(*) from public.proposal_templates pt
        where pt.tenant_id = p_tenant_id and pt.active
          and (select count(*) from public.proposal_template_packages tp
               join public.packages pk on pk.tenant_id = tp.tenant_id and pk.id = tp.package_id and pk.active
               where tp.tenant_id = pt.tenant_id and tp.template_id = pt.id) = 3),
      'client_use_contract_templates', (
        select count(distinct ct.id) from public.contract_templates ct
        join public.contract_template_versions v on v.tenant_id = ct.tenant_id and v.template_id = ct.id
        where ct.tenant_id = p_tenant_id and ct.active and v.published_at is not null and v.usage = 'client_use')));
end;
$function$;
