-- Business branding: verified logos, owner-only versioned changes, live versus
-- frozen branding, suspended and archived businesses, orphans.
begin;
\ir _fixtures.psql
\ir _catalog_fixtures.psql
\ir _offer_fixtures.psql
select plan(45);

-- A stored object as the app's verified upload leaves it.
create function tests.put_logo(tenant text, mime text default 'image/png', size int default 2048) returns text language plpgsql as $$
declare v_path text := tests.id(tenant) || '/logos/' || gen_random_uuid() || '.png';
begin
  insert into storage.objects (bucket_id, name, metadata) values ('tenant-logos', v_path, jsonb_build_object('size', size, 'mimetype', mime));
  return v_path;
end $$;
create function tests.register(tenant text, uploader text, path text, size int default 2048, dark boolean default false) returns uuid language plpgsql as $$
declare r uuid;
begin
  perform tests.login_as_service();
  r := public.register_tenant_logo(tests.id(tenant), tests.id(uploader), path, repeat('c', 64), size, 800, 200, dark);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function tests.brand(who text, tenant text, version int, logo uuid, color text) returns int language plpgsql as $$
declare r int;
begin
  perform tests.login_as(tests.id(who));
  r := public.update_tenant_branding(tests.id(tenant), version, logo, color);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

update public.tenants set brand_colors = '{"accent": "#e11d48"}', tax_categories = '{"standard": ["GST", "QST"]}' where id = tests.id('tenant_a');

-- ===========================================================================
-- Registering verified logos (service role, after the app's checks)
-- ===========================================================================
select set_config('tests.p1', tests.put_logo('tenant_a'), true);
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ select public.register_tenant_logo(tests.id('tenant_a'), tests.id('owner_a'), current_setting('tests.p1'), repeat('c', 64), 2048, 800, 200, false) $$,
  '42501', null, 'signed-in users cannot register logos themselves');
reset role;
select throws_ok($$ select tests.register('tenant_a', 'staff_a', current_setting('tests.p1')) $$, '42501', null, 'only the owner''s uploads are registered');
select throws_ok($$ select tests.register('tenant_a', 'owner_b', current_setting('tests.p1')) $$, '42501', null, 'not another business''s owner');
select throws_like($$ select tests.register('tenant_a', 'owner_a', tests.id('tenant_a') || '/logos/' || gen_random_uuid() || '.png') $$,
  '%branding_invalid%', 'a logo must be stored first');
select throws_like($$ select tests.register('tenant_a', 'owner_a', tests.put_logo('tenant_a', 'image/svg+xml')) $$, '%branding_invalid%', 'only stored PNGs');
select throws_like($$ select tests.register('tenant_a', 'owner_a', current_setting('tests.p1'), 9999) $$, '%branding_invalid%', 'the stored size must match');
select throws_ok($$ select tests.register('tenant_a', 'owner_a', tests.put_logo('tenant_b')) $$, '23514', null, 'a logo is stored under its own business');
select set_config('tests.l1', tests.register('tenant_a', 'owner_a', current_setting('tests.p1'))::text, true);
select set_config('tests.p2', tests.put_logo('tenant_a'), true);
select set_config('tests.l2', tests.register('tenant_a', 'owner_a', current_setting('tests.p2'), 2048, true)::text, true);
select set_config('tests.p3', tests.put_logo('tenant_a'), true);
select set_config('tests.l3', tests.register('tenant_a', 'owner_a', current_setting('tests.p3'))::text, true);
select set_config('tests.pb', tests.put_logo('tenant_b'), true);
select set_config('tests.lb', tests.register('tenant_b', 'owner_b', current_setting('tests.pb'))::text, true);
select isnt(current_setting('tests.l1'), '', 'the owner''s verified upload is registered');
select throws_ok($$ update public.tenant_logos set width = 1 where id = current_setting('tests.l1')::uuid $$, '23514', null, 'registered logos are immutable');
select throws_ok($$ delete from public.tenant_logos where id = current_setting('tests.l1')::uuid $$, '23514', null, 'and never deleted');

