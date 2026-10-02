-- Storage authorization for the private gear-media bucket, tested against
-- the real storage.objects policies that the Storage API enforces.
-- Paths: {tenant_id}/gear-items/{gear_item_id}/{object_uuid}.{ext}
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
select plan(27);

-- The Storage API sets storage.allow_delete_query before deleting, so that
-- deletes are decided by RLS. Do the same here; otherwise Storage's own
-- protect_delete trigger rejects every direct delete and the test would not
-- exercise our policies.
select set_config('storage.allow_delete_query', 'true', true);

-- Runs a statement and reports the outcome without aborting the test.
create function tests.attempt(sql text) returns text
language plpgsql as $$
declare
  n bigint;
begin
  execute sql;
  get diagnostics n = row_count;
  return 'rows:' || n;
exception when others then
  return 'error:' || sqlstate;
end;
$$;
grant execute on function tests.attempt(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Bucket configuration
-- ---------------------------------------------------------------------------
select results_eq($$ select public from storage.buckets where id = 'gear-media' $$,
  array[false], 'gear-media bucket is private');
select ok((select file_size_limit is not null from storage.buckets where id = 'gear-media'),
  'gear-media bucket has a size limit');
select is(
  (select array(select unnest(allowed_mime_types) order by 1) from storage.buckets where id = 'gear-media'),
  array['image/avif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'],
  'gear-media accepts only image/video types');
select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and cmd in ('UPDATE', 'DELETE', 'ALL')
       and (coalesce(qual, '') like '%gear-media%' or coalesce(with_check, '') like '%gear-media%') $$,
  'no update or delete policies: gear media cannot be overwritten or removed by users');

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select results_eq($$ select name from storage.objects where bucket_id = 'gear-media' $$,
  array[tests.media_path('tenant_a', 'gear_a_speaker', 'obj_a', 'jpg')], 'owner A reads only tenant A media');
select tests.login_as(tests.id('staff_a'));
select results_eq($$ select name from storage.objects where bucket_id = 'gear-media' $$,
  array[tests.media_path('tenant_a', 'gear_a_speaker', 'obj_a', 'jpg')], 'staff A reads tenant A media');
select tests.login_as(tests.id('owner_b'));
select results_eq($$ select name from storage.objects where bucket_id = 'gear-media' $$,
  array[tests.media_path('tenant_b', 'gear_b_speaker', 'obj_b', 'mp4')], 'owner B reads only tenant B media');
select tests.login_as(tests.id('client_x'));
select is_empty($$ select name from storage.objects where bucket_id = 'gear-media' $$,
  'client with events at both DJs reads no gear media directly');
select tests.login_as(tests.id('stranger'));
select is_empty($$ select name from storage.objects where bucket_id = 'gear-media' $$,
  'user without membership reads no gear media');
select tests.login_as_anon();
select is_empty($$ select name from storage.objects where bucket_id = 'gear-media' $$,
  'anon reads no gear media');

-- ---------------------------------------------------------------------------
-- Uploads (inserts)
-- ---------------------------------------------------------------------------
select tests.login_as(tests.id('owner_a'));
select lives_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || tests.id('gear_a_uplights') || '/' || gen_random_uuid() || '.webp'),
  'owner A uploads under own tenant gear item');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_b') || '/gear-items/' || tests.id('gear_b_speaker') || '/' || gen_random_uuid() || '.jpg'),
  '42501', null, 'owner A cannot upload into tenant B');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || tests.id('gear_b_speaker') || '/' || gen_random_uuid() || '.jpg'),
  '42501', null, 'owner A cannot upload under tenant B gear using own tenant prefix');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || gen_random_uuid() || '/' || gen_random_uuid() || '.jpg'),
  '42501', null, 'owner A cannot upload under a gear item that does not exist');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || tests.id('gear_a_speaker') || '/speaker.jpg'),
  '42501', null, 'object names must be random UUIDs, not chosen filenames');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || tests.id('gear_a_speaker') || '/' || gen_random_uuid() || '.svg'),
  '42501', null, 'unsupported extensions (e.g. svg) are rejected');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/../' || tests.id('tenant_b') || '/' || gen_random_uuid() || '.jpg'),
  '42501', null, 'path traversal style names are rejected');

-- Overwrite and delete attempts change nothing.
select is(
  tests.attempt(format($$ update storage.objects set metadata = '{"tampered":true}' where name = %L $$,
  tests.media_path('tenant_a', 'gear_a_speaker', 'obj_a', 'jpg'))),
  'rows:0',
  'owner A cannot overwrite own media (no update policy)');
select is(
  tests.attempt(format($$ delete from storage.objects where name = %L $$,
  tests.media_path('tenant_a', 'gear_a_speaker', 'obj_a', 'jpg'))),
  'rows:0',
  'owner A cannot delete own media (no delete policy)');

select tests.login_as(tests.id('staff_a'));
select lives_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || tests.id('gear_a_speaker') || '/' || gen_random_uuid() || '.mp4'),
  'staff A can upload tenant A media');

select tests.login_as(tests.id('client_x'));
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || tests.id('gear_a_speaker') || '/' || gen_random_uuid() || '.jpg'),
  '42501', null, 'client cannot upload gear media');
select is(
  tests.attempt(format($$ delete from storage.objects where name = %L $$,
  tests.media_path('tenant_b', 'gear_b_speaker', 'obj_b', 'mp4'))),
  'rows:0',
  'client cannot delete tenant B media');

select tests.login_as_anon();
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('gear-media', %L) $$,
         tests.id('tenant_a') || '/gear-items/' || tests.id('gear_a_speaker') || '/' || gen_random_uuid() || '.jpg'),
  '42501', null, 'anon cannot upload gear media');

select tests.login_as(tests.id('owner_b'));
select is(
  tests.attempt(format($$ delete from storage.objects where name = %L $$,
  tests.media_path('tenant_a', 'gear_a_speaker', 'obj_a', 'jpg'))),
  'rows:0',
  'owner B cannot delete tenant A media');

-- ---------------------------------------------------------------------------
-- After every overwrite/delete attempt above, both objects are intact.
-- ---------------------------------------------------------------------------
reset role;
select results_eq(
  $$ select metadata from storage.objects where name = tests.media_path('tenant_a', 'gear_a_speaker', 'obj_a', 'jpg') $$,
  array['{"mimetype":"image/jpeg"}'::jsonb], 'owner A could not overwrite object metadata');
select results_eq(
  $$ select count(*)::int from storage.objects
     where name in (tests.media_path('tenant_a', 'gear_a_speaker', 'obj_a', 'jpg'),
                    tests.media_path('tenant_b', 'gear_b_speaker', 'obj_b', 'mp4')) $$,
  array[2], 'no user could delete gear media objects');
select results_eq(
  $$ select count(*)::int from storage.objects where bucket_id = 'gear-media'
     and split_part(name, '/', 1) = tests.id('tenant_a')::text $$,
  array[3], 'exactly the two permitted tenant A uploads were added');

select * from finish();
rollback;
