# Flux DJ

Branded proposal, contract and event planning portal for independent DJs.
The source of truth for scope and behavior is [docs/Flux-DJ-V1-Spec.md](docs/Flux-DJ-V1-Spec.md).

**Current status: Phase 1 complete (steps 1 to 6) and Phase 2 step 1 (contract
templates and contract drafts).** The stack is scaffolded and the data
foundation is in place:

- Tenancy: tenants, memberships, clients, events, event contacts and event access.
- Catalog: gear items with private image/video media, packages with included
  gear, logistics questions with constrained rules, and reusable proposal
  templates.
- Offers and pricing: a shared deterministic pricing module, one editable
  proposal draft per event, previews, and offer snapshots that freeze once.
- Staff interface: magic-link login, and screens for gear (with photos and
  videos), packages, questions and rules, templates, clients and events. It
  also has a proposal builder with a responsive live preview.
- Proposals end to end: staff send an offer, the client opens a private link
  with no account, edits with autosave, and submits for review. Staff then
  approve the exact submission or send a revised offer. A durable email
  outbox delivers locally through Mailpit.

- Contracts, step 1: versioned contract templates with immutable published
  versions, and contract drafts generated from an approved selection and
  previewed by staff. Drafts are frozen when generated. They are never sent.

- Contracts, later steps: sending with verified client access, resend and
  void, signing by the frozen signer with immutable evidence, and signed
  PDFs emailed to both parties. Each template version is published either as
  DEMO (test wording, labelled everywhere) or for client use (the business's
  own agreement, approved by the owner).

Everything has row-level security and tests. Not built yet: booking
confirmation, payments, planning and amendments. Approval, contract
drafts and signing are not bookings.

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS · shadcn/ui · Supabase
(Postgres, Auth) · Zod. Package versions are pinned in `package.json` and
`pnpm-lock.yaml`.

## Prerequisites

- Node.js 20.9 or newer
- pnpm (the repo pins its version through `packageManager`)
- Docker Desktop, running. The local Supabase stack runs in containers.

The Supabase CLI is a dev dependency, so no global install is needed.

## Local setup

```bash
pnpm install
pnpm db:start          # starts local Supabase, applies migrations and seed.sql
cp .env.example .env.local
pnpm exec supabase status   # copy the local API URL, anon key and service role key into .env.local
pnpm dev               # http://127.0.0.1:3000
```

The first `pnpm db:start` downloads the Supabase Docker images and takes a
few minutes. Local Studio runs at http://127.0.0.1:54323 and captured emails
(magic links) at http://127.0.0.1:54324.

Useful commands:

| Command | What it does |
|---|---|
| `pnpm db:reset` | Recreate the local database from migrations, then apply `supabase/seed.sql` |
| `pnpm db:types` | Regenerate `src/lib/supabase/database.types.ts` after a migration |
| `pnpm db:stop` | Stop the local Supabase containers |

Everything above touches only the local Docker database. A CLI link to the
hosted project lives only in the git-ignored `supabase/.temp`. Commands with
`--linked`, `db push` above all, act on the hosted database: run
`db push --linked --dry-run` first, and never `db reset` or `--include-seed`
against it. See "Hosted setup" below.

### Seed data

`supabase/seed.sql` creates two isolated tenants for local development:

| Tenant slug | Owner login | Notes |
|---|---|---|
| `bouprod` | owner@bouprod.example | One event with a verified client |
| `other-dj` | owner@otherdj.example | One event for the same couple, with no client access |

Both tenants have tax categories configured: BOUPROD maps `standard` to
GST and QST, and Other DJ maps it to HST.

BOUPROD also gets a **demo catalog**: five gear items, three packages
(Essential, Signature, Premium), four logistics questions with three rules,
and a "Wedding (DEMO)" template. Every record is tagged DEMO. Prices and
wording are placeholders that Pavel has not reviewed. The catalog mirrors
the spec's pricing example, where separate ceremony and cocktail spaces each
require an additional-location speaker. No media files are seeded.

The client `client@couple.example` has verified access to the BOUPROD event
only. Seeded users have no passwords. Login is magic-link only, and the login
screens arrive in Phase 2.

## Trying it in the browser

With `pnpm db:start` done and `.env.local` filled in, follow these steps:

1. Run `pnpm dev` and open http://127.0.0.1:3000/login. Use `127.0.0.1`, not
   `localhost`, so the magic-link cookie matches the configured site URL.
2. Enter `owner@bouprod.example` and click **Email me a sign-in link**.
3. Open Mailpit at http://127.0.0.1:54324, open the newest "Your Flux DJ
   sign-in link" email, and click **Continue to sign in**. Use the same
   browser.
4. Click **Sign in** on the confirmation page. You land on
   http://127.0.0.1:3000/staff/bouprod.

`owner@otherdj.example` signs in to the second tenant. Its workspace is at
`/staff/other-dj`, and each owner gets a 404 for the other's workspace.
Unknown emails get the same on-screen message, but no email and no account.

| Screen | URL (BOUPROD) |
|---|---|
| Dashboard | http://127.0.0.1:3000/staff/bouprod |
| Gear (photos and videos on each item) | http://127.0.0.1:3000/staff/bouprod/gear |
| Packages | http://127.0.0.1:3000/staff/bouprod/packages |
| Questions and rules | http://127.0.0.1:3000/staff/bouprod/questions |
| Templates | http://127.0.0.1:3000/staff/bouprod/templates |
| Contract templates | http://127.0.0.1:3000/staff/bouprod/contract-templates |
| Clients | http://127.0.0.1:3000/staff/bouprod/clients |
| Events, which is where proposals start | http://127.0.0.1:3000/staff/bouprod/events |

The seeded event "Alex & Sam Wedding" can start a proposal from the
"Wedding (DEMO)" template. Each proposal builder links to a full-page
preview at `/staff/bouprod/proposals/{id}/preview`.

### Sending a proposal and testing it as the client

1. As staff, open http://127.0.0.1:3000/staff/bouprod/events, then
   **Alex & Sam Wedding**. Choose **Wedding (DEMO)** and click **Start
   proposal draft**.
2. Adjust the offer and click **Save draft**. Sending is blocked while
   there are unsaved changes. Click **Review and send…**, check the
   recipient (`client@couple.example`), event and expiry, then click **Send
   proposal now**.
3. Open Mailpit at http://127.0.0.1:54324 and find "BOUPROD sent you a
   proposal for Alex & Sam Wedding". Copy the **View your proposal** link.
   It looks like `http://127.0.0.1:3000/bouprod/p#…`.
4. Paste the link into a **signed-out browser**, such as a private window or
   another browser. It opens `/bouprod/proposals/{id}` with no account and
   no token in the URL.
5. Pick a package, answer the questions and adjust extras. Required gear is
   explained and can't go below its minimum. Changes save automatically,
   and reloading keeps them. Click **Submit for BOUPROD to review**. The
   page shows "Submitted for DJ review."
6. Mailpit now has "Proposal link opened" and "Submitted for your review"
   notices for staff. As staff, reload the proposal page, check the
   submission, then click **Approve…** and confirm. The client gets an email
   saying the contract will follow, and their page shows "Approved by
   BOUPROD."
7. To change terms, click **Start a revised offer** on the proposal, edit
   it and send it. The client's old link and page then say a newer
   proposal is available.

### Contract templates and contract drafts

1. Open http://127.0.0.1:3000/staff/bouprod/contract-templates. The **New
   contract template** form is prefilled with DEMO text marked "DEMO, NOT FOR
   CLIENT USE". It is not a reviewed agreement. Click **Create template
   draft**.
2. On the template page, the right-hand column lists every allowed
   placeholder. Type `{{client.nickname}}` into a section and click **Save
   draft** to see it rejected. Remove it and save.