-- ===========================================================================
-- Who changes branding
-- ===========================================================================
select throws_ok($$ select tests.brand('staff_a', 'tenant_a', 0, current_setting('tests.l1')::uuid, '#1e3a8a') $$, '42501', null, 'staff can''t change branding');
select throws_ok($$ select tests.brand('owner_b', 'tenant_a', 0, current_setting('tests.l1')::uuid, '#1e3a8a') $$, 'P0002', null, 'other owners get not found');
select throws_ok($$ select tests.brand('client_x', 'tenant_a', 0, null, '#1e3a8a') $$, 'P0002', null, 'clients get not found');
select tests.login_as_anon();
select throws_ok($$ select public.update_tenant_branding(tests.id('tenant_a'), 0, null, '#1e3a8a') $$, '42501', null, 'anon can''t');
select tests.login_as(tests.id('owner_a'));
select throws_ok($$ update public.tenants set logo_storage_path = current_setting('tests.p1') where id = tests.id('tenant_a') $$, '42501', null,
  'the owner can''t write the logo column directly');
select throws_ok($$ update public.tenants set brand_colors = '{"primary": "#000000"}' where id = tests.id('tenant_a') $$, '42501', null,
  'nor the colours');
reset role;
select tests.login_as_service();
select throws_ok($$ update public.tenants set logo_storage_path = tests.id('tenant_a') || '/logos/unverified.png' where id = tests.id('tenant_a') $$,
  '23503', null, 'even privileged code can only activate a registered logo');
select throws_ok($$ update public.tenants set logo_storage_path = current_setting('tests.pb') where id = tests.id('tenant_a') $$,
  '23503', null, 'of the same business');
reset role;

select throws_ok($$ select tests.brand('owner_a', 'tenant_a', 3, null, '#1e3a8a') $$, 'PT409', null, 'a stale version is a conflict (PT409)');
select throws_like($$ select tests.brand('owner_a', 'tenant_a', 0, null, 'blue') $$, '%branding_invalid%', 'colours must be #rrggbb');
select throws_like($$ select tests.brand('owner_a', 'tenant_a', 0, null, '#12345') $$, '%branding_invalid%', 'and complete');
select throws_like($$ select tests.brand('owner_a', 'tenant_a', 0, current_setting('tests.lb')::uuid, null) $$, '%branding_invalid%',
  'another business''s logo can''t be chosen');
select is(tests.brand('owner_a', 'tenant_a', 0, current_setting('tests.l1')::uuid, '#1E3A8A'), 1, 'the owner sets a logo and colour');
select results_eq(
  $$ select logo_storage_path, brand_colors, branding_version from public.tenants where id = tests.id('tenant_a') $$,
  $$ values (current_setting('tests.p1'), '{"accent": "#e11d48", "primary": "#1e3a8a"}'::jsonb, 1) $$,
  'the logo is active, the colour normalized and other colours kept');
select is((select count(*)::int from public.audit_events where tenant_id = tests.id('tenant_a') and action = 'branding_updated'), 1, 'the change is audited');
select throws_ok($$ select tests.brand('owner_a', 'tenant_a', 0, null, null) $$, 'PT409', null, 'the earlier version is now stale');

-- ===========================================================================
-- Reading
-- ===========================================================================
select tests.login_as(tests.id('staff_a'));
select set_eq($$ select storage_path from public.tenant_logos $$,
  $$ values (current_setting('tests.p1')), (current_setting('tests.p2')), (current_setting('tests.p3')) $$, 'staff can read their business''s logos');
select ok((select bool_and(tenant_id = tests.id('tenant_a')) from public.tenant_logos), 'and only theirs');
select tests.login_as(tests.id('owner_b'));
select is((select count(*)::int from public.tenant_logos where tenant_id = tests.id('tenant_a')), 0, 'other businesses see none of them');
select tests.login_as(tests.id('client_x'));
select is((select count(*)::int from public.tenant_logos), 0, 'clients read no logo rows');
select tests.login_as_service();
select results_eq(
  $$ select b ->> 'logo_storage_path', (b ->> 'logo_needs_dark_background')::boolean, b -> 'brand_colors' ->> 'primary' from (select public.public_tenant_brand('test-bouprod') b) x $$,
  $$ values (current_setting('tests.p1'), false, '#1e3a8a'::text) $$, 'client pages get the live logo and colour');
