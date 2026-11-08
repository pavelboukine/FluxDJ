# Flux DJ: Current Product and Engineering Reference

**Last updated:** November 5, 2026  
**Product state:** Live, actively used, and under ongoing refinement  
**Repository:** `pavelboukine/FluxDJ`  
**Production:** https://fluxdj.com  
**First tenant:** BOUPROD

> **How to use this document**
>
> This replaces the October 2, 2026 proposed V1 implementation baseline. It describes the product as last reported in the development conversations, plus the constraints that must continue to hold. It is a living engineering reference, not an instruction to rebuild existing functionality.
>
> **Source-of-truth rule:** Current repository code, committed database migrations, deployed configuration, and passing tests take precedence over illustrative names or historical assumptions in this document. This update was prepared from the supplied earlier specification and reported development progress, **not from a fresh code or production audit**. Where verification is missing, the text says so.

## 1. Product and direction

Flux DJ is a multi-tenant DJ business platform for proposals, contracts, client planning, and event execution. Each DJ business has its own clients, events, packages, equipment, branding, staff, and settings. BOUPROD is the first production tenant, but the system must remain reusable across independent DJ businesses.

The working product flow is:

1. A DJ creates a client and event, then assembles a branded proposal from their catalog, packages, add-ons, and logistics questions.
2. A client opens a scoped proposal link, chooses a package and add-ons, answers applicable questions, and submits their selection for DJ review.
3. Staff approve the exact submitted terms or prepare a revised offer. Approved terms are used to generate a contract from a published, versioned template.
4. The intended client verifies their identity through passwordless email authentication, reviews the contract, and signs. A signed PDF is generated and delivered.
5. Booking and payment status follow the configured policy. **Signing a contract does not itself record a deposit or payment.** Wave or another outside payment workflow remains external.
6. The client completes planning in their authenticated portal. Staff review responses, coordinate the event, control client editing, and use the run sheet.

**Current emphasis:** Improve reliability, maintainability, mobile polish, delivery confidence, and testing around this already functioning workflow. Add music search and playlist-link support after the core workflows are stable.

### Product boundaries

- Support distinct business tenants and staff, rather than a single BOUPROD-specific code path.
- Keep client booking, planning, and signing flows easy to understand on mobile.
- Do not introduce payment processing, invoices, calendar scheduling, native mobile apps, equipment inventory allocation, or arbitrary workflow automation merely because the platform has grown.
- TidyCal and Wave can continue as external services. Payment tracking inside Flux DJ is not the same thing as collecting payment.
- Do not assume public self-service DJ signup exists. Invite-only onboarding is the last confirmed model.
- Custom domains/subdomains and multiple mandatory contract signers are not confirmed as delivered features.

## 2. Technical baseline

### Confirmed stack and operating environment

| Area            | Current baseline                                                             |
| --------------- | ---------------------------------------------------------------------------- |
| Application     | Next.js **16** App Router, TypeScript                                        |
| UI              | Tailwind CSS **4**, shadcn/ui, responsive React components                   |
| Data/auth/files | Supabase Postgres, Auth, Storage, RLS, SQL migrations and database functions |
| Email           | Resend with a durable outbox and webhook-based delivery tracking             |
| Hosting         | Vercel; `main` is used for production deployments                            |
| Authentication  | Passwordless email / magic-link flows; event-scoped client access            |
| Mobile          | Installable PWA, responsive web interfaces, mobile launch experience         |
| Document flow   | Versioned contract templates, electronic signatures, generated signed PDFs   |

Avoid declaring specific PDF, signature, testing, or observability library versions authoritative without checking `package.json` and the code. The earlier baseline listed `react-pdf`, `signature_pad`, and Vercel Pro as choices, but those precise runtime dependencies and plan details should be verified.

### Engineering conventions

- Preserve established project patterns and server actions instead of introducing a second framework or duplicate abstraction.
- Keep SQL migrations, access policies, and types aligned. Do not make schema claims from this document alone.
- Use strong typing, runtime validation at trust boundaries, and integer cents for monetary amounts.
- Prefer straightforward, incremental changes with targeted tests. Avoid large refactors when a localized change is sufficient.
- Do not request or generate screenshots as a routine part of coding tasks unless visual evidence is specifically needed.
- Production deploys, merges, migrations, and client-impacting changes are explicit actions, not automatic conclusions of a successful local test run.

