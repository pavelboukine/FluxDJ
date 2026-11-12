-- Logo variants: an optional logo for dark backgrounds beside the main logo.
-- Owner-only and versioned with the rest of branding, registered and tenant-isolated
-- like the main logo, never without a main logo, frozen into every new proposal (null
-- without one, so an offer without the key was sent before), and invisible to callers
-- from before it existed.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(43);

create function tests.put_logo(tenant text) returns text language plpgsql as $$
declare v_path text := tests.id(tenant) || '/logos/' || gen_random_uuid() || '.png';
begin
  insert into storage.objects (bucket_id, name, metadata) values ('tenant-logos', v_path, jsonb_build_object('size', 2048, 'mimetype', 'image/png'));
  return v_path;
end $$;
create function tests.register(tenant text, owner text, path text, dark boolean default false) returns uuid language plpgsql as $$
declare r uuid;
begin
  perform tests.login_as_service();
  r := public.register_tenant_logo(tests.id(tenant), tests.id(owner), path, repeat('c', 64), 2048, 800, 200, dark);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- A save as the current app sends it: the whole branding, and the variant only when it changes.
create function tests.brand(who text, version int, logo uuid, dark uuid default null, change boolean default false) returns int language plpgsql as $$
declare r int;
begin
  perform tests.login_as(tests.id(who));
  r := public.update_tenant_branding(tests.id('tenant_a'), version, logo, '#1e3a8a', null, null, null, dark, change);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- A save as the app deployed before this release sends it (seven arguments).
create function tests.brand_v1(version int, logo uuid) returns int language plpgsql as $$
declare r int;
begin
  perform tests.login_as(tests.id('owner_a'));
  r := public.update_tenant_branding(tests.id('tenant_a'), version, logo, '#1e3a8a', null, null, null);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.dark_path() returns text language sql as $$
  select logo_on_dark_storage_path from public.tenants where id = tests.id('tenant_a');
$$;
create function tests.version() returns int language sql as $$
  select branding_version from public.tenants where id = tests.id('tenant_a');
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set tax_categories = '{"standard": ["GST", "QST"]}' where id = tests.id('tenant_a');

select set_config('tests.main', tests.put_logo('tenant_a'), true);
select set_config('tests.l_main', tests.register('tenant_a', 'owner_a', current_setting('tests.main'))::text, true);
select set_config('tests.dark', tests.put_logo('tenant_a'), true);
select set_config('tests.l_dark', tests.register('tenant_a', 'owner_a', current_setting('tests.dark'), true)::text, true);
select set_config('tests.dark2', tests.put_logo('tenant_a'), true);
select set_config('tests.l_dark2', tests.register('tenant_a', 'owner_a', current_setting('tests.dark2'), true)::text, true);
select set_config('tests.other', tests.put_logo('tenant_b'), true);
select set_config('tests.l_other', tests.register('tenant_b', 'owner_b', current_setting('tests.other'), true)::text, true);

-- ===========================================================================
-- The column: registered, same business, never without a main logo
-- ===========================================================================
select is(tests.dark_path(), null, 'no business has a logo for dark backgrounds until its owner adds one');
select is(has_function_privilege('anon', 'public.update_tenant_branding(uuid, integer, uuid, text, integer, text, boolean, uuid, boolean)', 'execute'), false,
  'anonymous visitors can''t change it');
select is((select count(*)::int from pg_proc where proname = 'update_tenant_branding'), 1, 'one signature, so older calls are never ambiguous');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.tenants set logo_on_dark_storage_path = current_setting('tests.dark') where id = tests.id('tenant_a') $$, '42501', null,
  'the owner can''t write the column directly');
reset role;
select tests.login_as_service();
select throws_ok($$ update public.tenants set logo_storage_path = current_setting('tests.main'), logo_on_dark_storage_path = current_setting('tests.other') where id = tests.id('tenant_a') $$,
  '23503', null, 'even privileged code can only use a registered logo of the same business');
