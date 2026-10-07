// Shows which service versions the local Supabase stack is running, next to
// the hosted project's versions that the CLI pins when this repo is linked
// (supabase/.temp/*-version, written by `supabase link`; gitignored). Read
// only: it never edits those files or restarts anything.
//
//   pnpm db:versions          report, and exit 1 if a pinned service differs
//
// `supabase start` uses the pinned versions when the files exist, so after a
// restart local matches hosted. See README, "Local Supabase versions".
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1];
const services = [
  ["PostgREST", "rest", "rest-version"],
  ["Auth", "auth", "gotrue-version"],
  ["Storage", "storage", "storage-version"],
  ["Postgres", "db", "postgres-version"],
];

let running = "";
try {
  running = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"], { encoding: "utf8" });
} catch {
  console.error("Docker isn't reachable: start Docker and the local stack (pnpm db:start).");
  process.exit(1);
}
const image = (name) => running.split("\n").find((l) => l.startsWith(`supabase_${name}_${project}\t`))?.split("\t")[1];
const tag = (img) => img?.split(":").pop();

let mismatch = false;
console.log(`Local stack "${project}"`);
for (const [label, name, file] of services) {
  const pinFile = `supabase/.temp/${file}`;
  const pinned = existsSync(pinFile) ? readFileSync(pinFile, "utf8").trim() : null;
  const now = tag(image(name));
  const differs = Boolean(pinned && now && pinned !== now);
  mismatch ||= differs;
  console.log(
    `  ${label.padEnd(10)} running ${String(now ?? "not running").padEnd(14)} hosted pin ${String(pinned ?? "none (repo not linked)").padEnd(14)}${differs ? "  <- differs" : ""}`,
  );
}
if (mismatch) {
  console.log("\nLocal differs from the hosted versions. A plain `pnpm db:stop && pnpm db:start` restarts on the hosted versions (data is kept).");
  process.exit(1);
}
console.log("\nLocal matches the hosted versions it can see.");
