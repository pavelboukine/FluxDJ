-- Platform administration counts only active memberships.
--
-- 20261030000100_staff_invitations made staff removal soft
-- (tenant_memberships.removed_at). Two platform checks still counted any
-- membership row, so a former staff member was treated as belonging to the
-- business:
--   * suspend_workspace refuses an administrator who belongs to the
--     workspace ("workspace_own"). The guard stays for active owners and
--     staff; a removed member no longer belongs and is not refused.
--   * platform_workspaces_overview's is_member flag (which marks "your
--     workspace" and hides Suspend) now means an active membership.
-- Both definitions are otherwise unchanged; grants are kept by CREATE OR
-- REPLACE. Nothing else changes and no rows are touched.

create or replace function public.suspend_workspace(p_tenant_id uuid, p_expected_version integer, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
  if exists (select 1 from public.tenant_memberships m
             where m.tenant_id = t.id and m.user_id = (select auth.uid()) and m.removed_at is null) then
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
$function$;

create or replace function public.platform_workspaces_overview()
 returns table(id uuid, slug text, display_name text, created_at timestamp with time zone, archived_at timestamp with time zone, suspended_at timestamp with time zone, suspension_version integer, suspension_reason text, suspended_by_email text, is_member boolean)
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
#variable_conflict use_column
begin
  perform private.require_platform_admin();
  return query
  select t.id, t.slug, t.display_name, t.created_at, t.archived_at, t.suspended_at, t.suspension_version,
         a.metadata ->> 'reason', u.email::text,
         exists (select 1 from public.tenant_memberships m
                 where m.tenant_id = t.id and m.user_id = (select auth.uid()) and m.removed_at is null)
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
$function$;
