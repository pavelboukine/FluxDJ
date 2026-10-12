-- Audit client email changes.
--
-- Staff save client details with a direct, RLS-checked update of
-- public.clients (the app guards it with the row's updated_at). An AFTER
-- UPDATE trigger records one audit event, in the same transaction, whenever
-- the stored email actually changes:
--
--   action      client_email_changed
--   entity      client / the client's id, in the client's business
--   actor       staff + auth.uid() (system when no user, e.g. trusted SQL)
--   metadata    {"membership_id": ...} of the acting staff member; neither
--               address is stored, so the audit log holds no extra personal
--               data (the current address is on the client record).
--
-- Only rows that really change fire it: an unchanged email, a stale-version
-- update that matches no row, and anything RLS refuses (another business, a
-- removed staff member, a suspended workspace, a client) write nothing. A
-- failed update rolls back with its audit event. Nothing else changes: no
-- column, grant, policy or existing function.

create function private.audit_client_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_membership uuid;
begin
  if v_uid is not null then
    select m.id into v_membership from public.tenant_memberships m
    where m.tenant_id = new.tenant_id and m.user_id = v_uid and m.removed_at is null;
  end if;
  perform private.audit(new.tenant_id, 'client', new.id, 'client_email_changed',
    case when v_uid is null then 'system' else 'staff' end, v_uid,
    case when v_membership is null then '{}'::jsonb else jsonb_build_object('membership_id', v_membership) end);
  return null;
end;
$$;
revoke execute on function private.audit_client_email_change() from public, anon, authenticated;

create trigger clients_audit_email_change
  after update of email on public.clients
  for each row
  when (old.email is distinct from new.email)
  execute function private.audit_client_email_change();