3. Click **Publish…**, choose **DEMO, for testing** (the starter text is
   DEMO wording), then **Publish version 1 as DEMO**. The version is now
   read-only. **Start draft version 2** copies it into a new editable draft.
   To use your own agreement, replace the text with your wording, save,
   click **Publish…**, keep **For client use**, check the responsibility
   statement and click **Publish version N for client use** (owner only).
4. Approve a proposal as described in the previous section. The approved
   proposal page, and the event page, now show a **Contract** card.
5. Choose the template version and click **Generate contract draft**. With
   the seeded event this works once you enter a **Balance due date**, because
   the DEMO text uses one. To see the missing-information message, clear the
   event's venue address or the client's phone first.
6. The draft opens at `/staff/bouprod/contracts/{id}`. Check the totals,
   the 50% deposit and the balance, then narrow the window to phone width.
7. Back on the proposal, **Regenerate draft…** asks for confirmation and
   keeps the old draft as "replaced". Sending a revised offer marks the draft
   "superseded", and the old approval can no longer be used.

Generating a draft sends no email, does not book the event and gives the
client no access. Clients and anonymous users cannot see templates or drafts.

Delivery problems show under **Emails**
(http://127.0.0.1:3000/staff/bouprod/emails), with **Retry** and **Deliver
due emails now** buttons. Emails go out right after each action. To retry
pending mail in the background, run `pnpm outbox:work` alongside
`pnpm dev`.

## Running the checks

```bash
pnpm check
```

This runs, in order:

| Step | Command | Needs Docker |
|---|---|---|
| ESLint | `pnpm lint` | No |
| TypeScript | `pnpm typecheck` | No |
| Pricing unit tests (Vitest) | `pnpm test:unit` | No |
| Postgres schema lint | `pnpm db:lint` | Yes |
| Database tests (pgTAP) | `pnpm db:test` | Yes |
| Integration tests (Vitest) | `pnpm test:integration` | Yes, with the Storage service running |
| Browser tests (Playwright) | `pnpm test:e2e` | Yes. It starts `pnpm dev` if it isn't running |

Before the first browser test run, install the browser once with
`pnpm exec playwright install chromium`.

Tests never write to the seeded BOUPROD or Other DJ tenants, so your manual
work there is safe while they run.
- Browser tests create their own tenants (`e2e-…`) with the DEMO catalog
  copied from the seed (`tests/e2e/tenant.ts`).
- Integration tests create their own tenants (`it-…`).
- Each test tenant's only member is a throwaway `@example.test` owner, so it
  never appears in your staff workspace. It is archived when the suite ends.
- Proposals, contracts and audit rows are immutable, so test tenants are
  archived rather than deleted. `pnpm db:reset` removes them along with
  everything else.

`pnpm build` also verifies the production build.

### Database tests

The tests in `supabase/tests/database/` run against the real local Postgres
with real RLS. Each file switches to the `authenticated` or `anon` role with
JWT claims, as PostgREST does, and rolls everything back afterwards. Nothing
is mocked. Shared fixtures in `_fixtures.psql` create two tenants and users
in every relevant relationship.

| File | Proves |
|---|---|
| `01_schema_guards` | RLS is on for every table; anon has no grants; security definer functions pin `search_path`; no RLS-bypassing views; the client projection omits staff fields |
| `02_staff_tenant_isolation` | Staff of tenant A cannot SELECT, INSERT, UPDATE or DELETE tenant B rows; `tenant_id` cannot change, even for privileged code |
| `03_integrity_constraints` | Composite foreign keys block cross-tenant references even when RLS is bypassed; one primary contact and one signer per event; access revocation is one-way; value validation |
| `04_membership_and_privileges` | Staff cannot escalate; owners manage staff only in their own tenant; lifecycle and access columns are not directly writable |
| `05_client_access` | A verified client sees only their linked events, including at two different DJs; unverified, revoked or email-only matches grant nothing; clients cannot alter staff data |
| `06_anonymous_access` | Anon has no table or function access |
| `07_catalog_isolation` | Every catalog and template table is visible and writable only by staff of the owning tenant; clients and anon get nothing |
| `08_catalog_integrity` | Cross-tenant composite keys for package contents, rules, templates and media; the default package must belong to its template; at most three packages per template; immutable keys; rule conditions limited to equality and membership, and checked against the question's options; media type, extension and path checks |
| `12_send_submit_approve` | Send authorization, stale versions and missing contacts; staff can't see token hashes or sessions. Link exchange across tenants, unknown, revoked and superseded links. Safe client view, draft conflicts and invalid input. Submissions with omitted required gear, out-of-range quantities, missing answers or tampered prices, stale tabs, idempotency, approval, revision, expiry while open, the outbox and rate limits |
| `15_event_archiving` | Only staff of the event's tenant can archive or unarchive, never directly. Links and sessions are revoked and pending client emails cancelled, while history and lifecycle status stay. Viewing, saving, submitting, link exchange, sending, approval and contract generation are blocked while archived. Unarchiving is audited and doesn't resurrect links |
| `17_contract_sending_client_access` | Send authorization, eligibility, idempotency and frozen content. Only `send_contract` can send, and generation is blocked while a contract is sent. The invitation token is hashed and scoped, and only asks for verification emails, rate limited. Wrong, unverified and multi-tenant accounts. Idempotent acceptance with no staff membership. Safe DTO fields, no leakage, client and anon reads. Dispatch rechecks. Resend, void and replacement with access kept. Archive and unarchive. Revised offers void sent contracts. Expired invitations |
| `18_contract_void_notice` | One notice per voided sent contract, none on repeats. Frozen signer, no link, no reason. Cancelled invitation emails. Memberships, identities, access and other events untouched. Deliverable at dispatch. Archiving neither sends nor cancels it. Revised-offer voids notify. Unsent drafts never do |
| `19_tax_settings` | Owner-only tax settings for staff, other tenants, clients and anon; no direct column writes. Malformed, fractional, negative and over-100% rates, codes, names, keys and unknown taxes. Stale versions. Multiple taxes on standard. Removal rules for used taxes and categories. Explicit no tax versus missing. New offers read the new settings; the sent snapshot and hash are unchanged. Audit |
| `20_contract_signing` | Only the service role signs. Wrong signer, other event's client, staff, stranger, no identity, wrong tenant, unverified or changed email, revoked access, archived event. Consent, consent version, displayed hash, typed name, never-stored, wrong-size, non-PNG, oversized and out-of-folder images. The atomic signed state and evidence, one audit event, no booking. Replays return the first signature to the signer only. Immutable evidence and content; void, resend, regeneration and revisions refused. Client and staff reads, Storage visibility, orphans. Archiving keeps evidence. Void and superseded contracts can't be signed |
| `22_client_use_signing` | Usage is required when publishing; legacy can't be chosen. Client use is owner-only, needs the current statement, and stores the exact statement, owner and database time; staff publish DEMO only; other tenants get nothing. Published usage and confirmation are immutable; drafts carry none; a new version copies text, not usage. Contracts freeze mode and consent, immutably. Signing with `client-v1` (the DEMO consent is refused) and exact evidence; `demo-v1` unchanged. Legacy versions can't generate; `none` contracts can't be sent or signed and the review explains how to regenerate. Signed-copy senders are frozen when queued and at the first attempt, never change, keep older rows' first values, ignore sent rows and are service-role only |
| `21_signed_contract_pdfs` | Signing queues one PDF job (none on replay) and no email. Only the service role runs jobs. Leases: no double claim, expired-lease recovery, stale leases can't fail a job. Commit validation (missing, wrong size, wrong type, wrong folder, wrong signature hash). One canonical immutable document; a second upload is "exists" with no duplicate emails. One email per party with separate dedup keys, no paths or tokens in payloads. Staff, other tenants, signer, other clients and anon. Archiving blocks the signer and cancels undelivered copies but keeps the PDF. Recipient-confirmed resend that never repeats a delivered copy. Contracts signed before PDFs: explicit generation without email |
| `16_business_settings_send_review` | Owner-only settings for staff, other tenants, clients and anon. Validation and 0% and 100% boundaries. Half-up deposit rounding, and equality with the original 50% formula. Existing contracts are byte-for-byte unchanged with valid hashes. Explicit regeneration freezes new terms and identity. New placeholders and missing values. Every review rejection reason. Sending stays impossible |
| `13_contract_templates` | Templates are visible and writable only by staff of their tenant; clients and anon get nothing. Unknown, malformed or expression-like placeholders are rejected, also by a CHECK constraint. Optimistic draft versions, publishing, and published versions that no role can edit, unpublish or delete. Editing opens one new draft version |
| `14_contract_generation` | Deposit rounding. Authorization for other tenants, clients, strangers and anon. Unpublished and other tenants' template versions. Missing values listed with what to complete, and no signer. Amounts and lines from the approved selection, the documented hash, no booking and no access. Repeat clicks, explicit replacement and conflicts. Snapshot independence after client, event, business, tax, catalog and template changes. Frozen rows, cross-tenant foreign keys with the guard trigger disabled, literal rendering of client values, and superseded approvals |
| `09_storage_gear_media` | Storage policies on the `gear-media` bucket: private bucket, tenant-scoped reads, uploads only under the uploader's own gear items, no overwrite or delete |

| `10_offer_snapshots` | Offer creation rules: exactly three distinct packages and one most popular; every referenced package, gear item and question is active; only active rules of offered questions are frozen; every tax category resolves. Also covers authorization, template prefill, and snapshots and hashes that survive every catalog, tax and branding change |
| `11_selection_recording` | Only the service role records selections; optimistic versions; immutable selections and lines. The database rejects tampered prices, line totals, subtotals, tax rates, tax rounding, currency, offer hash and packages |

`_catalog_fixtures.psql` adds catalog rows and Storage objects for both test
tenants. `_offer_fixtures.psql` adds a third package and an offer-input
helper.

The selection tests force deferred constraint checks with
`set constraints all immediate`. The test transaction never commits, so
otherwise those checks would never run.

### Unit tests

`tests/unit/pricing.test.ts` covers the pricing module:

- The spec's speaker example, and charging required gear once when the
  client also selects it as an addon.
- Addon quantity bounds, missing answers and invalid selections.
- Rejection of client-supplied prices and totals.
- Half-up tax rounding per line, and determinism.
- Offer-snapshot validation.

### Browser tests

`tests/e2e/staff-flow.spec.ts` drives the real UI in Chromium:

1. It signs in through a real magic link read from Mailpit, and confirms
   unknown emails get no link and no account.
2. It confirms the other tenant's workspace returns 404.
3. It creates gear, changes its price, and uploads a real PNG. It then
   confirms that HTML renamed to `.png` is rejected and deleted from Storage.
4. It builds a package, a question with a rule, and a template, then creates
   an event with a new client.
5. It opens a proposal draft and checks the spec's speaker example in the
   live preview, a total of $2,701.91.
6. It saves the draft twice. It checks that the same row was updated, that
   nothing froze, and that a stale tab gets a conflict message.
7. It checks the preview has no sideways scrolling at 390px wide, and that
   signed-out visitors are redirected to login.

Browser tests in `tests/e2e/proposal-flow.spec.ts` run the client side in a
signed-out browser:

1. Staff must save before sending, and the confirmation shows recipient,
   event and expiry.
2. The emailed link opens on a clean URL with the recommended selections.
3. Required gear has a minimum the client can't go below.
4. Edits made while a save is pending survive. A failed save shows Retry.
5. A catalog price change doesn't affect the sent terms. The page fits a
   phone screen.
6. Double-clicking Submit creates one submission.
7. Staff review and approve. The client is told the contract follows.
8. The link grants no staff, event or direct database access.
9. A revision supersedes the old link and session.
10. Invalid and cross-tenant links show generic messages.
11. Expiry while the page is open blocks submission.

### Contract tests

- `tests/unit/contract-templates.test.ts` covers the "## Heading" editor
  format, the DEMO text markers and the error messages.
- `tests/integration/contracts.test.ts` runs through PostgREST with real
  sessions. It checks that the DEMO text is accepted, and that contract
  amounts equal the TypeScript pricing engine's. Two simultaneous generations
  create one draft. Later catalog, client and event edits leave the contract
  unchanged. Other tenants, the event's own verified client and anonymous
  REST calls get nothing.
- `tests/e2e/contract-flow.spec.ts` drives the staff UI. It covers
  publishing a template with a rejected placeholder, approving a real
  submission, missing-information guidance, and generation with a
  double-click. It checks the preview, including a client name with markup
  shown literally, and the layout at 390px with no sideways scrolling. It
  also covers confirmed replacement, signed-out redirects and 404s for the
  other DJ.

### Signed PDF tests

- `tests/unit/contract-pdf.test.ts` renders a long French agreement
  (multiline addresses, accents, 14 sections, signature) and a short one,
  checks the extracted text page by page (page numbers, DEMO labels, parties,
  terms, both hashes, consent, IP or "Not recorded"), checks that the PDF does
  not contain its own hash, and writes every page as PNG to
  `test-results/pdf-samples/` for visual review. A client-use agreement has no
  DEMO wording and still says only the client signed; DEMO labels follow the
  frozen signing mode, not the title.
- `tests/integration/contract-documents.test.ts` uses real rendering, Storage
  and the outbox. It covers:
  - frozen content after source records change
  - renderer and upload failures with recovery
  - a worker that dies after uploading (expired lease, orphan)
  - a stale worker losing the race
  - three parallel workers
  - signature and final-PDF hash mismatches
  - identical attachments to both parties with a per-recipient retry
  - a client-use contract signed with `client-v1`, rendered without DEMO
  - a signed-copy retry through the real Resend adapter (HTTP answered
    locally) after Business settings change: same idempotency key, headers
    and body byte for byte, with the original sender
  - private Storage
- `tests/e2e/contract-signing-flow.spec.ts` continues after signing: both
  emails arrive in Mailpit with the same PDF attached (hash checked), the
  signer and staff download identical bytes with private headers, and
  signed-out and other-tenant requests get no PDF.

### Signing tests

- `tests/unit/signature-image.test.ts` covers the PNG validator (blank,
  tiny, filled, palette, 16-bit, interlaced, bad CRC, trailing bytes,
  decompression bombs, SVG and JPEG, size limits), clean re-encoding, and
  trusted IP capture.
- `tests/integration/contract-signing.test.ts` runs against real Storage and
  Postgres: the stored bytes match the evidence hash, Storage access for staff,
  other tenants, the client and anon, replays after a lost response,
  concurrent attempts, expired sessions, failed uploads, a void or revision
  winning the race before the commit, a crash leaving only an unreadable
  orphan, and real sign-versus-void races.
- `tests/e2e/contract-signing-flow.spec.ts` signs on a phone-sized browser
  with touch input: validation, clear, scroll and rotation without losing the
  drawing, a failed request that keeps every input, consent and confirmation,
  then the signed views for the client and staff.
- `tests/e2e/client-use-signing.spec.ts`: the owner publishes their own
  agreement for client use (publish stays disabled until the responsibility
  statement is checked), generates and sends a contract, and the verified
  client signs with the `client-v1` consent. No DEMO wording appears on the
  page or in the emailed PDF.

### Integration tests

`tests/integration/proposal-flow.test.ts` covers the outbox:
- A failed email is retried with backoff using the identical link, with no
  new links or records.
- Emails exhaust their attempts, then staff retry them.
- Emails for superseded offers are cancelled.
- Links that no longer match the secret are refused.
- The whole flow delivers to Mailpit.

It also covers concurrent submissions, where exactly one wins, and checks
that the client view and links leak nothing and grant no event access.
`tests/integration/support/fixtures.ts` holds the shared setup.


Integration tests run with Vitest against the local stack and refuse any
non-local URL.

`tests/integration/offers-pricing.test.ts` runs the whole step 4 flow:

1. A staff user with a real magic-link session freezes an offer from a
   template.
2. The snapshot is read back through RLS and validated by the TypeScript
   schema.
3. The spec example is priced and committed, so the database's deferred
   verification runs for real.
4. It checks that stale versions, invalid input and a writer that lowers a
   price are all rejected.
5. It changes the catalog and confirms the frozen offer is unchanged.

Proposals can't be deleted, so this test leaves its uniquely named tenant
behind, archived. `pnpm db:reset` clears it.

`tests/integration/storage-gear-media.test.ts` runs through the real Storage
HTTP API. It creates throwaway users and gets real sessions through the
magic-link token flow, so there are no passwords and no hand-made JWTs. It
checks uploads, downloads, signed URLs, cross-tenant access, overwrites,
deletes, MIME types, clients and anonymous users, then removes everything it
created. It refuses to run unless the Supabase URL is local.

## How tenant isolation works

Isolation is enforced by the database, not by application code.

1. **Composite foreign keys.** Every tenant-owned table carries `tenant_id`
   and exposes `unique (tenant_id, id)`. Children reference parents with
   `(tenant_id, parent_id)`, so a row can never point at another tenant's
   row.
2. **Immutable keys.** Triggers reject changes to `id`, `tenant_id` and
   parent references for every role, including the service role.
3. **RLS and column grants.** Policies limit rows to the caller's tenants.
   Column-level grants limit which fields staff can write. For example,
   `events.lifecycle_status` changes only through future transactional server
   operations.
4. **Deny by default.** A migration revokes default privileges for `anon`
   and `authenticated`. Every new table needs explicit grants, RLS and tests.

### Staff authentication

- **Magic links only.** Login uses magic links and no passwords. Public
  sign-ups are disabled in `supabase/config.toml`, so the admin API creates
  every user. The login form never creates accounts and always shows the
  same message.
- **Scanner-safe links.** The email template points at `/auth/confirm`,
  which needs a click on **Sign in** (a POST) before it verifies the token.
  A link scanner that prefetches the URL therefore can't use it up.
- **Server checks.** `src/proxy.ts` refreshes the session and sends
  signed-out visitors to `/login`. That is a convenience only. Every staff
  page and action calls `requireStaff(slug)`, which checks the user with the
  auth server and the membership through RLS.
- **Hosted projects** need the same email template, redirect URLs and
  sign-up setting configured separately.

### Gear uploads

Files go straight from the browser to Storage, because Server Actions are
capped at 1 MB and hosting platforms limit request bodies.

1. A server action checks the declared type and size, then picks a random
   object path.
2. The browser uploads the file with the staff session. Storage RLS allows
   only the staff member's own tenant and gear item.
3. A second server action reads the object's first 4 KB through a
   short-lived signed URL and checks the real file signature. Accepted
   formats are JPEG, PNG, WebP, AVIF, MP4 and WebM. The signature must match
   the declared type and the size must be within limits.
4. Only then is a `gear_media` row created. Anything else is deleted with
   the service role. Offers only reference registered media, so they never
   include an unchecked file.

### Offers, snapshots and pricing

- **Drafting.** Each event has one editable draft, `proposals.draft_offer`,
  saved in place with an optimistic `draft_version`. Staff use
  `open_proposal_draft`, `update_proposal_draft` and
  `proposal_offer_input_from_template`. Editing never freezes anything or
  creates revisions.
- **Previewing.** `preview_proposal_offer` builds the snapshot in memory,
  using exactly the validation and builder that freezing uses. It stores
  nothing.
- **Freezing an offer.** Only `send_proposal` freezes a snapshot, inside the
  send transaction, and it does so exactly once. Under a row lock it
  enforces the offer rules and copies everything into
  `proposals.offer_snapshot`:
  - packages, included quantities, gear prices and descriptions, and active
    media references
  - addons, questions and active rules of offered questions
  - tax rates and categories, currency, branding and expiry
  - the database computes `offer_sha256` itself
  - the snapshot and hash can never change afterwards
- **Pricing.** `src/lib/pricing` is pure, deterministic TypeScript, shared by
  the server and a future browser preview. It follows spec section 5:
  - input is only a package key, addon quantities and answers, and unknown
    fields such as prices are rejected
  - required gear is aggregated across rules, then reduced by package
    inclusions
  - gear that is both required and optional is charged
    `max(optional, required extra)`, so it is never charged twice
- **Tax policy.** For each line and each tax code in that line's category,
  `round_half_up(line_total × rate_ppm / 1,000,000)`, summed per code. Every
  configured rate is listed, including zero amounts.
- **Tax categories.** `tenants.tax_categories` maps a category key to tax
  codes. There is no implicit default, and an unmapped category blocks offer
  creation.
- **Tax settings.** Owners edit taxes and category mappings in Settings,
  under Taxes; other staff see them read-only. Rates are typed as percentages
  with up to 4 decimals and converted exactly to `rate_ppm` (no floats).
  `update_tax_settings` is the only write path. It checks the owner role and
  `tax_settings_version` (stale tabs get a conflict), refuses a tax still
  used by a category and unmapping a category used by active gear or
  packages, and audits each change. Each category is not configured, no tax
  (`[]`), or a set of taxes. Only new offers read these settings.
- **Selections.** A proposal's single editable client selection lives in
  `proposal_selection_drafts` and is autosaved with optimistic versions.
  Immutable `proposal_selections` rows are submissions only.
- **Verification.** The database re-checks every submission against the
  frozen offer, not just the money. It checks unit prices, line totals,
  subtotal, per-line tax rounding and total. It also checks the package,
  addon keys and bounds, required and typed answers, and that the
  chargeable and included lines match the rules, the package inclusions and
  the addons.

### Sending, client access and approval

- **Sending.** `send_proposal` runs as the staff user, with membership
  checked inside, in one transaction:
  - it checks the editor's draft version (unsaved edits elsewhere cause a
    conflict) and freezes the offer
  - it sets the deadline
  - it supersedes and revokes the previous offer, whose terms stay untouched
  - it points `events.active_proposal_id` at the new offer, and a partial
    unique index allows only one actionable proposal per event
  - it creates the access link for the primary contact and queues the email
  - it leaves the event as a lead, because sending is not a booking