select is(public.public_tenant_brand('test-other-dj') ->> 'logo_storage_path', null, 'and never another business''s');
select is(public.tenant_logo_details(tests.id('tenant_b'), current_setting('tests.p1')), null, 'logo details only for the logo''s own business');
reset role;

-- ===========================================================================
-- Frozen branding: proposals keep what they were sent with
-- ===========================================================================
select tests.login_as(tests.id('owner_a'));
select set_config('tests.pid', public.open_proposal_draft(tests.id('event_a1'), tests.base_offer())::text, true);
select tests.send(current_setting('tests.pid')::uuid);
reset role;
select is((select offer_snapshot -> 'branding' ->> 'logo_storage_path' from public.proposals where id = current_setting('tests.pid')::uuid),
  current_setting('tests.p1'), 'a sent proposal freezes the logo it was sent with');
select is(tests.brand('owner_a', 'tenant_a', 1, current_setting('tests.l2')::uuid, '#ffff00'), 2, 'the owner replaces the logo and colour');
select results_eq(
  $$ select offer_snapshot -> 'branding' ->> 'logo_storage_path', offer_snapshot -> 'branding' -> 'brand_colors' ->> 'primary'
     from public.proposals where id = current_setting('tests.pid')::uuid $$,
  $$ values (current_setting('tests.p1'), '#1e3a8a'::text) $$, 'the sent proposal keeps its logo and colour');
select is(tests.brand('owner_a', 'tenant_a', 2, null, null), 3, 'the owner removes the logo and colour');
select results_eq(
  $$ select logo_storage_path, brand_colors from public.tenants where id = tests.id('tenant_a') $$,
  $$ values (null::text, '{"accent": "#e11d48"}'::jsonb) $$, 'the business shows its name and default colour again');
select tests.login_as_service();
select is(public.tenant_logo_details(tests.id('tenant_a'), current_setting('tests.p1')) ->> 'storage_path', current_setting('tests.p1'),
  'the frozen logo still resolves');
reset role;
select ok(exists (select 1 from storage.objects where bucket_id = 'tenant-logos' and name = current_setting('tests.p1')), 'and its file is kept');
select set_config('tests.orphan', tests.put_logo('tenant_a'), true);
select set_eq(
  $$ select storage_path, registered from private.unused_tenant_logos() where tenant_id = tests.id('tenant_a') $$,
  $$ values (current_setting('tests.p2'), true), (current_setting('tests.p3'), true), (current_setting('tests.orphan'), false) $$,
  'unused logos are listed for clean-up; the frozen one is not');

-- ===========================================================================
-- Suspended and archived businesses
-- ===========================================================================
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = now(), suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select set_config('flux.workspace_suspension', '', true);
select throws_ok($$ select tests.brand('owner_a', 'tenant_a', 3, current_setting('tests.l1')::uuid, null) $$, 'PT423', null,
  'a suspended business''s branding can''t change');
select throws_ok($$ select tests.register('tenant_a', 'owner_a', tests.put_logo('tenant_a')) $$, 'PT423', null, 'nor can logos be added');
select set_config('flux.workspace_suspension', tests.id('tenant_a')::text, true);
update public.tenants set suspended_at = null, suspension_version = suspension_version + 1 where id = tests.id('tenant_a');
select set_config('flux.workspace_suspension', '', true);
update public.tenants set archived_at = now() where id = tests.id('tenant_a');
select is(tests.brand('owner_a', 'tenant_a', 3, current_setting('tests.l1')::uuid, '#0f766e'), 4,
  'an archived business follows its existing rules (settings stay editable)');
select tests.login_as_service();
select is(public.public_tenant_brand('test-bouprod'), null, 'but client pages see no archived business');
reset role;

select * from finish();
rollback;
