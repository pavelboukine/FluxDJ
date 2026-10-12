-- Package photos (package_media, set_package_photo, Storage policies for
-- {tenant}/packages/{package}/… objects, and the frozen "image" field):
-- who may upload, read and set them, that replacing or removing keeps the
-- old photo for offers already sent, that a new revision freezes the current
-- photo, and that removed staff and suspended workspaces are refused.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(49);

select set_config('storage.allow_delete_query', 'true', true);

create function tests.su() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- Object path helper: {tenant}/packages/{package}/{object}.{ext}
create function tests.photo_path(tenant text, pkg text, obj text, ext text default 'jpg') returns text
language sql immutable as $$
  select tests.id(tenant)::text || '/packages/' || tests.id(pkg)::text || '/' || md5('package-photo-' || obj)::uuid::text || '.' || ext;
$$;
create function tests.attempt(sql text) returns text
language plpgsql as $$
begin
  execute sql;
  return 'ok';
exception when others then
  return 'error:' || sqlstate;
end;
$$;
create function tests.set_photo(pkg text, path text, who text default 'staff_a', content_type text default 'image/jpeg') returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.set_package_photo(tests.id(pkg), path, content_type, 'Full setup');
  perform tests.su();
  return r;
end $$;
create function tests.remove_photo(pkg text, who text default 'staff_a') returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  perform tests.login_as(tests.id(who));
  r := public.set_package_photo(tests.id(pkg), null);
  perform tests.su();
  return r;
end $$;
create function tests.upload(path text, who text) returns text
language plpgsql as $$
declare r text;
begin
  perform tests.login_as(tests.id(who));
  r := tests.attempt(format($q$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $q$, path));
  perform tests.su();
  return r;
end $$;
create function tests.signature_image(snapshot jsonb) returns jsonb language sql immutable as $$
  select p -> 'image' from jsonb_array_elements(snapshot -> 'packages') p where p ->> 'key' = 'signature';
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set tax_categories = '{"standard":["GST","QST"],"exempt":[]}' where id = tests.id('tenant_a');
-- Uploaded objects (as the Storage API would store them after an upload).
insert into storage.objects (bucket_id, name, metadata) values
  ('gear-media', tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), '{"mimetype":"image/jpeg"}'),
  ('gear-media', tests.photo_path('tenant_a', 'pkg_a_plus', 'b', 'webp'), '{"mimetype":"image/webp"}'),
  ('gear-media', tests.photo_path('tenant_a', 'pkg_a_basic', 'c'), '{"mimetype":"image/jpeg"}'),
  ('gear-media', tests.photo_path('tenant_b', 'pkg_b_basic', 'd'), '{"mimetype":"image/jpeg"}');

-- Privileges -------------------------------------------------------------------
select table_privs_are('public', 'package_media', 'authenticated', array['SELECT'], 'package_media: staff read only; changes go through set_package_photo');
select table_privs_are('public', 'package_media', 'anon', array[]::text[], 'package_media: nothing for anon');
select is_empty(
  $$ select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and cmd in ('UPDATE', 'DELETE', 'ALL') and (coalesce(qual, '') || coalesce(with_check, '')) like '%package_media%' $$,
  'no update or delete policies: package photos cannot be overwritten or removed by users');

-- Storage uploads ------------------------------------------------------------------
select is(tests.upload(tests.photo_path('tenant_a', 'pkg_a_plus', 'up1'), 'staff_a'), 'ok', 'staff upload a photo under their own package');
select is(tests.upload(tests.photo_path('tenant_b', 'pkg_b_basic', 'up2'), 'owner_a'), 'error:42501', 'not under another business''s package');
select is(tests.upload(tests.id('tenant_b')::text || '/packages/' || tests.id('pkg_a_plus')::text || '/' || gen_random_uuid() || '.jpg', 'owner_b'),
  'error:42501', 'not with their own prefix and another business''s package');
select is(tests.upload(tests.id('tenant_a')::text || '/packages/' || gen_random_uuid() || '/' || gen_random_uuid() || '.jpg', 'owner_a'),
  'error:42501', 'not under a package that doesn''t exist');
select is(tests.upload(tests.photo_path('tenant_a', 'pkg_a_plus', 'up3', 'mp4'), 'owner_a'), 'error:42501', 'not a video');
select is(tests.upload(tests.photo_path('tenant_a', 'pkg_a_plus', 'up4'), 'client_x'), 'error:42501', 'not a client');
select tests.login_as_anon();
select is(tests.attempt(format($q$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $q$, tests.photo_path('tenant_a', 'pkg_a_plus', 'up5'))),
  'error:42501', 'not anon');
