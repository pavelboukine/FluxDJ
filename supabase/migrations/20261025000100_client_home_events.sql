-- Client home (/my).
--
-- 1. my_events() hides archived events, like every other client function
--    (contracts, planning and proposal access already exclude them). Until
--    now nothing in the app called it, so no client ever saw an archived event.
-- 2. my_contracts() also returns the contract's event_id, so the client home
--    can show each readable contract on its own event. The extra column is
--    appended: callers that ignore it (the previous app) are unaffected.
--
-- No access rule changes: both still read only verified, unrevoked event
-- access in non-suspended, non-archived businesses, and contracts only for
-- their intended signer (private.client_can_read_contract).

create or replace function public.my_events()
returns table (
  event_id uuid,
  tenant_slug text,
  tenant_display_name text,
  title text,
  event_type text,
  event_date date,
  timezone text,
  venue_name text,
  venue_address text,
  lifecycle_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, t.slug, t.display_name, e.title, e.event_type, e.event_date,
         e.timezone, e.venue_name, e.venue_address, e.lifecycle_status
  from public.events e
  join public.tenants t on t.id = e.tenant_id
  where e.id in (select private.client_event_ids())
    and t.archived_at is null
    and e.archived_at is null
  order by e.event_date, e.id;
$$;
revoke execute on function public.my_events() from public, anon;
grant execute on function public.my_events() to authenticated;

drop function public.my_contracts();
create function public.my_contracts()
returns table (tenant_slug text, tenant_display_name text, contract_id uuid, event_title text, event_date text, sent_at timestamptz,
               status text, signed_at timestamptz, event_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select t.slug, t.display_name, c.id, c.party_snapshot -> 'event' ->> 'title', c.party_snapshot -> 'event' ->> 'date', c.sent_at,
         c.status, c.signed_at, c.event_id
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id
  join public.event_access ea on ea.tenant_id = c.tenant_id and ea.event_id = c.event_id
    and ea.user_id = (select auth.uid()) and ea.revoked_at is null
  where c.status in ('sent', 'signed') and private.client_can_read_contract(c.id)
  order by c.sent_at desc;
$$;
revoke execute on function public.my_contracts() from public, anon;
grant execute on function public.my_contracts() to authenticated;
