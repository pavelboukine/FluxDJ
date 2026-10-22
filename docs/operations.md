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
  emails now. If part of the run hit a database problem, it says so; the
  rest was still processed.
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
  unset).
- **500:** the run hit a database problem after doing everything else it
  could. The causes are:
  - the PDF worker failed as a whole;
  - an email category couldn't be claimed (DJ, staff or planning invitations,
    or business emails), so that category sent nothing this run;
  - an email was accepted by the provider but couldn't be recorded as sent.

  The function log has a structured line for each (`"category":"worker"`, see
  section 5), naming the category, row id and error code, never addresses,
  links or contents. The JSON body lists the same `problems`. A failed single
  email or PDF doesn't fail the run; it shows on its row and in Platform →
  Operations.
- HTTP 200 only means the worker had no worker-level problem. Single emails can
  still be retrying (pending, with attempts) or failed (every attempt used, or
  refused). Check them on the business's Emails page or in Platform →
  Operations.
- An email counted as `unconfirmed` was handed to the provider but couldn't be
  recorded. Its row stays `sending` until the lease ends (2 minutes), then is
  claimed again. Emails with an idempotency key (everything except sign-in
  emails) are dropped by Resend as a repeat within 24 hours. A sign-in email
  can arrive twice; the newest link is the one that works. On the row's last
  attempt it is marked failed with "delivery did not complete", and staff
  see "may have been delivered, check before retrying". This was already the
  case before Batch 7C, for example after a worker crash. Check Resend's log
  before retrying.
- Everything in a keyed email is frozen on its row at the first attempt
  (sender name and address, reply-to, branding, content), so renaming the
  business or changing its reply-to doesn't change a retry.
- A failed email whose staff explanation says "An earlier attempt may already
  have been delivered" got `Resend 409 invalid_idempotent_request`. Resend
  processed an earlier request under this row's key with different content
  and refuses the repeat for 24 hours. It isn't retried automatically. Check
  Resend's log: the earlier attempt usually arrived. A staff retry within the
  24 hours gets the same refusal; after them it sends a new copy. A 409
  `concurrent_idempotent_requests` is an ordinary, automatically retried
  failure.
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

## 5. Monitoring and alerts

### Platform → Operations

`/platform/operations` is for platform administrators only (the same grant as
DJ invitations and Workspaces); everyone else gets a 404. It's read-only and
covers every business:

- **Scheduled worker:** its last recorded run (the cron route writes one row,
  `private.worker_heartbeats`, at the end of every run).
  - *Running:* the last run, under 15 minutes ago, had no worker-level problem.
  - *Last run failed:* a database problem; the function logs name it.
  - *Not running:* no run has finished for 15 minutes (three intervals).
  - *No run recorded:* nothing written yet; expect a run within 5 minutes of
    the first deploy with this record.
- **Counts:**
  - *Failed emails:* every attempt used, or refused, in the last 30 days, from
    active businesses and platform emails. Of these, *possibly delivered* are
    an attempt that never finished, or the provider refusing a changed repeat:
    check Resend's log before retrying them.
  - *Overdue emails:* what the worker should already have claimed, more than
    15 minutes past due.
  - *Retrying:* normal and automatic; no action needed.
  - *Failed PDFs* and *overdue PDFs:* the same, for signed-contract PDF jobs.
- **Lists:** the 50 newest email and PDF issues. Each shows its id, business,
  category, state, attempts and time, never recipients, links or contents.
  The error is a fixed sentence chosen in the database. The worker's own known
  messages are named; a provider refusal shows only its HTTP status and fixed
  code; anything else reads "unexpected error". The raw text never leaves the
  database; read it with the SQL checks in section 3 when needed.

Retrying stays where it was, on the business's Emails page or contract page.
There are no cross-business retry or cancel controls.

Archived businesses send nothing on purpose, so their emails are never shown
as failed or overdue. Suspended businesses' emails are cancelled by the
suspension, and their PDF jobs wait for restoration.