select tests.su();

-- Storage reads -------------------------------------------------------------------
select tests.login_as(tests.id('staff_a'));
select ok((select count(*) = 4 from storage.objects where bucket_id = 'gear-media' and name like '%/packages/%'),
  'staff read their own business''s package photos (and only those)');
select tests.login_as(tests.id('owner_b'));
select results_eq($$ select name from storage.objects where bucket_id = 'gear-media' and name like '%/packages/%' $$,
  array[tests.photo_path('tenant_b', 'pkg_b_basic', 'd')], 'another business reads only its own');
select tests.login_as(tests.id('client_x'));
select is_empty($$ select name from storage.objects where bucket_id = 'gear-media' and name like '%/packages/%' $$, 'clients read no package photos directly');
select tests.login_as_anon();
select is_empty($$ select name from storage.objects where bucket_id = 'gear-media' and name like '%/packages/%' $$, 'anon cannot list package photos');
select tests.su();

-- Who may set a photo -------------------------------------------------------------
select tests.login_as_anon();
select throws_ok($$ select public.set_package_photo(tests.id('pkg_a_plus'), tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), 'image/jpeg', 'x') $$,
  '42501', null, 'anon cannot set a photo');
select tests.su();
select throws_ok($$ select tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), 'owner_b') $$, 'P0002', 'not found', 'another business cannot');
select throws_ok($$ select tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), 'client_y') $$, 'P0002', 'not found', 'nor a client');
select throws_like($$ select tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_basic', 'c')) $$, '%photo_invalid%',
  'a photo uploaded under another package is refused');
select throws_like($$ select tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'b', 'webp'), 'staff_a', 'image/jpeg') $$, '%photo_invalid%',
  'a type that doesn''t match the file name is refused');
select throws_like($$ select tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'missing')) $$, '%photo_invalid: the upload was not found%',
  'an upload that doesn''t exist is refused');
select is((select count(*)::int from public.package_media), 0, 'refused calls change nothing');

-- Set, snapshot, send ---------------------------------------------------------------
select is(tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'a')), '{"status": "set", "replayed": false}'::jsonb, 'staff set a package photo');
select is(tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'a')), '{"status": "set", "replayed": true}'::jsonb, 'a repeat is a no-op');
select is((select count(*)::int from public.package_media where package_id = tests.id('pkg_a_plus') and active), 1, 'one active photo');

select tests.login_as(tests.id('staff_a'));
select set_config('tests.p1', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select set_config('tests.preview1', tests.preview(tests.base_offer())::text, true);
select is(tests.signature_image(current_setting('tests.preview1')::jsonb),
  jsonb_build_object('storage_path', tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), 'content_type', 'image/jpeg', 'alt_text', 'Full setup'),
  'the preview carries the package''s own photo');
select ok(not exists (select 1 from jsonb_array_elements(current_setting('tests.preview1')::jsonb -> 'packages') p where p ->> 'key' <> 'signature' and p ? 'image'),
  'packages without a photo are built exactly as before (no image field)');
select lives_ok($$ select tests.send(current_setting('tests.p1')::uuid) $$, 'the proposal is sent');
select tests.su();
create temp table sent1 as select offer_snapshot, offer_sha256 from public.proposals where id = current_setting('tests.p1')::uuid;
select is(tests.signature_image((select offer_snapshot from sent1)) ->> 'storage_path', tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), 'the sent offer froze photo A');

-- Replace: the sent offer keeps A, a new revision gets B ------------------------------
select is(tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'b', 'webp'), 'owner_a', 'image/webp'),
  '{"status": "set", "replayed": false}'::jsonb, 'the owner replaces it');
select results_eq(
  $$ select storage_path, active from public.package_media where package_id = tests.id('pkg_a_plus') order by created_at, active $$,
  $$ values (tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), false), (tests.photo_path('tenant_a', 'pkg_a_plus', 'b', 'webp'), true) $$,
  'the previous photo is archived, not deleted');
select ok(exists (select 1 from storage.objects where bucket_id = 'gear-media' and name = tests.photo_path('tenant_a', 'pkg_a_plus', 'a')), 'its file is kept');
select results_eq(
  $$ select offer_snapshot = (select offer_snapshot from sent1), offer_sha256 = (select offer_sha256 from sent1) from public.proposals where id = current_setting('tests.p1')::uuid $$,
  $$ values (true, true) $$, 'the sent offer is unchanged and still shows photo A');
