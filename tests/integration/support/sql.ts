/**
 * Trusted SQL on the LOCAL database, through psql in the local Supabase
 * container (no Postgres driver is installed). For what the API can't do on
 * purpose: holding a row lock in another session to force a race, and moving
 * a test event's stored deadline as time passing would. Only for rows of the
 * test's own tenants.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { localStatus } from "./fixtures";

function container(): string {
  localStatus(); // refuses a non-local stack
  const id = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1];
  if (!id) throw new Error("No project_id in supabase/config.toml");
  return `supabase_db_${id}`;
}

const args = () => ["exec", "-i", container(), "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"];

/** Runs SQL and returns its output. */
export function sql(text: string): string {
  return execFileSync("docker", args(), { input: text, encoding: "utf8" }).trim();
}

/** Runs SQL in a separate session without waiting; resolves with its output when it ends. */
export function sqlInBackground(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args());
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `psql exited ${code}`))));
    child.stdin.end(text);
  });
}

/** A uuid literal, validated (these helpers only ever take generated ids). */
export function uuid(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Not a uuid: ${id}`);
  return `'${id}'::uuid`;
}
