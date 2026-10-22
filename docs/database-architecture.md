# Flux DJ database architecture

A map of the current database for developers and coding agents: what is
authoritative, how the parts fit, where each business rule lives, and how to
change it safely. It describes the schema as of migration
`20261123000100_platform_operations`. Per-feature behaviour is in the README
("How tenant isolation works" onwards, and the table of pgTAP files);
releasing a migration is in [`operations.md`](operations.md), section 2.

PostgreSQL is the authority for tenant isolation, authorization, lifecycle
transitions, money, contracts and immutable snapshots. The app validates early
for clearer messages and checks what the database sends back
([TypeScript types and Zod schemas](#typescript-types-and-zod-schemas)), but it
never decides any of these on its own.

## Files and what they are

| File | Role | Edited by hand? |
|---|---|---|
| `supabase/migrations/*.sql` | **The source of truth.** Forward-only, applied in file-name order. Many functions are redefined by later migrations (`create or replace`). | New files only. Never change a migration that has been applied to production. |
| `supabase/schema-snapshot.sql` | The current `public` and `private` schemas, dumped from a local database with every migration applied (`pnpm db:schema`). A reading aid: the quickest way to see a function's or table's **current** definition. Storage policies are not in it (they live in the migrations). | Never. Regenerate it. |
| `src/lib/supabase/database.types.ts` | Generated TypeScript types for tables, views and function arguments and results (`pnpm db:types`). | Never. Regenerate it. |
| `supabase/tests/database/*.test.sql` | pgTAP tests against the real local database, with real roles and RLS (`pnpm db:test`). | Yes. |
| `supabase/seed.sql` | Local-only DEMO data (the BOUPROD and Other DJ tenants). | Yes. Never run on the hosted project. |

CI (`.github/workflows/ci.yml`, "Database tests") replays every migration on a
fresh local database, runs `pnpm db:lint`, pgTAP and the integration tests,
then `pnpm db:schema:check`. That check fails when the committed snapshot or
the generated types differ from what the migrations produce.

## Changing the schema

1. Add a new migration (`supabase/migrations/<timestamp>_<name>.sql`) and apply
   it locally: `pnpm exec supabase migration up --local`.
2. Redefine a function with its complete current body. Start from the
   snapshot's definition, not an older migration's.
3. Keep it backward compatible. Production gets the migration **before** the
   app, so the deployed code must keep working against the new schema. That
   includes the JSON shape of any function result the app validates (see
   below).
4. Grant explicitly. Default privileges deny everything. A new function used
   in a CHECK constraint needs EXECUTE for `authenticated` and `service_role`
   (a schema guard test fails otherwise). See the README, "Adding a
   tenant-owned table".
5. Test: add pgTAP coverage, then run `pnpm db:lint`, the affected pgTAP and
   integration files, and `pnpm typecheck`.
6. Regenerate and commit with the migration: `pnpm db:types` and
   `pnpm db:schema`. If nothing in the schema changed, don't regenerate.
7. Release as in `operations.md`, section 2. Applying a migration to
   production needs explicit authorization.

To check drift at any time: `pnpm db:schema:check` (exit 1 and a diff when
stale). To replay every migration from scratch without touching your working
database, use a throwaway second stack (`operations.md`, section 6).

## Finding a function's current definition and history

- **Current definition:** search the snapshot for
  `CREATE OR REPLACE FUNCTION "private"."plan_progress"(` (schema and name
  quoted). Or ask the local database:
  `select pg_get_functiondef('private.plan_progress'::regproc);`
- **History:** every migration that (re)defines it, oldest first:

  ```sh
  grep -li 'function private.plan_progress(' supabase/migrations/*.sql | sort
  ```

  The last file is the current body. Pipe through `sort`: shell glob order
  isn't reliable here. Some functions are redefined many times
  (`private.planning_library` 8 times, `public.client_planning_view` 7,
  `private.plan_progress` 6).
- **Overloads:** a few names have more than one signature (for example
  `private.contract_deposit_cents(bigint)` and `(bigint, integer)`, and two
  `publish_contract_template_version`). Match the full argument list.
- **Why it changed:** `git log --oneline -- <migration>` gives the commit;
  `git log -S'<a distinctive line>' -- supabase/migrations` finds when a rule
  appeared.

## Domains

50 tables: 48 in `public` (all with RLS enabled) and 2 in `private`
(`rate_limit_counters` and `worker_heartbeats`, which no API role can reach).
Almost every table carries `tenant_id`.

| Domain | Tables | Notes |
|---|---|---|
| Businesses and people | `tenants`, `tenant_memberships`, `tenant_logos`, `staff_invitations`, `clients` | A tenant is one DJ business (`slug` is its web address). Memberships are `owner` or `staff`, removed by setting `removed_at`. |
| Platform | `platform_admins`, `platform_invitations`, `platform_audit_events` | Administrators are granted only by the database owner (`private.grant_platform_admin`), never by the app or the service role. |
| Catalog | `gear_categories`, `gear_items`, `gear_media`, `packages`, `package_items`, `package_media`, `logistics_questions`, `logistics_rules`, `proposal_templates`, `proposal_template_packages`, `proposal_template_addons`, `proposal_template_questions` | Live, editable, archived rather than deleted. Never read for pricing once an offer is frozen. |
| Events | `events`, `event_clients`, `event_access`, `access_links`, `event_billing`, `event_payments` | `event_clients` links clients (one primary contact, one signer). `event_access` is a verified client's access to one event. |
| Proposals | `proposals`, `proposal_sessions`, `proposal_views`, `proposal_selection_drafts`, `proposal_selections`, `proposal_selection_lines`, `proposal_approvals` | `proposals.offer_snapshot` is the frozen offer (`offer_sha256`). A selection is the client's priced choice, verified against it. |
| Contracts | `contract_templates`, `contract_template_versions`, `contracts`, `contract_signatures`, `contract_documents`, `document_jobs` | A contract freezes rendered content, commercial and party snapshots, and the content hash at generation. |
| Planning | `planning_templates`, `planning_template_items`, `event_plans`, `event_plan_items`, `event_plan_responses`, `event_plan_imports`, `planning_invitations` | One plan per booked event, built from a template. Answers are normalized by `private.normalize_plan_*` and scored by `private.plan_progress`. |
| Communication and audit | `email_outbox`, `audit_events` | Durable outbox (below). Audit rows are written by functions, never by the app. |

## Tenant isolation and authorization

- **Composite keys.** Tenant-owned tables expose `unique (tenant_id, id)`.
  Children reference parents through `(tenant_id, parent_id)`, so no row can
  point into another tenant. `private.forbid_column_changes` triggers make
  ids, `tenant_id` and parent references immutable for every role.
- **Staff.** RLS policies exist only for `authenticated` staff: rows where
  `tenant_id in (select private.member_tenant_ids())` (active memberships of
  unsuspended tenants). Staff write the catalog, clients, events and event
  contacts directly, within column grants and guard triggers. Anything with
  a lifecycle, money, contracts, invitations, planning or settings goes
  through
  `SECURITY DEFINER` functions, which call `private.require_staff_of(tenant)`
  or `private.require_owner_of(tenant)` first. Those tables are read-only
  to staff.
- **Clients have no table policies.** Everything a client sees comes from
  `SECURITY DEFINER` functions granted to `authenticated` (`my_events`,
  `my_contracts`, `client_contract_view`, `client_payment_summary`,
  `client_approved_offer`, `client_planning_view`, …). They decide access
  with `private.client_event_ids()` (unrevoked `event_access`, verified email,
  unsuspended tenant) and, for contracts, `private.signer_can_access_contract`
  (the contract's intended signer only). Each returns an explicit projection
  that leaves out staff-only fields.
- **Anonymous proposal links.** `anon` has no grants. The proposal link flow
  uses service-role-only functions (`exchange_proposal_link`,
  `client_proposal_view`, `client_save_selection_draft`,
  `client_submit_selection`), called by server code with a hashed session
  token. The functions re-resolve the session on every call.
- **Service role only.** Besides the proposal functions: signing
  (`sign_contract`), the email and PDF workers (`claim_*`, `complete_*`,
  `fail_*`, `cancel_email_outbox`, `commit_contract_document`, `freeze_*`),
  sign-in requests (`request_*_sign_in`), rate limiting
  (`consume_rate_limit`), logos (`register_tenant_logo`,
  `tenant_logo_details`), branding for public pages (`public_tenant_brand`),
  provider events and the worker record (`record_email_provider_event`,
  `record_worker_run`). The grants are in the snapshot
  (`GRANT ALL ON FUNCTION … TO "service_role"`).
- **Suspension and archiving.** `private.tenant_write_guard` refuses every
  write to a suspended tenant's rows (`PT423`), for every role. Suspension
  columns change only through `suspend_workspace` and `restore_workspace`
  (platform administrators). `events.archived_at` (set only by
  `set_event_archived`) blocks sends, approvals, contract generation and
  client sessions. It is not a lifecycle status.
- **Platform administrators** (`private.is_platform_admin`: a
  `platform_admins` row and a verified email) can manage invitations and
  suspension and read Platform Operations
  (`platform_operations_summary`, `platform_email_issues`,
  `platform_document_issues`: each failed or overdue email or PDF by
  business, with an error summary but no recipient or content). Nothing
  gives them a business's clients, events or contracts.

## Lifecycles: who may change what

Status columns change only through named functions. Triggers enforce the
allowed transitions, and some transitions also require a transaction-local
flag that only the owning function sets (`set_config('flux.…', id, true)`).

| Record | States | Allowed moves (trigger) | Owned by |
|---|---|---|---|
| Proposal | `draft`, `sent`, `submitted`, `approved`, `expired`, `superseded`, `declined` | draft → sent → submitted → approved; sent or submitted → superseded or declined; sent → expired; approved → superseded (`private.proposals_status_transition`) | `send_proposal` freezes the offer (`private.proposals_freeze_once`). `client_submit_selection`, `approve_proposal_selection`. A sent revision supersedes the previous one. |
| Selection | immutable once stored | — | `client_submit_selection` → `private.insert_selection_submission`. Then `private.verify_proposal_selection` (deferred trigger) recomputes lines, discount, taxes and totals against the frozen offer. |
| Contract | `draft`, `replaced`, `superseded`, `sent`, `signed`, `void` | draft → replaced, superseded or sent; sent → void or signed (`private.contracts_status_transition`) | `generate_contract_draft` (freezes content and money), `send_contract` (flag `flux.sending_contract`), `sign_contract` (flag `flux.signing_contract`; stores the signature and evidence in the same transaction), `void_contract`. |
| Event | `lead`, `pending_approval`, `awaiting_signature`, `awaiting_deposit`, `booked`, `completed`, `cancelled` | a booked event never goes back; `booking_confirmed_at` is set once (`private.events_booking_guard`) | `private.evaluate_booking` (flag `flux.booking_event`), run by `sign_contract`, `record_event_payment` and `check_event_booking` under the contract's frozen `booking_policy`. |
| Payment | recorded, or invalidated with a reason | rows are never deleted | `record_event_payment` (idempotency key), `invalidate_event_payment` (flag `flux.invalidating_payment`). Totals come only from `private.event_payment_summary`. |

Money is integer cents throughout. Deposits are
`private.contract_deposit_cents` (half-up). Discounts are
`private.offer_discount_cents` (half-up on basis points), allocated to lines
by largest remainder. Taxes are per line and per tax, half-up, on the
discounted amounts. The rounding policy is documented in
`src/lib/pricing/tax.ts` and `discount.ts`, which price the browser preview.
The database re-verifies every submitted selection. A contract's figures are
frozen when it is generated and never recomputed.

## Durable work: emails and signed PDFs

- **`email_outbox`** (`pending` → `sending` → `sent`, or `failed` or
  `cancelled`). Rows are queued inside the business transaction that causes
  them (`private.enqueue_*`). Workers claim them with a lease
  (`claim_email_outbox`, `claim_staff_email_outbox`,
  `claim_planning_email_outbox`, `claim_platform_email_outbox`), recheck at
  dispatch (`email_outbox_dispatch_allowed`), freeze the sender and branding
  at the first attempt, and finish with `complete_email_outbox` or
  `fail_email_outbox` (retries back off exponentially, at most an hour
  apart). Sends use an idempotency key, so
  a retried send is delivered once.
- **`document_jobs`** (`pending`, `running`, `succeeded`, `failed`). Signing
  queues a signed-PDF job in the same transaction. The worker claims it under
  a renewable lease (`claim_document_jobs`) and commits the one canonical
  document (`commit_contract_document`), which queues the signed copies.
- **The worker** is `/api/internal/outbox` (Vercel Cron every 5 minutes;
  `pnpm outbox:work` locally): PDFs first, then emails. It records each run
  (`record_worker_run` → `private.worker_heartbeats`), which Platform →
  Operations and the external heartbeat read. Recovery steps are in
  `operations.md`, section 3.

## TypeScript types and Zod schemas

- **Generated types** cover tables and function arguments. Functions that
  return `jsonb` are typed only as `Json`, so their shape is a contract the
  generator can't check.
- **Validated at the boundary.** Where the app shows money, contract or
  booking state, or acts on a result, it parses the JSON with Zod before use
  (`src/lib/db-response.ts`). These boundaries are:
  - `client_contract_view`, `sign_contract`, `review_contract_for_send` and
    `generate_contract_draft` (`src/lib/contracts/responses.ts`);
  - `client_approved_offer` (the same file, with the offer and selection
    schemas);
  - `event_payment_summary`, `client_payment_summary` and a contract's frozen
    discount breakdown (`src/lib/payments.ts`);
  - `client_proposal_view` and the selection save and submit results
    (`src/lib/proposals/client-session.server.ts`);
  - frozen offers (`src/lib/pricing/offer-snapshot.ts`) and stored priced
    selections (`src/lib/pricing/selection-record.ts`);
  - signed-PDF data, from the contract and signature rows
    (`src/lib/contracts/pdf/data.ts`).

  A failed parse is logged once (`category: "data"`, with the function name
  and field paths, never values). The caller then shows nothing, an error
  page or a retryable error. It never substitutes figures. Fields the app
  only displays (an event's lifecycle status, for example) stay lenient, so
  an additive migration doesn't break the deployed app.
- **Changing a validated JSON shape** therefore needs the same care as a
  column change. Add fields freely (unknown fields are dropped). Never remove
  or retype a field the deployed schema requires. When the meaning changes,
  ship an app that accepts both shapes first. `tests/integration/db-responses.test.ts`
  parses the real local database's answers with these schemas, so CI catches
  drift between a migration and the schemas.
- **Rules enforced on both sides.** Some database checks are repeated in the
  app for an earlier, field-level message: https links, phone numbers,
  contact and account emails, keys, playlist duplicates, rule conditions,
  discount rounding, draft discount limits and tax settings. The expected
  answers are one shared table (`tests/support/rule-cases.ts`). The app's
  functions (`tests/unit/rule-parity.test.ts`) and the real database functions
  (`tests/integration/rule-parity.test.ts`) are both tested against it. When
  you change one side, change the cases and the other side together. Where
  the app is deliberately different, the case says why. It may be stricter
  about input, or more lenient about data it reads back, but never the other
  way round.
- **Rules only the database knows.** Deposits, booking evaluation, payment
  totals, planning progress and deadlines, contract send eligibility and
  slugs have no copy in the app. The app shows what the database returns.
