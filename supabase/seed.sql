-- Local development seed: two isolated tenants. LOCAL ONLY.
-- `supabase db reset` applies this to the local Docker database. It is never
-- run against a hosted project unless someone explicitly passes it, so do not.
--
-- Users have no passwords (spec: magic link only). Sign in locally with a
-- magic link; emails are captured by the local mail viewer (Mailpit) at
-- http://127.0.0.1:54324 when the full stack is running.

-- Auth users -------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('a1111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@bouprod.example', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('b2222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@otherdj.example', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('c3333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'client@couple.example', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email',
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now(), now()
from auth.users u
where u.id in ('a1111111-1111-4111-8111-111111111111',
               'b2222222-2222-4222-8222-222222222222',
               'c3333333-3333-4333-8333-333333333333');

-- Tenants ------------------------------------------------------------------------
-- Tax rates below are illustrative local values only. Each DJ configures
-- their own; nothing in the schema hardcodes them.
insert into public.tenants (id, slug, business_name, display_name, brand_colors, reply_to_email, tax_config) values
  ('11111111-0000-4000-8000-000000000001', 'bouprod', 'BOUPROD', 'BOUPROD',
   '{"primary":"#111827","accent":"#E11D48"}', 'owner@bouprod.example',
   '[{"code":"GST","label":"GST","rate_ppm":50000},{"code":"QST","label":"QST","rate_ppm":99750}]'),
  ('11111111-0000-4000-8000-000000000002', 'other-dj', 'Other DJ Co.', 'Other DJ',
   '{"primary":"#0F172A","accent":"#0EA5E9"}', 'owner@otherdj.example',
   '[{"code":"HST","label":"HST","rate_ppm":130000}]');

insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('11111111-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111', 'owner'),
  ('11111111-0000-4000-8000-000000000002', 'b2222222-2222-4222-8222-222222222222', 'owner');

-- Clients and events ---------------------------------------------------------------
-- The same couple books both DJs; each tenant has its own client record.
insert into public.clients (id, tenant_id, name, email, phone) values
  ('22222222-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'Alex & Sam', 'client@couple.example', '+1 514 555 0100'),
  ('22222222-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002', 'Alex & Sam', 'client@couple.example', null);

insert into public.events (id, tenant_id, title, event_type, event_date, venue_name, venue_address, internal_notes) values
  ('33333333-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001',
   'Alex & Sam Wedding', 'wedding', '2027-06-12', 'Château Example', '123 Rue Exemple, Montréal, QC',
   'Staff-only: confirm load-in time with venue.'),
  ('33333333-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002',
   'Alex & Sam Rehearsal Party', 'party', '2027-06-11', 'Example Hall', '456 Example St, Ottawa, ON',
   'Staff-only note for Other DJ.');

insert into public.event_clients (tenant_id, event_id, client_id, is_primary, can_sign) values
  ('11111111-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000001', true, true),
  ('11111111-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000002', true, true);

-- Verified client access to the BOUPROD event only. In the app this row is
-- created by the magic-link callback after email verification (Phase 2).
insert into public.event_access (tenant_id, event_id, client_id, user_id) values
  ('11111111-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000001',
   '22222222-0000-4000-8000-000000000001', 'c3333333-3333-4333-8333-333333333333');
