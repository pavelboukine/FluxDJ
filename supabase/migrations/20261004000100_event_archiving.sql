-- Event archiving.
--
-- Archiving hides an event from staff's default lists and stops all
-- client-facing activity on it. It is separate from the lifecycle status
-- (lead, booked, cancelled...) and never changes it. Nothing is deleted:
-- proposals, selections, approvals, contracts and audit history stay intact.
--
--   * events.archived_at is set only through set_event_archived (staff,
--     membership checked) or private.set_event_archived (trusted maintenance).
--     Staff have no direct column grant.
--   * Archiving, in one transaction under the event lock: revokes every active
--     proposal link and session of the event, cancels pending client emails
--     for its proposals, and writes an audit record.
--   * While archived: client sessions resolve as invalid (no viewing, editing
--     or submitting), proposals cannot be sent or approved, and contract
--     drafts cannot be generated.
--   * Unarchiving clears archived_at only. Revocations are one-way, so the
--     client regains access only when staff send a new revision.

alter table public.events add column archived_at timestamptz;
comment on column public.events.archived_at is
  'Set by set_event_archived. Hidden from default staff lists; blocks sends, approvals, contract generation and client sessions. Not a lifecycle status.';
create index events_tenant_archived_idx on public.events (tenant_id, archived_at, event_date);

-- ===========================================================================
-- Archive / unarchive
-- ===========================================================================

create function private.set_event_archived(p_event_id uuid, p_archived boolean, p_actor_type text, p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_proposals uuid[];
  v_links int := 0;
  v_sessions int := 0;
  v_emails int := 0;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if p_archived = (v_event.archived_at is not null) then
    return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', true);
  end if;

  if p_archived then
    select coalesce(array_agg(p.id), '{}') into v_proposals
    from public.proposals p where p.tenant_id = v_event.tenant_id and p.event_id = v_event.id;
    -- Lock order everywhere: event, then proposals.
    perform 1 from public.proposals p where p.id = any (v_proposals) for update;

    update public.events set archived_at = now() where id = v_event.id;
    update public.access_links set revoked_at = now()
      where tenant_id = v_event.tenant_id and proposal_id = any (v_proposals) and revoked_at is null;
    get diagnostics v_links = row_count;
    update public.proposal_sessions set revoked_at = now()
      where tenant_id = v_event.tenant_id and proposal_id = any (v_proposals) and revoked_at is null;
    get diagnostics v_sessions = row_count;
    update public.email_outbox set status = 'cancelled', last_error = 'event archived'
      where tenant_id = v_event.tenant_id and entity_id = any (v_proposals)
        and event_type in ('proposal_sent', 'proposal_approved') and status = 'pending';
    get diagnostics v_emails = row_count;
  else
    update public.events set archived_at = null where id = v_event.id;
  end if;

  perform private.audit(v_event.tenant_id, 'event', v_event.id, case when p_archived then 'archived' else 'unarchived' end,
    p_actor_type, p_actor_id,
    case when p_archived then jsonb_build_object('links_revoked', v_links, 'sessions_revoked', v_sessions, 'emails_cancelled', v_emails)
         else '{}'::jsonb end);
  return jsonb_build_object('status', case when p_archived then 'archived' else 'active' end, 'replayed', false,
                            'links_revoked', v_links, 'sessions_revoked', v_sessions, 'emails_cancelled', v_emails);
end;
$$;
revoke execute on function private.set_event_archived(uuid, boolean, text, uuid) from public, anon, authenticated;

-- Staff entry point: membership of the event's tenant is required.
create function public.set_event_archived(p_event_id uuid, p_archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select e.tenant_id into v_tenant from public.events e where e.id = p_event_id;
  if v_tenant is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_tenant);
  return private.set_event_archived(p_event_id, p_archived, 'staff', (select auth.uid()));
end;
$$;
revoke execute on function public.set_event_archived(uuid, boolean) from public, anon;
grant execute on function public.set_event_archived(uuid, boolean) to authenticated;

-- ===========================================================================
-- Blocks while archived
-- ===========================================================================

-- No sending or approving proposals of an archived event.
create function private.proposals_block_archived_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('sent', 'approved') and exists (
    select 1 from public.events e where e.tenant_id = new.tenant_id and e.id = new.event_id and e.archived_at is not null
  ) then
    raise exception 'event_archived: this event is archived. Unarchive it first' using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;
revoke execute on function private.proposals_block_archived_event() from public, anon, authenticated;
create trigger proposals_block_archived_event before update of status on public.proposals
  for each row when (new.status is distinct from old.status)
  execute function private.proposals_block_archived_event();

-- No contract drafts for an archived event. Otherwise unchanged from
-- 20261003000400_contract_drafts.sql.
create or replace function private.contracts_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'draft' then
    raise exception 'contracts are created as drafts' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.events e where e.tenant_id = new.tenant_id and e.id = new.event_id and e.archived_at is not null) then
    raise exception 'contract_not_allowed: the event is archived' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (
    select 1 from public.contract_template_versions v
    where v.tenant_id = new.tenant_id and v.id = new.template_version_id
      and v.published_at is not null and v.content_sha256 = new.template_content_sha256
  ) then
    raise exception 'contracts can only be generated from a published template version' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.proposals p
    join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
    where p.tenant_id = new.tenant_id and p.id = new.proposal_id
      and p.status = 'approved' and e.active_proposal_id = p.id
  ) then
    raise exception 'contracts can only be generated from the event''s current approved proposal' using errcode = 'check_violation';
  end if;
  new.status_changed_at := null;
  new.content_sha256 := private.contract_content_sha256(
    new.rendered_content, new.commercial_snapshot, new.party_snapshot, new.template_version_id, new.template_content_sha256);
  return new;
end;
$$;

-- Client sessions of an archived event resolve as invalid, which blocks
-- viewing, saving and submitting. client_submit_selection locks the event
-- before re-resolving, so it cannot race an archive. Otherwise unchanged from
-- 20261003000200_send_submit_approve_functions.sql.
create or replace function private.resolve_proposal_session(p_session_hash text, p_proposal_id uuid, p_tenant_slug text)
returns table (state text, session_id uuid, tenant_id uuid, proposal_id uuid, event_id uuid, access_link_id uuid, intended_client_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select s.id as sid, s.expires_at as s_exp, s.revoked_at as s_rev,
         l.id as lid, l.expires_at as l_exp, l.revoked_at as l_rev, l.intended_client_id as cid,
         p.id as pid, p.tenant_id as tid, p.event_id as eid, p.status, p.expires_at as p_exp,
         e.active_proposal_id, t.archived_at, e.archived_at as event_archived_at
    into r
  from public.proposal_sessions s
  join public.access_links l on l.tenant_id = s.tenant_id and l.id = s.access_link_id
  join public.proposals p on p.tenant_id = s.tenant_id and p.id = s.proposal_id
  join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  join public.tenants t on t.id = s.tenant_id
  where s.session_hash = p_session_hash and s.proposal_id = p_proposal_id and t.slug = p_tenant_slug
    and l.purpose = 'proposal';

  if not found or r.s_exp <= now() or r.l_exp <= now() or r.archived_at is not null or r.event_archived_at is not null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if r.s_rev is not null or r.l_rev is not null then
    return query select (case when r.status = 'superseded' then 'superseded' else 'invalid' end)::text,
      null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  return query select private.proposal_state(r.status, r.p_exp, r.active_proposal_id = r.pid),
    r.sid, r.tid, r.pid, r.eid, r.lid, r.cid;
end;
$$;