select throws_ok($$ update public.tenants set logo_storage_path = current_setting('tests.main'), logo_on_dark_storage_path = tests.id('tenant_a') || '/logos/unverified.png' where id = tests.id('tenant_a') $$,
  '23503', null, 'never an unregistered file');
select throws_ok($$ update public.tenants set logo_storage_path = null, logo_on_dark_storage_path = current_setting('tests.dark') where id = tests.id('tenant_a') $$,
  '23514', null, 'never without a main logo');
reset role;

-- ===========================================================================
-- Who changes it
-- ===========================================================================
select throws_ok($$ select tests.brand('staff_a', 0, current_setting('tests.l_main')::uuid, current_setting('tests.l_dark')::uuid, true) $$, '42501', null,
  'staff can''t add it');
select throws_ok($$ select tests.brand('owner_b', 0, current_setting('tests.l_main')::uuid, current_setting('tests.l_dark')::uuid, true) $$, 'P0002', null,
  'another business''s owner gets not found');
select throws_ok($$ select tests.brand('client_x', 0, current_setting('tests.l_main')::uuid, current_setting('tests.l_dark')::uuid, true) $$, 'P0002', null,
  'clients get not found');
select throws_like($$ select tests.brand('owner_a', 0, current_setting('tests.l_main')::uuid, current_setting('tests.l_other')::uuid, true) $$, '%branding_invalid%',
  'another business''s logo can''t be chosen');
select throws_like($$ select tests.brand('owner_a', 0, null, current_setting('tests.l_dark')::uuid, true) $$, '%branding_invalid: add your main logo%',
  'it needs a main logo');
select is(tests.version(), 0, 'refused saves change nothing');

-- ===========================================================================
-- Adding, keeping, replacing and removing
-- ===========================================================================
select is(tests.brand('owner_a', 0, current_setting('tests.l_main')::uuid, current_setting('tests.l_dark')::uuid, true), 1, 'the owner adds both logos in one save');
select results_eq($$ select logo_storage_path, logo_on_dark_storage_path from public.tenants where id = tests.id('tenant_a') $$,
  $$ values (current_setting('tests.main'), current_setting('tests.dark')) $$, 'both are active');
select is((select metadata ->> 'logo_on_dark_storage_path' from public.audit_events where tenant_id = tests.id('tenant_a') and action = 'branding_updated'),
  current_setting('tests.dark'), 'and the change is audited');
select is((select (metadata ->> 'logo_on_dark_changed')::boolean from public.audit_events where tenant_id = tests.id('tenant_a') and action = 'branding_updated'),
  true, 'as a change of the logo for dark backgrounds');
select throws_ok($$ select tests.brand('owner_a', 0, current_setting('tests.l_main')::uuid, null, true) $$, 'PT409', null, 'a stale tab can''t remove it');

select is(tests.brand('owner_a', 1, current_setting('tests.l_main')::uuid), 2, 'a save that doesn''t touch it');
select is(tests.dark_path(), current_setting('tests.dark'), 'keeps it');
select is(tests.brand_v1(2, current_setting('tests.l_main')::uuid), 3, 'so does a save from the app deployed before logo variants');
select is(tests.dark_path(), current_setting('tests.dark'), 'which never knew about it');

select is(tests.brand('owner_a', 3, current_setting('tests.l_main')::uuid, current_setting('tests.l_dark2')::uuid, true), 4, 'the owner replaces it');
select is(tests.dark_path(), current_setting('tests.dark2'), 'with the new upload');
select is((select logo_storage_path from public.tenants where id = tests.id('tenant_a')), current_setting('tests.main'), 'and the main logo is unchanged');

select tests.login_as_service();
select results_eq(
  $$ select b ->> 'logo_storage_path', b ->> 'logo_on_dark_storage_path', (b ->> 'logo_on_dark_width')::int, (b ->> 'logo_on_dark_height')::int
     from (select public.public_tenant_brand('test-bouprod') b) x $$,
  $$ values (current_setting('tests.main'), current_setting('tests.dark2'), 800, 200) $$, 'client pages get both logos');
