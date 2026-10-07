-- Workspace suspension: platform administrators suspend and restore a DJ
-- workspace. Separate from archiving (tenants.archived_at keeps its meaning).
--
-- While a workspace is suspended:
--   * Staff and clients of that workspace get no access to its data: the
--     shared gates (member_tenant_ids, owner_tenant_ids, client_event_ids,
--     require_staff_of, the signer, invitation and proposal-session checks)
--     leave it out, so RLS, Storage policies and every function built on them
--     refuse it. Access to other workspaces and Auth identities is untouched.
--   * No row of the workspace can be inserted, changed or deleted by any
--     role (private.tenant_write_guard), except the outbox and PDF job
--     bookkeeping that workers and the suspension itself need.
--   * Workers claim none of its emails or PDF jobs. Suspension cancels its
--     undelivered emails (restoration never sends them); PDF jobs wait and
--     resume after restoration; a commit racing the suspension pauses.
--   * Links, sessions and invitations are blocked, not revoked: they keep
--     their own expiry and work again after restoration if still valid.
-- Restoration only lifts the block. It sends nothing, creates no links,
-- extends no expiry or deadline and changes no booking or payment.
--
-- Version conflicts raise PT409 (never 40001). A blocked write raises PT423
-- ("workspace_suspended"), which PostgREST answers with HTTP 423.

-- ===========================================================================
-- State
-- ===========================================================================

alter table public.tenants
  add column suspended_at timestamptz,
  add column suspension_version integer not null default 0
    constraint tenants_suspension_version_nonnegative check (suspension_version >= 0);
comment on column public.tenants.suspended_at is
  'Set while a platform administrator has suspended the workspace (see suspend_workspace). The reason is only in platform_audit_events.';
comment on column public.tenants.suspension_version is
  'Optimistic version for suspend_workspace and restore_workspace; increases by one on every change.';

-- Only suspend_workspace and restore_workspace change the suspension columns
-- (for every role, including the service role), and a suspended workspace's
-- own settings can't change; archiving stays possible.
create function private.tenants_suspension_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.suspended_at is not null or new.suspension_version <> 0 then
      raise exception 'a workspace is created active' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.suspended_at is distinct from old.suspended_at or new.suspension_version is distinct from old.suspension_version)
     and current_setting('flux.workspace_suspension', true) is distinct from new.id::text then
    raise exception 'workspace suspension changes only through suspend_workspace and restore_workspace'
      using errcode = 'insufficient_privilege';
  end if;
  if old.suspended_at is not null and new.suspended_at is not null
     and (to_jsonb(new) - array['archived_at', 'updated_at']) is distinct from (to_jsonb(old) - array['archived_at', 'updated_at']) then
    raise exception 'workspace_suspended: this workspace is suspended' using errcode = 'PT423';
  end if;
  return new;
end;
$$;
create trigger tenants_suspension_guard before insert or update on public.tenants
  for each row execute function private.tenants_suspension_guard();

-- ===========================================================================
-- Writes: nothing of a suspended workspace changes
-- ===========================================================================

-- The key-share lock on the tenant row serializes with suspend_workspace
-- (which locks it FOR UPDATE): a write that started first finishes before the
-- suspension commits, and a later one sees it. Ordinary tenant updates don't
-- conflict with key-share locks.
create function private.tenant_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
  v_suspended timestamptz;
