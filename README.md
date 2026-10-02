# Flux DJ

Branded proposal, contract and event planning portal for independent DJs.
The source of truth for scope and behavior is [docs/Flux-DJ-V1-Spec.md](docs/Flux-DJ-V1-Spec.md).

**Current status: Phase 1, steps 1 to 3.** The stack is scaffolded and the
data foundation is in place:

- Tenancy: tenants, memberships, clients, events, event contacts and event access.
- Catalog: gear items with private image/video media, packages with included
  gear, logistics questions with constrained rules, and reusable proposal
  templates.

Everything has row-level security and tests. Sent proposals, pricing,
snapshots, contracts, planning and all screens are not built yet.

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

BOUPROD also gets a **demo catalog**: five gear items, three packages
(Essential, Signature, Premium), four logistics questions with three rules,
and a "Wedding (DEMO)" template. Every record is tagged DEMO. Prices and
wording are placeholders that Pavel has not reviewed. The catalog mirrors
the spec's pricing example, where separate ceremony and cocktail spaces each
require an additional-location speaker. No media files are seeded.

The client `client@couple.example` has verified access to the BOUPROD event
only. Seeded users have no passwords. Login is magic-link only, and the login
screens arrive in Phase 2.

## Running the checks

```bash
pnpm check
```

This runs, in order:

| Step | Command | Needs Docker |
|---|---|---|
| ESLint | `pnpm lint` | No |
| TypeScript | `pnpm typecheck` | No |
| Postgres schema lint | `pnpm db:lint` | Yes |
| Database tests (pgTAP) | `pnpm db:test` | Yes |
| Storage API integration tests | `pnpm test:integration` | Yes, with the Storage service running |

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
| `09_storage_gear_media` | Storage policies on the `gear-media` bucket: private bucket, tenant-scoped reads, uploads only under the uploader's own gear items, no overwrite or delete |

`_catalog_fixtures.psql` adds catalog rows and Storage objects for both test
tenants.

### Storage integration tests

`tests/integration/storage-gear-media.test.mts` runs through the real Storage
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
tests/integration/             Storage HTTP API tests against local Supabase
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
