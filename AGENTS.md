<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Testing workflow

Full commands and rationale: README, "Day-to-day testing". In short:

- Run the narrowest check while implementing: one browser test
  (`pnpm test:e2e tests/e2e/<spec>.ts:<line>`) or one spec, one integration file
  (`pnpm exec vitest run tests/integration/<file>.test.ts --no-file-parallelism`;
  `pnpm test:integration <file>` runs every integration file), `pnpm test:unit`,
  `pnpm db:test` for SQL. After a fix, rerun only what failed (`pnpm test:e2e --last-failed`).
- Individual tasks get focused verification only: `pnpm lint`, `pnpm typecheck`, the
  affected unit tests, and specifically chosen browser/integration specs (or pgTAP
  for SQL). If a serial browser spec needs its earlier tests, run that whole spec,
  not the suite. Add other specs only when a shared change creates a concrete risk,
  and say why.
- Do not run `pnpm check`, the unfiltered `pnpm test:e2e` (≈ 20 min) or
  `pnpm test:integration`, or a local `pnpm build`, unless the user explicitly asks
  for a release checkpoint or the change is broad enough to genuinely need it.
  Always report which broad suites were deferred, and never describe targeted
  checks as a full regression pass.
- Keep failure exit codes and useful output. Don't repeat passing, unchanged tests,
  and never rerun a spec only for screenshots or timings: failures keep screenshots
  and traces in `test-results/`, and `E2E_SCREENSHOTS=1` keeps one for every test in
  a run.
- Don't take screenshots or create screenshot deliverables unless the task asks for
  them; the automatic failure screenshots stay enabled.
- New browser specs sign in with `signInStaff`, `signInWithLink` or
  `verifyContractInvitation` from `tests/e2e/support.ts`, never through the `/login`
  or invitation forms. Those forms and their per-IP limits belong to `staff-flow` and
  `contract-send-flow` only. They share the limits with the developer's own browser,
  so never reset rate-limit counters and never raise limits.
- Fixtures stay in their own `e2e-…`/`it-…` tenants and are archived even on failure
  (`archiveTestTenant`, `archiveTestTenants`). A test that needs a PDF claims its own
  contract's job; it never drains other jobs. Never touch the BOUPROD or Other DJ tenants.
- Keep Playwright at one worker.
- Long runs: redirect output to a file and read that file while the run continues.
  Don't pipe through `tail` (it shows nothing until the end) or through `grep`/`tee`
  without `pipefail` (it hides failures). Full browser suite ≈ 20 min, integration
  ≈ 1–2 min, pgTAP ≈ 12 s: check progress every 30–60 s and schedule no fallback
  wakeup much longer than the expected run time.
- `pnpm build` is safe while `pnpm dev` runs (separate `.next/dev` output).
