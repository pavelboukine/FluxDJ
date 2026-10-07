import type { NextRequest } from "next/server";
import { privateError } from "@/lib/contracts/pdf-response.server";
import { UUID_RE } from "@/lib/forms";
import { loadRunSheet, runSheetFileName } from "@/lib/run-sheet/load.server";
import { renderRunSheetPdf } from "@/lib/run-sheet/render.server";
import { createClient } from "@/lib/supabase/server";

/**
 * Staff download of the run sheet PDF, generated on demand from the latest
 * saved plan and streamed: nothing is stored, no URL outlives the request.
 * Authorization is rechecked here with the staff member's own session (row
 * level security and the planning functions): signed-out visitors, clients
 * and other businesses get 404. Archived events stay available to staff.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/staff/[tenant]/events/[eventId]/run-sheet/pdf">) {
  const { tenant: slug, eventId } = await ctx.params;
  if (!UUID_RE.test(eventId)) return privateError(404, "Not found.");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return privateError(404, "Not found.");
  const { data: tenant } = await supabase.from("tenants").select("id, display_name").eq("slug", slug).maybeSingle();
  if (!tenant) return privateError(404, "Not found.");
  const { data: membership } = await supabase.from("tenant_memberships").select("id").eq("tenant_id", tenant.id).eq("user_id", auth.user.id).maybeSingle();
  if (!membership) return privateError(404, "Not found.");
  const loaded = await loadRunSheet(supabase, tenant, eventId);
  if (!loaded) return privateError(404, "Not found.");
  let bytes: Buffer;
  try {
    bytes = await renderRunSheetPdf(loaded.sheet, loaded.revision);
  } catch {
    return privateError(500, "The run sheet PDF couldn't be generated. Try again, or use the live run sheet.");
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${runSheetFileName(loaded.sheet.event.title, loaded.sheet.event.date)}"`,
      "X-Run-Sheet-Revision": loaded.revision,
    },
  });
}
