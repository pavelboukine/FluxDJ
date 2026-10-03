# Flux DJ: V1 data model and implementation specification

Status: proposed implementation baseline, October 2, 2026.

This document is intended for an AI coding tool and a human reviewer. Product requirements supplied by Pavel are authoritative. Provider pricing, API restrictions, legal compliance and current library APIs have not been independently verified here. This is a product and architecture specification, not a legal assessment or a working migration.

## 1. Product scope and fixed decisions

Flux DJ is a branded proposal, contract and event planning portal for independent DJs. BOUPROD is the first tenant; other DJs have separate accounts and branding. Client-facing routes use `fluxdj.com/{tenantSlug}/...`. Branding belongs to the DJ, with optional small Flux attribution.

Build in this order:

1. Proposal builder, gear media, packages, logistics requirements and DJ approval.
2. Frozen contracts, e-signature, signed PDFs and first client login.
3. Planning sections, progress, locking and mobile run sheet.

Stack: Next.js App Router, TypeScript, Supabase Postgres/Auth/Storage, Tailwind, shadcn/ui, Resend, react-pdf, signature_pad and Vercel Pro. Use the requested Canadian database region. Region choice alone does not establish privacy compliance; email, hosting, logs, storage, backups and subprocessors require separate deployment review.

Do not add passwords, scheduling, invoicing, payment collection, native apps, music integrations, subdomains or custom domains. TidyCal and Wave remain external. Music entries are manual in V1. PWA installation is required.

## 2. Working assumptions and decisions still to confirm

- Currency defaults to CAD. Store money as integer cents, never floating point. Tax rates and labels are configured by each DJ; do not hardcode Quebec rates or registration status.
- A tenant represents a DJ business, not an individual login. One owner per tenant initially; the schema permits additional staff later.
- An event can have multiple client contacts. One primary contact receives proposal and signing emails in V1. One client signer is supported initially. Additional mandatory signers need a later workflow extension.
- Signing opens planning and shows the signed confirmation screen. A tenant setting `booking_confirmation_policy` is `on_signature` or `on_deposit`; default `on_signature` follows the supplied client flow. If the DJ chooses `on_deposit`, show “Contract signed, deposit required to confirm booking” until payment is recorded. Never silently equate signing with payment.
- A sent proposal has immutable offered terms, but the client can adjust the allowed choices until submission or expiry. Acceptance freezes a selection and sends it for DJ approval.
- Public proposal links allow viewing and selection submission without an account. Signing additionally verifies the intended email through a magic link. A forwarded proposal link must never grant planning access or signing authority by itself.
- Planning locks seven calendar days before the event by default. This is a proposed default, editable per tenant and event. The event timezone governs the cutoff.
- One page is the target for the run sheet, not a reason to omit content. On phones it is one clean scrolling view; print can overflow when necessary.

## 3. Database conventions

Use UUID primary keys, `created_at` and `updated_at` timestamps for mutable records. All tenant-owned records carry a non-null `tenant_id`. `tenants` is the root exception. Global Auth identities are not tenant records; membership and event access records are.

Each tenant-owned parent exposes `unique (tenant_id, id)`. Child references use composite foreign keys `(tenant_id, parent_id)` to prevent cross-tenant references even when application code is wrong. Add indexes for foreign keys and RLS predicates. Use check constraints for nonnegative amounts, bounded rates, quantities and statuses. Archive catalog records instead of deleting referenced history.

Internal IDs are not access secrets. Authorization never relies on a URL slug, hidden button or UUID. Store event dates as dates and timezone as an IANA identifier, initially `America/Toronto`. Store absolute deadlines as `timestamptz`. Timeline entries use local date plus local time so midnight crossings are explicit.

Use typed columns for identity, money, lifecycle and permissions. JSONB is appropriate for validated section answers, frozen snapshots and constrained rules. Do not put the entire application into generic JSON documents.

## 4. Tables and relationships

The following is the logical schema. Expand enumerations and constraints in migrations. Every row below except `tenants` includes `tenant_id`.

### Accounts, clients and events