## 3. What is already implemented

The features below reflect reported completed work. Individual edge cases still require verification in current code and production.

### 3.1 Tenants, onboarding, and business administration

- Businesses, owners, staff memberships, tenant-isolated clients and events.
- Invite-only DJ onboarding and branded staff shell/navigation.
- Owner-managed staff invitations and membership revocation, with active membership checks.
- Business Settings as a directory of six pages: **Business profile**, **Branding** and **Team & access** (General), and **Bookings**, **Taxes & payments** and **Client planning** (Operations), with a page navigation, forwarding of the old single-page links, and a prompt before leaving unsaved edits.
- Configurable reply-to email, branding (logo, colour and logo size), taxes, deposit percentage (saved on its own), and planning deadline controls.
- Guided setup/onboarding checklist.
- Archive-aware access behavior. Hiding an event from `/my` is only presentation: the client database functions and direct routes must reject access when the event or business is archived.

### 3.2 Clients, events, and staff event workspace

- Client and event records with event-specific proposal, contract, payment, and planning access.
- Redesigned DJ Event Workspace with lifecycle-aware ordering and clearer next steps.
- Compact Payments and Planning/Client Access areas, with contract/documents given appropriate prominence based on event state.
- Collapsible or secondary event details/contacts, plus a responsive desktop layout.
- Event details editing and existing server behavior are preserved through the UI redesign.

