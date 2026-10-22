# Flux DJ operations

How changes reach production and how to respond when something goes wrong.
Setup details live in the README ("Hosted setup", "Environment variables").

Markers used below:
- **Verified**: confirmed from this repository or read-only GitHub queries.
- **Confirm**: a production setting this repository can't show; check it in
  the provider's dashboard before relying on it.

Production: **https://fluxdj.com** (also https://fluxdj-nine.vercel.app).
https://fluxdj.vercel.app belongs to someone else; never use it to check a
deploy.

## 1. Normal application release

1. Work on a feature branch. Locally run what the change touches (see
   AGENTS.md, "Testing workflow"): `pnpm lint`, `pnpm typecheck`, the
   affected unit tests, and the affected pgTAP or integration files.
2. Push the branch and open a pull request into `main`.
   - Vercel builds a **Preview** deployment of the branch. **Confirm** which
     environment variables Preview uses (Vercel → Settings → Environment
     Variables). If Preview shares Production's Supabase keys, unmerged code
     runs against production data.
3. GitHub Actions runs **CI** (`.github/workflows/ci.yml`). Both required
   checks must pass:
   - **App checks**: lint, typecheck, unit tests.
   - **Database tests**: a fresh local Supabase with every migration, then
     database lint, pgTAP and the integration tests.

   **Browser smoke** (`.github/workflows/browser-smoke.yml`) runs as well. It
   isn't required until it has proved reliable.
4. Review the diff, then merge. Vercel deploys `main` to Production
   (**Verified**: production deployments are created by `vercel[bot]` from
   `main`). CI runs again on `main` after the merge.
5. Check that Production serves the exact commit:

   ```sh
   gh api "repos/pavelboukine/FluxDJ/deployments?sha=<full sha>&environment=Production" --jq '.[0].id'
   gh api repos/pavelboukine/FluxDJ/deployments/<id>/statuses --jq '.[0] | {state, target_url}'
   ```

   `state` must be `success`. The page HTML of https://fluxdj.com contains
   the `dpl_…` id that ends the status's `target_url`.
6. Read-only production smoke test: open fluxdj.com and `/login`. Sign in as
   staff and open the dashboard, one event and its planning page. Change
   nothing. Then look at Vercel → the project → Logs for new errors.

## 2. Database migrations

Migrations are forward-only and never run automatically: CI applies them only
to its own throwaway local database. **Confirm** that the Supabase GitHub
integration's "deploy to production" is still off (README, "Hosted setup",
step 1).

1. **Test locally.** `pnpm exec supabase migration up --local` applies it to
   your local database without a reset. Add or adjust pgTAP tests, then run
   `pnpm db:lint`, the affected pgTAP files and the integration files. CI
   then replays every migration on a fresh database.
2. **Check backward compatibility.** The code currently in production must
   keep working on the migrated database, because the database changes first.
   Prefer additive changes (new columns, tables and functions; new arguments
   with defaults). Remove or rename only in a later release, once no deployed
   code uses the old form.
3. **Apply to production first**, with explicit authorization:

   ```sh
   pnpm exec supabase migration list --linked   # only the new migration is local-only
   pnpm exec supabase db push --linked --dry-run
   pnpm exec supabase db push --linked
   ```

   For a before/after check: `pnpm exec supabase db dump --linked --schema public,private -f <file>`
   (read-only) before and after the push, then diff the two files.
4. **Confirm the history.** Run `migration list --linked` again: local and
   remote now list the same migrations.
5. **Deploy the compatible application code** (section 1).
6. **Verify production** (section 1, steps 5 and 6).

Never run `supabase/seed.sql` on the hosted project: it creates DEMO users and
businesses.

## 3. Recovery

### Which commit is deployed?

```sh
gh api "repos/pavelboukine/FluxDJ/deployments?environment=Production" --jq '.[0] | {sha, created_at}'
```

The Vercel dashboard (project → Deployments) shows the same thing, with the
current Production deployment marked.

### A failed Vercel deployment

The commit's status on GitHub links to the build (`target_url`). In Vercel:
project → Deployments → the failed one → Build Logs. A failed build never
replaces the current Production deployment, so the site stays on the last
good build.

### Rolling back application code

In Vercel: project → Deployments → the last good Production deployment →
**Instant Rollback** (or "Promote to Production"). This changes which build is
served; it doesn't change Git. Then revert the bad commit on `main` through a
pull request, so the next deploy doesn't bring the bug back.

