-- Void notification for sent, unsigned contracts.
--
-- When a sent contract is voided (by staff, or automatically because a
-- revised offer replaced its approval), the frozen signer gets one email
-- saying the agreement is no longer available and their DJ will follow up.
-- It is queued in the same transaction as the void, deduplicated per
-- contract ("contract_voided:{contract id}"), and delivered by the existing
-- outbox worker with its usual retries. It carries no internal void reason
-- and no link. Archiving an event never queues it (archiving does not void),
-- and never cancels one already queued.

alter table public.email_outbox drop constraint email_outbox_event_type_valid;
alter table public.email_outbox
  add constraint email_outbox_event_type_valid check (event_type in (
    'proposal_sent', 'proposal_link_opened', 'proposal_submitted', 'proposal_approved',
    'contract_sent', 'contract_sign_in', 'contract_voided'));

create function private.enqueue_contract_void_notice(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
begin
  select * into c from public.contracts where id = p_contract_id;
  if not found or c.status <> 'void' or c.sent_at is null then
    return;
  end if;
  -- Frozen, non-secret details only: no void reason, no link.
  perform private.enqueue_contract_email(
    c.tenant_id, 'contract_voided', c.signer_email, c.id, null,
    jsonb_build_object(
      'client_name', c.signer_name,
      'event_title', c.party_snapshot -> 'event' ->> 'title',
      'legal_name', coalesce(c.party_snapshot -> 'business' ->> 'legal_name', c.party_snapshot -> 'business' ->> 'name'),
      'contact_email', c.party_snapshot -> 'business' ->> 'contact_email'),
    'contract_voided:' || c.id);
end;
$$;
revoke execute on function private.enqueue_contract_void_notice(uuid) from public, anon, authenticated;

create or replace function public.claim_email_outbox(p_limit integer default 10, p_lock_seconds integer default 120, p_tenant_id uuid default null)
returns table (
  id uuid, tenant_id uuid, event_type text, recipient_email text, entity_id uuid, payload jsonb, attempts integer,
  access_link_id uuid, link_token_hash text, link_usable boolean, proposal_active boolean,
  tenant_slug text, tenant_display_name text, tenant_reply_to text,
  contract_deliverable boolean, contract_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- Claims that expired with no attempts left are given up.
  update public.email_outbox o
    set status = 'failed', locked_until = null, last_error = coalesce(o.last_error, 'delivery did not complete')
    where o.status = 'sending' and o.locked_until < now() and o.attempts >= o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id);

  return query
  with due as (
    select o.id from public.email_outbox o
    where (o.status = 'pending' or (o.status = 'sending' and o.locked_until < now()))
      and o.next_attempt_at <= now()
      and o.attempts < o.max_attempts
      and (p_tenant_id is null or o.tenant_id = p_tenant_id)
      -- Archived businesses send nothing.
      and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null)
    order by o.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  ),
  claimed as (
    update public.email_outbox o
      set status = 'sending', attempts = o.attempts + 1,
          locked_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lock_seconds, 120), 900)))
      from due where o.id = due.id
      returning o.*
  )
  select c.id, c.tenant_id, c.event_type, c.recipient_email, c.entity_id, c.payload, c.attempts,
         c.access_link_id, l.token_hash, (l.id is not null and l.revoked_at is null and l.expires_at > now()),
         coalesce(e.active_proposal_id = c.entity_id, false),
         t.slug, t.display_name, t.reply_to_email,
         -- Contract emails are deliverable only while their invitation is
         -- usable and the contract is still sent, current and not archived.
         -- A void notice is deliverable while the contract is void.
         coalesce(case when c.event_type = 'contract_voided' then c.entity_type = 'contract' and k.status = 'void'
                  else c.entity_type = 'contract' and l.purpose = 'contract' and l.contract_id = c.entity_id
                  and l.revoked_at is null and l.expires_at > now()
                  and k.status = 'sent' and ke.archived_at is null
                  and kp.status = 'approved' and ke.active_proposal_id = k.proposal_id end, false),
         k.id
  from claimed c
  join public.tenants t on t.id = c.tenant_id
  left join public.access_links l on l.tenant_id = c.tenant_id and l.id = c.access_link_id
  left join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.entity_id
  left join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  left join public.contracts k on c.entity_type = 'contract' and k.tenant_id = c.tenant_id and k.id = c.entity_id
  left join public.events ke on ke.tenant_id = k.tenant_id and ke.id = k.event_id
  left join public.proposals kp on kp.tenant_id = k.tenant_id and kp.id = k.proposal_id;
end;
$$;

create or replace function public.void_contract(p_contract_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'contract_void_invalid: give a reason (up to 500 characters)' using errcode = 'invalid_parameter_value';
  end if;
  c := private.lock_contract_for_staff(p_contract_id);
  if c.status = 'void' then
    return jsonb_build_object('status', 'void', 'replayed', true);
  end if;
  if c.status <> 'sent' then
    raise exception 'contract_void_invalid: only a sent, unsigned contract can be voided (this one is %)', c.status
      using errcode = 'invalid_parameter_value';
  end if;
  update public.contracts set status = 'void', void_reason = btrim(p_reason) where id = c.id;
  perform private.retire_contract_invitations(c.id, 'contract voided');
  perform private.enqueue_contract_void_notice(c.id);
  perform private.audit(c.tenant_id, 'contract', c.id, 'voided', 'staff', (select auth.uid()), jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('status', 'void', 'replayed', false);
end;
$$;

create or replace function private.proposals_supersede_contract_drafts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  k record;
begin
  update public.contracts set status = 'superseded'
    where tenant_id = new.tenant_id and proposal_id = new.id and status = 'draft';
  for k in select id from public.contracts where tenant_id = new.tenant_id and proposal_id = new.id and status = 'sent' loop
    update public.contracts set status = 'void', void_reason = 'A revised offer replaced the approved terms.' where id = k.id;
    perform private.retire_contract_invitations(k.id, 'superseded by a revised offer');
    perform private.enqueue_contract_void_notice(k.id);
    perform private.audit(new.tenant_id, 'contract', k.id, 'voided', 'system', null, jsonb_build_object('reason', 'superseded by a revised offer'));
  end loop;
  return null;
end;
$$;

create or replace function private.set_event_archived(p_event_id uuid, p_archived boolean, p_actor_type text, p_actor_id uuid)
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
  v_contract_emails int := 0;
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
    -- Contract invitations share the proposal links table and were revoked
    -- above; their pending emails are cancelled here.
    update public.email_outbox set status = 'cancelled', last_error = 'event archived'
      where tenant_id = v_event.tenant_id and entity_type = 'contract' and status = 'pending'
        and event_type <> 'contract_voided'
        and entity_id in (select k.id from public.contracts k where k.tenant_id = v_event.tenant_id and k.event_id = v_event.id);
    get diagnostics v_contract_emails = row_count;
    v_emails := v_emails + v_contract_emails;
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