**Most recent known UI release state:** The event workspace redesign was reported deployed on `main` at `b2e179b`. A follow-up mobile fix, [PR #8](https://github.com/pavelboukine/FluxDJ/pull/8), was squash-merged into `main` as `a624623`. It fixes the mobile event-header badge/Edit Details arrangement and Event Details summary overflow. All three reported checks passed. **Production deployment and real-device behavior of PR #8 remain unverified**, so verify them before treating the fixes as live.

### 3.3 Catalog, packages, and proposals

- Gear catalog and media, packages and included gear, optional add-ons, logistics questions/rules, and reusable proposal templates.
- Staff proposal builder with client/event association, frozen offers, tax/price calculation, and delivery emails.
- Branded client proposal pages with package selection, add-ons, requirements questions, equipment descriptions/photos, and live totals.
- Public scoped proposal link/session exchange, expiration, first-open notification, selection submission, review, approval, and replacement/revised offer workflows.
- Immutable submitted selections and approved commercial terms. Catalog edits must not rewrite sent offers or approvals.
- Real-client workflows have been exercised, including expiring/resending proposal links, revised offers, and approval-to-contract handoff.

**Proposal principle:** A client's submitted configuration is a request for DJ review, not permission for the DJ to silently change the final price or equipment. Changed terms require a new client-visible offer or reviewed acceptance flow.

### 3.4 Contract generation, signing, and PDFs

- Reusable contract templates with published immutable versions.
- Contract editor redesign with section cards and Word `.docx` import.
- Contract generation from the exact approved selection with populated placeholders and frozen terms.
- Passwordless signer onboarding, signing flow, stored signature evidence, signed PDF generation, and email delivery to intended recipients.
- Signed-contract confirmation and event-page handoff to booking/planning.
- Contract version/immutability rules: a sent contract is not edited in place; a correction to an unsigned contract uses a void/replacement path. Signed contracts remain immutable.

Signed contract and PDF delivery have been used in hosted workflows. **Signing is not proof of payment**, and generating a PDF does not by itself establish legal compliance.

### 3.5 Payment and booking tracking

- Staff-visible payment/deposit status, associated agreement totals, and booking-state handoff.
- Configurable deposit percentage; the originally agreed default was **50% of the total including taxes**.
- Manual payment tracking remains distinct from external invoicing/payment collection.
- Client-facing confirmation and payment wording should accurately reflect actual booking policy and the recorded deposit state.

Verify the precise enum names and whether each booking policy is enabled from code and tenant settings before changing status logic. Do not conflate `signed`, `booked`, and `paid`.

### 3.6 Client planning, staff planning, and run sheets

- Reusable planning templates, including Wedding and Simple Party styles, and planning data initialized from booking/proposal context.
- Client planning redesign with a progress-oriented overview, deadline awareness, **Continue / Review / View** actions, **Still to sort out** and **Already provided** groupings, section navigation, and mobile layouts.
- Music/section entry, event moments, timeline, announcements, vendors, and related planning information as supported by existing templates and editors.
- DJ planning redesign, including **Needs attention**, client list, booking access, and review/edit workflows.
- Mobile and wide run-sheet presentations.
- Planning access, deadline enforcement, and an immediate staff-controlled open/close switch for client editing.
- Planning templates administration with list/search/archive/default, preview, and version checks.
- Client `/my` and event-hub handoff from contract/booking into planning.

Planning is no longer an unbuilt Phase 3. **Do not rebuild planning from the old six-table conceptual specification.** Check the present template, stages/moments, section data, server actions, and database functions before changing it.

### 3.7 Sign-in, PWA, and mobile performance

- Redesigned homepage and role-specific entry points: `/login?role=dj` and `/login?role=client`.
- Branded confirmation/sign-in pages, safer return-to handling, and cross-browser email confirmation fixes.
- Installable PWA. iPhone installation and persistent authenticated access were previously verified.
- Mobile startup/performance changes deployed in two batches. The user reported an iPhone cold launch below two seconds, a white Flux startup image, and working dark mode on November 2. This is an observed device result, not a universal performance guarantee.

Do not cache private contract data, bearer tokens, or sensitive authenticated documents in an offline service worker. Offline run-sheet availability is a separate feature, not automatically provided by PWA installation.

### 3.8 Email, notifications, and delivery visibility

- Branded email system with approximately **13 redesigned templates**, plain-text versions, business logo/header, and editable reply-to behavior.
- Durable outbox, retry/delivery history, and staff-facing email status visibility.
- Resend webhook handling for delivered, delayed, bounced, complained, failed, and suppressed states.
- Dashboard warnings summarizing recent delivery issues (30-day view).
- Email coverage across proposal, first view, review submission, contract, signing/PDF, booking confirmation, and staff invitation flows.

**Open operational concern:** Delivery and inbox placement must continue to be monitored. Prior real-world testing found sign-in emails in inboxes while other messages were often classified as spam. DMARC was reported as `p=none` with relaxed alignment. Never assume branded templating or a delivered webhook proves inbox placement. The older security/reliability audit also flagged a potential outbox claim-query error path that could skip some notification types; verify whether that issue remains before presenting it as an open defect.

## 4. Data and authorization invariants

These are ongoing design requirements. Exact table/column names must be checked against migrations.

### Tenant and identity model

- A tenant is a **business**, not a user account.
- Every tenant-owned record is scoped to its business; global Supabase Auth identities are separate from business membership.
- Staff authorization requires a currently active membership in the requested tenant. Owner-only actions include membership administration and contract template publication where that is the implemented rule.
- Client authorization is **event-specific** and tied to verified authentication, not merely a matching email address, visible UI, tenant slug, or UUID.
- Archived tenants/events must be blocked in both the UI and all direct database/client action paths. Staff-only internal event data must not appear in client projections.
- Cross-tenant foreign keys, RLS policies, carefully scoped privileged SQL functions, and tests are complementary defenses. Privileged server credentials do not replace authorization checks.

### Commercial snapshots

- Proposed pricing, package inclusions, catalog media, tax settings, and requirements are captured in a **frozen offered snapshot**.
- Submitted client selections are validated and frozen independently of the mutable offer/editor state.
- Approval references one exact submitted selection.
- Contracts derive from approved, frozen terms and a published contract-template version. Retries must never regenerate legal terms from mutable live catalog or client records.
- Signed PDF artifacts and audit/evidence records must remain associated with the signed content; status changes must not mutate a completed signature.
- Financial amounts use integer cents and frozen configured tax rules. Display and server totals must agree.

### Links, passwords, and downloads

- Public proposal tokens must be high entropy, expiring, scoped, revocable, and hashed at rest. Exchange bearer tokens for narrow authenticated or proposal sessions where the app's implemented pattern requires it.
- Email scanner GETs must never submit a proposal or execute a signature.
- A forwarded proposal link must not grant contract signing or authenticated planning access.
- The signer must be the verified intended person for that contract. Signed documents and signature files require authorized private downloads.
- Treat storage location, retention, subprocessors, logs, and deletion as privacy concerns independent of Canadian Supabase region selection.

### Planning and archiving

- Planning is seeded from approved proposal answers **once**; retries must not overwrite later user edits.
- Progress derives from actual valid/required information, not page visits.
- Deadline and reopening checks are enforced in server/database mutation paths, not simply by hiding controls.
- Staff reopening or closing client access should not inadvertently expose another event or tenant.
- A run sheet is a view of planning records, not a second copy of the timeline that can drift out of sync.

## 5. Pricing and proposal calculation rules

Preserve the existing server-authoritative calculation model when editing proposal/pricing code:

1. Validate package selection, optional add-on IDs/quantities, and logistics answers against the **frozen offer**.
2. Evaluate the frozen logistics requirements for independent audio/lighting locations or other needs.
3. Aggregate required quantities by sellable gear item and subtract eligible package inclusions.
4. For overlap between optional choices and required gear, charge only the greater necessary extra quantity, not both independently.
5. Add the frozen package price and chargeable optional/required add-ons.
6. Calculate tax using frozen tenant settings, a consistent rounding policy, and integer cents; save the breakdown.
7. Ignore or reject client-supplied monetary amounts. Server/database validation is authoritative.

Conceptually:

```text
requiredExtra = max(0, requiredQuantity - includedEligibleQuantity)
chargeableExtra = max(optionalExtraQuantity, requiredExtra)
total = packageBase + sum(chargeableAddons) + configuredTaxes
```

Example: Two separate ceremony/cocktail areas require two eligible extra speakers. If the package already includes one eligible speaker, only one additional speaker is chargeable. If the client already selected that additional speaker, charge it **once**.

Catalog units must be clear. Four uplights sold as a bundle are not interchangeable with four individually priced units unless the actual catalog/rules model explicitly supports that conversion. Simultaneous-location and inventory feasibility still require DJ review.

## 6. UX requirements worth preserving

### Staff

- Keep dashboard/event-workspace ordering aligned to the event lifecycle; make the recommended next action obvious.
- Preserve the familiar catalog, proposal creation, template administration, client management, and business settings areas.
- Payment status is operationally important but should not overwhelm the workspace.
- Maintain a responsive layout without cramped status badges, inaccessible controls, overflowing event details, or giant cards on phones.
- Avoid reintroducing redundant summary/detail data and avoid unexpectedly changing existing deep links or section anchors.

### Client proposal and signature

- Show packages, included gear, add-ons, requirements, understandable prices, and large useful equipment photos.
- A photo of moving heads, uplights, or tubes can explain the offering better than technical names alone. Media should be tied to the frozen offer and accessible on mobile.
- Required logistics equipment must be explained, not disguised as an optional upsell.
- Expose submission, signing, completion, expiry, retry, and pending-review states clearly.
- Show the frozen contract terms in readable HTML/mobile UI, not solely inside a PDF.

### Client planning and DJ run sheet

- Let clients quickly see what is missing, what is already provided, and what they should work on next.
- Keep input on the page during transient save/network issues and communicate save/retry state.
- Respect closed planning and archived-event access, including direct URL and database access.
- Keep run sheets readable on phones and printable without silently clipping long timelines.
- Show operational information such as timings, key songs/versions, pronunciations, vendor contacts, and notes, without unnecessary financial/signature information.

## 7. Quality, security, and release checks

The project has meaningful automated coverage, including database authorization tests and browser workflows. A recent event-workspace report cited **886 unit, 189 integration, and 324 browser tests passing**, but those are a _historical reported run_, not proof about the current checkout. The exact current test inventory and CI requirements are determined from the repository.

Keep these regression areas covered:

- Tenant A cannot read, create, update, delete, or cross-reference Tenant B records; inactive/revoked staff lose access.
- Client identity and event access remain separate from email equality and public link possession.
- Direct access to archived event/business data is rejected, not merely hidden from `/my`.
- Expired, revoked, and superseded proposals cannot be used to mutate active events.
- Server-side pricing rejects tampered totals, invalid add-ons, missing logistics answers, and duplicate required gear charges.
- Concurrent accept/approval/signature attempts cannot create inconsistent records or duplicate completed signatures.
- Contract template/catalog edits cannot alter sent or signed contract terms.
- Signed PDF and email retries do not roll back completed business transactions or duplicate planning records.
- Deposits, signatures, confirmation, and booking-state policy remain correctly distinguished.
- Planning deadlines and staff reopen controls are enforced through server/database paths, including timezone and archived-event cases.
- Resend webhooks, durable outbox retries, failure notifications, and bounced/suppressed email visibility behave correctly.
- Mobile proposal, signing, planning, and event-workspace journeys continue to work in authenticated browser and PWA sessions.

**Release practice:** Prefer focused checks for normal changes; run the relevant wider browser/database suite before shipping high-risk auth, financial, signing, or shared navigation changes. Treat failing or skipped tests as actionable information, not something to hide by updating snapshots blindly.

## 8. Immediate priorities and roadmap

### Priority 0: Finish and verify the current mobile event-workspace patch

- PR #8 is merged into `main` as `a624623`; do not reimplement the fix. Confirm that this commit is deployed to production, then record that here.
- Verify the mobile header and Event Details overflow on a real phone, without unrelated redesign scope.

### Priority 1: Reliability and technical hardening

- Perform a **read-only current-state audit** before deciding which older audit findings still apply.
- Check booking-state consistency and client access guards across direct routes, RLS, database functions, and server actions.
- Check outbox claim/retry failure handling, delivery-status observability, and real inbox placement. Improve sender authentication/DMARC only with proper DNS and provider verification.
- Verify CI requirements, test determinism/isolation, production error reporting, performance regressions, and critical proposal-to-planning smoke coverage.
- Keep data-retention, cleanup, backup/recovery, and privacy/legal reviews visible as release obligations. Do not claim these are solved merely because the app is live.

### Priority 2: Maintainability and UX cleanup

- Remove proven duplicate components/queries and outdated code paths without broad architecture rewrites.
- Keep the newly redesigned staff and client workspaces stable. Make small changes driven by actual bugs, accessibility, and user testing.
- Retain one clear flow for contract, payment, booking, planning, and run-sheet navigation.

### Priority 3: Music entry and playlist support

**Status: researched, not implemented.** No music API integration was confirmed built or deployed.

The desired client experience is to paste a Spotify, Apple Music, or other playlist link for dancing/cocktail/dinner rather than entering every track manually, while allowing convenient lookup of individual songs for key moments such as ceremony or grand entrance.

Recommended incremental approach:

1. Add provider-neutral song/playlist references while preserving existing manual song entry and planning data.
2. Recognize and validate user-pasted Spotify, Apple Music, YouTube, and similar URLs; display them as links without assuming API authorization.
3. Store playlist links by planning section. For imported track lists, initially support user-provided exported files or pasted lists rather than scraping private playlists.
4. Investigate a recording lookup backed by MusicBrainz for title/artist, with the caveat that its free-text ranking is not equivalent to consumer music-app autocomplete.
5. Consider richer provider search/import only after confirming terms, licensing, quotas, privacy, and a viable UX.

**Research caveats:** Earlier analysis considered Spotify's API restrictions unsuitable for the intended commercial integration, and Apple Music's exact use case subject to licensing clarification. Treat those as research conclusions to revalidate before implementation, not as permanent statements about providers. No Spotify/Apple account connection should be assumed to exist.

### Explicitly later or unconfirmed

- Automated planning/payment reminder schedules.
- Offline private run-sheet storage/sync.
- Integrated invoice/payment collection or credit-card processing.
- Multiple required client signers and post-signature contract amendments.
- Self-service public DJ signup, custom tenant domains, native mobile apps.
- Broad equipment inventory allocation, staff scheduling, or generalized automation engines.

Do not begin these simply because they appeared in the original V1 wish list.

## 9. Architectural map for a developer or coding assistant

The old October 2 file contained a **proposed** database table inventory. It should not be copied into migrations as though the current application were empty.

For implementation work, inspect the existing modules/migrations corresponding to these domain groups:

| Domain             | What must remain authoritative                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Tenancy and roles  | Businesses, active owner/staff membership, tenant RLS, archived state                           |
| Clients and events | Business-owned contacts, event lifecycle, client-to-event access                                |
| Catalog            | Gear/media, packages, inclusions, optional add-ons, logistics questions/rules                   |
| Proposals          | Versions, frozen offers, token/session access, submitted selections, approvals, revisions       |
| Contracts          | Published templates, immutable versions, generation, signer evidence, PDF artifacts             |
| Payments           | External invoice references, deposit/balance records, booking policy and status                 |
| Planning           | Reusable templates, answers/moments/timeline/music, progress, deadlines, staff editing controls |
| Notifications      | Outbox, message deduplication, provider IDs, webhook delivery/failure history                   |
| Auditing           | Security-relevant state changes, actor and scope, immutable evidence as appropriate             |

Use actual schema/table/function names from committed migrations. Avoid parallel tables or shadow copies of existing planning and payment data.

### State transitions to keep separate

```text
Proposal: draft -> sent -> submitted -> approved
                     |           |
                     |           +-> revise/re-offer where required
                     +-> expired / superseded / revoked

Contract: generated/draft -> sent -> signed
                              +-> void/replacement if unsigned

Payment: deposit due -> recorded deposit -> balance due/paid
         (tracked separately; no payment is collected by signing)

Planning: available after the authorized booking/signing handoff
          -> client edits until closed/deadline
          -> staff can manage/reopen according to current policy
```

These are **conceptual flows**, not a claim that these are the exact database enum values. Check the existing implementation before altering lifecycle logic.

## 10. Outstanding verification and legal/privacy gates

Before expanding usage or making compliance statements, explicitly verify:

- The actual hosting, Supabase, Resend, logs, backups, storage, subprocessors, and retention/deletion arrangements.
- Published contract text, signer consent language, legal enforceability, and any amendment workflow with qualified counsel.
- Financial/tax configuration for each tenant; never hardcode BOUPROD's registration or provincial rates for all DJs.
- Email sender alignment and inbox placement, not only API delivery success.
- Secure download authorization and evidence retention for signatures and signed PDFs.
- Production parity with the latest tested commit, migrations, and environment configuration.

**Do not infer legal compliance** from storing an electronic signature, PDF hash, or data in a Canadian region. Preserve the relevant evidence and access-control controls, and obtain the necessary legal and privacy review.

---

## Change log

### November 8, 2026

- Setup guide and dashboard setup card follow the business's setup guidance (Proposals and contracts, Contracts only or Planning only; owner-only, audited, guidance only): steps grouped as Business, Proposals, Contracts, Planning and Getting started; unfinished steps of a skipped workflow read "Skipped" and drop out of dashboard reminders, while readiness and sending checks are unchanged. Status glyphs no longer look like checkboxes, the overall "x of 4" counter is gone, and the booking-confirmation step no longer depends on the legal details. Migration `20261130000100`.
- Business Settings reorganized from one page into six focused pages; the deposit moved to Taxes & payments with its own save (`update_deposit_percent`), legal details save separately (`update_business_identity`), and owners can set a logo size (100-130%) for the staff header and client pages. Migrations `20261128000100` and `20261129000100`.

### November 5, 2026

- Reclassified the document from _proposed V1 baseline_ to _current live-product reference_.
- Marked proposal, contract, signed-PDF, planning, run-sheet, staff management, onboarding, settings, branded email, and PWA work as implemented based on development history.
- Recorded the event workspace/mobile PR #8 merge as `a624623` and added production deployment and real-device verification items.
- Preserved security, pricing, tenant isolation, contract immutability, and archive access requirements.
- Distinguished manual payment status from payment collection and contract signing.
- Added reliability, CI, email deliverability, and maintainability as near-term priorities.
- Added the music search/playlist-link research roadmap without pretending integrations are already built.
- Replaced the unverified proposed table-by-table migration plan with a current-domain architecture map and an instruction to inspect migrations first.

### October 2, 2026 (historical)

- Initial proposed V1 data model and three-phase delivery plan for proposals, contracts, and planning. The original document is superseded by this reference.
