-- Staff dashboard: what's coming up and what needs attention, in one read.
--
-- public.staff_dashboard(p_tenant_id, p_upcoming_limit) returns facts only;
-- the app words them (src/lib/dashboard.ts). It is STABLE: it cannot change
-- event state, set up plans, confirm bookings, queue jobs or send email
-- (Postgres refuses writes inside a non-volatile function). Staff of the
-- business only, through private.require_staff_of: other users get
-- "not found" and a suspended workspace gets workspace_suspended (PT423).
-- Archived events are left out everywhere.
--
--   upcoming          events dated today or later in each event's own time
--                     zone, by date then title: at most p_upcoming_limit
--                     rows, plus upcoming_more when there are others.
--   submitted         the event's current proposal, submitted by the client
--                     and waiting for staff approval (exactly what
--                     approve_proposal_selection accepts).
--   awaiting_deposit  events whose signed contract waits for its deposit
--                     (lifecycle awaiting_deposit, set only by
--                     private.evaluate_booking under the deposit policy),
--                     with the outstanding amount from the authoritative
--                     private.event_payment_summary. Booked events, signature
--                     policies and 0% deposits never appear here.
--   booking_check     contracts signed before booking policies existed and
--                     never checked (event still awaiting_signature,
--                     summary legacy_signed): staff run "Check booking".
--   planning          booked events dated today or later (clients plan only
--                     after booking, as in my_plans) whose plan still misses
--                     required answers in available sections
--                     (private.plan_progress) and whose client editing
--                     either closes within 7 days, is reopened, or closed.
--                     Progress is computed only for those plans.
--   failed_emails     this business's emails that used up their retries
--                     (status failed). Pending and sending emails, normal
--                     retries included, are not failures; platform emails
--                     (tenant_id null) are never counted.
--   setup             saved facts for the setup checklist: the legal identity
--                     saved (update_business_settings sets address and email
--                     together), configured tax categories (an empty list is
--                     an explicit "no tax") and the categories active gear
--                     and packages use, active packages (an offer needs
--                     three), proposal templates whose three packages are
--                     all active, and active contract templates with a
--                     version published for client use.
--
-- Cancelled and completed events are left out of the attention lists.

create function public.staff_dashboard(p_tenant_id uuid, p_upcoming_limit integer default 8)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
           exists (select 1 from public.contracts k where k.tenant_id = e.tenant_id and k.event_id = e.id and k.status = 'signed') as contract_signed
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
                 private.plan_editing_state(d.deadline, e.planning_override_until, v_at) as state,
                 case private.plan_editing_state(d.deadline, e.planning_override_until, v_at)
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
$$;

comment on function public.staff_dashboard(uuid, integer) is
  'Read-only dashboard facts for staff of one business: upcoming events and work needing attention. See the migration header for each rule.';
revoke execute on function public.staff_dashboard(uuid, integer) from public, anon;
grant execute on function public.staff_dashboard(uuid, integer) to authenticated;