select is(public.public_tenant_brand('test-other-dj') ->> 'logo_on_dark_storage_path', null, 'and never another business''s');
reset role;

-- ===========================================================================
-- Frozen proposals
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.pid', public.open_proposal_draft(tests.id('event_a1'), tests.base_offer())::text, true);
select is(public.preview_proposal_offer(current_setting('tests.pid')::uuid) -> 'branding' ->> 'logo_on_dark_storage_path', current_setting('tests.dark2'),
  'a draft''s preview carries the logo for dark backgrounds');
select tests.send(current_setting('tests.pid')::uuid);
reset role;
select results_eq(
  $$ select offer_snapshot -> 'branding' ->> 'logo_storage_path', offer_snapshot -> 'branding' ->> 'logo_on_dark_storage_path'
     from public.proposals where id = current_setting('tests.pid')::uuid $$,
  $$ values (current_setting('tests.main'), current_setting('tests.dark2')) $$, 'a sent proposal freezes both logos');
select set_eq(
  $$ select jsonb_object_keys(offer_snapshot -> 'branding') from public.proposals where id = current_setting('tests.pid')::uuid $$,
  array['display_name', 'logo_storage_path', 'brand_colors', 'logo_on_dark_storage_path'],
  'under the key the deployed app reads, and nothing else new');

select is(tests.brand('owner_a', 4, current_setting('tests.l_main')::uuid, current_setting('tests.l_dark')::uuid, true), 5, 'the owner swaps the variant back');
select is((select offer_snapshot -> 'branding' ->> 'logo_on_dark_storage_path' from public.proposals where id = current_setting('tests.pid')::uuid),
  current_setting('tests.dark2'), 'the sent proposal keeps the one it was sent with');

select is(tests.brand('owner_a', 5, current_setting('tests.l_main')::uuid, null, true), 6, 'the owner removes the variant');
select is(tests.dark_path(), null, 'it is gone');
select is((select logo_storage_path from public.tenants where id = tests.id('tenant_a')), current_setting('tests.main'), 'and the main logo stays');
select tests.login_as(tests.id('owner_a'));
select set_config('tests.pid2', public.open_proposal_draft(tests.id('event_a2'), tests.base_offer())::text, true);
select is(public.preview_proposal_offer(current_setting('tests.pid2')::uuid) -> 'branding' -> 'logo_on_dark_storage_path', 'null'::jsonb,
  'without a variant the key is still present, as null: it marks an offer frozen under logo variants');
select is(public.preview_proposal_offer(current_setting('tests.pid2')::uuid) -> 'branding' ->> 'logo_storage_path', current_setting('tests.main'),
  'with the main logo as before');
reset role;
select is((select offer_snapshot -> 'branding' ->> 'logo_on_dark_storage_path' from public.proposals where id = current_setting('tests.pid')::uuid),
  current_setting('tests.dark2'), 'and the earlier proposal still has its frozen variant');
select tests.login_as_service();
select is(public.tenant_logo_details(tests.id('tenant_a'), current_setting('tests.dark2')) ->> 'storage_path', current_setting('tests.dark2'),
  'which still resolves');
reset role;

select set_eq(
  $$ select storage_path from private.unused_tenant_logos() where tenant_id = tests.id('tenant_a') $$,
  $$ values (current_setting('tests.dark')) $$,
  'clean-up lists only the variant nothing shows or holds; a frozen variant is in use');

-- ===========================================================================
-- Removing the main logo removes the variant
-- ===========================================================================
select is(tests.brand('owner_a', 6, current_setting('tests.l_main')::uuid, current_setting('tests.l_dark')::uuid, true), 7, 'with both logos again');
select is(tests.brand_v1(7, null), 8, 'an older app removing the logo still succeeds');
select results_eq($$ select logo_storage_path, logo_on_dark_storage_path from public.tenants where id = tests.id('tenant_a') $$,
  $$ values (null::text, null::text) $$, 'and leaves no variant behind');

select * from finish();
rollback;
