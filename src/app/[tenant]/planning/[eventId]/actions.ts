"use server";

import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { saveResultSchema, type SaveItemResult } from "@/lib/planning/view";
import { createClient } from "@/lib/supabase/server";

/*
 * Client planning actions. Every argument is untrusted: access comes only
 * from the signed-in user's own session, rechecked in the database on every
 * call (verified event access, booked, not archived, item visible).
 */

export async function saveClientItemAction(slug: string, eventId: string, itemId: string, expectedRevision: number, answers: unknown): Promise<SaveItemResult> {
  if (
    typeof slug !== "string" || !SLUG_PATTERN.test(slug) || typeof eventId !== "string" || !UUID_RE.test(eventId) ||
    typeof itemId !== "string" || !UUID_RE.test(itemId) ||
    !Number.isInteger(expectedRevision) || typeof answers !== "object" || answers === null || Array.isArray(answers)
  ) {
    return { status: "invalid", field: null, message: "Reload the page and try again." };
  }
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { status: "signed_out" };
  const { data, error } = await supabase.rpc("client_save_plan_item", {
    p_event_id: eventId,
    p_tenant_slug: slug,
    p_item_id: itemId,
    p_expected_revision: expectedRevision,
    p_answers: JSON.parse(JSON.stringify(answers)),
  });
  if (error) return { status: "error", message: "Couldn't save. Try again. Your answers are still here." };
  const parsed = saveResultSchema.safeParse(data);
  return parsed.success ? parsed.data : { status: "error", message: "Couldn't save. Reload the page and try again." };
}