**Confirm** in the dashboard which rollback options your Vercel plan offers.

**A rollback never reverses a migration.** The database keeps every applied
migration, so the older build has to work against the newer schema. That is
why migrations go first and stay backward compatible. To undo a schema
change, write a new forward migration and follow section 2.

### Failed emails

Every email is a row in `email_outbox`, with status `pending`, `sending`,
`sent`, `failed` or `cancelled`, the attempt count and `last_error`.

- **Per business:** Staff → Emails (`/staff/<business>/emails`) lists the last
  100 emails. Rows needing attention are flagged.
- **Retry:** use **Retry** on a failed email there. It's safe:
  `retry_email_outbox` re-queues only a failed row, with three more attempts.
  Each email has a dedup key, so retrying never creates a second email for the
  same business event. **Process queue** delivers that business's queued
  emails now.
- **Across businesses** (read-only, Supabase dashboard → SQL editor):

  ```sql
  select status, event_type, count(*) from public.email_outbox
  where status in ('failed', 'pending', 'sending') group by 1, 2 order by 1, 2;
  ```

  Rows stuck in `pending` with an old `next_attempt_at` mean the worker isn't
  running (see "Outbox cron failures" below).
- **Provider delivery:** only "Delivered" confirms the recipient's server
  accepted the email. That needs the Resend webhook (**Confirm**
  `RESEND_WEBHOOK_SECRET`; README, "Hosted setup", step 9). Resend's dashboard
  shows bounces and suppressions.

### Failed contract PDFs

Signing queues one `document_jobs` row per signed contract (`pending`,
`running`, `succeeded`, `failed`). The PDF renders right after signing and
again on each worker run.

- The staff contract page (`/staff/<business>/contracts/<id>`) shows the PDF
  state, attempts and last error.
- **Generate signed PDF** there re-queues a failed job with three more
  attempts (`request_signed_contract_pdf`). Nothing is emailed until a PDF
  exists. Copies are sent with **Send signed copies**.
- The signature and signed contract are never affected by a PDF failure.
- Across businesses (read-only):

  ```sql
  select status, attempts, last_error, updated_at from public.document_jobs
  where status <> 'succeeded' order by updated_at desc;
  ```

### Outbox cron failures

`vercel.json` calls `/api/internal/outbox` every 5 minutes. It renders up to 5
PDFs, then sends up to 50 emails. Emails also go out right after each action;
the cron retries failures and catches up on anything missed.

- Vercel → project → Settings → Cron Jobs shows the schedule and recent
  runs. Logs → filter on `/api/internal/outbox` shows each call's status.
- **404:** `CRON_SECRET` doesn't equal `OUTBOX_WORKER_SECRET` (or the latter is
  unset). **500:** the main email claim failed.
- Known limitation, to fix in Phase 7C: a PDF-worker error is reported only
  inside a 200 response (`"documents": {"error": true}`), and a failing
  platform, staff or planning invitation claim is skipped silently. Until
  then, use the SQL checks above when emails or PDFs seem late.
- **Confirm**: a schedule more often than daily needs a Vercel Pro plan.

### Backups and point-in-time recovery

Nothing in this repository configures or verifies database backups.
**Confirm** in Supabase → Project Settings / Database → Backups:

- whether daily backups exist and how long they're kept (this depends on the
  plan);
- whether Point-in-Time Recovery is enabled (a paid add-on);
- that a restore has been tried at least once, ideally into a separate
  project.

Supabase backups cover the database. **Confirm** separately how Storage
(signatures, signed PDFs, logos, gear media) is backed up, if at all. Record
the answers here once checked.

## 4. Local CI environment

CI uses the repository's own scripts and a local Supabase stack on the
runner:

- `.github/actions/setup`: pnpm from `packageManager`, Node.js 24,
  `pnpm install --frozen-lockfile`.
- `.github/actions/local-supabase`: pins the hosted service versions
  (PostgREST, Auth, Storage, Postgres), runs `supabase start` (every
  migration plus the local seed), then `scripts/ci-env.mjs` writes
  `.env.local` from `supabase status` with fresh random secrets.

The tests refuse any non-local Supabase. CI holds no secrets and never
contacts a hosted project. When the hosted versions change (`pnpm db:versions`
shows a difference), update the pins in `.github/actions/local-supabase/action.yml`.
