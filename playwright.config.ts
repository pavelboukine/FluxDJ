import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against the local app and LOCAL Supabase only.
 * Start Supabase first (pnpm db:start). The dev server is reused if running.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    // Failures always keep a screenshot. E2E_SCREENSHOTS=1 keeps one for every
    // test in the run, so review screenshots need no extra run (test-results/).
    screenshot: process.env.E2E_SCREENSHOTS ? "on" : "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