begin
  if v_tenant is not null then
    select t.suspended_at into v_suspended from public.tenants t where t.id = v_tenant for key share;
    if v_suspended is not null then
      -- Signed-in non-members get the same refusal RLS would give them, so
      -- the suspension of a business they don't belong to never shows.
      if (select auth.uid()) is not null and not exists (
           select 1 from public.tenant_memberships m where m.tenant_id = v_tenant and m.user_id = (select auth.uid())) then
        raise exception 'new row violates row-level security policy' using errcode = 'insufficient_privilege';
      end if;
      raise exception 'workspace_suspended: this workspace is suspended' using errcode = 'PT423';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function private.tenant_write_guard() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  -- Every tenant-owned table except the append-only audit log and platform
  -- invitations (which only point at the workspace they created).
  foreach v_table in array array[
    'access_links', 'clients', 'contract_documents', 'contract_signatures', 'contract_template_versions',
    'contract_templates', 'contracts', 'event_access', 'event_billing', 'event_clients', 'event_payments',
    'event_plan_imports', 'event_plan_items', 'event_plan_responses', 'event_plans', 'events', 'gear_items',
    'gear_media', 'logistics_questions', 'logistics_rules', 'package_items', 'packages', 'planning_template_items',
    'planning_templates', 'proposal_approvals', 'proposal_selection_drafts', 'proposal_selection_lines',
    'proposal_selections', 'proposal_sessions', 'proposal_template_addons', 'proposal_template_packages',
    'proposal_template_questions', 'proposal_templates', 'proposal_views', 'proposals', 'tenant_memberships'
  ] loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.tenant_write_guard()',
      v_table || '_workspace_suspended', v_table);
  end loop;
  -- Outbox and PDF jobs: nothing new is queued, but workers and the
  -- suspension itself still record outcomes and cancellations.
  foreach v_table in array array['email_outbox', 'document_jobs'] loop
    execute format('create trigger %I before insert on public.%I for each row execute function private.tenant_write_guard()',
      v_table || '_workspace_suspended', v_table);
  end loop;
end;
$$;

-- ===========================================================================
-- Reads: the shared gates leave suspended workspaces out
-- ===========================================================================

create or replace function private.member_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid()) and t.suspended_at is null;
$$;

create or replace function private.owner_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid()) and m.role = 'owner' and t.suspended_at is null;
$$;

create or replace function private.client_event_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ea.event_id
  from public.event_access ea
  join auth.users u on u.id = ea.user_id
  join public.tenants t on t.id = ea.tenant_id
  where ea.user_id = (select auth.uid())
    and ea.revoked_at is null
    and u.email_confirmed_at is not null
    and t.suspended_at is null;
$$;

-- Members of a suspended workspace get "workspace_suspended" (PT423);
-- everyone else still gets "not found", so nothing leaks to non-members.
create or replace function private.require_staff_of(p_tenant_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
begin
  select m.id into v_membership_id
  from public.tenant_memberships m
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
  if v_membership_id is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.tenants t where t.id = p_tenant_id and t.suspended_at is not null) then
    raise exception 'workspace_suspended: this workspace is suspended' using errcode = 'PT423';
  end if;
  return v_membership_id;
end;
$$;

create or replace function private.signer_can_access_contract(p_contract_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
    from public.contracts c
    join public.events e on e.tenant_id = c.tenant_id and e.id = c.event_id
    join public.tenants t on t.id = c.tenant_id
    join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.proposal_id
    join public.event_access ea on ea.tenant_id = c.tenant_id and ea.event_id = c.event_id
      and ea.user_id = p_user_id and ea.client_id = c.signer_client_id and ea.revoked_at is null
    join auth.users u on u.id = p_user_id and u.email_confirmed_at is not null
    where c.id = p_contract_id and e.archived_at is null and t.archived_at is null and t.suspended_at is null
      and lower(c.signer_email) = lower(u.email)
      and (c.status = 'signed'
           or (c.status = 'sent' and p.status = 'approved' and e.active_proposal_id = c.proposal_id))
  );
$$;

create or replace function private.contract_invitation(p_link_id uuid, p_token_hash text, p_tenant_slug text)
returns table (usable boolean, link_id uuid, tenant_id uuid, tenant_display_name text, contract_id uuid, event_id uuid,
               signer_client_id uuid, signer_email text, signer_name text, event_title text)