| Table                | Essential columns and constraints                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`            | `id`, unique `slug`, `business_name`, `display_name`, `logo_storage_path`, validated `brand_colors`, `reply_to_email`, `timezone`, `currency`, `planning_lock_days`, `booking_confirmation_policy`, `tax_config`, `archived_at` |
| `tenant_memberships` | `id`, `user_id` referencing Auth, `role` owner/staff, unique `(tenant_id,user_id)`; only owners manage membership                                                                                                               |
| `clients`            | `id`, `name`, `email`, optional phone, `archived_at`; contacts belong to a business and are not globally shared between DJs                                                                                                     |
| `events`             | `id`, `title`, `event_type`, `event_date`, `timezone`, venue name/address, `lifecycle_status`, nullable `active_proposal_id`, `booking_confirmed_at`, `planning_lock_at`, `planning_override_until`, `internal_notes`           |
| `event_clients`      | `id`, `event_id`, `client_id`, `is_primary`, `can_sign`; unique event/client pair and at most one primary per event                                                                                                             |
| `event_access`       | `id`, `event_id`, `client_id`, `user_id`, `revoked_at`; grants an authenticated client access to a specific event, never to the entire tenant                                                                                   |

Create clients and events before sending a proposal. Create event access only after verifying the contact's email. Do not create a fake Auth password or treat a lead as an authenticated client. Never expose `internal_notes` in client queries.

### Catalog and reusable templates

| Table                         | Essential columns and constraints                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gear_items`                  | `id`, name, description, `unit_label`, `default_price_cents`, `tax_category`, `active`; represents a sellable item such as a ceremony speaker or four tube lights |
| `gear_media`                  | `id`, `gear_item_id`, private storage path, `kind` image/video, alt text, sort order                                                                              |
| `packages`                    | `id`, name, description, `base_price_cents`, sort order, `is_popular`, `active`                                                                                   |
| `package_items`               | `id`, `package_id`, `gear_item_id`, positive quantity; unique package/item pair; describes included gear, without adding its retail price again                   |
| `logistics_questions`         | `id`, stable key, prompt, answer type, validated options, sort order, required, active                                                                            |
| `logistics_rules`             | `id`, `question_id`, constrained condition JSON, `gear_item_id`, positive required quantity, client-facing reason, active                                         |
| `proposal_templates`          | `id`, name, intro, expiry duration, optional default package, active                                                                                              |
| `proposal_template_packages`  | `id`, `template_id`, `package_id`, sort order                                                                                                                     |
| `proposal_template_addons`    | `id`, `template_id`, `gear_item_id`, recommended quantity, max quantity, sort order                                                                               |
| `proposal_template_questions` | `id`, `template_id`, `question_id`, sort order                                                                                                                    |
| `contract_templates`          | `id`, name, active; points to a published template version                                                                                                        |
| `contract_template_versions`  | `id`, `template_id`, version number, structured content, allowed placeholders, `published_at`; published versions are immutable                                   |

V1 logistics rules support only explicit equality and membership checks against answers. No executable expressions, arbitrary SQL, JavaScript or complex branching engine. Missing required answers block submission rather than being interpreted as false.

### Proposals and selected pricing

| Table                      | Essential columns and constraints                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposals`                | `id`, `event_id`, `revision`, status, `expires_at`, `sent_at`, `first_viewed_at`, nullable `supersedes_id`, frozen `offer_snapshot`, `offer_sha256`, `current_selection_version`; unique event/revision |
| `proposal_selections`      | `id`, `proposal_id`, version, selected package key, addon quantities, logistics answers, calculated subtotal/tax/total cents, currency, `selection_snapshot`, `submitted_at`; unique proposal/version   |
| `proposal_selection_lines` | `id`, `selection_id`, stable gear key, name/description snapshot, quantity, unit price cents, line total cents, `source` package/optional/required, required reason, tax category                       |
| `proposal_approvals`       | `id`, `proposal_id`, `selection_id`, approved-by membership, `approved_at`, snapshot hash; unique approval for the selected submission                                                                  |
| `access_links`             | `id`, purpose proposal/signing, parent proposal or contract reference, `token_hash`, intended client, `expires_at`, `revoked_at`, `consumed_at`; never store raw bearer tokens                          |

The offer snapshot copies packages, included quantities, optional gear, prices, descriptions, media references, questions, rules, tax configuration, expiry and branding shown to the client. Media referenced by sent offers must remain available; do not overwrite the original storage objects.

Client selection is separate from the offer. Each submitted selection is immutable. During editing, an optimistic version guards against one browser tab overwriting another. The accepted selection includes a complete computed snapshot for approval and contract generation. Catalog edits do not affect it.

Do not permit multiple actionable proposals for the same event. A transactional replacement revokes the old link, marks the old proposal superseded and sets the new active proposal. Preserve history.

### Contracts, payment status and evidence

| Table                  | Essential columns and constraints                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts`            | `id`, `event_id`, `approval_id`, `template_version_id`, status, frozen rendered content and commercial snapshot, `content_sha256`, expected signer client/email, `sent_at`, `signed_at`, signed PDF path/hash, `pdf_generation_status` |
| `contract_signatures`  | `id`, `contract_id`, typed name, verified email, signature image path, signed timestamp, trusted-source IP when available, user agent, consent text/version, frozen content hash, `auth_user_id`; unique contract for one-signer V1    |
| `event_payment_status` | `id`, unique `event_id`, invoice URL, agreed total cents, deposit due cents/date, deposit received cents/date, balance due cents/date, balance received cents/date, updated-by membership; no banking/card information                 |
| `audit_events`         | `id`, entity type/id, action, actor identity/type, minimal metadata, occurred-at; append-only and staff-readable only                                                                                                                  |
| `email_outbox`         | `id`, event type, recipient, entity reference, unique deduplication key, status, attempts, next attempt time, provider message ID, sent-at                                                                                             |

