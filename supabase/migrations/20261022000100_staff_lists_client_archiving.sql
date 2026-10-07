-- Staff Events and Clients lists, and explicit client archiving.
--
-- Why a migration: the lists need a server-side search and date view that
-- PostgREST filters can't express safely ("today or later" depends on each
-- event's own time zone; the search covers the primary contact's name), and
-- client archiving needs an audited, idempotent action like event archiving.
-- Nothing existing changes; the old direct update of clients.archived_at
-- stays granted so the previously deployed app keeps working.
--
--   staff_event_list   one page of events matching a search (title, venue,
--                      primary contact name), a date view (upcoming: today or
--                      later in the event's own time zone, nearest first;
--                      past: before today, most recent first; all: latest
--                      date first), a lifecycle status and archived
--                      inclusion, with the total and how many archived
--                      events the filters left out.
--   staff_client_list  the same for clients (name or email), with each
--                      listed client's event count and next upcoming event.
--   set_client_archived archives or restores a client. It only sets
--                      archived_at (once, never restamped) and records an
--                      audit event. It changes no event, contact link,
--                      proposal, contract, sign-in or client access. Existing
--                      rules then apply to archived clients: they can't be
--                      chosen for new events or contacts in the app, a
--                      proposal can't be sent to an archived primary
--                      contact, and a contract can't be sent to an archived
--                      signer. Their history stays on events and documents.
--
-- All three are for staff of the business only (private.require_staff_of:
-- others get "not found", a suspended workspace gets workspace_suspended).
-- The lists are STABLE: Postgres refuses any write inside them.