language sql
stable
security definer
set search_path = ''
as $$
  select (l.revoked_at is null and l.expires_at > now() and t.archived_at is null and t.suspended_at is null and c.status = 'sent'
          and e.archived_at is null and p.status = 'approved' and e.active_proposal_id = c.proposal_id),
         l.id, l.tenant_id, t.display_name, c.id, c.event_id, c.signer_client_id, c.signer_email, c.signer_name,
         c.party_snapshot -> 'event' ->> 'title'
  from public.access_links l
  join public.tenants t on t.id = l.tenant_id
  join public.contracts c on c.tenant_id = l.tenant_id and c.id = l.contract_id
  join public.events e on e.tenant_id = c.tenant_id and e.id = c.event_id
  join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.proposal_id
  where l.purpose = 'contract' and t.slug = p_tenant_slug
    and ((p_link_id is not null and l.id = p_link_id) or (p_token_hash is not null and l.token_hash = p_token_hash));
$$;

-- Public branding (invitation and proposal pages): a suspended workspace
-- looks like an unknown one.
create or replace function public.public_tenant_brand(p_tenant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors)
  from public.tenants t where t.slug = p_tenant_slug and t.archived_at is null and t.suspended_at is null;
$$;

-- Proposal sessions: a suspended workspace's otherwise valid session is
-- "unavailable" (temporarily); expired, revoked or archived ones stay
-- "invalid" or "superseded" exactly as before, so nothing is revived.
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
         e.active_proposal_id, t.archived_at, t.suspended_at, e.archived_at as event_archived_at
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
  if r.suspended_at is not null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  return query select private.proposal_state(r.status, r.p_exp, r.active_proposal_id = r.pid),
    r.sid, r.tid, r.pid, r.eid, r.lid, r.cid;
end;
$$;

-- ===========================================================================
-- Outbox: last check right before an email is handed to the provider
-- ===========================================================================

-- True while a claimed email may still be sent: it is still claimed
-- ("sending") and its workspace, if any, is not suspended. Narrows the race
-- with a suspension to the provider call itself.
create function public.email_outbox_dispatch_allowed(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.email_outbox o
    left join public.tenants t on t.id = o.tenant_id
    where o.id = p_id and o.status = 'sending' and (o.tenant_id is null or t.suspended_at is null));
$$;
revoke execute on function public.email_outbox_dispatch_allowed(uuid) from public, anon, authenticated;
grant execute on function public.email_outbox_dispatch_allowed(uuid) to service_role;

