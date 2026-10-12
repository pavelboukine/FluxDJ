-- Everyday client and event management: richer staff lists.
--
-- Replaces the two read-only list functions from
-- 20261022000100_staff_lists_client_archiving.sql with versions that take a
-- few more optional parameters. Every earlier parameter keeps its name,
-- meaning and default, and every earlier result key is still returned, so the
-- previously deployed app keeps working against this database (it simply
-- doesn't pass the new parameters). Nothing is written and no table changes.
--
--   staff_event_list   adds an event type filter, an optional date range
--                      (inclusive calendar dates, combined with the date
--                      view), the primary contact's email in the search and
--                      a sort: "date" (the previous order: upcoming nearest
--                      first, otherwise latest date first), "updated" (most
--                      recently changed first) or "created" (newest first).
--                      Each row also carries what the staff list needs to
--                      describe the event from its records without another
--                      query: the event type, the current proposal's state
--                      (the active proposal, an expired send reported as
--                      expired, and whether an editable draft exists) and
--                      the current contract's status (signed, sent or
--                      draft). These are read, never stored or derived into
--                      a new state.
--   staff_client_list  adds a phone search (digits only, so "514 555" and
--                      "(514) 555-0100" match the same number once the
--                      search holds at least three digits) and a sort:
--                      "name" (the previous order) or "recent" (newest
--                      first). Rows also carry created_at.
--
-- Both stay staff-of-the-business only through private.require_staff_of
-- (non-members get "not found", a suspended workspace gets PT423), STABLE,
-- SECURITY DEFINER with an empty search_path, and executable by
-- authenticated only.

drop function public.staff_event_list(uuid, text, text, text, boolean, integer, integer);
drop function public.staff_client_list(uuid, text, boolean, integer, integer);

-- ===========================================================================
-- Events list
-- ===========================================================================

create function public.staff_event_list(
  p_tenant_id uuid,
  p_view text default 'upcoming',
  p_status text default null,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 25,
  p_offset integer default 0,
  p_event_type text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_sort text default 'date'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := now();
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sort text := coalesce(p_sort, 'date');
  v_result jsonb;
begin
  perform private.require_staff_of(p_tenant_id);
  if p_view is null or p_view not in ('upcoming', 'past', 'all') then
    raise exception 'list_invalid: unknown date view' using errcode = 'invalid_parameter_value';
  end if;
  if p_status is not null and p_status not in ('lead', 'pending_approval', 'awaiting_signature', 'awaiting_deposit', 'booked', 'completed', 'cancelled') then
    raise exception 'list_invalid: unknown status' using errcode = 'invalid_parameter_value';
  end if;
  if v_query is not null and length(v_query) > 100 then
    raise exception 'list_invalid: the search is too long' using errcode = 'invalid_parameter_value';
  end if;
  if p_event_type is not null and p_event_type !~ '^[a-z][a-z0-9_]{0,39}$' then
    raise exception 'list_invalid: unknown event type' using errcode = 'invalid_parameter_value';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'list_invalid: the start date is after the end date' using errcode = 'invalid_parameter_value';
  end if;
  if v_sort not in ('date', 'updated', 'created') then
    raise exception 'list_invalid: unknown sort' using errcode = 'invalid_parameter_value';
  end if;

  with candidates as (
    select e.id, e.title, e.event_type, e.event_date, e.timezone, e.venue_name, e.lifecycle_status, e.archived_at,
           e.active_proposal_id, e.created_at, e.updated_at, pc.name as client_name
    from public.events e
    left join lateral (
      select c.name, c.email from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
      where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary limit 1
    ) pc on true
    where e.tenant_id = p_tenant_id
      and (p_view = 'all'
           or (p_view = 'upcoming' and e.event_date >= (v_at at time zone e.timezone)::date)
           or (p_view = 'past' and e.event_date < (v_at at time zone e.timezone)::date))
      and (p_status is null or e.lifecycle_status = p_status)
      and (p_event_type is null or e.event_type = p_event_type)
      and (p_date_from is null or e.event_date >= p_date_from)
      and (p_date_to is null or e.event_date <= p_date_to)
      and (v_query is null
           or e.title ilike private.contains_pattern(v_query)
           or e.venue_name ilike private.contains_pattern(v_query)
           or pc.name ilike private.contains_pattern(v_query)
           or pc.email ilike private.contains_pattern(v_query))
  ),
  matching as (
    select * from candidates where p_include_archived or archived_at is null
  ),
  page as (
    select m.* from matching m
    order by
      case when v_sort = 'updated' then m.updated_at end desc,
      case when v_sort = 'created' then m.created_at end desc,
      case when v_sort = 'date' and p_view = 'upcoming' then m.event_date end asc,
      case when v_sort = 'date' and p_view <> 'upcoming' then m.event_date end desc,
      m.event_date, m.title, m.id
    limit v_limit offset v_offset
  ),
  described as (
    select p.*,
           (select case when ap.status = 'sent' and ap.expires_at is not null and ap.expires_at <= v_at then 'expired' else ap.status end
            from public.proposals ap where ap.tenant_id = p_tenant_id and ap.id = p.active_proposal_id) as proposal_status,
           exists (select 1 from public.proposals d where d.tenant_id = p_tenant_id and d.event_id = p.id and d.status = 'draft') as proposal_draft,
           (select k.status from public.contracts k
            where k.tenant_id = p_tenant_id and k.event_id = p.id and k.status in ('signed', 'sent', 'draft')
            order by case k.status when 'signed' then 1 when 'sent' then 2 else 3 end limit 1) as contract_status
    from page p
  )
  select jsonb_build_object(
    'total', (select count(*) from matching),
    'archived_excluded', case when p_include_archived then 0 else (select count(*) from candidates where archived_at is not null) end,
    'tenant_events', (select count(*) from public.events e where e.tenant_id = p_tenant_id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'title', d.title, 'event_type', d.event_type, 'event_date', d.event_date, 'timezone', d.timezone,
               'venue_name', d.venue_name, 'lifecycle_status', d.lifecycle_status, 'archived', d.archived_at is not null,
               'client_name', d.client_name, 'today', (v_at at time zone d.timezone)::date,
               'contract_signed', coalesce(d.contract_status = 'signed', false),
               'proposal_status', d.proposal_status, 'proposal_draft', d.proposal_draft, 'contract_status', d.contract_status,
               'updated_at', d.updated_at, 'created_at', d.created_at)
             order by
               case when v_sort = 'updated' then d.updated_at end desc,
               case when v_sort = 'created' then d.created_at end desc,
               case when v_sort = 'date' and p_view = 'upcoming' then d.event_date end asc,
               case when v_sort = 'date' and p_view <> 'upcoming' then d.event_date end desc,
               d.event_date, d.title, d.id)
      from described d), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;