- **Link tokens.** The server picks the link id and derives the token as
  `base64url(HMAC-SHA256(PROPOSAL_LINK_SECRET, "flux:proposal-link:v1:" + id))`,
  which is 256 bits. The database stores only `sha256(token)`, in
  `access_links.token_hash`, which staff can't even read. The outbox stores
  only the link id. An email retry re-derives the identical token, so no
  plaintext or encrypted token is ever stored and retries never create new
  links. Before sending, the worker compares the hash, so a rotated secret
  makes undelivered proposal emails fail visibly instead of sending a dead
  link.
- **Opening a link.** Emailed links put the token in the URL fragment
  (`/bouprod/p#token`). Browsers never send fragments, so the token can't
  reach request logs or analytics, and scanners that don't run JavaScript
  can't open sessions.
  - The page removes the token from the address bar at once and POSTs it to
    `/{tenant}/p/exchange`.
  - That route accepts same-origin JSON only and is rate limited per hashed
    IP in Postgres.
  - It creates a 12-hour proposal session: a random token in an HttpOnly,
    SameSite=Lax cookie scoped to `/{tenant}/proposals/{id}`, stored only as
    a hash. It then redirects to the clean URL.
  - GET requests never change anything.
- **Every client read and write** goes through service-role database
  functions: `client_proposal_view`, `client_save_selection_draft` and
  `client_submit_selection`.
  - Each call re-resolves the session and rechecks tenant, proposal,
    revocation, link and session expiry, offer deadline, active proposal
    and state.
  - Responses are explicit safe objects. They never include internal notes,
    other contacts, draft input or staff fields.
  - Media gets 10-minute signed URLs, only for paths inside the frozen
    offer.
  - Anonymous users still have no table or Storage grants.
