-- Platform operations: the scheduled worker's heartbeat, and read-only
-- summaries of email and signed-PDF jobs needing attention, for platform
-- administrators only (Platform → Operations).
--
-- Nothing here changes how emails or PDFs are queued, claimed, retried or
-- leased. "Overdue" mirrors exactly what the claim functions would pick up
-- (claim_email_outbox, claim_platform/staff/planning_email_outbox,
-- claim_document_jobs) once it has waited longer than three cron intervals:
-- if such a job exists, the worker isn't keeping up. "Failed" is the existing
-- failed status. Additive only: the deployed app never calls these.

-- ---------------------------------------------------------------------------
-- Worker heartbeat: one row per scheduled worker, updated at the end of each
-- run by the cron route (record_worker_run). Private: not exposed over the
-- API and never readable by any client role.
-- ---------------------------------------------------------------------------
create table private.worker_heartbeats (
  worker text primary key
    constraint worker_heartbeats_worker_valid check (worker in ('outbox_cron')),
  last_finished_at timestamptz not null,
  last_outcome text not null
    constraint worker_heartbeats_outcome_valid check (last_outcome in ('ok', 'error')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer not null default 0
    constraint worker_heartbeats_failures_valid check (consecutive_failures >= 0),
  -- Counts only (claimed, sent, failed, …): never ids, addresses or errors.
  last_summary jsonb not null default '{}'::jsonb
);
revoke all on private.worker_heartbeats from public, anon, authenticated;

-- Records the end of a scheduled run. Service role only (the cron route).
-- p_ok: no worker-level problem. Counts are clamped to non-negative integers
-- and stored under fixed keys, so the row can never carry anything else.
create function public.record_worker_run(
  p_worker text,
  p_ok boolean,
  p_claimed integer default 0,
  p_sent integer default 0,
  p_failed integer default 0,
  p_cancelled integer default 0,
  p_unconfirmed integer default 0,
  p_problems integer default 0,
  p_documents_failed integer default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_summary jsonb := jsonb_build_object(
    'claimed', greatest(coalesce(p_claimed, 0), 0), 'sent', greatest(coalesce(p_sent, 0), 0),
    'failed', greatest(coalesce(p_failed, 0), 0), 'cancelled', greatest(coalesce(p_cancelled, 0), 0),
    'unconfirmed', greatest(coalesce(p_unconfirmed, 0), 0), 'problems', greatest(coalesce(p_problems, 0), 0),
    'documents_failed', greatest(coalesce(p_documents_failed, 0), 0));
  v_ok boolean := coalesce(p_ok, false);
begin
  if p_worker is distinct from 'outbox_cron' then
    raise exception 'unknown worker' using errcode = 'invalid_parameter_value';
  end if;
  insert into private.worker_heartbeats as h (worker, last_finished_at, last_outcome, last_success_at, last_failure_at, consecutive_failures, last_summary)
  values (p_worker, now(), case when v_ok then 'ok' else 'error' end,
          case when v_ok then now() end, case when v_ok then null else now() end,
          case when v_ok then 0 else 1 end, v_summary)
  on conflict (worker) do update set
    last_finished_at = now(),
    last_outcome = excluded.last_outcome,
    last_success_at = case when v_ok then now() else h.last_success_at end,
    last_failure_at = case when v_ok then h.last_failure_at else now() end,
    consecutive_failures = case when v_ok then 0 else h.consecutive_failures + 1 end,
    last_summary = excluded.last_summary;
end;
$$;
revoke execute on function public.record_worker_run(text, boolean, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.record_worker_run(text, boolean, integer, integer, integer, integer, integer, integer, integer) to service_role;

-- Failed jobs, newest first, for the bounded lists below.
create index email_outbox_failed_idx on public.email_outbox (updated_at desc) where status = 'failed';
create index document_jobs_failed_idx on public.document_jobs (updated_at desc) where status = 'failed';

-- ---------------------------------------------------------------------------
-- Shared definitions (private, not callable over the API)
-- ---------------------------------------------------------------------------

-- An email the worker should already have claimed: what a claim function
-- would pick up (pending and due, or a claim whose lease ended, attempts
-- left, business active), overdue by more than p_grace. Archived and
-- suspended businesses send nothing on purpose, so their emails never count.
create function private.email_overdue(o public.email_outbox, p_grace interval)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (o.status = 'pending' or (o.status = 'sending' and o.locked_until < now() - p_grace))
     and o.next_attempt_at < now() - p_grace
     and o.attempts < o.max_attempts
     and (o.tenant_id is null
          or exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null and t.suspended_at is null));
$$;
revoke execute on function private.email_overdue(public.email_outbox, interval) from public, anon, authenticated;

-- A failed email needing attention: failed within the window, from an
-- active business or a platform email (archived businesses send nothing, so
-- their failures need no action).
create function private.email_needs_attention(o public.email_outbox, p_since timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select o.status = 'failed' and o.updated_at >= p_since
     and (o.tenant_id is null or exists (select 1 from public.tenants t where t.id = o.tenant_id and t.archived_at is null));
$$;
revoke execute on function private.email_needs_attention(public.email_outbox, timestamptz) from public, anon, authenticated;

-- Failed, but an earlier attempt may have reached the recipient: an attempt
-- that never finished, or the provider refusing a changed repeat (wording
-- written by claim_email_outbox and the worker; see src/lib/email/history.ts).
create function private.email_possibly_delivered(p_last_error text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_last_error = 'delivery did not complete'
                  or p_last_error like 'An earlier attempt of this email may already have been delivered%', false);
$$;
revoke execute on function private.email_possibly_delivered(text) from public, anon, authenticated;

-- A signed-PDF job the worker should already have claimed (claim_document_jobs:
-- pending and due, or a lease that ended, attempts left, business not
-- suspended), overdue by more than p_grace.
create function private.document_job_overdue(j public.document_jobs, p_grace interval)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ((j.status = 'pending' and j.next_attempt_at < now() - p_grace)
          or (j.status = 'running' and j.locked_until < now() - p_grace))
     and j.attempts < j.max_attempts
     and exists (select 1 from public.tenants t where t.id = j.tenant_id and t.suspended_at is null);
$$;
revoke execute on function private.document_job_overdue(public.document_jobs, interval) from public, anon, authenticated;

-- A failed PDF job needing attention: failed within the window, business not archived.
create function private.document_job_needs_attention(j public.document_jobs, p_since timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select j.status = 'failed' and j.updated_at >= p_since
     and exists (select 1 from public.tenants t where t.id = j.tenant_id and t.archived_at is null);
$$;
revoke execute on function private.document_job_needs_attention(public.document_jobs, timestamptz) from public, anon, authenticated;

-- Error text never leaves the database for these summaries. A stored error
-- can quote anything (a provider's or database's own message, values from a
-- failed statement), so it is mapped to a fixed sentence: the worker's own
-- known messages are named, a provider refusal shows only its HTTP status and
-- fixed error code, anything else is generic. The raw text stays on the row,
-- for an operator with database access.
create function private.email_error_summary(p_error text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_error is null then null
    when private.email_possibly_delivered(p_error) and p_error = 'delivery did not complete'
      then 'The last attempt didn''t finish, so it may have been delivered. Check before retrying.'
    when private.email_possibly_delivered(p_error)
      then 'An earlier attempt may already have been delivered: the email provider refused a changed repeat. Check before retrying.'
    when p_error ~ 'responded [0-9]{3}'
      then 'The email provider refused it (HTTP ' || substring(p_error from 'responded ([0-9]{3})')
           || coalesce(', ' || substring(p_error from 'responded [0-9]{3} \(([a-z_]{1,60})\)'), '') || ').'
    when p_error like 'The link secret changed%' then 'The link secret changed after this link was created; send a new one.'
    when p_error like 'The signed PDF is not available yet%' then 'The signed PDF was not available yet.'
    when p_error like 'The signed PDF%' or p_error like 'The stored signed PDF%' then 'The signed PDF could not be read or verified.'
    when p_error like 'The sender could not be prepared%' then 'The sender could not be prepared.'
    when p_error like 'Could not create a verification link%' then 'A sign-in link could not be created.'
    when p_error like 'The delivery check could not run%' then 'The delivery check could not run, so nothing was sent.'
    when p_error like 'Email delivery is disabled%' then 'Email delivery is disabled on this deployment.'
    else 'The last attempt failed (unexpected error).'
  end;
$$;
revoke execute on function private.email_error_summary(text) from public, anon, authenticated;

create function private.document_error_summary(p_error text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_error is null then null
    when p_error = 'PDF generation did not complete' then 'The last attempt didn''t finish.'
    when p_error like 'The stored signed PDF does not match%' or p_error like 'The stored signature image does not match%'
      then 'A stored file failed its integrity check. Investigate before requesting it again.'
    when p_error like 'The signed contract or its signature record could not be loaded%' then 'The signed contract or its signature record could not be loaded.'
    when p_error like 'The signature image could not be read%' then 'The signature image could not be read from storage.'
    when p_error like 'The signed PDF could not be read%' then 'The signed PDF could not be read from storage.'
    when p_error like 'The signed PDF could not be stored%' then 'The signed PDF could not be stored.'
    when p_error like 'The signed PDF could not be recorded%' then 'The signed PDF could not be recorded.'
    when p_error like 'The rendered PDF is larger than%' then 'The rendered PDF is larger than 10 MB.'
    else 'The PDF could not be generated (unexpected error).'
  end;
$$;
revoke execute on function private.document_error_summary(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Platform administrators: read-only summaries. Ids, businesses, categories,
-- statuses, attempts, times and fixed-sentence error summaries only; never
-- recipients, payloads, links, senders, branding or contract contents.
-- Failures are those of the last 30 days; overdue means more than
-- 15 minutes (three cron intervals) past due.
-- ---------------------------------------------------------------------------

create function public.platform_operations_summary()
returns table (
  checked_at timestamptz,
  window_days integer,
  grace_minutes integer,
  emails_failed bigint,
  emails_possibly_delivered bigint,
  emails_overdue bigint,
  emails_retrying bigint,
  documents_failed bigint,
  documents_overdue bigint,
  worker_last_finished_at timestamptz,
  worker_last_outcome text,
  worker_last_success_at timestamptz,
  worker_last_failure_at timestamptz,
  worker_consecutive_failures integer,
  worker_last_summary jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := now() - interval '30 days';
  v_grace interval := interval '15 minutes';
begin
  perform private.require_platform_admin();
  return query
  select now(), 30, 15,
    (select count(*) from public.email_outbox o where o.status = 'failed' and private.email_needs_attention(o, v_since)),
    (select count(*) from public.email_outbox o
      where o.status = 'failed' and private.email_needs_attention(o, v_since) and private.email_possibly_delivered(o.last_error)),
    (select count(*) from public.email_outbox o where o.status in ('pending', 'sending') and private.email_overdue(o, v_grace)),
    -- Retrying normally: a failed attempt waiting for its next try (attempts left, not overdue).
    (select count(*) from public.email_outbox o
      where o.status = 'pending' and o.attempts > 0 and o.attempts < o.max_attempts and not private.email_overdue(o, v_grace)),
    (select count(*) from public.document_jobs j where j.status = 'failed' and private.document_job_needs_attention(j, v_since)),
    (select count(*) from public.document_jobs j where j.status in ('pending', 'running') and private.document_job_overdue(j, v_grace)),
    h.last_finished_at, h.last_outcome, h.last_success_at, h.last_failure_at, h.consecutive_failures, h.last_summary
  from (select 1) one
  left join private.worker_heartbeats h on h.worker = 'outbox_cron';
end;
$$;
revoke execute on function public.platform_operations_summary() from public, anon;
grant execute on function public.platform_operations_summary() to authenticated, service_role;

create function public.platform_email_issues(p_limit integer default 50)
returns table (
  id uuid,
  issue text,
  tenant_slug text,
  tenant_name text,
  event_type text,
  status text,
  attempts integer,
  max_attempts integer,
  possibly_delivered boolean,
  error_summary text,
  next_attempt_at timestamptz,
  updated_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz := now() - interval '30 days';
  v_grace interval := interval '15 minutes';
begin
  perform private.require_platform_admin();
  return query
  select o.id,
         case when o.status = 'failed' then 'failed' else 'overdue' end,
         t.slug, t.display_name, o.event_type, o.status, o.attempts, o.max_attempts,
         o.status = 'failed' and private.email_possibly_delivered(o.last_error),
         private.email_error_summary(o.last_error), o.next_attempt_at, o.updated_at, o.created_at
  from public.email_outbox o
  left join public.tenants t on t.id = o.tenant_id
  where (o.status = 'failed' and private.email_needs_attention(o, v_since))
     or (o.status in ('pending', 'sending') and private.email_overdue(o, v_grace))
  order by (o.status <> 'failed') desc, o.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke execute on function public.platform_email_issues(integer) from public, anon;
grant execute on function public.platform_email_issues(integer) to authenticated, service_role;

create function public.platform_document_issues(p_limit integer default 50)
returns table (
  id uuid,
  issue text,
  tenant_slug text,
  tenant_name text,
  contract_id uuid,
  status text,
  attempts integer,
  max_attempts integer,
  error_summary text,
  next_attempt_at timestamptz,
  updated_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz := now() - interval '30 days';
  v_grace interval := interval '15 minutes';
begin
  perform private.require_platform_admin();
  return query
  select j.id,
         case when j.status = 'failed' then 'failed' else 'overdue' end,
         t.slug, t.display_name, j.contract_id, j.status, j.attempts, j.max_attempts,
         private.document_error_summary(j.last_error), j.next_attempt_at, j.updated_at, j.created_at
  from public.document_jobs j
  join public.tenants t on t.id = j.tenant_id
  where (j.status = 'failed' and private.document_job_needs_attention(j, v_since))
     or (j.status in ('pending', 'running') and private.document_job_overdue(j, v_grace))
  order by (j.status <> 'failed') desc, j.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke execute on function public.platform_document_issues(integer) from public, anon;
grant execute on function public.platform_document_issues(integer) to authenticated, service_role;
