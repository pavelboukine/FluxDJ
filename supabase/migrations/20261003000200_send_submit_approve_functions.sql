-- Flux DJ step 6 (part 2): transactional functions.
--
--   Staff (authenticated, membership checked inside):
--     send_proposal, approve_proposal_selection, retry_email_outbox,
--     open_proposal_draft (now prefills revisions from the active offer).
--   Client path (service_role only; the Next.js server calls these after
--   reading the HttpOnly session cookie; every call rechecks the session,
--   link, revocation, expiry, active proposal and state):
--     exchange_proposal_link, client_proposal_view,
--     client_save_selection_draft, client_submit_selection.
--   Infrastructure (service_role only):
--     consume_rate_limit, claim/complete/fail/cancel_email_outbox,
--     public_tenant_brand.
--
-- Removed: freeze_proposal_offer (freezing happens only inside
-- send_proposal), record_proposal_selection and save_proposal_selection_draft
-- (they had no caller checks; selections are now reachable only through the
-- session-checked client functions above).

drop function public.freeze_proposal_offer(uuid);
drop function public.record_proposal_selection(uuid, integer, jsonb);
drop function public.save_proposal_selection_draft(uuid, integer, text, jsonb, jsonb);

-- ===========================================================================
-- Small helpers
-- ===========================================================================

