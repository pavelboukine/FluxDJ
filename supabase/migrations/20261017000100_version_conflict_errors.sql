-- Version conflicts are reported with SQLSTATE PT409 instead of 40001.
--
-- Optimistic-version checks ("changed elsewhere", "draft_version_conflict")
-- used to raise serialization_failure (40001). PostgREST v14 retries 40001 as
-- a transient serialization failure, so a deliberate conflict was retried in
-- a tight loop until the client gave up: the request never answered and the
-- database rolled back thousands of transactions a second. PT409 is
-- PostgREST's custom-status SQLSTATE: it answers at once with HTTP 409 and
-- code "PT409" (PostgREST v14 and v16), the message unchanged.
--
-- Only these deliberate raises change. Genuine serialization failures, which
-- Postgres raises itself and PostgREST may rightly retry, are untouched; no
-- function catches 40001. Each function keeps its body, signature, owner,
-- grants and comment: its live definition is re-created with the one token
-- replaced. The migration refuses to run unless it finds exactly the expected
-- functions, each with one conflict raise, so it never half-applies to an
-- unexpected database.
--
-- The app maps both PT409 and 40001 to "Someone else saved changes first",
-- so the app can be deployed before or after this migration.

do $$
declare
  v_expected text[] := array[
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
  ];
  v_found text[];
  r record;
  v_def text;
  v_new text;
begin
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '{}')
    into v_found
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosrc ilike '%serialization_failure%';
  if v_found <> (select array_agg(x order by x) from unnest(v_expected) x) then
    raise exception 'version-conflict migration: expected %, found %', v_expected, v_found;
  end if;

  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosrc ilike '%serialization_failure%'
  loop
    v_def := pg_get_functiondef(r.oid);
    if (select count(*) from regexp_matches(v_def, 'errcode\s*=\s*''serialization_failure''', 'g')) <> 1
       or (select count(*) from regexp_matches(v_def, 'serialization_failure', 'g')) <> 1 then
      raise exception 'version-conflict migration: unexpected use of serialization_failure in %', r.oid::regprocedure;
    end if;
    v_new := regexp_replace(v_def, 'errcode\s*=\s*''serialization_failure''', 'errcode = ''PT409''');
    execute v_new;
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname in ('public', 'private') and p.prosrc ilike '%serialization_failure%') then
    raise exception 'version-conflict migration: serialization_failure still raised';
  end if;
end;
$$;