- **Submission** is one transaction:
  - it locks the event, then the proposal
  - an idempotency key makes repeat clicks return the original submission
  - the draft version must be current, so a stale tab can't submit
  - the database verifies prices and choices, records the submission, sets
    the event to pending approval, and notifies staff
  - submitting never grants event access, signing or planning
- **Approval.** `approve_proposal_selection` approves the exact latest
  submission. The approval records the selection's SHA-256, and repeats
  return the same approval. It moves the event to awaiting signature, not
  booked, and the client is told the contract will follow. To change terms,
  start a revised offer: it opens a draft prefilled from the current offer,
  and the client reviews and submits again.
- **Email outbox.** Business state commits first, then a row is queued with
  a unique dedup key.
  - Delivery runs right after each action, through Next.js `after()`, and
    from `pnpm outbox:work`, which calls `POST /api/internal/outbox` with
    `OUTBOX_WORKER_SECRET`. A hosted cron job can call the same endpoint.
  - Claims use `FOR UPDATE SKIP LOCKED` with expiring locks, and retries
    back off from 1 minute up to 1 hour.
  - After the last attempt an email is marked failed and shown to staff
    with **Retry**. Proposal emails for superseded offers are cancelled.
  - Delivery is at least once: a crash after sending but before recording
    can resend one email. Retries never create proposals, submissions,
    approvals or links.
