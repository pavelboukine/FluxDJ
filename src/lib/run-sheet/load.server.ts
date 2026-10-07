import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EVENT_TYPES } from "@/app/staff/[tenant]/events/event-form";
import { answersKey } from "@/lib/planning/basics";
import { staffPlanningViewSchema } from "@/lib/planning/view";
import type { Database } from "@/lib/supabase/database.types";
import { buildRunSheet, type RunSheet } from "./model";

export type LoadedRunSheet = { sheet: RunSheet; revision: string };

/**
 * Loads the run sheet with the staff member's own session, so row-level
 * security and the planning functions decide access (members of the event's
 * business only; archived events stay readable for staff history).
 *
 * The plan is read by one staff_planning_view call: a single STABLE
 * function, so every answer, revision and song link comes from the same
 * database snapshot even while someone is saving. The event row supplies the
 * header and the venue that "same as the event venue" refers to.
 *
 * revision: a short fingerprint of the content (not the time), so two
 * exports differ exactly when the saved plan or event details differ.
 */
export async function loadRunSheet(supabase: SupabaseClient<Database>, tenant: { id: string; display_name: string }, eventId: string): Promise<LoadedRunSheet | null> {
  const [{ data: event }, { data: brand }] = await Promise.all([
    supabase
      .from("events")
      .select("title, event_type, event_date, timezone, venue_name, venue_address, archived_at, booking_confirmed_at, lifecycle_status")
      .eq("id", eventId)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    supabase.from("tenants").select("display_name, brand_colors").eq("id", tenant.id).maybeSingle(),
  ]);
  if (!event || !brand) return null;
  const { data, error } = await supabase.rpc("staff_planning_view", { p_event_id: eventId });
  if (error) return null;
  const view = staffPlanningViewSchema.parse(data);
  const sheet = buildRunSheet({
    business: { display_name: brand.display_name, brand_colors: (brand.brand_colors ?? {}) as Record<string, unknown> },
    event,
    view,
    eventTypeLabel: new Map<string, string>(EVENT_TYPES).get(event.event_type) ?? "Event",
  });
  const { asOf: _asOf, editing: _editing, ...content } = sheet;
  void _asOf;
  void _editing;
  const revision = createHash("sha256").update(answersKey(content as unknown as Record<string, unknown>)).digest("hex").slice(0, 8).toUpperCase();
  return { sheet, revision };
}

/** "run-sheet-noam-justin-wedding-2026-10-30.pdf": ASCII only, safe in a header. */
export function runSheetFileName(title: string, date: string): string {
  const slug = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "event";
  return `run-sheet-${slug}-${/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "undated"}.pdf`;
}