comment on function public.staff_event_list(uuid, text, text, text, boolean, integer, integer, text, date, date, text) is
  'One page of a business''s events for staff: search, date view by each event''s own time zone, status, type, date range, archived filter and sort. Read-only.';
revoke execute on function public.staff_event_list(uuid, text, text, text, boolean, integer, integer, text, date, date, text) from public, anon;
grant execute on function public.staff_event_list(uuid, text, text, text, boolean, integer, integer, text, date, date, text) to authenticated;

-- ===========================================================================
-- Clients list
-- ===========================================================================

create function public.staff_client_list(
  p_tenant_id uuid,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 25,
  p_offset integer default 0,
  p_sort text default 'name'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := now();
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_digits text;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sort text := coalesce(p_sort, 'name');
  v_result jsonb;
begin
  perform private.require_staff_of(p_tenant_id);
  if v_query is not null and length(v_query) > 100 then
    raise exception 'list_invalid: the search is too long' using errcode = 'invalid_parameter_value';
  end if;
  if v_sort not in ('name', 'recent') then
    raise exception 'list_invalid: unknown sort' using errcode = 'invalid_parameter_value';
  end if;
  -- A phone search compares digits only, and only once there are enough to mean something.
  v_digits := regexp_replace(coalesce(v_query, ''), '[^0-9]', '', 'g');
  if length(v_digits) < 3 then
    v_digits := null;
  end if;

  with candidates as (
    select c.id, c.name, c.email, c.phone, c.archived_at, c.created_at
    from public.clients c
    where c.tenant_id = p_tenant_id
      and (v_query is null
           or c.name ilike private.contains_pattern(v_query)
           or c.email ilike private.contains_pattern(v_query)
           or (v_digits is not null and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'))
  ),
  matching as (
    select * from candidates where p_include_archived or archived_at is null
  ),
  page as (
    select m.* from matching m
    order by
      case when v_sort = 'recent' then m.created_at end desc,
      lower(m.name), m.email, m.id
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matching),
    'archived_excluded', case when p_include_archived then 0 else (select count(*) from candidates where archived_at is not null) end,
    'tenant_clients', (select count(*) from public.clients c where c.tenant_id = p_tenant_id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'email', p.email, 'phone', p.phone, 'archived', p.archived_at is not null,
               'created_at', p.created_at,
               'events', (select count(*) from public.event_clients ec where ec.tenant_id = p_tenant_id and ec.client_id = p.id),
               'next_event', (
                 select jsonb_build_object('id', e.id, 'title', e.title, 'event_date', e.event_date, 'today', (v_at at time zone e.timezone)::date)
                 from public.event_clients ec join public.events e on e.tenant_id = ec.tenant_id and e.id = ec.event_id
                 where ec.tenant_id = p_tenant_id and ec.client_id = p.id and e.archived_at is null
                   and e.event_date >= (v_at at time zone e.timezone)::date
                 order by e.event_date, e.title limit 1))
             order by
               case when v_sort = 'recent' then p.created_at end desc,
               lower(p.name), p.email, p.id)
      from page p), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;
comment on function public.staff_client_list(uuid, text, boolean, integer, integer, text) is
  'One page of a business''s clients for staff: name, email or phone search, archived filter and sort, with event counts. Read-only.';
revoke execute on function public.staff_client_list(uuid, text, boolean, integer, integer, text) from public, anon;
grant execute on function public.staff_client_list(uuid, text, boolean, integer, integer, text) to authenticated;