create function private.audit(
  p_tenant_id uuid, p_entity_type text, p_entity_id uuid, p_action text,
  p_actor_type text, p_actor_id uuid, p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (tenant_id, entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (p_tenant_id, p_entity_type, p_entity_id, p_action, p_actor_type, p_actor_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- Where staff notifications go: the tenant's reply-to address, else the owner's login email.
create function private.staff_notification_email(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select t.reply_to_email from public.tenants t where t.id = p_tenant_id),
    (select lower(u.email) from public.tenant_memberships m join auth.users u on u.id = m.user_id
     where m.tenant_id = p_tenant_id and m.role = 'owner' limit 1)
  );
$$;

-- Queues an email once per dedup key. Silently skips when there is no recipient.
create function private.enqueue_email(
  p_tenant_id uuid, p_event_type text, p_recipient text, p_entity_id uuid,
  p_access_link_id uuid, p_payload jsonb, p_dedup_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recipient is null then
    return;
  end if;
  insert into public.email_outbox (tenant_id, event_type, recipient_email, entity_id, access_link_id, payload, dedup_key)
  values (p_tenant_id, p_event_type, lower(p_recipient), p_entity_id, p_access_link_id, coalesce(p_payload, '{}'::jsonb), p_dedup_key)
  on conflict (dedup_key) do nothing;
end;
$$;

-- What a client may do with a proposal right now.
create function private.proposal_state(p_status text, p_expires_at timestamptz, p_is_active boolean)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_status = 'superseded' or not coalesce(p_is_active, false) then 'superseded'
    when p_status = 'approved' then 'approved'
    when p_status = 'submitted' then 'submitted'
    when p_status = 'sent' and p_expires_at > now() then 'open'
    when p_status in ('sent', 'expired') then 'expired'
    else 'invalid'
  end;
$$;

-- Mirrors conditionMatches in src/lib/pricing/price-selection.ts.
create function private.rule_condition_matches(p_condition jsonb, p_answer jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(case p_condition ->> 'op'
    when 'equals' then p_answer = p_condition -> 'value'
    when 'in' then jsonb_typeof(p_answer) = 'string' and (p_condition -> 'values') @> jsonb_build_array(p_answer)
    when 'contains' then jsonb_typeof(p_answer) = 'array' and p_answer @> jsonb_build_array(p_condition -> 'value')
    else false
  end, false);
$$;

revoke execute on function private.audit(uuid, text, uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.staff_notification_email(uuid) from public, anon, authenticated;
revoke execute on function private.enqueue_email(uuid, text, text, uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function private.proposal_state(text, timestamptz, boolean), private.rule_condition_matches(jsonb, jsonb)
  to authenticated, service_role;

-- ===========================================================================
-- Choices re-verified against the frozen offer (not just the money)
-- ===========================================================================

-- Returns why a stored selection's choices are not what the frozen offer
-- allows, or null. Checks the package, addon keys and bounds, answers
-- (required, typed, from the options), and that the chargeable and included
-- lines are exactly what the rules, package inclusions and addons demand:
-- chargeable = max(optional, max(0, required - included)).
create function private.selection_choice_problem(p_selection_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.proposal_selections%rowtype;
  v_offer jsonb;
  v_package jsonb;
  q jsonb;
  v_answer jsonb;
  v_ok boolean;
  v_problem text;
begin
  select * into s from public.proposal_selections where id = p_selection_id;
  if not found then
    return null;
  end if;
  select p.offer_snapshot into v_offer from public.proposals p where p.tenant_id = s.tenant_id and p.id = s.proposal_id;
  if v_offer is null then
    return 'the offer is not frozen';
  end if;
  select x into v_package from jsonb_array_elements(v_offer -> 'packages') x where x ->> 'key' = s.package_key;
  if v_package is null then
    return 'package is not part of the offer';
  end if;

  if exists (
    select 1
    from jsonb_each(s.addon_quantities) a(k, v)
    left join lateral (
      select (o ->> 'max_quantity')::int as max_q from jsonb_array_elements(v_offer -> 'addons') o where o ->> 'gear_key' = a.k
    ) m on true
    where case
      when m.max_q is null then true
      when jsonb_typeof(a.v) <> 'number' or (a.v #>> '{}') !~ '^[0-9]{1,3}$' then true
      else (a.v #>> '{}')::int not between 1 and m.max_q
    end
  ) then
    return 'addon quantities are outside what the offer allows';
  end if;

  if exists (
    select 1 from jsonb_object_keys(s.logistics_answers) k
    where not exists (select 1 from jsonb_array_elements(v_offer -> 'questions') qq where qq ->> 'key' = k)
  ) then
    return 'an answer refers to a question outside the offer';
  end if;

  for q in select x from jsonb_array_elements(v_offer -> 'questions') x loop
    v_answer := s.logistics_answers -> (q ->> 'key');
    if v_answer is null or jsonb_typeof(v_answer) = 'null' then
      if (q ->> 'required')::boolean then
        return 'required answer missing: ' || (q ->> 'key');
      end if;
      continue;
    end if;
    v_ok := case q ->> 'answer_type'
      when 'boolean' then jsonb_typeof(v_answer) = 'boolean'
      when 'single_choice' then
        jsonb_typeof(v_answer) = 'string' and (q -> 'options') @> jsonb_build_array(jsonb_build_object('value', v_answer))
      when 'multi_choice' then
        case when jsonb_typeof(v_answer) <> 'array' then false
        else not exists (
               select 1 from jsonb_array_elements(v_answer) e
               where jsonb_typeof(e) <> 'string' or not (q -> 'options') @> jsonb_build_array(jsonb_build_object('value', e))
             )
             and (select count(distinct e) = count(*) from jsonb_array_elements(v_answer) e)
        end
      when 'short_text' then
        case when jsonb_typeof(v_answer) <> 'string' then false
        else length(btrim(v_answer #>> '{}')) between 1 and 2000 end
      else false
    end;
    if not v_ok then
      return 'invalid answer: ' || (q ->> 'key');
    end if;
  end loop;

  if (select count(*) <> count(distinct l.item_key) from public.proposal_selection_lines l
      where l.selection_id = s.id and l.source in ('optional', 'required')) then
    return 'chargeable gear appears more than once';
  end if;

  with fired as (
    select r ->> 'gear_key' as gear, (r ->> 'required_quantity')::int as qty
    from jsonb_array_elements(v_offer -> 'rules') r
    where private.rule_condition_matches(r -> 'condition', s.logistics_answers -> (r ->> 'question_key'))
  ),
  required as (select gear, sum(qty)::int as qty from fired group by gear),
  included as (select i ->> 'gear_key' as gear, (i ->> 'quantity')::int as qty from jsonb_array_elements(v_package -> 'included') i),
  optional as (select a.k as gear, (a.v #>> '{}')::int as qty from jsonb_each(s.addon_quantities) a(k, v)),
  expected as (
    select g.gear,
           greatest(0, coalesce(r.qty, 0) - coalesce(i.qty, 0)) as req_extra,
           greatest(coalesce(o.qty, 0), greatest(0, coalesce(r.qty, 0) - coalesce(i.qty, 0))) as qty
    from (select gear from required union select gear from optional) g
    left join required r on r.gear = g.gear
    left join included i on i.gear = g.gear
    left join optional o on o.gear = g.gear
  ),
  expected_lines as (select * from expected where qty > 0),
  actual as (
    select l.item_key as gear, l.source, l.quantity, l.required_quantity
    from public.proposal_selection_lines l
    where l.selection_id = s.id and l.source in ('optional', 'required')
  )
  select coalesce(e.gear, a.gear) into v_problem
  from expected_lines e
  full join actual a on a.gear = e.gear
  where e.gear is null or a.gear is null
     or a.quantity <> e.qty
     or a.required_quantity <> e.req_extra
     or a.source <> case when e.req_extra > 0 then 'required' else 'optional' end
  limit 1;
  if v_problem is not null then
    return 'chargeable gear does not match the answers, package and addons: ' || v_problem;
  end if;

  if exists (
    select 1
    from (select i ->> 'gear_key' as gear, (i ->> 'quantity')::int as qty from jsonb_array_elements(v_package -> 'included') i) e
    full join (
      select l.item_key as gear, l.quantity as qty from public.proposal_selection_lines l
      where l.selection_id = s.id and l.source = 'included'
    ) a on a.gear = e.gear
    where e.gear is null or a.gear is null or a.qty <> e.qty
  ) then
    return 'included gear does not match the package';
  end if;
  return null;
end;
$$;
revoke execute on function private.selection_choice_problem(uuid) from public, anon, authenticated;

create or replace function private.verify_selection_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_problem text;
begin
  if tg_table_name = 'proposal_selections' then
    v_id := new.id;
  else
    v_id := new.selection_id;
  end if;
  perform private.verify_proposal_selection(v_id);
  v_problem := private.selection_choice_problem(v_id);
  if v_problem is not null then
    raise exception 'invalid selection: %', v_problem using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- Inserts an immutable submission (selection + lines). Internal only: no
-- role can execute it; callers hold the proposal lock and have checked the
-- session, state and expiry.
create function private.insert_selection_submission(p_proposal_id uuid, p_selection jsonb, p_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_selection_id uuid;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id;
  if v_proposal.offer_snapshot is null then
    raise exception 'the offer is not frozen yet' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.proposal_selections (
    tenant_id, proposal_id, version, package_key, addon_quantities, logistics_answers,
    subtotal_cents, tax_cents, total_cents, currency, tax_breakdown, selection_snapshot,
    pricing_version, offer_sha256, submitted_at, idempotency_key
  ) values (
    v_proposal.tenant_id, v_proposal.id, v_proposal.current_selection_version + 1,
    p_selection ->> 'package_key', p_selection -> 'addon_quantities', p_selection -> 'logistics_answers',
    (p_selection ->> 'subtotal_cents')::bigint, (p_selection ->> 'tax_cents')::bigint, (p_selection ->> 'total_cents')::bigint,
    p_selection ->> 'currency', p_selection -> 'tax_breakdown', p_selection,
    p_selection ->> 'pricing_version', p_selection ->> 'offer_sha256', now(), p_idempotency_key
  )
  returning id into v_selection_id;

  insert into public.proposal_selection_lines (
    tenant_id, selection_id, line_no, source, item_key, name, description, quantity,
    unit_price_cents, line_total_cents, required_quantity, required_reasons, tax_category
  )
  select v_proposal.tenant_id, v_selection_id, l.ord::int,
         l.x ->> 'source', l.x ->> 'item_key', l.x ->> 'name', l.x ->> 'description',
         (l.x ->> 'quantity')::int, (l.x ->> 'unit_price_cents')::bigint, (l.x ->> 'line_total_cents')::bigint,
         coalesce((l.x ->> 'required_quantity')::int, 0),
         coalesce(array(select jsonb_array_elements_text(l.x -> 'required_reasons')), '{}'),
         l.x ->> 'tax_category'
  from jsonb_array_elements(p_selection -> 'lines') with ordinality as l(x, ord);

  update public.proposals set current_selection_version = v_proposal.current_selection_version + 1 where id = v_proposal.id;
  return v_selection_id;
end;
$$;
revoke execute on function private.insert_selection_submission(uuid, jsonb, text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- Drafts: revisions start from the current offer
-- ===========================================================================

create or replace function public.open_proposal_draft(p_event_id uuid, p_offer jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_membership_id uuid;
  v_existing uuid;
  v_revision int;
  v_offer jsonb := p_offer;
  v_id uuid;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_event.tenant_id);

  select p.id into v_existing from public.proposals p where p.event_id = v_event.id and p.status = 'draft';
  if v_existing is not null then
    return v_existing;
  end if;

  if v_event.lifecycle_status in ('cancelled', 'completed', 'booked') then
    perform private.offer_error('event is ' || v_event.lifecycle_status);
  end if;
  -- A revision starts from the offer the client currently has.
  if v_offer is null and v_event.active_proposal_id is not null then
    select p.draft_offer into v_offer from public.proposals p
    where p.tenant_id = v_event.tenant_id and p.id = v_event.active_proposal_id;
  end if;
  v_offer := coalesce(v_offer, '{}'::jsonb);
  if not private.is_valid_draft_offer(v_offer) then
    perform private.offer_error('draft offer has an invalid shape');
  end if;

  select coalesce(max(p.revision), 0) + 1 into v_revision from public.proposals p where p.event_id = v_event.id;

  insert into public.proposals (tenant_id, event_id, revision, status, draft_offer, source_template_id, created_by_membership_id)
  values (
    v_event.tenant_id, v_event.id, v_revision, 'draft', v_offer,
    case when private.is_uuid_text(v_offer ->> 'template_id') then (v_offer ->> 'template_id')::uuid end,
    v_membership_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- ===========================================================================
-- Sending
-- ===========================================================================

-- One transaction: validate and freeze the saved draft exactly once, set the
-- deadline, supersede and revoke the previous offer (its frozen terms stay
-- untouched), make this the event's one actionable proposal, create the
-- hashed access link for the primary contact, and queue the email.
-- Sending is not a booking: the event returns to (or stays) a lead.
create function public.send_proposal(
  p_proposal_id uuid,
  p_expected_draft_version integer,
  p_access_link_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_event public.events%rowtype;
  v_client record;
  v_snapshot jsonb;
  v_expires timestamptz;
  v_sha text;
  v_previous uuid[];
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_access_link_id is null then
    raise exception 'invalid access link' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_proposal from public.proposals where id = p_proposal_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_proposal.tenant_id);

  -- Lock order everywhere: event, then proposal.
  select * into v_event from public.events where tenant_id = v_proposal.tenant_id and id = v_proposal.event_id for update;
  select * into v_proposal from public.proposals where id = p_proposal_id for update;

  if v_proposal.status <> 'draft' then
    raise exception 'proposal_already_sent: this proposal has already been sent' using errcode = 'invalid_parameter_value';
  end if;
  if v_proposal.draft_version <> p_expected_draft_version then
    raise exception 'draft_version_conflict: expected %, current %', p_expected_draft_version, v_proposal.draft_version
      using errcode = 'serialization_failure';
  end if;
  if v_event.lifecycle_status not in ('lead', 'pending_approval', 'awaiting_signature') then
    perform private.offer_error('event is ' || v_event.lifecycle_status);
  end if;

  select c.id, c.name, c.email, c.archived_at into v_client
  from public.event_clients ec
  join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where ec.tenant_id = v_event.tenant_id and ec.event_id = v_event.id and ec.is_primary;
  if not found then
    perform private.offer_error('the event needs a primary contact before sending');
  end if;
  if v_client.archived_at is not null then
    perform private.offer_error('the primary contact is archived');
  end if;

  v_snapshot := private.build_offer_snapshot(v_proposal.tenant_id, v_proposal.draft_offer);
  v_expires := now() + make_interval(days => (v_snapshot ->> 'expiry_days')::int);

  -- Supersede and revoke earlier actionable offers. Their frozen terms,
  -- submissions and approvals are preserved as history.
  select coalesce(array_agg(p.id), '{}') into v_previous
  from public.proposals p
  where p.event_id = v_event.id and p.id <> v_proposal.id and p.status in ('sent', 'submitted', 'approved');
  update public.proposals set status = 'superseded' where id = any (v_previous);
  update public.access_links set revoked_at = now() where proposal_id = any (v_previous) and revoked_at is null;
  update public.proposal_sessions set revoked_at = now() where proposal_id = any (v_previous) and revoked_at is null;
  update public.email_outbox set status = 'cancelled', last_error = 'superseded by a newer revision'
    where entity_id = any (v_previous) and event_type = 'proposal_sent' and status = 'pending';

  update public.proposals
    set offer_snapshot = v_snapshot,
        status = 'sent',
        sent_at = now(),
        expires_at = v_expires,
        supersedes_id = case when v_event.active_proposal_id = any (v_previous) then v_event.active_proposal_id end
    where id = v_proposal.id
    returning offer_sha256 into v_sha;

  insert into public.access_links (id, tenant_id, purpose, proposal_id, intended_client_id, token_hash, expires_at)
  values (p_access_link_id, v_proposal.tenant_id, 'proposal', v_proposal.id, v_client.id, p_token_hash,
          -- The link outlives the offer deadline so the client can still see status.
          v_expires + interval '60 days');

  update public.events set active_proposal_id = v_proposal.id, lifecycle_status = 'lead' where id = v_event.id;

  perform private.enqueue_email(
    v_proposal.tenant_id, 'proposal_sent', v_client.email, v_proposal.id, p_access_link_id,
    jsonb_build_object('event_title', v_event.title, 'event_date', v_event.event_date, 'client_name', v_client.name,
                       'expires_at', v_expires, 'revision', v_proposal.revision),
    'proposal_sent:' || v_proposal.id
  );
  perform private.audit(v_proposal.tenant_id, 'proposal', v_proposal.id, 'sent', 'staff', (select auth.uid()),
    jsonb_build_object('revision', v_proposal.revision, 'offer_sha256', v_sha, 'superseded', to_jsonb(v_previous)));

  return jsonb_build_object('status', 'sent', 'proposal_id', v_proposal.id, 'expires_at', v_expires,
                            'recipient_email', v_client.email, 'offer_sha256', v_sha);
end;
$$;

-- ===========================================================================
-- Client sessions
-- ===========================================================================

create function private.resolve_proposal_session(p_session_hash text, p_proposal_id uuid, p_tenant_slug text)
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
         e.active_proposal_id, t.archived_at
    into r
  from public.proposal_sessions s
  join public.access_links l on l.tenant_id = s.tenant_id and l.id = s.access_link_id
  join public.proposals p on p.tenant_id = s.tenant_id and p.id = s.proposal_id
  join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id
  join public.tenants t on t.id = s.tenant_id
  where s.session_hash = p_session_hash and s.proposal_id = p_proposal_id and t.slug = p_tenant_slug
    and l.purpose = 'proposal';

  if not found or r.s_exp <= now() or r.l_exp <= now() or r.archived_at is not null then
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
revoke execute on function private.resolve_proposal_session(text, uuid, text) from public, anon, authenticated;

-- Exchanges a link token hash for a new session. Returns {status: ok|invalid|superseded}.
-- Records a best-effort "link opened" event and notifies staff once.
create function public.exchange_proposal_link(p_token_hash text, p_session_hash text, p_tenant_slug text, p_session_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
         p.status, p.first_viewed_at, p.event_id, e.active_proposal_id, e.title as event_title, t.archived_at
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
$$;

-- The client's view of a proposal: an explicit, safe DTO. Excludes internal
-- notes, other contacts, staff fields, draft input, audit data and planning.
create function public.client_proposal_view(p_session_hash text, p_proposal_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
  v jsonb;
begin
  select * into s from private.resolve_proposal_session(p_session_hash, p_proposal_id, p_tenant_slug);
  if s.state in ('invalid', 'superseded') then
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
$$;

-- Saves the single mutable selection draft. Structural checks only (full
-- validation happens at submission). Returns {status: ok, version} or
-- {status: conflict, version} or the proposal state when it is not open.
create function public.client_save_selection_draft(
  p_session_hash text,
  p_proposal_id uuid,
  p_tenant_slug text,
  p_expected_version integer,
  p_package_key text,
  p_addon_quantities jsonb,
  p_logistics_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_offer jsonb;
  v_current int;
  v_version int;
begin
  select * into s from private.resolve_proposal_session(p_session_hash, p_proposal_id, p_tenant_slug);
  if s.state <> 'open' then
    return jsonb_build_object('status', s.state);
  end if;
  select p.offer_snapshot into v_offer from public.proposals p where p.id = s.proposal_id for update;
  -- Recheck after taking the lock (a submission or replacement may have committed).
  select * into s from private.resolve_proposal_session(p_session_hash, p_proposal_id, p_tenant_slug);
  if s.state <> 'open' then
    return jsonb_build_object('status', s.state);
  end if;

  if (p_package_key is not null and not exists (
        select 1 from jsonb_array_elements(v_offer -> 'packages') x where x ->> 'key' = p_package_key))
     or jsonb_typeof(p_addon_quantities) is distinct from 'object'
     or jsonb_typeof(p_logistics_answers) is distinct from 'object'
     or pg_column_size(p_logistics_answers) > 50000
     or exists (
       select 1 from jsonb_each(p_addon_quantities) a(k, v)
       left join lateral (
         select (o ->> 'max_quantity')::int as max_q from jsonb_array_elements(v_offer -> 'addons') o where o ->> 'gear_key' = a.k
       ) m on true
       where case
         when m.max_q is null then true
         when jsonb_typeof(a.v) <> 'number' or (a.v #>> '{}') !~ '^[0-9]{1,3}$' then true
         else (a.v #>> '{}')::int > m.max_q
       end)
     or exists (
       select 1 from jsonb_object_keys(p_logistics_answers) k
       where not exists (select 1 from jsonb_array_elements(v_offer -> 'questions') q where q ->> 'key' = k)) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select d.version into v_current from public.proposal_selection_drafts d where d.proposal_id = s.proposal_id;
  if coalesce(v_current, 0) <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', coalesce(v_current, 0));
  end if;

  insert into public.proposal_selection_drafts (tenant_id, proposal_id, package_key, addon_quantities, logistics_answers, version)
  values (s.tenant_id, s.proposal_id, p_package_key, p_addon_quantities, p_logistics_answers, 1)
  on conflict (proposal_id) do update
    set package_key = excluded.package_key,
        addon_quantities = excluded.addon_quantities,
        logistics_answers = excluded.logistics_answers,
        version = public.proposal_selection_drafts.version + 1
  returning version into v_version;
  return jsonb_build_object('status', 'ok', 'version', v_version);
end;
$$;

-- Submits a priced selection for DJ review. Transactional and idempotent:
-- the same idempotency key returns the original submission. Rechecks the
-- session and state after locking (event, then proposal), requires the
-- client's draft version to be current (no stale tab), and verifies prices,
-- taxes and choices against the frozen offer before committing.
create function public.client_submit_selection(
  p_session_hash text,
  p_proposal_id uuid,
  p_tenant_slug text,
  p_expected_draft_version integer,
  p_idempotency_key text,
  p_selection jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if s.state in ('invalid', 'superseded') then
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
$$;

-- ===========================================================================
-- Approval
-- ===========================================================================

-- Approves the exact, latest immutable submission of the current proposal.
-- Moves the event to awaiting_signature for the contract phase. Creates no
-- contract and never marks the event booked. Repeating the same approval
-- returns the existing one.
create function public.approve_proposal_selection(p_proposal_id uuid, p_selection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_event public.events%rowtype;
  v_membership_id uuid;
  v_selection public.proposal_selections%rowtype;
  v_existing record;
  v_client record;
  v_approval_id uuid;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_proposal.tenant_id);
  select * into v_event from public.events where tenant_id = v_proposal.tenant_id and id = v_proposal.event_id for update;
  select * into v_proposal from public.proposals where id = p_proposal_id for update;

  select a.id, a.selection_id into v_existing from public.proposal_approvals a where a.proposal_id = p_proposal_id;
  if found then
    if v_existing.selection_id = p_selection_id then
      return jsonb_build_object('status', 'approved', 'approval_id', v_existing.id, 'replayed', true);
    end if;
    raise exception 'this proposal was already approved with a different selection' using errcode = 'invalid_parameter_value';
  end if;
  if v_proposal.status <> 'submitted' or v_event.active_proposal_id is distinct from v_proposal.id then
    raise exception 'only the current, submitted proposal can be approved' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_selection from public.proposal_selections
  where tenant_id = v_proposal.tenant_id and proposal_id = v_proposal.id and id = p_selection_id;
  if not found or v_selection.version <> v_proposal.current_selection_version then
    raise exception 'approve the latest submitted selection' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.proposal_approvals (tenant_id, proposal_id, selection_id, approved_by_membership_id, approved_by_user_id, selection_sha256)
  values (v_proposal.tenant_id, v_proposal.id, v_selection.id, v_membership_id, (select auth.uid()),
          encode(pg_catalog.sha256(convert_to(v_selection.selection_snapshot::text, 'UTF8')), 'hex'))
  returning id into v_approval_id;

  update public.proposals set status = 'approved' where id = v_proposal.id;
  update public.events set lifecycle_status = 'awaiting_signature'
    where id = v_event.id and lifecycle_status in ('lead', 'pending_approval');

  select c.name, c.email into v_client
  from public.access_links l join public.clients c on c.tenant_id = l.tenant_id and c.id = l.intended_client_id
  where l.tenant_id = v_proposal.tenant_id and l.proposal_id = v_proposal.id and l.purpose = 'proposal'
  order by l.created_at desc limit 1;

  perform private.enqueue_email(
    v_proposal.tenant_id, 'proposal_approved', v_client.email, v_proposal.id, null,
    jsonb_build_object('event_title', v_event.title, 'client_name', v_client.name,
                       'total_cents', v_selection.total_cents, 'currency', v_selection.currency),
    'proposal_approved:' || v_proposal.id
  );
  perform private.audit(v_proposal.tenant_id, 'proposal', v_proposal.id, 'approved', 'staff', (select auth.uid()),
    jsonb_build_object('selection_id', v_selection.id));

  return jsonb_build_object('status', 'approved', 'approval_id', v_approval_id, 'replayed', false);
end;
$$;

-- ===========================================================================
-- Rate limiting (durable, shared by all server instances)
-- ===========================================================================

create function public.consume_rate_limit(p_bucket text, p_subject_hash text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits int;
begin
  if p_bucket !~ '^[a-z_]{1,40}$' or p_subject_hash !~ '^[0-9a-f]{64}$'
     or p_limit < 1 or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit request' using errcode = 'invalid_parameter_value';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into private.rate_limit_counters as c (bucket, subject_hash, window_start, hits)
  values (p_bucket, p_subject_hash, v_window, 1)
  on conflict (bucket, subject_hash, window_start) do update set hits = c.hits + 1
  returning hits into v_hits;
  delete from private.rate_limit_counters
    where bucket = p_bucket and subject_hash = p_subject_hash and window_start < v_window;
  if random() < 0.01 then
    delete from private.rate_limit_counters where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_limit;
end;
$$;

-- Public branding for a tenant slug (used on error pages). Nothing else.
create function public.public_tenant_brand(p_tenant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('display_name', t.display_name, 'brand_colors', t.brand_colors)
  from public.tenants t where t.slug = p_tenant_slug and t.archived_at is null;
$$;

-- ===========================================================================
-- Email outbox processing
-- ===========================================================================

-- Claims due emails for delivery. FOR UPDATE SKIP LOCKED lets several
-- workers run safely; a crashed worker's claim expires after p_lock_seconds.
create function public.claim_email_outbox(p_limit integer default 10, p_lock_seconds integer default 120, p_tenant_id uuid default null)
returns table (
  id uuid, tenant_id uuid, event_type text, recipient_email text, entity_id uuid, payload jsonb, attempts integer,
  access_link_id uuid, link_token_hash text, link_usable boolean, proposal_active boolean,
  tenant_slug text, tenant_display_name text, tenant_reply_to text
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
         t.slug, t.display_name, t.reply_to_email
  from claimed c
  join public.tenants t on t.id = c.tenant_id
  left join public.access_links l on l.tenant_id = c.tenant_id and l.id = c.access_link_id
  left join public.proposals p on p.tenant_id = c.tenant_id and p.id = c.entity_id
  left join public.events e on e.tenant_id = p.tenant_id and e.id = p.event_id;
end;
$$;

create function public.complete_email_outbox(p_id uuid, p_provider_message_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox
    set status = 'sent', sent_at = now(), provider_message_id = left(p_provider_message_id, 200),
        locked_until = null, last_error = null
    where id = p_id and status = 'sending';
$$;

-- Records a failed attempt. Retries back off exponentially (1, 2, 4... min,
-- capped at 1 hour) until max_attempts, then the email is marked failed and
-- shown to staff with a retry control.
create function public.fail_email_outbox(p_id uuid, p_error text, p_permanent boolean default false)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox
    set status = case when p_permanent or attempts >= max_attempts then 'failed' else 'pending' end,
        next_attempt_at = now() + least(interval '1 minute' * power(2, greatest(attempts - 1, 0)), interval '1 hour'),
        last_error = left(coalesce(p_error, 'unknown error'), 1000),
        locked_until = null
    where id = p_id and status = 'sending';
$$;

create function public.cancel_email_outbox(p_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox
    set status = 'cancelled', last_error = left(coalesce(p_reason, 'cancelled'), 1000), locked_until = null
    where id = p_id and status in ('pending', 'sending');
$$;

-- Staff: put a failed email back in the queue with a few more attempts.
create function public.retry_email_outbox(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select o.tenant_id into v_tenant from public.email_outbox o where o.id = p_id;
  if v_tenant is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(v_tenant);
  update public.email_outbox
    set status = 'pending', max_attempts = least(attempts + 3, 50), next_attempt_at = now()
    where id = p_id and status = 'failed';
  return found;
end;
$$;

-- ===========================================================================
-- Grants
-- ===========================================================================

revoke execute on function
  public.send_proposal(uuid, integer, uuid, text),
  public.approve_proposal_selection(uuid, uuid),
  public.retry_email_outbox(uuid),
  public.exchange_proposal_link(text, text, text, integer),
  public.client_proposal_view(text, uuid, text),
  public.client_save_selection_draft(text, uuid, text, integer, text, jsonb, jsonb),
  public.client_submit_selection(text, uuid, text, integer, text, jsonb),
  public.consume_rate_limit(text, text, integer, integer),
  public.public_tenant_brand(text),
  public.claim_email_outbox(integer, integer, uuid),
  public.complete_email_outbox(uuid, text),
  public.fail_email_outbox(uuid, text, boolean),
  public.cancel_email_outbox(uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.send_proposal(uuid, integer, uuid, text),
  public.approve_proposal_selection(uuid, uuid),
  public.retry_email_outbox(uuid)
  to authenticated;

grant execute on function
  public.exchange_proposal_link(text, text, text, integer),
  public.client_proposal_view(text, uuid, text),
  public.client_save_selection_draft(text, uuid, text, integer, text, jsonb, jsonb),
  public.client_submit_selection(text, uuid, text, integer, text, jsonb),
  public.consume_rate_limit(text, text, integer, integer),
  public.public_tenant_brand(text),
  public.claim_email_outbox(integer, integer, uuid),
  public.complete_email_outbox(uuid, text),
  public.fail_email_outbox(uuid, text, boolean),
  public.cancel_email_outbox(uuid, text)
  to service_role;
