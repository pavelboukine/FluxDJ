/**
 * Grants and revokes platform administration on the LOCAL database, through
 * the same SQL functions as the hosted one-time grant (README, "DJ
 * invitations"). The app, the API and the service role cannot grant it, so
 * this runs psql in the local Supabase container, like
 * tests/integration/support/sql.ts (which browser specs can't import: it
 * loads server-only modules). The email is bound as a psql variable, never
 * spliced into SQL.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function localDbContainer(): string {
  const id = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1];
  if (!id) throw new Error("No project_id in supabase/config.toml");
  return `supabase_db_${id}`;
}

function localPsql(text: string, email: string) {
  if (!/^[a-z0-9-]+@example\.test$/.test(email)) throw new Error("Only throwaway @example.test operators are granted by tests");
  execFileSync("docker", ["exec", "-i", localDbContainer(), "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-v", `email=${email}`], {
    input: text,
    stdio: ["pipe", "ignore", "pipe"],
  });
}

export function grantPlatformAdminLocally(email: string) {
  localPsql("select private.grant_platform_admin(:'email', 'Local test operator');", email);
}

export function revokePlatformAdminLocally(email: string) {
  localPsql("select private.revoke_platform_admin(:'email');", email);
}