- **Email transports** are `src/lib/email/transport.server.ts`: Mailpit's
  HTTP API locally, and Resend behind the same server-only interface for
  hosting. `EMAIL_TRANSPORT=resend` with `RESEND_API_KEY`. Resend isn't used
  locally or in tests.

### Contract sending and verified client access

Clients can read a sent contract. They cannot sign it yet.

- **Send.** **Send contract…** on the review screen runs `send_contract` in
  one transaction:
  - it locks the event, then the proposal, then the contract
  - it re-runs `private.contract_send_problems`
  - it marks the contract sent, with `sent_at` stamped once by the database
  - it creates an invitation (`access_links` with purpose `contract`) that
    expires after 14 days and is scoped to the tenant, event, contract and
    frozen signer
  - it queues the contract email with the dedup key `contract_sent:{link}`
    and writes an audit record

  Repeated or concurrent sends return the existing result. Content and
  hashes never change, and the event stays awaiting signature. Only this
  function can move a contract to `sent`; the transition trigger requires a
  marker that only it sets.
- **Invitation token.** It is `HMAC(PROPOSAL_LINK_SECRET,
  "flux:contract-invite:v1:" + link id)`. Only its SHA-256 is stored, and the
  worker re-derives it at delivery, as proposal links do. The email link is
  `/{tenant}/invite#token`: the token stays in the fragment, out of server
  logs, and is removed from the address bar. The token is not proof of
  identity. Its only power is asking for a verification email to the frozen
  signer address, rate-limited per IP and per invitation, three every 15
  minutes. That first step needs JavaScript.
- **Verification email.** The `contract_sign_in` outbox email gets its
  Supabase link from the worker at delivery time, through the Auth admin
  API:
  - `invite` when the address has no verified identity. Trusted code creates
    the identity, and public signup stays disabled.
  - `magiclink` when a verified identity exists, for example a client of
    another DJ or a staff user.

  The link goes to `/auth/confirm` with `type` and `next`. Both are
  allow-listed, and `next` may only be an invitation, contract, `/my` or
  `/staff` path. Verification needs the explicit **Sign in** POST, which
  works without JavaScript and sends a real Origin (`strict-origin`). It
  works in any browser or device.
- **Acceptance.** `/{tenant}/invitations/{id}` shows a page, and only its
  **Open my contract** POST runs `accept_contract_invitation`. That
  function:
  - locks the event and rechecks the invitation, contract and event
  - requires the session's verified email to equal the frozen signer email
  - grants `event_access` idempotently, to the exact tenant, event and
    signer client

  A wrong account is shown only that the invitation belongs to a masked
  other address. No client data is accepted from the browser.
- **Reading.** `/{tenant}/contracts/{id}` calls `client_contract_view`, a
  safe DTO of frozen data. It rechecks on every read:
  - the verified identity
  - active event access for the signer client
  - the signer email
  - that the contract is sent, its approval current, and the event and
    tenant not archived

  `/my` lists readable contracts. Returning clients sign in at `/login`
  with the same magic-link form and land on `/my`. Signing in never grants
  planning access or confirms a booking.
- **Resend** (`resend_contract`). It revokes earlier invitations, cancels
  their pending emails, issues a fresh invitation and email, and is audited.
  `sent_at`, content, hashes and granted access are kept. It is limited to
  once every 2 minutes and 10 times a day.
- **Void** (`void_contract`, with a reason). It works on sent, unsigned
  contracts only. Invitations are revoked and pending contract emails
  cancelled. Clients can no longer read the contract, while event access,
  other events and identities are untouched. A replacement can then be
  generated; generation is refused while a contract is sent.
- **Revised offers and archiving.** A revised offer voids the sent contract
  automatically. Archiving revokes invitations and cancels contract emails,
  and unarchiving revives neither.
- **Withdrawn notice** (`contract_voided`). Every void of a sent contract,
  whether by staff or by a revised offer, queues one email to the frozen
  signer in the same transaction, deduplicated per contract. It says the
  contract is no longer available and the DJ will follow up. It carries no
  link and no internal reason, and doesn't suggest the event is cancelled.
  Archiving never queues or cancels it.
- **One sign-in per browser.** Supabase keeps a single session cookie, so
  opening a client sign-in link in a browser where staff are signed in
  replaces the staff session. Staff pages and actions then redirect to
  `/login?notice=no-staff-access`, which names the signed-in account and
  explains this, instead of a bare 404. Nothing is changed. The redirect
  happens only when the account has no staff role anywhere, so it reveals
  nothing about tenants; staff of another tenant still get 404. For manual
  testing, open client links in a private window or another browser.

**Ordering and recovery.** Postgres commits business state first: the
contract, invitation, queued email and audit record. Email delivery and
Supabase Auth calls happen afterwards in the worker, through `after()` or
`pnpm outbox:work`, and are never inside a transaction.
- **Dispatch rechecks.** Before sending, the worker rechecks that the
  contract is still sent and current, the invitation unrevoked and
  unexpired, and the event unarchived. Otherwise it cancels the email.
- **Fresh links on every attempt.** Each `contract_sign_in` attempt creates
  a new Supabase link, which invalidates the previous one. A crash after
  sending but before recording can therefore resend one email, and only the
  newest link works. Supabase verification links expire after one hour, and
  invitations after 14 days.
- **No tokens stored.** Neither the invitation token nor any Supabase token
  is written to the outbox, logs or error text.
- **Access is never premature.** It is granted only by the verified POST.
- **Recovering a stuck invitation.** If a verification email is lost or
  expires, the client asks for another from the invitation page. If the
  invitation is lost or expires, staff resend. Failed emails appear under
  **Emails** with **Retry**.

No new environment variables are needed. Invitations reuse
`PROPOSAL_LINK_SECRET` with their own domain prefix, and rotating it fails
undelivered contract emails visibly.

### Business settings and contract send review

- **Owner-only settings.** The owner manages `/staff/{tenant}/settings`:
  - legal business name (`tenants.business_name`)
  - business address
  - contact email
  - deposit percentage, a whole number from 0 to 100, default 50

  The display name stays the client-facing brand. Changes go only through
  `update_business_settings`, which checks the owner role in the database.
  Staff can see the values but not edit them.
- **New placeholders.** `{{business.legal_name}}`, `{{business.address}}`
  and `{{business.email}}`. `{{business.name}}` is kept for existing
  templates and means the legal name.
- **Deposit.** It is `round_half_up(total × percent / 100)` in integer cents,
  and the balance is the total minus the deposit. Each new contract freezes
  the percentage (`contracts.deposit_percent` and the commercial snapshot),
  the amounts and the business identity.
- **Existing contracts.** They were backfilled at 50%, which their snapshots
  record. No snapshot or hash was rewritten.
