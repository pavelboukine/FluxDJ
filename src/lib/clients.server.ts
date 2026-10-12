import "server-only";
import type { StaffContext } from "@/lib/auth/staff";

/*
 * Reads behind client management. Every query runs as the signed-in staff
 * member (RLS: their own business only, never a removed member or a
 * suspended workspace) and is also filtered by the business's id, so a
 * duplicate check or impact count never looks at another DJ's clients.
 */

type Db = StaffContext["supabase"];

/** A LIKE pattern matching `value` exactly, case-insensitively (wildcards escaped). */
const exactly = (value: string) => value.replace(/[\\%_]/g, "\\$&");

/** Another client of this business with the same email (any case), archived ones included. */
export async function findClientWithEmail(db: Db, tenantId: string, email: string, exceptId?: string) {
  let query = db.from("clients").select("id, name, archived_at").eq("tenant_id", tenantId).ilike("email", exactly(email)).order("created_at").limit(1);
  if (exceptId) query = query.neq("id", exceptId);
  const { data } = await query;
  return data?.[0] ?? null;
}

/** The confirmation shown when an email already belongs to another client. Never merges anything. */
export function duplicateEmailWarning(slug: string, email: string, existing: { id: string; name: string; archived_at: string | null }) {
  return {
    message: `${existing.name}${existing.archived_at ? " (archived)" : ""} already uses ${email}. Use that client instead, or confirm that this is a different person who shares the address.`,
    link: { href: `/staff/${slug}/clients/${existing.id}`, label: "Open existing client" },
    confirm: { name: "confirm_duplicate", label: `Save anyway as a separate client with ${email} (nothing is merged).` },
  };
}

/**
 * What a client's email is already tied to. Changing the address moves none
 * of it: event access stays with the person who signed in (an Auth user,
 * not an address), a sent contract only accepts the address frozen into it,
 * and proposal links are bearer links that keep working until they expire
 * or are replaced.
 */
export async function emailChangeImpact(db: Db, tenantId: string, clientId: string) {
  const now = new Date().toISOString();
  const [access, contracts, links] = await Promise.all([
    db.from("event_access").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("client_id", clientId).is("revoked_at", null),
    db.from("contracts").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("signer_client_id", clientId).eq("status", "sent"),
    db.from("access_links").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("intended_client_id", clientId).eq("purpose", "proposal").is("revoked_at", null).gt("expires_at", now),
  ]);
  return { signIns: access.count ?? 0, sentContracts: contracts.count ?? 0, proposalLinks: links.count ?? 0 };
}

export type EmailImpact = Awaited<ReturnType<typeof emailChangeImpact>>;

export const hasEmailImpact = (i: EmailImpact) => i.signIns + i.sentContracts + i.proposalLinks > 0;

/** Plain-language consequences of changing an email that's already in use. */
export function emailImpactText(i: EmailImpact, oldEmail: string): string {
  const parts = ["Changing the contact email doesn't revoke or move anything already sent."];
  if (i.sentContracts > 0) parts.push(`The signer of ${i.sentContracts === 1 ? "the contract already sent" : "contracts already sent"} stays ${oldEmail}; to send to the new address, void and generate a new contract.`);
  if (i.proposalLinks > 0) parts.push("Proposal links already emailed keep working as before until they expire or are replaced.");
  if (i.signIns > 0) parts.push(`Anyone already signed in as ${oldEmail} keeps their current access.`);
  parts.push("New proposals and contracts go to the new address. Signed contracts don't change.");
  return parts.join(" ");
}

/**
 * Whether the business's contract templates print the client's phone: a
 * published version, usable for contracts, of an active template uses
 * {{client.phone}}. Generation then refuses a signer without a phone
 * (generate_contract_draft requires a value for every placeholder used).
 */
export async function contractsUseClientPhone(db: Db, tenantId: string): Promise<boolean> {
  const { data } = await db
    .from("contract_template_versions")
    .select("id, contract_templates!contract_template_versions_template_fk!inner(active)")
    .eq("tenant_id", tenantId)
    .not("published_at", "is", null)
    .neq("usage", "legacy")
    .eq("contract_templates.active", true)
    .contains("placeholders", ["client.phone"])
    .limit(1);
  return (data?.length ?? 0) > 0;
}