select tests.login_as(tests.id('staff_a'));
select set_config('tests.p2', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select is(tests.signature_image(public.preview_proposal_offer(current_setting('tests.p2')::uuid)) ->> 'storage_path',
  tests.photo_path('tenant_a', 'pkg_a_plus', 'b', 'webp'), 'a new revision previews photo B');
select lives_ok($$ select tests.send(current_setting('tests.p2')::uuid) $$, 'the revision is sent');
select tests.su();
select results_eq(
  $$ select tests.signature_image(p1.offer_snapshot) ->> 'storage_path', tests.signature_image(p2.offer_snapshot) ->> 'storage_path', p1.status
     from public.proposals p1, public.proposals p2 where p1.id = current_setting('tests.p1')::uuid and p2.id = current_setting('tests.p2')::uuid $$,
  $$ values (tests.photo_path('tenant_a', 'pkg_a_plus', 'a'), tests.photo_path('tenant_a', 'pkg_a_plus', 'b', 'webp'), 'superseded'::text) $$,
  'the revision froze B; the superseded offer still has A');
select throws_like($$ select tests.set_photo('pkg_a_plus', tests.photo_path('tenant_a', 'pkg_a_plus', 'a')) $$, '%already used%',
  'an archived photo''s upload can''t be reattached (upload it again instead)');

-- Remove -------------------------------------------------------------------------------
select is(tests.remove_photo('pkg_a_plus'), '{"status": "removed", "replayed": false}'::jsonb, 'staff remove the photo');
select is(tests.remove_photo('pkg_a_plus'), '{"status": "removed", "replayed": true}'::jsonb, 'removing again is a no-op');
select is((select count(*)::int || '/' || count(*) filter (where active) from public.package_media where package_id = tests.id('pkg_a_plus')), '2/0',
  'both records are kept, none active');
select tests.login_as(tests.id('staff_a'));
select set_config('tests.p3', public.open_proposal_draft(tests.id('event_a1'))::text, true);
select is(tests.signature_image(public.preview_proposal_offer(current_setting('tests.p3')::uuid)), null,
  'new offers no longer carry a package photo (the gear fallback applies)');
select tests.su();
select is(
  (select array_agg(action order by action) from public.audit_events where entity_type = 'package' and entity_id = tests.id('pkg_a_plus')),
  array['package_photo_added', 'package_photo_removed', 'package_photo_replaced'], 'each change is audited once');

-- Direct writes ------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select throws_ok(format($q$ insert into public.package_media (tenant_id, package_id, storage_path, content_type, alt_text) values (%L, %L, %L, 'image/jpeg', 'x') $q$,
  tests.id('tenant_a'), tests.id('pkg_a_basic'), tests.photo_path('tenant_a', 'pkg_a_basic', 'c')), '42501', null, 'staff cannot insert records directly');
select throws_ok($$ update public.package_media set active = true $$, '42501', null, 'nor change them');
select throws_ok($$ delete from public.package_media $$, '42501', null, 'nor delete them');
select tests.login_as(tests.id('owner_b'));
select is_empty($$ select id from public.package_media where tenant_id = tests.id('tenant_a') $$, 'another business sees none of the records');
select tests.su();

-- Removed staff and suspended workspaces -------------------------------------------------
update public.tenant_memberships set removed_at = now(), removed_by = tests.id('owner_a') where tenant_id = tests.id('tenant_a') and user_id = tests.id('staff_a');
select throws_ok($$ select tests.set_photo('pkg_a_basic', tests.photo_path('tenant_a', 'pkg_a_basic', 'c')) $$, 'P0002', 'not found', 'removed staff cannot set a photo');
select is(tests.upload(tests.photo_path('tenant_a', 'pkg_a_basic', 'up6'), 'staff_a'), 'error:42501', 'nor upload one');

select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select throws_ok($$ select tests.set_photo('pkg_a_basic', tests.photo_path('tenant_a', 'pkg_a_basic', 'c'), 'owner_a') $$, 'PT423', null,
  'a suspended workspace cannot set a photo');
select is(tests.upload(tests.photo_path('tenant_a', 'pkg_a_basic', 'up7'), 'owner_a'), 'error:42501', 'nor upload one');

select * from finish();
rollback;