-- ===========================================================================
-- Unchanged definitions apart from the suspension checks marked in each:
--   claim_document_jobs       skips suspended workspaces (jobs wait)
--   claim_email_outbox        skips suspended workspaces
--   client_proposal_view,
--   client_submit_selection   stop at the new "unavailable" session state
--   commit_contract_document  pauses a racing commit (job back to pending)
--   exchange_proposal_link    opens no session for a suspended workspace
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.claim_document_jobs(p_limit integer DEFAULT 5, p_lease_seconds integer DEFAULT 120, p_tenant_id uuid DEFAULT NULL::uuid, p_contract_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(job_id uuid, lease_token uuid, tenant_id uuid, contract_id uuid, attempts integer, max_attempts integer, deliver_copies boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  update public.document_jobs j
    set status = 'failed', lease_token = null, locked_until = null,
        last_error = coalesce(j.last_error, 'PDF generation did not complete')
    where j.status = 'running' and j.locked_until < now() and j.attempts >= j.max_attempts
      and (p_tenant_id is null or j.tenant_id = p_tenant_id)
      and (p_contract_id is null or j.contract_id = p_contract_id);

  return query
  with due as (
    select j.id from public.document_jobs j
    where ((j.status = 'pending' and j.next_attempt_at <= now()) or (j.status = 'running' and j.locked_until < now()))
      and j.attempts < j.max_attempts
      and (p_tenant_id is null or j.tenant_id = p_tenant_id)
      and (p_contract_id is null or j.contract_id = p_contract_id)
      -- Suspended workspaces: jobs wait, untouched, until restoration.
      and exists (select 1 from public.tenants t where t.id = j.tenant_id and t.suspended_at is null)
    order by j.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 5), 20))
    for update skip locked
  ),
  claimed as (
    update public.document_jobs j
      set status = 'running', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
          locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900)))
      from due where j.id = due.id
      returning j.*
  )
  select c.id, c.lease_token, c.tenant_id, c.contract_id, c.attempts, c.max_attempts, c.deliver_copies from claimed c;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.claim_email_outbox(p_limit integer DEFAULT 10, p_lock_seconds integer DEFAULT 120, p_tenant_id uuid DEFAULT NULL::uuid, p_include_booking boolean DEFAULT false)
 RETURNS TABLE(id uuid, tenant_id uuid, event_type text, recipient_email text, entity_id uuid, payload jsonb, attempts integer, access_link_id uuid, link_token_hash text, link_usable boolean, proposal_active boolean, tenant_slug text, tenant_display_name text, tenant_reply_to text, contract_deliverable boolean, contract_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      -- Workers that predate booking emails never claim them (they would
      -- render them as something else); they wait for an updated worker.
      and (o.event_type <> 'booking_confirmed' or coalesce(p_include_booking, false))
      -- Archived businesses send nothing.
      and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null and t.suspended_at is null)
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
         -- A signed copy is deliverable while the contract is signed, its event
         -- is not archived and its canonical PDF is committed.
         -- A booking confirmation is deliverable while the event is booked,
         -- not archived, and its contract signed.
         coalesce(case when c.event_type = 'booking_confirmed' then c.entity_type = 'contract' and k.status = 'signed'
                    and ke.archived_at is null and ke.lifecycle_status = 'booked'
                  when c.event_type = 'contract_signed_copy' then c.entity_type = 'contract' and k.status = 'signed'
                    and ke.archived_at is null
                    and exists (select 1 from public.contract_documents d where d.contract_id = k.id and d.kind = 'signed_contract')
                  when c.event_type = 'contract_voided' then c.entity_type = 'contract' and k.status = 'void'
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
$function$
;


CREATE OR REPLACE FUNCTION public.client_proposal_view(p_session_hash text, p_proposal_id uuid, p_tenant_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s record;
  v jsonb;
begin
  select * into s from private.resolve_proposal_session(p_session_hash, p_proposal_id, p_tenant_slug);
  if s.state in ('invalid', 'superseded', 'unavailable') then
    return jsonb_build_object('state', s.state);
  end if;

  select jsonb_build_object(
    'state', s.state,
    'tenant', jsonb_build_object('slug', t.slug, 'display_name', t.display_name),
    'event', jsonb_build_object('title', e.title, 'event_date', e.event_date, 'venue_name', e.venue_name, 'timezone', e.timezone),
    'proposal', jsonb_build_object(
      'id', p.id, 'revision', p.revision, 'sent_at', p.sent_at, 'expires_at', p.expires_at,
      'offer_sha256', p.offer_sha256, 'offer', p.offer_snapshot
    ),
    'selection_draft', (
      select jsonb_build_object('package_key', d.package_key, 'addon_quantities', d.addon_quantities,
                                'logistics_answers', d.logistics_answers, 'version', d.version)
      from public.proposal_selection_drafts d where d.proposal_id = p.id
    ),
    'submission', (
      select jsonb_build_object('version', ps.version, 'submitted_at', ps.submitted_at, 'selection', ps.selection_snapshot)
      from public.proposal_selections ps where ps.proposal_id = p.id order by ps.version desc limit 1
    ),
    'approved_at', (select a.approved_at from public.proposal_approvals a where a.proposal_id = p.id)
  ) into v
  from public.proposals p
  join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  join public.tenants t on t.id = p.tenant_id
  where p.id = s.proposal_id;
  return v;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.client_submit_selection(p_session_hash text, p_proposal_id uuid, p_tenant_slug text, p_expected_draft_version integer, p_idempotency_key text, p_selection jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s record;
  v_existing record;
  v_current int;
  v_selection_id uuid;
  v_event_title text;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,64}$' or jsonb_typeof(p_selection) is distinct from 'object' then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select * into s from private.resolve_proposal_session(p_session_hash, p_proposal_id, p_tenant_slug);
  if s.state in ('invalid', 'superseded', 'unavailable') then
    return jsonb_build_object('status', s.state);
  end if;

  select e.title into v_event_title from public.events e where e.tenant_id = s.tenant_id and e.id = s.event_id for update;
  perform 1 from public.proposals p where p.id = s.proposal_id for update;

  select ps.id, ps.submitted_at into v_existing
  from public.proposal_selections ps where ps.proposal_id = s.proposal_id and ps.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('status', 'submitted', 'selection_id', v_existing.id, 'submitted_at', v_existing.submitted_at, 'replayed', true);
  end if;

  select * into s from private.resolve_proposal_session(p_session_hash, p_proposal_id, p_tenant_slug);
  if s.state <> 'open' then
    return jsonb_build_object('status', s.state);
  end if;
  select d.version into v_current from public.proposal_selection_drafts d where d.proposal_id = s.proposal_id;
  if coalesce(v_current, 0) <> p_expected_draft_version then
    return jsonb_build_object('status', 'conflict', 'version', coalesce(v_current, 0));
  end if;

  begin
    v_selection_id := private.insert_selection_submission(s.proposal_id, p_selection, p_idempotency_key);
    -- Run the deferred price, tax and choice verification now, so a bad
    -- selection is reported here instead of failing at commit.
    set constraints public.proposal_selections_verify, public.proposal_selection_lines_verify immediate;
  exception when check_violation or invalid_text_representation or not_null_violation or numeric_value_out_of_range then
    return jsonb_build_object('status', 'invalid_selection', 'message', sqlerrm);
  end;

  insert into public.proposal_selection_drafts (tenant_id, proposal_id, package_key, addon_quantities, logistics_answers, version)
  values (s.tenant_id, s.proposal_id, p_selection ->> 'package_key', p_selection -> 'addon_quantities', p_selection -> 'logistics_answers', 1)
  on conflict (proposal_id) do update
    set package_key = excluded.package_key,
        addon_quantities = excluded.addon_quantities,
        logistics_answers = excluded.logistics_answers,
        version = public.proposal_selection_drafts.version + 1;

  update public.proposals set status = 'submitted' where id = s.proposal_id;
  update public.events set lifecycle_status = 'pending_approval'
    where tenant_id = s.tenant_id and id = s.event_id and lifecycle_status = 'lead';

  perform private.enqueue_email(
    s.tenant_id, 'proposal_submitted', private.staff_notification_email(s.tenant_id), s.proposal_id, null,
    jsonb_build_object('event_title', v_event_title, 'package_key', p_selection ->> 'package_key',
                       'total_cents', (p_selection ->> 'total_cents')::bigint, 'currency', p_selection ->> 'currency'),
    'proposal_submitted:' || s.proposal_id
  );
  perform private.audit(s.tenant_id, 'proposal', s.proposal_id, 'submitted', 'client', null,
    jsonb_build_object('selection_id', v_selection_id));

  return jsonb_build_object('status', 'submitted', 'selection_id', v_selection_id, 'submitted_at', now(), 'replayed', false,
                            'tenant_id', s.tenant_id);
end;
$function$
;


CREATE OR REPLACE FUNCTION public.commit_contract_document(p_job_id uuid, p_storage_path text, p_pdf_sha256 text, p_byte_size integer, p_signature_sha256 text, p_renderer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  j public.document_jobs%rowtype;
  c public.contracts%rowtype;
  s public.contract_signatures%rowtype;
  d public.contract_documents%rowtype;
  v_object record;
begin
  select * into j from public.document_jobs where id = p_job_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  -- Suspended workspace: nothing is committed or emailed. The job goes back
  -- to pending without using up an attempt, and resumes after restoration.
  -- The key-share lock makes a concurrent suspension wait for this commit.
  if exists (select 1 from public.tenants t where t.id = j.tenant_id and t.suspended_at is not null for key share) then
    update public.document_jobs
      set status = 'pending', attempts = greatest(attempts - 1, 0), lease_token = null, locked_until = null,
          next_attempt_at = now(), last_error = 'Paused while the workspace is unavailable.'
      where id = j.id and status = 'running';
    return jsonb_build_object('status', 'suspended');
  end if;
  select * into c from public.contracts where id = j.contract_id;
  select * into s from public.contract_signatures where contract_id = j.contract_id;

  select * into d from public.contract_documents where contract_id = j.contract_id and kind = 'signed_contract';
  if found then
    if j.status <> 'succeeded' then
      update public.document_jobs
        set status = 'succeeded', document_id = d.id, completed_at = now(), lease_token = null, locked_until = null, last_error = null
        where id = j.id;
      if j.deliver_copies then
        perform private.enqueue_signed_copy_emails(c.id);
      end if;
    end if;
    return jsonb_build_object('status', 'exists', 'document_id', d.id, 'storage_path', d.storage_path);
  end if;

  if c.status <> 'signed' or s.id is null then
    raise exception 'contract_document_invalid: the contract is not signed' using errcode = 'invalid_parameter_value';
  end if;
  if p_signature_sha256 is distinct from s.signature_sha256 then
    raise exception 'contract_document_invalid: the PDF was rendered from a different signature image' using errcode = 'invalid_parameter_value';
  end if;
  if p_storage_path is null or p_storage_path !~ ('^' || c.tenant_id || '/' || c.id || '/[0-9a-f-]{36}\.pdf$')
     or p_pdf_sha256 is null or p_pdf_sha256 !~ '^[0-9a-f]{64}$'
     or p_byte_size is null or p_byte_size not between 1 and 10485760
     or p_renderer is null or length(p_renderer) not between 1 and 60 then
    raise exception 'contract_document_invalid: invalid document reference' using errcode = 'invalid_parameter_value';
  end if;
  select (o.metadata ->> 'size')::bigint as size, o.metadata ->> 'mimetype' as mimetype into v_object
  from storage.objects o where o.bucket_id = 'contract-documents' and o.name = p_storage_path;
  if not found or v_object.size is distinct from p_byte_size or v_object.mimetype is distinct from 'application/pdf' then
    raise exception 'contract_document_invalid: the uploaded PDF is missing or does not match its size' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.contract_documents (tenant_id, event_id, contract_id, storage_path, pdf_sha256, byte_size,
    content_sha256, signature_sha256, renderer)
  values (c.tenant_id, c.event_id, c.id, p_storage_path, p_pdf_sha256, p_byte_size, c.content_sha256, s.signature_sha256, p_renderer)
  returning * into d;
  update public.document_jobs
    set status = 'succeeded', document_id = d.id, completed_at = now(), lease_token = null, locked_until = null, last_error = null
    where id = j.id;
  -- Emails only after the artifact is committed, in the same transaction.
  if j.deliver_copies then
    perform private.enqueue_signed_copy_emails(c.id);
  end if;
  perform private.audit(c.tenant_id, 'contract', c.id, 'signed_pdf_generated', 'system', null,
    jsonb_build_object('document_id', d.id, 'pdf_sha256', d.pdf_sha256, 'byte_size', d.byte_size));
  return jsonb_build_object('status', 'committed', 'document_id', d.id);
end;
$function$
;


CREATE OR REPLACE FUNCTION public.exchange_proposal_link(p_token_hash text, p_session_hash text, p_tenant_slug text, p_session_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record;
  v_expires timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
     or p_session_seconds is null or p_session_seconds not between 60 and 86400 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select l.id as link_id, l.tenant_id, l.proposal_id, l.expires_at as link_expires, l.revoked_at,
         p.status, p.first_viewed_at, p.event_id, e.active_proposal_id, e.title as event_title, t.archived_at, t.suspended_at
    into r
  from public.access_links l
  join public.tenants t on t.id = l.tenant_id
  join public.proposals p on p.tenant_id = l.tenant_id and p.id = l.proposal_id
  join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  where l.token_hash = p_token_hash and t.slug = p_tenant_slug and l.purpose = 'proposal'
  for update of p;

  if not found or r.link_expires <= now() or r.archived_at is not null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if r.revoked_at is not null then
    return jsonb_build_object('status', case when r.status = 'superseded' then 'superseded' else 'invalid' end);
  end if;
  if r.status not in ('sent', 'submitted', 'approved') or r.active_proposal_id is distinct from r.proposal_id then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Suspended workspace: temporarily unavailable. No session, view or email;
  -- the link keeps its own expiry and works again after restoration.
  if r.suspended_at is not null then
    return jsonb_build_object('status', 'unavailable');
  end if;
  v_expires := least(now() + make_interval(secs => p_session_seconds), r.link_expires);
  insert into public.proposal_sessions (tenant_id, proposal_id, access_link_id, session_hash, expires_at)
  values (r.tenant_id, r.proposal_id, r.link_id, p_session_hash, v_expires);
  insert into public.proposal_views (tenant_id, proposal_id, access_link_id) values (r.tenant_id, r.proposal_id, r.link_id);

  if r.first_viewed_at is null then
    update public.proposals set first_viewed_at = now() where id = r.proposal_id;
    perform private.enqueue_email(
      r.tenant_id, 'proposal_link_opened', private.staff_notification_email(r.tenant_id), r.proposal_id, null,
      jsonb_build_object('event_title', r.event_title, 'opened_at', now()),
      'proposal_link_opened:' || r.proposal_id
    );
    perform private.audit(r.tenant_id, 'proposal', r.proposal_id, 'link_first_opened', 'client', null);
  end if;

  return jsonb_build_object('status', 'ok', 'proposal_id', r.proposal_id, 'tenant_id', r.tenant_id, 'session_expires_at', v_expires);
end;
$function$
;



-- ===========================================================================
-- Platform administrators: list, suspend, restore
-- ===========================================================================

-- Administration metadata only: names, addresses, dates and suspension
-- details. Never clients, events, contracts, payments or planning.
create function public.platform_workspaces_overview()
returns table (
  id uuid, slug text, display_name text, created_at timestamptz, archived_at timestamptz,
  suspended_at timestamptz, suspension_version integer, suspension_reason text, suspended_by_email text,
  is_member boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_platform_admin();
  return query
  select t.id, t.slug, t.display_name, t.created_at, t.archived_at, t.suspended_at, t.suspension_version,
         a.metadata ->> 'reason', u.email::text,
         exists (select 1 from public.tenant_memberships m where m.tenant_id = t.id and m.user_id = (select auth.uid()))
  from public.tenants t
  left join lateral (
    select x.metadata, x.actor_id from public.platform_audit_events x
    where t.suspended_at is not null and x.entity_type = 'workspace' and x.entity_id = t.id and x.action = 'suspended'
    order by x.occurred_at desc limit 1
  ) a on true
  left join auth.users u on u.id = a.actor_id
  order by t.created_at desc, t.slug
  limit 1000;
end;
$$;

create function private.workspace_suspension_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g'));
begin
  if length(v_reason) not between 3 and 500 then
    raise exception 'workspace_reason_required: give an internal reason (3 to 500 characters)' using errcode = 'invalid_parameter_value';
  end if;
  return v_reason;
end;
$$;
revoke execute on function private.workspace_suspension_reason(text) from public, anon, authenticated;

-- Suspends a workspace. Repeats (also concurrent ones, which wait on the row
-- lock) return the existing suspension; a stale version for a workspace that
-- was restored meanwhile is a conflict (PT409). Cancels its undelivered
-- emails in the same transaction. An administrator who belongs to the
-- workspace can't suspend it (no locking yourself out by accident).
create function public.suspend_workspace(p_tenant_id uuid, p_expected_version integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tenants%rowtype;
  v_reason text;
  v_cancelled integer;
begin
  perform private.require_platform_admin();
  v_reason := private.workspace_suspension_reason(p_reason);
  select * into t from public.tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if t.suspended_at is not null then
    return jsonb_build_object('status', 'suspended', 'replayed', true, 'version', t.suspension_version, 'suspended_at', t.suspended_at);
  end if;
  if exists (select 1 from public.tenant_memberships m where m.tenant_id = t.id and m.user_id = (select auth.uid())) then
    raise exception 'workspace_own: you belong to this workspace, so it can''t be suspended from your account'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is distinct from t.suspension_version then
    raise exception 'workspace suspension was changed elsewhere' using errcode = 'PT409';
  end if;

  perform set_config('flux.workspace_suspension', t.id::text, true);
  update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1
    where id = t.id returning * into t;
  perform set_config('flux.workspace_suspension', '', true);
  -- Undelivered emails are cancelled, so restoration can't send obsolete ones.
  -- One already handed to the provider can't be recalled.
  update public.email_outbox
    set status = 'cancelled', locked_until = null, last_error = 'Cancelled: the workspace was suspended before delivery.'
    where tenant_id = t.id and status in ('pending', 'sending');
  get diagnostics v_cancelled = row_count;
  perform private.platform_audit('workspace', t.id, 'suspended', (select auth.uid()),
    jsonb_build_object('reason', v_reason, 'slug', t.slug, 'version', t.suspension_version, 'cancelled_emails', v_cancelled));
  return jsonb_build_object('status', 'suspended', 'replayed', false, 'version', t.suspension_version,
    'suspended_at', t.suspended_at, 'cancelled_emails', v_cancelled);
end;
$$;

-- Restores a workspace: only lifts the block. Sends nothing, creates no
-- links, extends nothing and changes no booking or payment. Same repeat and
-- conflict rules as suspend_workspace.
create function public.restore_workspace(p_tenant_id uuid, p_expected_version integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tenants%rowtype;
  v_reason text;
  v_since timestamptz;
begin
  perform private.require_platform_admin();
  v_reason := private.workspace_suspension_reason(p_reason);
  select * into t from public.tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  if t.suspended_at is null then
    return jsonb_build_object('status', 'active', 'replayed', true, 'version', t.suspension_version);
  end if;
  if p_expected_version is distinct from t.suspension_version then
    raise exception 'workspace suspension was changed elsewhere' using errcode = 'PT409';
  end if;
  v_since := t.suspended_at;
  perform set_config('flux.workspace_suspension', t.id::text, true);
  update public.tenants set suspended_at = null, suspension_version = suspension_version + 1
    where id = t.id returning * into t;
  perform set_config('flux.workspace_suspension', '', true);
  perform private.platform_audit('workspace', t.id, 'restored', (select auth.uid()),
    jsonb_build_object('reason', v_reason, 'slug', t.slug, 'version', t.suspension_version, 'suspended_since', v_since));
  return jsonb_build_object('status', 'active', 'replayed', false, 'version', t.suspension_version);
end;
$$;

revoke execute on function
  public.platform_workspaces_overview(),
  public.suspend_workspace(uuid, integer, text),
  public.restore_workspace(uuid, integer, text)
  from public, anon;
grant execute on function
  public.platform_workspaces_overview(),
  public.suspend_workspace(uuid, integer, text),
  public.restore_workspace(uuid, integer, text)
  to authenticated;

-- ===========================================================================
-- Members: which of my workspaces are unavailable
-- ===========================================================================

-- The signed-in user's own workspaces, including suspended ones (shown as
-- unavailable, never with a reason or who suspended them). Nothing about
-- workspaces the user doesn't belong to.
create function public.my_workspaces()
returns table (slug text, display_name text, role text, suspended boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select t.slug, t.display_name, m.role, t.suspended_at is not null
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid())
  order by t.display_name, t.slug;
$$;
revoke execute on function public.my_workspaces() from public, anon;
grant execute on function public.my_workspaces() to authenticated;

-- ===========================================================================
-- New workspaces can't claim the unavailable-workspace page's address
-- ===========================================================================

create or replace function private.is_claimable_tenant_slug(p_slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(private.is_valid_tenant_slug(p_slug), false)
     and p_slug not in (
       'about', 'account', 'accounts', 'apple-icon', 'billing', 'blog', 'contact', 'contracts', 'demo', 'docs',
       'email', 'emails', 'favicon', 'home', 'icon', 'icons', 'invitations', 'invite', 'join', 'mail', 'new',
       'next', 'onboarding', 'platform', 'pricing', 'proposals', 'robots', 'root', 'setup', 'sitemap', 'start',
       'suspended', 'system', 'unavailable', 'welcome', 'workspace', 'workspaces'
     );
$$;