### Application errors in the logs

Every unexpected server error (a page, route handler, server action or the
proxy, through `src/instrumentation.ts`) and every worker-level failure
writes one JSON line to the Vercel function logs:

```json
{"source":"flux-dj","ts":"…","level":"error","category":"request","operation":"POST /staff/[tenant]/emails (action)","code":"2847561093","detail":"TypeError"}
```

- `category`: `request`, `worker`, `email`, `pdf`, `monitoring` or `data`.
  `data` means a database function returned JSON that failed the app's
  validation (`src/lib/db-response.ts`): `operation` names the function and
  `detail` lists the failing field paths and issue codes, never values. The
  app showed or did nothing with that response. Usually a migration and the
  deployed code disagree about a response's shape; see
  `docs/database-architecture.md`, "TypeScript types and Zod schemas".
- `code`: a database code, HTTP status, error class or Next.js digest. A digest
  matches the "Digest" on the error page the visitor saw.
- `id`: only a row, job or contract id.
- Request errors log the error's **class only, never its message**: an
  unexpected message can quote a name or a database value that no redaction
  reliably removes. Worker failures log only their fixed problem list
  (category, row id, code). Free text is also redacted (email addresses,
  URLs, token-like strings, credentials, long numbers). Request paths, query
  strings, headers, cookies and bodies are never logged.
- The message and stack are in Next.js's own error line in the same logs (the
  framework prints it). Find it by the digest. Treat those lines as
  potentially containing client data.
- Not logged: validation and permission refusals (returned, not thrown),
  redirects and not-found, a visitor leaving mid-response, and single emails
  or PDFs failing and retrying. Those keep their state in the database.
  React can report one failure twice; it's logged once per server instance
  per minute.

In Vercel → the project → Logs, search `"source":"flux-dj"`, then filter on
`"level":"error"` or a `category`.

### Alerts

**Nothing alerts yet.** The code is ready; the steps below are manual and
unverified until you complete them.

1. **Worker heartbeat (recommended, free): Healthchecks.io.** It alerts by its
   own email, independent of Flux's outbox and Resend.
   1. Create an account and a check named "Flux DJ outbox cron": period
      **5 minutes**, grace **15 minutes**. Confirm the plan's limits at
      signup; the free tier was enough for this when checked.
   2. Copy its ping URL (`https://hc-ping.com/<uuid>`).
   3. In Vercel → Settings → Environment Variables, add
      `MONITOR_HEARTBEAT_URL` with that URL (Production, Sensitive), then
      redeploy.
   4. Check: within 5 minutes the check turns "up". The Operations page shows
      "Running".

   Each run pings the URL (success) or `<url>/fail` (a worker-level problem),
   with counts only in the body. Healthchecks alerts once when runs **stop**
   (the cron is disabled, deploys fail, the secret is wrong) or **fail**, and
   once when they recover, so an outage is one alert, not hundreds. Better
   Stack heartbeats accept the same URLs. An invalid or `http:` URL disables
   the ping (logged as a `monitoring` warning); it never affects the run.
2. **Application exceptions (recommended next step): Sentry**, free Developer
   plan. This isn't installed: it adds `@sentry/nextjs` and its build
   configuration, and needs an account and `SENTRY_DSN`. The single place to
   add it is `onRequestError` in `src/instrumentation.ts` and `logEvent` in
   `src/lib/observability.ts`, with the same redaction. Until then,
   exceptions are only in the Vercel logs. **Confirm** whether your Vercel
   plan offers log-based alerts or a log drain.

**What should alert:**
- the worker not running, or failing (heartbeat);
- repeated unexpected server errors (Sentry, once added).

**What shouldn't:** an empty queue, a single retried email, expected
invitation or sign-in refusals, permission denials, redirects, visitors
leaving mid-page.

**Not pushed as alerts yet:** failed emails or PDFs that need a decision. Check
Platform → Operations, for example weekly. A daily digest would be a future
improvement.

## 6. Local CI environment

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