- **Regeneration.** Changing settings never alters a draft. Regenerate it
  explicitly to pick up new values.
- **Version choice.** Generation defaults to the latest published template
  version, which is labelled, and staff can choose another. The balance due
  date is still entered per contract.
- **Review and send.** **Review and send…** on a contract draft runs
  `review_contract_for_send`, read-only. It shows:
  - the intended signer and recipient email
  - the frozen business identity
  - the exact contract text
  - the deposit, balance and deadline
  - every problem found by `private.contract_send_problems`: archived event,
    not the current draft, superseded approval, changed or missing signer,
    incomplete settings, or business details or deposit changed since
    generation
- **Sending.** **Send contract…** sends from the review screen once every
  check passes. See "Contract sending and verified client access".

### Contract signing

- **Who signs.** Only the contract's frozen signer, signed in with a current,
  verified Supabase session whose email matches the frozen signer email, and
  holding event access for that signer. The server reads the identity from
  `auth.getUser()`, which checks the session with the Auth server. An
  invitation token is never signer identity. There is no second email check
  per signature.
- **What the client provides.** A typed name, a drawn signature
  (`signature_pad`, exported as a 900 × 300 PNG), the consent checkbox and the
  content hash of the contract they were shown. The server and database derive
  the signer email, user id, time, consent text and request context.
- **Signing modes.** Every published template version has an explicit
  `usage`, chosen when publishing and immutable like the text:
  - `demo`: test wording. Contracts, the signing page and signed PDFs are
    labelled "DEMO, NOT FOR CLIENT USE", and the client accepts the `demo-v1`
    consent. Any staff member may publish DEMO versions.
  - `client_use`: the business's own agreement. Only the owner can publish
    it, after checking the responsibility statement (`client-use-v1`: the
    owner is responsible for the agreement and approves it for clients;
    Flux DJ has not reviewed or approved it and gives no legal advice). The
    exact statement, the owner's user id and the database time are stored on
    the version. The client accepts the `client-v1` consent. No DEMO labels.
  - The previous two-argument `publish_contract_template_version(id, draft
    version)` remains for older callers: it publishes DEMO-titled versions as
    DEMO, replays versions already published, and refuses everything else, so
    nothing is ever approved for client use without the owner's confirmation.
  - `legacy`: versions published before modes existed that were not DEMO.
    Contracts can't be generated from them; open a new draft version (the
    text is copied) and publish it for client use.

  A contract freezes `signing_mode` and `consent_version` from its template
  version when it is generated (`contracts_signing_terms`); nobody can choose
  or change them. The client view shows that exact consent, unchecked, and
  `sign_contract` accepts only that version and stores its text in the
  evidence. Changing wording or usage always needs a new version, and
  publishing sends or signs nothing.
- **Existing contracts.** The migration classified existing data with the old
  title rule ("DEMO, NOT FOR CLIENT USE"): DEMO versions and contracts stay
  DEMO with `demo-v1`, and signatures, evidence, hashes and PDFs are
  unchanged. Other contracts get `signing_mode = none`: they can't be signed
  or sent (review lists the problem), and the contract page explains how to
  publish a client-use version and regenerate (or void and replace a sent
  one). Nothing old becomes signable automatically.
- **Image checks (server).** Only a base64 PNG data URL of at most 256 KiB.
  The server accepts plain 8-bit, non-interlaced PNG only, with CRCs checked,
  no unknown critical chunks or trailing bytes, an exact inflate cap,
  dimensions within 300–1800 × 100–600, and enough dark ink over a minimum
  span. It then re-encodes the pixels into a fresh PNG, so nothing else from
  the upload is stored.
- **Ordering and retries.** Storage and the database can't share a
  transaction, so the order is:
  1. Validate the request and image, and run the read-only eligibility check
     as the user.
  2. Upload with the service role to the private `contract-signatures` bucket
     at a new `{tenant}/{contract}/{uuid}.png`, never overwriting.
  3. Call `sign_contract` (service role only). One transaction locks event,
     proposal and contract, rechecks everything, and confirms the object
     exists with the declared size and type and is unused. It then inserts
     the immutable `contract_signatures` row, moves the contract
     `sent → signed`, retires invitations and writes one audit event.
  - **Rejection or replay:** the database's answer is definitive, so the
    upload is deleted.
  - **Unknown outcome** (lost response): the upload is kept, because a
    committed signature may reference it. A retry returns the existing
    signature as a replay, to the same signer only.
  - **Concurrent attempts** wait on the event lock. Exactly one commits.
  - **Crash** between upload and commit: an orphan stays behind. Nobody but
    the service role can read it, and `private.contract_signature_orphans`
    lists it for manual cleanup. No automatic cleanup exists yet.
  - A deferred check guarantees that a signed contract always has exactly one
    evidence row.
- **Evidence.** Typed name, verified email and user id, image path, SHA-256,
  size and dimensions, database signing time, frozen content hash, exact
  consent text and version, and user agent. The IP is recorded only on Vercel,
  from `x-vercel-forwarded-for` (set by Vercel, not spoofable). Anywhere else
  it is stored as unavailable. Evidence rows can't be updated or deleted, and
  evidence stays out of the audit log and app logs.
- **Viewing.** Staff of the tenant read evidence through row-level security,
  and get two-minute signed URLs for committed signatures only, through a
  Storage policy. The signer sees the signed name and time and a two-minute
  link issued by the server after `client_signature_object` authorizes it.
  Clients and anon have no Storage policy and can't read or list the bucket.
  Nobody but the service role writes to it.
- **Protected paths.** Nothing leaves `signed`. Void, resend, regeneration
  and replacement refuse signed contracts. A signed contract blocks
  commercial revisions: `open_proposal_draft` refuses, and a trigger refuses
  superseding the signed proposal, so `send_proposal` rolls back. Archiving
  hides the event and cuts client access but keeps the agreement and
  evidence; unarchiving restores the signer's read access.
- **Not a booking.** The event stays `awaiting_signature`. Signing grants no
  planning access and records no payment. The client sees "Contract signed.
  Your DJ will follow up with the next steps."
- **Retention is undecided.** Nothing deletes signatures or evidence, and no
  retention period is set. Decide one (and how to handle archived tenants and
  deletion requests) before real clients sign. Collecting this evidence does
  not by itself establish legal compliance for electronic signatures; that
  needs review of the agreement, the consent wording and the process.

### Signed PDFs and signed copies

- **What the PDF shows.** It is rendered with `@react-pdf/renderer` only from
  the frozen contract (text, parties, terms, content hash) and the signing
  evidence. It includes:
  - the full agreement, with numbered pages
  - the frozen business and client identities
  - the agreed price, taxes, deposit and balance
  - the typed name, the signature image, and the signing time in the event's
    time zone and in UTC
  - the contract id and the contract content SHA-256
  - the consent text and version
  - the recorded IP (or "Not recorded") and the user agent

  DEMO contracts carry DEMO labels on every page; client-use contracts have
  none (decided by the frozen `signing_mode`, never the wording). Both state
  that the PDF records the client's signature only, with no signature from
  the business. Fonts are bundled in
  `assets/fonts/dejavu` (Latin and French accents, no network fetch) and
  traced into the deployed functions by `next.config.ts`.
- **Two different hashes.** `contracts.content_sha256` identifies the agreed
  text, terms and parties. `contract_documents.pdf_sha256` is the SHA-256 of
  the exact final PDF file. The PDF never contains its own hash.
