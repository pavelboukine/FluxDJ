-- Version conflicts use SQLSTATE PT409, which PostgREST answers at once with
-- HTTP 409. Never serialization_failure (40001): PostgREST v14 retries that
-- as a transient failure, so a deliberate conflict would never answer.
-- Behaviour per function is covered by each feature's tests (a stale version
-- raises PT409 and writes nothing).
begin;
select plan(3);

select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosrc ilike '%serialization_failure%'
$$, 'no function raises serialization_failure (40001)');

select set_eq($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosrc ~ 'errcode\s*=\s*''PT409'''
$$, array[
  'close_plan_client_editing(uuid,integer,text)',
  'private.lock_plan_for_staff(uuid,integer)',
  'private.lock_planning_template(uuid,integer)',
  'private.move_plan_client_cutoff(uuid,integer,integer,text,text)',
  'publish_contract_template_version(uuid,integer,text,text)',
  'reopen_plan_client_editing(uuid,integer,timestamp without time zone,text)',
  'save_contract_template_draft(uuid,integer,text,jsonb)',
  'send_proposal(uuid,integer,uuid,text)',
  'set_event_invoice_url(uuid,text,integer)',
  'update_booking_policy(uuid,text,integer)',
  'update_planning_cutoff_days(uuid,integer,integer)',
  'update_proposal_draft(uuid,integer,jsonb)',
  'update_tax_settings(uuid,integer,jsonb,jsonb)'
], 'every optimistic-version check raises PT409');

-- The conflict functions keep their privileges: still callable by signed-in users, never by anon.
select ok(
  has_function_privilege('authenticated', 'public.update_booking_policy(uuid,text,integer)', 'execute')
  and not has_function_privilege('anon', 'public.update_booking_policy(uuid,text,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.lock_plan_for_staff(uuid,integer)', 'execute'),
  'grants are unchanged by the re-created definitions');

select * from finish();
rollback;
