/**
 * Trusted SQL on the LOCAL database for browser specs, through psql in the
 * local Supabase container (like tests/integration/support/sql.ts, which
 * browser specs can't import). Only for what the app refuses on purpose,
 * such as placing a test event's stored planning deadline as time passing
 * would. Every id is validated before it reaches SQL; only rows of the
 * spec's own e2e tenants are touched.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function container(): string {
  const id = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1];
  if (!id) throw new Error("No project_id in supabase/config.toml");
  return `supabase_db_${id}`;
}

function run(text: string): string {
  return execFileSync("docker", ["exec", "-i", container(), "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"], {
    input: text,
    encoding: "utf8",
  }).trim();
}

const uuid = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error(`Not a uuid: ${id}`);
  return `'${id}'::uuid`;
};

/** Books a test event as private.evaluate_booking does (which also sets up its plan). */
export function bookLocally(eventId: string) {
  run(`select set_config('flux.booking_event', ${uuid(eventId)}::text, false);
       update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = ${uuid(eventId)};`);
}

/** Places a booked test event's client planning deadline (and reopening) relative to now, in whole hours. */
export function placePlanningDeadline(eventId: string, hoursFromNow: number, reopenHoursFromNow: number | null = null) {
  if (!Number.isInteger(hoursFromNow) || (reopenHoursFromNow !== null && !Number.isInteger(reopenHoursFromNow))) throw new Error("hours must be integers");
  run(`select private.set_plan_cutoff_columns(${uuid(eventId)}, now() + interval '${hoursFromNow} hours',
         ${reopenHoursFromNow === null ? "null" : `now() + interval '${reopenHoursFromNow} hours'`});`);
}

/** Leaves a test event signed and waiting for its deposit, for screens that only display that state (rules: pgTAP 36). */
export function markAwaitingDepositLocally(eventId: string) {
  run(`set session_replication_role = replica;
       update public.events set lifecycle_status = 'awaiting_deposit' where id = ${uuid(eventId)};`);
}