-- A case-insensitive "contains" pattern with LIKE wildcards escaped (so % and _ are literal).
create function private.contains_pattern(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '%' || replace(replace(replace(btrim(p_text), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;
revoke execute on function private.contains_pattern(text) from public, anon, authenticated;

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
  p_offset integer default 0
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

  with candidates as (
    select e.id, e.title, e.event_date, e.timezone, e.venue_name, e.lifecycle_status, e.archived_at,
           pc.name as client_name
    from public.events e
    left join lateral (
      select c.name from public.event_clients ec join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
      where ec.tenant_id = e.tenant_id and ec.event_id = e.id and ec.is_primary limit 1
    ) pc on true
    where e.tenant_id = p_tenant_id
      and (p_view = 'all'
           or (p_view = 'upcoming' and e.event_date >= (v_at at time zone e.timezone)::date)
           or (p_view = 'past' and e.event_date < (v_at at time zone e.timezone)::date))
      and (p_status is null or e.lifecycle_status = p_status)
      and (v_query is null
           or e.title ilike private.contains_pattern(v_query)
           or e.venue_name ilike private.contains_pattern(v_query)
           or pc.name ilike private.contains_pattern(v_query))
  ),
  matching as (
    select * from candidates where p_include_archived or archived_at is null
  ),
  page as (
    select m.* from matching m
    order by
      case when p_view = 'upcoming' then m.event_date end asc,
      case when p_view <> 'upcoming' then m.event_date end desc,
      m.title, m.id
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matching),
    'archived_excluded', case when p_include_archived then 0 else (select count(*) from candidates where archived_at is not null) end,
    'tenant_events', (select count(*) from public.events e where e.tenant_id = p_tenant_id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'title', p.title, 'event_date', p.event_date, 'timezone', p.timezone, 'venue_name', p.venue_name,
               'lifecycle_status', p.lifecycle_status, 'archived', p.archived_at is not null, 'client_name', p.client_name,
               'today', (v_at at time zone p.timezone)::date,
               'contract_signed', exists (select 1 from public.contracts k where k.tenant_id = p_tenant_id and k.event_id = p.id and k.status = 'signed'))
             order by
               case when p_view = 'upcoming' then p.event_date end asc,
               case when p_view <> 'upcoming' then p.event_date end desc,
               p.title, p.id)
      from page p), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;
comment on function public.staff_event_list(uuid, text, text, text, boolean, integer, integer) is
  'One page of a business''s events for staff: search, date view by each event''s own time zone, status and archived filters. Read-only.';
revoke execute on function public.staff_event_list(uuid, text, text, text, boolean, integer, integer) from public, anon;
grant execute on function public.staff_event_list(uuid, text, text, text, boolean, integer, integer) to authenticated;

-- ===========================================================================
-- Clients list
-- ===========================================================================

create function public.staff_client_list(
  p_tenant_id uuid,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 25,
  p_offset integer default 0
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
  v_result jsonb;
begin
  perform private.require_staff_of(p_tenant_id);
  if v_query is not null and length(v_query) > 100 then
    raise exception 'list_invalid: the search is too long' using errcode = 'invalid_parameter_value';
  end if;

  with candidates as (
    select c.id, c.name, c.email, c.phone, c.archived_at
    from public.clients c
    where c.tenant_id = p_tenant_id
      and (v_query is null or c.name ilike private.contains_pattern(v_query) or c.email ilike private.contains_pattern(v_query))
  ),
  matching as (
    select * from candidates where p_include_archived or archived_at is null
  ),
  page as (
    select m.* from matching m order by lower(m.name), m.email, m.id limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matching),
    'archived_excluded', case when p_include_archived then 0 else (select count(*) from candidates where archived_at is not null) end,
    'tenant_clients', (select count(*) from public.clients c where c.tenant_id = p_tenant_id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'email', p.email, 'phone', p.phone, 'archived', p.archived_at is not null,
               'events', (select count(*) from public.event_clients ec where ec.tenant_id = p_tenant_id and ec.client_id = p.id),
               'next_event', (
                 select jsonb_build_object('id', e.id, 'title', e.title, 'event_date', e.event_date, 'today', (v_at at time zone e.timezone)::date)
                 from public.event_clients ec join public.events e on e.tenant_id = ec.tenant_id and e.id = ec.event_id
                 where ec.tenant_id = p_tenant_id and ec.client_id = p.id and e.archived_at is null
                   and e.event_date >= (v_at at time zone e.timezone)::date
                 order by e.event_date, e.title limit 1))
             order by lower(p.name), p.email, p.id)
      from page p), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;
comment on function public.staff_client_list(uuid, text, boolean, integer, integer) is
  'One page of a business''s clients for staff: name or email search and archived filter, with event counts. Read-only.';
revoke execute on function public.staff_client_list(uuid, text, boolean, integer, integer) from public, anon;
grant execute on function public.staff_client_list(uuid, text, boolean, integer, integer) to authenticated;

-- ===========================================================================
-- Client archiving
-- ===========================================================================

create function public.set_client_archived(p_client_id uuid, p_archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_events integer;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_client.tenant_id);
  if p_archived is null then
    raise exception 'archive_invalid: choose archive or restore' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_client from public.clients where id = p_client_id for update;
  -- Already in the requested state (a repeated click or another tab): nothing changes.
  if p_archived = (v_client.archived_at is not null) then
    return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', true);
  end if;
  update public.clients set archived_at = case when p_archived then now() end where id = v_client.id;
  select count(*) into v_events from public.event_clients ec where ec.tenant_id = v_client.tenant_id and ec.client_id = v_client.id;
  perform private.audit(v_client.tenant_id, 'client', v_client.id, case when p_archived then 'client_archived' else 'client_restored' end,
    'staff', (select auth.uid()), jsonb_build_object('events', v_events));
  return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', false, 'events', v_events);
end;
$$;
comment on function public.set_client_archived(uuid, boolean) is
  'Archives or restores a client (staff of the business). Sets archived_at only and audits it; events, contact links, documents and access are unchanged.';
revoke execute on function public.set_client_archived(uuid, boolean) from public, anon;
grant execute on function public.set_client_archived(uuid, boolean) to authenticated;
