import type { NextRequest } from "next/server";
import { privateError, verifiedPdfResponse } from "@/lib/contracts/pdf-response.server";
import { UUID_RE } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";

/**
 * Staff download of a signed PDF. Authorization is row-level security with
 * the staff member's own session: the tenant must be one they belong to and
 * the document must belong to it. Archived events stay downloadable for
 * staff (history is preserved); other tenants get 404.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/staff/[tenant]/contracts/[contractId]/signed-pdf">) {
  const { tenant: slug, contractId } = await ctx.params;
  if (!UUID_RE.test(contractId)) return privateError(404, "Not found.");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return privateError(404, "Not found.");
  const { data: tenant } = await supabase.from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (!tenant) return privateError(404, "Not found.");
  const { data: membership } = await supabase.from("tenant_memberships").select("id").eq("tenant_id", tenant.id).eq("user_id", auth.user.id).maybeSingle();
  if (!membership) return privateError(404, "Not found.");
  const { data: doc } = await supabase
    .from("contract_documents")
    .select("storage_path, pdf_sha256, byte_size, contracts!contract_documents_contract_fk(party_snapshot)")
    .eq("tenant_id", tenant.id)
    .eq("contract_id", contractId)
    .eq("kind", "signed_contract")
    .maybeSingle();
  if (!doc) return privateError(404, "Not found.");
  const event = ((doc.contracts as { party_snapshot?: { event?: { title?: string; date?: string } } } | null)?.party_snapshot?.event) ?? {};
  return verifiedPdfResponse(doc, event.title ?? "agreement", event.date ?? "");
}
