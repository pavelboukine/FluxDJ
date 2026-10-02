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

-- =============================================================================
-- DEMO DATA: BOUPROD catalog and wedding template (Phase 1, step 3)
-- =============================================================================
-- Illustrative only. Prices, gear, questions and wording are placeholders for
-- local development and have NOT been reviewed by Pavel (spec section 12).
-- Every record is tagged "DEMO" in its name or description. Do not copy into
-- production.
--
-- Mirrors the spec's pricing example: separate ceremony and cocktail spaces
-- each require an additional-location speaker; the Signature package already
-- includes one. The main reception system is a separate catalog key so it is
-- never counted as an additional-location speaker.
-- No media rows are seeded because no image files exist locally.

insert into public.gear_items (id, tenant_id, key, name, description, unit_label, default_price_cents, tax_category) values
  ('44444444-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'main_sound_system',
   'Main reception sound system', 'DEMO: two tops and a sub for the main room.', 'system', 0, 'standard'),
  ('44444444-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', 'additional_location_speaker',
   'Additional-location speaker', 'DEMO: powered speaker on a stand for a separate ceremony or cocktail space.', 'speaker', 15000, 'standard'),
  ('44444444-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001', 'wireless_mic',
   'Wireless microphone', 'DEMO: handheld wireless mic for speeches.', 'mic', 5000, 'standard'),
  ('44444444-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', 'uplights_4',
   'Uplights (pack of 4)', 'DEMO: one unit is four colour-matched uplights.', 'pack', 12000, 'standard'),
  ('44444444-0000-4000-8000-000000000005', '11111111-0000-4000-8000-000000000001', 'dance_floor_lighting',
   'Dance floor lighting', 'DEMO: moving heads and wash lights over the dance floor.', 'set', 20000, 'standard');

insert into public.packages (id, tenant_id, key, name, description, base_price_cents, sort_order, is_popular) values
  ('55555555-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'essential',
   'Essential', 'DEMO: reception DJ with main sound and one mic.', 150000, 1, false),
  ('55555555-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', 'signature',
   'Signature', 'DEMO: adds dance floor lighting and one additional-location speaker.', 220000, 2, true),
  ('55555555-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001', 'premium',
   'Premium', 'DEMO: adds uplighting and a second additional-location speaker.', 300000, 3, false);

insert into public.package_items (tenant_id, package_id, gear_item_id, quantity) values
  -- Essential
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000001', 1),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000003', 1),
  -- Signature
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000001', 1),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000003', 2),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000002', 1),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000002', '44444444-0000-4000-8000-000000000005', 1),
  -- Premium
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000001', 1),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000003', 2),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000002', 2),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000005', 1),
  ('11111111-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000004', 2);

insert into public.logistics_questions (id, tenant_id, key, prompt, answer_type, options, sort_order, required) values
  ('66666666-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'ceremony_location',
   'DEMO: Where will the ceremony take place?', 'single_choice',
   '[{"value":"no_ceremony","label":"No ceremony"},{"value":"same_room","label":"Same room as the reception"},{"value":"separate_space","label":"A separate space"}]', 1, true),
  ('66666666-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', 'cocktail_location',
   'DEMO: Where will cocktail hour take place?', 'single_choice',
   '[{"value":"same_room","label":"Same room as the reception"},{"value":"separate_space","label":"A separate space"}]', 2, true),
  ('66666666-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001', 'speeches_wireless_mic',
   'DEMO: Will there be speeches that need a wireless microphone?', 'boolean', '[]', 3, true),
  ('66666666-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000001', 'venue_notes',
   'DEMO: Anything we should know about the venue (load-in, stairs, curfew)?', 'short_text', '[]', 4, false);

insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason) values
  ('11111111-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000001',
   '{"op":"equals","value":"separate_space"}', '44444444-0000-4000-8000-000000000002', 1,
   'DEMO: Your ceremony is in a separate space, so it needs its own speaker.'),
  ('11111111-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000002',
   '{"op":"equals","value":"separate_space"}', '44444444-0000-4000-8000-000000000002', 1,
   'DEMO: Cocktail hour is in a separate space, so it needs its own speaker.'),
  ('11111111-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000003',
   '{"op":"equals","value":true}', '44444444-0000-4000-8000-000000000003', 1,
   'DEMO: Speeches need a wireless microphone.');

insert into public.proposal_templates (id, tenant_id, name, intro, expiry_days) values
  ('88888888-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001',
   'Wedding (DEMO)', 'DEMO: Thank you for considering BOUPROD for your wedding. Choose a package, adjust the extras and submit it for review.', 14);

insert into public.proposal_template_packages (tenant_id, template_id, package_id, sort_order) values
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000001', 1),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000002', 2),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000003', 3);

-- Recommended (middle) package.
update public.proposal_templates
  set default_package_id = '55555555-0000-4000-8000-000000000002'
  where id = '88888888-0000-4000-8000-000000000001';

insert into public.proposal_template_addons (tenant_id, template_id, gear_item_id, recommended_quantity, max_quantity, sort_order) values
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000004', 1, 4, 1),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000002', 0, 3, 2),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000003', 0, 3, 3),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000005', 0, 1, 4);

insert into public.proposal_template_questions (tenant_id, template_id, question_id, sort_order) values
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000001', 1),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000002', 2),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000003', 3),
  ('11111111-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '66666666-0000-4000-8000-000000000004', 4);
