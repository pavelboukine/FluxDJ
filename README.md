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

Everything has row-level security and tests. Not built yet: sending
contracts, signing, signed PDFs, client login, booking confirmation, payments
and planning. Approval and contract drafts are not bookings.

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

Everything above touches only the local Docker database. This repo is not
linked to a hosted Supabase project. Do not run `supabase link` or
`supabase db push` without a deliberate deployment review (spec section 12).

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
3. Click **Publish…**, then **Publish version 1**. The version is now
   read-only. **Start draft version 2** copies it into a new editable draft.
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
- **Sending is not built.** **Send contract** is disabled until verified
  client onboarding exists. No contract is marked sent, and no link or email
  is created. `renderContractEmail` is prepared and unit-tested, but nothing
  queues it.

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

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. It is read only through
`src/lib/env.server.ts`, which is marked `server-only`, so importing it into
client code fails the build. Never commit `.env.local`.

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