Deposit defaults to 50% of the final agreed total including taxes, rounded to integer cents. The remaining amount is total minus deposit. Partial payments are supported through amounts; display status is derived. Only staff edits payment status. Validate invoice URLs as HTTPS and restrict to configured Wave hosts before showing them as trusted invoice links.

Contracts cannot be edited after sending. To correct an unsigned contract, void it, revoke its links and create a replacement. Signed contracts remain immutable; later commercial changes require a separate reviewed amendment process, outside V1.

### Planning

| Table               | Essential columns and constraints                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planning_sections` | `id`, `event_id`, section key, schema version, validated answers JSON, `revision`, `completed_at`; unique event/section                                                       |
| `timeline_items`    | `id`, `event_id`, local date/time, optional end date/time, title, location, notes, sort order, optional `key_moment_key`                                                      |
| `songs`             | `id`, `event_id`, title, artist, optional HTTPS reference URL, version/edit notes, `usage` key_moment/must_play/do_not_play, optional timeline item, `moment_key`, sort order |
| `announcements`     | `id`, `event_id`, name, phonetic pronunciation, role, announcement text, sort order                                                                                           |
| `vendors`           | `id`, `event_id`, role, business/contact name, email, phone, notes                                                                                                            |

Section keys: basics, timeline, key_moments, music, announcements, vendors. Typed timeline/song/vendor records are the authoritative source for their sections. Do not maintain a duplicate timeline in section JSON. JSON contains only section-specific answers that lack a dedicated table.

Seed planning from approved proposal answers once, after signing. Persist stable mappings, for example ceremony location to basics.ceremony_location. Do not overwrite later client edits when a job retries. Planning progress is derived from section validation requirements, not just whether a section has been opened. Allow explicit “not applicable” for optional moments.

## 5. Pricing algorithm

All pricing runs on the server against the frozen offer. The browser may display a preview, but submitted monetary values are ignored.

1. Validate the selected package is one of the offered packages.
2. Validate addon IDs and quantity bounds against the offer.
3. Validate answers and evaluate frozen logistics rules.
4. Aggregate required quantities by gear item. Separate-space requirements add quantities when their rules demand independent setups.
5. Account for included package quantities: `requiredExtra = max(0, requiredQuantity - includedQuantity)`.
6. For gear also selected as an optional addon, `chargeableQuantity = max(optionalQuantity, requiredExtra)`. Optional quantity means total extra quantity beyond package inclusion. Show an unremovable required minimum and allow more above it.
7. Add the selected package base price and chargeable addon line totals. Included package gear is displayed as included and is not charged twice.
8. Compute taxes using frozen configured rates and a single documented line-rounding policy. Sum rounded tax amounts. Store the breakdown, subtotal and total.

Example: separate ceremony and cocktail locations each need one speaker. Package includes one eligible additional speaker. Rules require two additional-location speakers; charge one extra. If the client already selected one extra of that same gear item, charge it once. The main reception speaker must be a separate catalog key or excluded from additional-location eligibility so it is not incorrectly counted.

Rules represent quantities of sellable catalog units. A four-uplight pack is one unit with clear naming. Any physical gear availability, venue restrictions and simultaneous-use conflicts remain subject to manual DJ review in V1.

## 6. Lifecycle and transactions

Proposal: `draft -> sent -> submitted -> approved`; alternate terminal states `expired`, `superseded`, `declined`. Store view events separately, since opening is not a commercial state transition.

Contract: `draft -> sent -> signed`; alternate `void`. PDF generation and email delivery are independent states, never reasons to lose a completed signature.

Event: `lead -> pending_approval -> awaiting_signature -> booked -> completed`, plus `cancelled`. With deposit-required policy, use `awaiting_deposit` between signing and booked. Planning access depends on a signed contract, not merely the event enum. Planning locked/unlocked is calculated separately.

Required transactional operations:

- Sending: validate complete offer, freeze it, activate proposal, issue link, enqueue email.
- Submitting: lock proposal row, check active/sent/unexpired, compute selection, freeze submission, update event and enqueue notification. Duplicate submissions return the existing result for the same idempotency key.
- Approving: approve the exact immutable submitted selection and transition event. If adjustments change client terms, issue a new proposal revision for client acceptance. Do not silently approve different gear/prices.
- Signing: verify session and signer, lock contract, check sent/not void, verify displayed hash, capture evidence, mark signed, seed planning/event access and enqueue PDF work atomically. Enforce one signature row and idempotency.
- PDF job: render solely from frozen contract and signature, calculate SHA-256 over final PDF bytes, save private object, record path/hash, enqueue emails to client and DJ. Retries reuse the completed artifact.
- Payment update: update amounts and booking policy effects atomically; record staff audit event.

Row locks or equivalent database concurrency controls are required for acceptance/signing. UI button disabling is insufficient. Recheck expiry at server time, including submissions from an already-open page.

The “held until” date is a proposal deadline, not an availability scheduler. Do not imply automatic exclusivity unless the DJ has actually placed that hold. The dashboard should warn staff about other active leads for the same date without preventing legitimate multi-event work.

## 7. Authorization and link handling

Staff access requires active membership in the row's tenant. Client access requires active event access for the exact event and verified Auth user. An email match alone does not authorize an event.

Anonymous users receive no direct database table access. A server route exchanges a high-entropy proposal token for a narrowly scoped, expiring proposal session in a secure HttpOnly cookie and redirects to a clean URL. Tokens are hashed at rest, rate limited and revocable; exclude token URLs from analytics/logs and use a restrictive referrer policy. Link GET requests do not accept, sign or consume one-time signing authorization.

The public server route returns an explicit safe DTO: offered content and permitted event basics only. It cannot expose other contacts, internal notes, audit data or planning. Server-side privileged credentials remain outside browser bundles. Every privileged handler checks tenant, token scope, event, state and input; service-role credentials do not make these checks optional.

Signing links initiate magic-link verification for the intended contact and return to the same frozen contract. Scope redirects to approved origins/routes. After verified callback, attach the exact event access record and establish the client's first login. Repeated login remains magic-link only. Email scanners must not cause acceptance/signature or consume the signing capability.

RLS limits rows, not columns. Clients must not receive broad SELECT/UPDATE access to `events` or `contracts` containing staff fields. Use separate safe projections or carefully configured read functions, and narrow mutation functions/handlers for client actions. Revoke unintended direct table writes, enforce planning locks server-side and in the database mutation path, and avoid RLS-bypassing views. Harden privileged functions with a fixed search path and restricted execution grants.

Private Storage buckets: tenant gear media, signatures and contracts. Object paths include tenant and entity IDs; path naming alone grants no access. Apply storage policies and issue short-lived signed read URLs only after authorization. Public proposal media URLs are generated from authorized frozen references. Keep signature/PDF downloads private. Validate upload type/size and do not trust filename extensions.

## 8. Pages and interface behavior

Staff pages: dashboard; clients/events; gear/media; packages; templates/questions/rules; proposal editor; submitted proposal review; event contract/payment/planning view; run sheet.

Client pages: proposal; submitted/pending review; frozen contract/signing; confirmation with deposit status and Wave link; planning home and sections.

Proposal editor must support choosing a template, event/contact basics, three packages, recommended middle package, preselected addons, requirements questions, expiry, preview and send in roughly two minutes after setup. Keep catalog management outside the send flow. Exactly one offered package is marked most popular. Do not force clients to buy the recommended package.

Client proposal shows DJ branding, media, concise package comparison, required gear with explanatory text, editable optional addons, live total/tax breakdown, deadline and clear “Submit for DJ review” action. Required logistics gear is not presented as a persuasive upsell. Keep accessible mobile controls and visible save/error states.

Signing shows full frozen terms, typed name, drawn signature, explicit consent and a final signing action. Blank drawings are rejected. Accessible signing alternative needs agreement with the reviewed template; do not invent legal equivalence. No PDF-only reading requirement on mobile.

Planning autosaves with visible status and optimistic revision checks. Expired sessions and network failures retain unsaved input and clearly offer retry/login. Staff can edit after cutoff or explicitly reopen client editing until a specified deadline, with audit records.

Run sheet: event/date/venue; chronological timeline; song title/artist/version; pronunciations; vendor names/phones; key logistics. Omit unnecessary client personal details, signatures and financial data. Provide tap-to-call and print layout. Use the existing records, not a separately editable duplicate.

PWA V1 supports installation and responsive authenticated screens. Cache static application assets only. Do not cache private contracts or tokens in a service worker. Offline run-sheet support is a separate explicit enhancement, not an implicit promise of PWA installation.

## 9. Notifications and reliability

Send proposal email, first-open notice, submitted-for-review notice, contract email, signed-contract email to both parties and booking confirmation. Treat first-open detection as best effort: email scanners can open links, and it does not prove the client read the offer. Label the notification accordingly.

Use a durable outbox, stable deduplication keys and bounded retries. Show failed email/PDF jobs to staff with retry controls. Persist business state before delivery. Never regenerate a contract from live client/catalog records when retrying an email.

Each DJ receives their branding and reply-to address. V1 may use one verified Flux sender domain; arbitrary tenant From domains require separate verification. Keep credentials out of tenant settings. Payment reminders and planning reminder schedules are outside the initial scope.

## 10. Implementation sequence for the coding tool

### Phase 1: proposals

1. Initialize the chosen stack, typed validation, lint/typecheck, migrations and local test setup. Pin actual package versions during implementation.
2. Implement tenants, memberships, clients/events, RLS and cross-tenant constraints before building screens.
3. Add catalog/media, package composition, templates and constrained logistics rules.
4. Implement a pure server-shared pricing module, offer snapshots and selection validation.
5. Build staff proposal creation and mobile public proposal pages.
6. Add token/session exchange, transactional send/submit/approval, outbox and first-view notices.

Phase 1 is complete when BOUPROD can send a proposal, a lead can adjust and submit it, and Pavel can review the exact submitted terms. Do not pretend contracts/planning work before later phases are implemented.

### Phase 2: contracts

1. Publish immutable contract template versions and render placeholders from approved terms.
2. Implement verified magic-link onboarding and event-scoped access.
3. Implement send/void/sign transitions and captured evidence.
4. Implement PDF job, final-byte hash, private downloads and emails.
5. Add manual Wave status and explicit booking-policy behavior.

### Phase 3: planning

1. Seed proposal answers without duplicate client entry.
2. Implement sections, timeline, moments/songs, announcements and vendors.
3. Implement validated progress, revisions, cutoff and staff reopening.
4. Build mobile/print run sheet and installable PWA shell.

Deliver migrations, relevant security/pricing/concurrency tests, environment-variable example without secrets, minimal seed data for two isolated tenants, and setup instructions. Do not introduce a billing platform, complex inventory system, generic automation engine or additional backend framework.

## 11. Required acceptance tests

Use real database RLS integration tests, not mocked authorization alone.

- Tenant A staff cannot read, modify or reference Tenant B clients, events, proposals, media, contracts, payment status or planning records.
- Test SELECT, INSERT, UPDATE and DELETE; membership escalation; changing `tenant_id`; cross-tenant composite foreign keys; and Storage reads/writes.
- A verified client can access only their linked events, including when participating in events with multiple DJs. They cannot alter price, status, tenant membership, payment state, contracts or internal fields.
- Anonymous access has no direct table permissions; forwarded proposal links cannot read planning or sign as the client.
- Required gear cannot be removed, included gear is accounted for, optional and required gear is not double charged, tax rounding is consistent, and catalog changes cannot affect sent terms.
- Tampered prices, unsupported addons, invalid quantities and missing answers are rejected server-side.
- Expired, revoked and superseded links fail; concurrent submissions/replacements and repeated clicks cannot approve stale selections or create multiple signatures.
- Wrong-email magic-link sessions cannot sign. GET requests and email scanning cannot sign or submit.
- A frozen contract remains unchanged when its template, client, event or catalog changes. Signing records the displayed content hash; the stored PDF hash matches downloaded bytes.
- PDF/email failure can retry without losing a signature or duplicating planning records. Delivery retries respect idempotency keys.
- Planning locks reject direct mutation attempts after cutoff, timezone handling covers daylight-saving transitions and midnight events, and staff reopening is scoped/audited.
- Mobile proposal/signing/planning and run sheet remain readable. Long run sheets print all content rather than clipping it to one page.

## 12. Review gates before real clients

Pavel reviews the proposal pricing examples and booking/deposit wording. The lawyer reviews contract language, signing consent/evidence and amendment approach. Deployment review covers actual provider locations and privacy handling, retention/deletion, backup/recovery and production email setup. Retention periods are intentionally unspecified until decided; do not hardcode permanent storage of IP addresses or client data.

The application must not claim legal compliance solely because it stores a signature, hash or Canadian database. Hashes detect changed bytes; authorization, frozen source content, evidence capture and reliable delivery are separate requirements.
