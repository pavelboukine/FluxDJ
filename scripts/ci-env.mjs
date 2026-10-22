// Writes .env.local for CI from the LOCAL Supabase stack, so integration and
// browser tests run server code with the same configuration as `pnpm dev`.
// Only for a fresh checkout (GitHub Actions): it refuses a non-local stack and
// never overwrites an existing .env.local. Values come from `supabase status`
// (local keys only) and fresh random secrets; only variable names are printed.
//
//   node scripts/ci-env.mjs
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env.local")) {
  console.error(".env.local already exists; this script only creates it in a fresh checkout (CI). Nothing was changed.");
  process.exit(1);
}

const status = JSON.parse(
  execFileSync("node_modules/.bin/supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
);
const host = new URL(status.API_URL).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  console.error("Refusing to configure a non-local Supabase stack.");
  process.exit(1);
}
for (const key of ["API_URL", "PUBLISHABLE_KEY", "SECRET_KEY"]) {
  if (!status[key]) {
    console.error(`supabase status has no ${key}; is the local stack running?`);
    process.exit(1);
  }
}

const secret = () => randomBytes(32).toString("base64url");
const env = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
  SUPABASE_SECRET_KEY: status.SECRET_KEY,
  PROPOSAL_LINK_SECRET: secret(),
  OUTBOX_WORKER_SECRET: secret(),
  EMAIL_TRANSPORT: "mailpit",
  EMAIL_FROM_ADDRESS: "proposals@fluxdj.local",
  MAILPIT_URL: status.MAILPIT_URL || status.INBUCKET_URL || "http://127.0.0.1:54324",
};
writeFileSync(".env.local", Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
console.log(`Wrote .env.local for the local stack: ${Object.keys(env).join(", ")}`);
