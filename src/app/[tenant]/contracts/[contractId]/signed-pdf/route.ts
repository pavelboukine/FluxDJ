import type { NextRequest } from "next/server";
import { privateError, verifiedPdfResponse } from "@/lib/contracts/pdf-response.server";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";

/**
 * The signer's signed PDF. Every request rechecks, in the database, the
 * verified identity, the signer match, live event access and that the event
 * and business are not archived (client_signed_document), then streams the
 * bytes after a hash check. Anyone else gets the same 404.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/[tenant]/contracts/[contractId]/signed-pdf">) {
  const { tenant: slug, contractId } = await ctx.params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(contractId)) return privateError(404, "Not found.");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return privateError(404, "Not found.");
  const { data } = await supabase.rpc("client_signed_document", { p_contract_id: contractId, p_tenant_slug: slug });
  const doc = data as { storage_path: string; pdf_sha256: string; byte_size: number; event_title: string; event_date: string } | null;
  if (!doc) return privateError(404, "Not found.");
  return verifiedPdfResponse(doc, doc.event_title, doc.event_date);
}