- **Durable job.** `sign_contract` queues one `document_jobs` row in the
  signing transaction. Rendering happens later, so a failure never touches
  the signature. The worker (`src/lib/contracts/documents.server.ts`) runs
  right after signing and after **Generate signed PDF**, for that contract's
  job only (the contract id comes from the database's answer, never the
  browser), so other tenants' backlog never delays it. The scheduled
  `/api/internal/outbox` route drains everything else, including anything
  the immediate run failed or never finished:
  1. Claim with a 2-minute lease.
  2. Verify the signature image against its recorded hash. A mismatch fails
     the job permanently and visibly.
  3. Render, then hash the final bytes.
  4. Upload to a new `{tenant}/{contract}/{uuid}.pdf` in the private
     `contract-documents` bucket.
  5. `commit_contract_document`: atomically records the one canonical
     document, marks the job succeeded and queues the signed-copy emails.

  Retries back off (1, 2, 4… minutes) for up to 5 attempts, after which staff
  see the error and can retry.
- **Concurrency and recovery.**
  - **Second commit:** a second commit for the same contract (a stale or
    parallel worker) returns `exists`. That worker deletes its upload, and the
    canonical PDF is reused forever; nothing overwrites it.
  - **Crashed worker:** its lease expires and another worker retries.
  - **Lost commit response:** the upload is kept, because it may be canonical.
  - **Orphans:** unreferenced uploads appear in
    `private.contract_document_orphans` and are readable only by the service
    role. No automatic cleanup exists yet.
- **Downloads.** `/{tenant}/contracts/{id}/signed-pdf` (signer) and
  `/staff/{tenant}/contracts/{id}/signed-pdf` (staff) recheck access on every
  request. They then stream the bytes after checking them against
  `pdf_sha256`, with `Content-Disposition: attachment` and
  `Cache-Control: private, no-store`. A mismatch returns an error and never
  the file. The bucket has no Storage policies and there are no signed URLs.
  Archiving blocks the signer's download but keeps the PDF; staff can still
  download it.
- **Emails.** A commit queues `contract_signed_copy` for the frozen signer
  email and the frozen business contact email. Each recipient gets its own
  row, dedup key and status, so a retry for one never resends the other. The
  worker attaches the committed PDF after the same hash check; a mismatch
  fails permanently. No bytes, paths, URLs or tokens are stored in the
  outbox. Resend receives `Idempotency-Key: flux-signed-copy-{row id}`, which
  closes the crash-after-send window for 24 hours. After that, or with
  Mailpit, a crash between sending and recording can resend one copy. Mailpit
  (local) and Resend (hosted) both send real attachments.
- **Frozen sender.** Resend refuses a reused key with a different request, so
  every attempt must be identical. Each row's `sender` freezes the business
  display name (also used in the text), the from name and the reply-to when
  queued, and the from address (`EMAIL_FROM_ADDRESS`) at the first attempt
  (`freeze_email_sender`). Keys are set once and never change. Retries are
  built only from the payload, the frozen sender and the canonical PDF, so
  changing Business settings between attempts changes nothing. Rows queued
  before this existed freeze the then-current settings at their next attempt;
  if such a row had already reached Resend and the settings changed since,
  that one retry can still get a 409 within the 24 hours. Sent rows are never
  changed.
- **Contracts signed before PDFs.** They have no job. Staff click **Generate
  signed PDF**, which sends no email. **Send signed copies…** is a separate
  step whose confirmation lists both recipients; the database checks that
  they match the frozen addresses.

### Archiving events

- **Archive or unarchive.** Staff do this from the event page, through
  `set_event_archived`, which checks membership. Staff have no direct grant
  on `events.archived_at`.
- **Hidden by default.** Archived events are hidden from the Events list and
  the dashboard. **Include archived** shows them, marked as archived.
- **One transaction.** Archiving locks the event and does the following
  together:
  - revokes all its proposal links and client sessions
  - cancels pending client emails for its proposals
  - writes an audit record
- **Blocked while archived.**
  - Client sessions resolve as invalid, so clients can't view, edit or submit.
  - Proposals can't be sent or approved.
  - Contract drafts can't be generated.
- **Separate from status.** Archiving never changes the lifecycle status.
  Proposals, contracts and audit history are kept.
- **Unarchiving** clears the flag only. Revocations are one-way, so the client
  gets access again only when staff send a revised offer.

### Contract templates and drafts

- **Templates.** `contract_templates` holds a name and an active flag.
  `contract_template_versions` holds numbered versions of the text: a title
  and 1 to 60 plain-text `{heading, body}` sections.
  - A version is an editable draft until published, with optimistic
    `draft_version` checks. At most one draft exists per template.
  - Publishing stamps the time and computes `content_sha256`, the SHA-256 of
    the canonical jsonb text of `{"title", "sections"}`. After that no role
    can change, unpublish or delete the version.
  - "Editing" a published template opens a new draft version copied from the
    latest one.
  - The template does not store a pointer to a current version. Staff choose
    any published version of an active template when generating.
- **Placeholders.** The only dynamic syntax is `{{group.name}}` from the fixed
  registry `private.contract_placeholders()`. The editor shows the same list.
  - Unknown or malformed placeholders are rejected on save and by a CHECK
    constraint. There is no HTML, markup, filter or expression.
  - The staff editor uses one text field in which `## Heading` lines start
    sections.
- **Generation.** `generate_contract_draft` renders the contract inside the
  database, in one transaction under the event lock. It uses only three
  sources:
  - the published template version
  - the approved, immutable selection and its lines, for every commercial
    value
  - the signer, event, venue and business records as they are at that
    moment, copied into `party_snapshot`
- **Substitution** is a single pass, so a client name containing `{{...}}`
  or `<b>` is stored and shown literally. React renders it as text.
- **Missing values.** Every placeholder a template uses must have a
  non-blank value, and the event needs a signer. Otherwise nothing is stored
  and staff get a list of what to complete.
- **Balance due date.** It is entered by staff when the template uses
  `{{payment.balance_due_date}}`, and refused when it doesn't. Nothing is
  assumed.
- **Deposit.** It is 50% of the approved total including taxes, rounded half
  up to the cent (`private.contract_deposit_cents`). The balance is the total
  minus the deposit, and a CHECK constraint enforces that they add up.
- **One draft per event.** An identical request returns the existing draft,
  which covers double clicks and concurrent calls.
  - A different draft needs explicit replacement, which inserts a new row and
    marks the old one `replaced` with `replaces_id` provenance.
  - Generation and replacement are audited.
- **Stale terms.** Generation requires the event's active proposal to be
  approved. When a revised offer is sent, a trigger marks that proposal's
  drafts `superseded` in the same transaction.
- **Freezing.** Every contract row is content-immutable from insert, for
  every role including the service role. That covers rendered content,
  commercial and party snapshots, provenance, signer, amounts and hash. Only
  `status` moves, and this step allows only `draft` to `replaced` or
  `superseded`.
  - The `sent`, `signed` and `void` statuses exist for later steps, but no
    transition reaches them yet.
  - Contracts are never deleted, and published template versions they use
    can't be removed.
- **Content hash.** `contracts.content_sha256` is the SHA-256 (hex) of the
  UTF-8 bytes of the canonical Postgres jsonb text of:

  ```
  {"schema_version": 1,
   "content":    rendered_content,     -- title and sections exactly as shown
   "commercial": commercial_snapshot,  -- lines, taxes, totals, deposit, balance, due date, source approval
   "parties":    party_snapshot,       -- business, signer, event, venue
   "template":   {"version_id", "content_sha256"}}
  ```

  The database computes it on insert. Verify it in SQL with
  `private.contract_content_sha256(rendered_content, commercial_snapshot,
  party_snapshot, template_version_id, template_content_sha256)`. It is
  separate from the future hash of signed PDF bytes.
- **Access.** Staff of the tenant can read templates, versions and contracts.
  All writes go through membership-checked functions, except renaming or
  archiving a template. Clients and anonymous users have no access.

### Gear media in Storage

Gear images and videos live in the private `gear-media` bucket. The object
path is `{tenant_id}/gear-items/{gear_item_id}/{random uuid}.{ext}`.

- Staff can upload only under a gear item that belongs to their own tenant.
  They can read only their own tenant's objects.
- No user can update or delete an object, and upserts fail. A sent offer can
  therefore never lose or silently change its media.
- Clients and anonymous users have no direct access. Proposal pages will
  receive short-lived signed URLs from the server after authorization.
- Allowed types are JPEG, PNG, WebP, AVIF, MP4 and WebM, up to 100 MiB. The
  `gear_media` row must agree on path, kind, MIME type and extension.

### Client access

Clients never read `events` directly, because RLS limits rows, not columns.
They call `public.my_events()`, a hardened security definer function that
returns only client-safe columns for events with active access and a verified
email.

`event_access` rows can only be created by trusted server code using the
service role, after magic-link email verification (Phase 2). Staff can revoke
access but not grant it.

## Environment variables

See `.env.example`. Only `NEXT_PUBLIC_*` values reach the browser.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL (public) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key, `sb_publishable_…` (public). The legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is still read as a fallback. A secret or service-role key here is refused at startup. |
| `SUPABASE_SECRET_KEY` | Supabase secret key, `sb_secret_…`. Server only; bypasses RLS. The legacy `SUPABASE_SERVICE_ROLE_KEY` is still read as a fallback. A publishable or anon key here is refused. |
| `NEXT_PUBLIC_APP_URL` | The app's own origin, used in emailed links |
| `PROPOSAL_LINK_SECRET` | Derives proposal link tokens. 32 or more random characters. Rotating it fails undelivered proposal emails visibly; links already delivered keep working. |
| `EMAIL_TRANSPORT` | `mailpit` (local default), `resend` (hosted) or `disabled` (queue only) |
| `EMAIL_FROM_ADDRESS` | Sender address. Emails show "{DJ} via Flux DJ" with the DJ's reply-to address. |
| `MAILPIT_URL` | Local Mailpit, http://127.0.0.1:54324 |
| `RESEND_API_KEY` | Required only with `EMAIL_TRANSPORT=resend` |
| `OUTBOX_WORKER_SECRET` | Bearer secret for `/api/internal/outbox`. The endpoint returns 404 when it isn't set. |

Hosted configuration, still to review before real clients:
- Set every variable above as a server-side environment variable.
- Verify the sending domain in Resend.
- Schedule `/api/internal/outbox` with the worker secret, for example with
  Vercel Cron.
- Check that the platform's proxy sets `X-Forwarded-For`, which rate
  limiting uses.
- The Supabase magic-link template, redirect URLs and the disabled sign-up
  setting also need configuring.

The secret key bypasses RLS. It is read only through
`src/lib/env.server.ts`, which is marked `server-only`, so importing it into
client code fails the build. Never commit `.env.local`.

### Hosted setup

The production order, as followed for the hosted project. Apply migrations
only after reviewing a dry run, and keep the review gates in spec section 12
before real clients.

1. **Check the Supabase GitHub integration first.** With "deploy to
   production" enabled, pushing commits that contain `supabase/migrations`
   applies them to the hosted database. Keep it off until you intend to
   migrate.
2. **Link the CLI.** Run `pnpm exec supabase login`, then
   `pnpm exec supabase link --project-ref <ref>`. Linking records the project
   in `supabase/.temp`, which is git-ignored, and applies nothing.
3. **Inspect only.** `pnpm exec supabase migration list --linked` should
   show every migration as local-only. `pnpm exec supabase db push --dry-run`
   previews the push without applying it.
4. **Configure Auth in the dashboard** rather than with `supabase config push`,
   which would upload the local values, including the `127.0.0.1` URLs:
   - Turn off "Allow new users to sign up". Invited clients are still
     created by trusted server code.
   - Set the Site URL to the production origin.
   - Add `https://<domain>/auth/confirm` to the redirect URLs.
   - Paste `supabase/templates/magic_link.html` into the Magic Link template.
   - Keep the email OTP expiry at 3600 seconds.
   - Configure custom SMTP (Resend). Supabase's built-in mailer is heavily
     rate-limited and meant for testing.
5. **Never run `supabase/seed.sql` on hosted.** It creates DEMO users and
   tenants. `db push` does not seed unless you pass `--include-seed`.
6. **Set Vercel environment variables:**
   - the four from the table above (Supabase URL, publishable key, secret
     key, app URL)
   - a new `PROPOSAL_LINK_SECRET` and `OUTBOX_WORKER_SECRET`, each 32 or more
     random characters, never reused from local
   - `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY` and a verified
     `EMAIL_FROM_ADDRESS`
7. **Schedule the outbox worker.** It also generates signed PDFs (up to 5 per run, before emails, `maxDuration` 60 s; a PDF usually renders in well under 2 s). `vercel.json` runs `/api/internal/outbox`
   every 5 minutes. Vercel cron sends `Authorization: Bearer $CRON_SECRET`, and
   only when a `CRON_SECRET` variable exists. The route accepts exactly
   `Bearer $OUTBOX_WORKER_SECRET`, so set `CRON_SECRET` (Production,
   Sensitive) to the same value as `OUTBOX_WORKER_SECRET`. A mismatch shows as
   404s in the cron logs.
   - Emails still go out immediately after each action. The cron only retries
     and catches up.
   - Schedules more frequent than once a day need a Vercel Pro plan; on Hobby
     the deployment fails.
   - Vercel can occasionally skip or repeat a run, which the outbox tolerates:
     claims skip locked rows, and every email has a dedup key.

Locally verified with the new key formats: service-role RPCs, Auth admin
(`generateLink`), Storage, anon denial, magic-link verification, RLS reads,
the proxy's `getClaims`, the SSR client, and the integration suite through
`SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The local
gateway does not reject secret keys sent from a browser; hosted Supabase
does.

## Project layout

```
docs/                          Product and data specification
src/app/                       Next.js routes (placeholder home page for now)
src/components/ui/             shadcn/ui components
src/lib/env.ts, env.server.ts  Validated public and server-only environment
src/lib/supabase/              Browser, server and admin clients, generated DB types
supabase/migrations/           SQL migrations (source of truth for the schema)
supabase/tests/database/       pgTAP RLS, constraint and Storage policy tests
src/lib/pricing/               Pure pricing module and offer snapshot schema
src/lib/proposals/             Server-only selection pricing and recording
src/app/staff/                 Staff screens and Server Actions
src/app/login, src/app/auth/   Magic-link login and confirmation
src/components/proposal/       Responsive proposal preview (live pricing)
src/lib/media/                 File-signature detection for uploads
src/lib/proposals/             Link tokens and the client proposal session
src/lib/email/                 Email templates, transports (Mailpit/Resend) and outbox worker
src/lib/contracts/             Template text format, rendered-content schema, DEMO template text
src/components/contract/       Readable, escaped contract document view
src/app/staff/[tenant]/contract-templates/  Template list, editor and publishing
src/app/staff/[tenant]/contracts/          Contract generation panel and draft preview
src/app/[tenant]/p/            Link opener and token exchange (public)
src/app/[tenant]/proposals/    Client proposal page (session cookie)
src/app/api/internal/outbox/   Outbox worker endpoint (secret required)
scripts/outbox-worker.mjs      Local worker loop (pnpm outbox:work)
tests/unit/                    Vitest unit tests (pricing, uploads, money)
tests/e2e/                     Playwright browser tests
tests/integration/             Vitest tests against local Supabase (offers, Storage)
supabase/seed.sql              Local-only seed data
```

## Adding a tenant-owned table

1. Add `tenant_id uuid not null`, `unique (tenant_id, id)` and composite
   foreign keys to parents.
2. Add the `set_updated_at` and `forbid_column_changes` triggers.
   Add stable keys and parent references to the immutable list.
3. If a CHECK constraint calls a new function, grant EXECUTE on it to
   `authenticated` and `service_role`. Default privileges deny it, and a
   schema guard test fails if it is missing.
4. Enable RLS and grant only the needed privileges, column by column for
   writes. Catalog-style records get no DELETE; archive them with `active`.
5. Add tests for SELECT, INSERT, UPDATE and DELETE from another tenant, and
   for client and anon access.
6. Run `pnpm db:types` and `pnpm check`.
