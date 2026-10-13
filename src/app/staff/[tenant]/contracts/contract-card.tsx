import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Disclosure } from "@/components/app/disclosure";
import type { StaffContext } from "@/lib/auth/staff";
import { CONTRACT_STATUS_LABEL } from "@/lib/contracts/content";
import { dateIn, shortInstant } from "@/lib/dates";
import { SIGNING_MODE_LABELS, USAGE_LABELS, type SigningMode, type TemplateUsage } from "@/lib/contracts/usage";
import { GenerateContractPanel } from "./generate-panel";

/** Ends a sentence after a formatted time without doubling the period of "p.m.". */
const sentence = (text: string) => (text.endsWith(".") ? text : `${text}.`);

/** The event and signer details a contract froze when it was generated (party_snapshot), for spotting later edits. */
export type FrozenDetails = { title: string | null; date: string | null; venueName: string | null; venueAddress: string | null; clientPhone: string | null };

function frozenDetails(snapshot: unknown): FrozenDetails | null {
  const s = snapshot as { event?: Record<string, unknown>; client?: Record<string, unknown> } | null;
  if (!s?.event) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return { title: str(s.event.title), date: str(s.event.date), venueName: str(s.event.venue_name), venueAddress: str(s.event.venue_address), clientPhone: str(s.client?.phone) };
}

/**
 * The event's contracts and the template versions a draft can be generated
 * from, read once by the event page. Times are shown in the event's time
 * zone (the server's own zone is UTC in production).
 */
export async function loadContracts(staff: StaffContext, eventId: string) {
  const { supabase, tenant } = staff;
  const [{ data: versions }, { data: contracts }, { data: event }] = await Promise.all([
    supabase
      .from("contract_template_versions")
      .select("id, version_number, placeholders, published_at, usage, contract_templates!contract_template_versions_template_fk(name, active)")
      .eq("tenant_id", tenant.id)
      .not("published_at", "is", null)
      .order("version_number", { ascending: false }),
    supabase
      .from("contracts")
      .select("id, status, created_at, signed_at, signing_mode, template_version_id, balance_due_date, party_snapshot, contract_template_versions!contracts_template_version_fk(version_number, contract_templates!contract_template_versions_template_fk(name))")
      .eq("tenant_id", tenant.id)
      .eq("event_id", eventId)
      .order("created_at", { ascending: false }),
    supabase.from("events").select("event_date, timezone").eq("tenant_id", tenant.id).eq("id", eventId).maybeSingle(),
  ]);
  const timeZone = event?.timezone ?? tenant.timezone;
  const fmt = (iso: string) => shortInstant(iso, timeZone);
  // The remaining balance is usually due on the event day: the default for a new draft, unless that day has passed
  // (the database refuses a past date). A calendar date, compared in the event's own zone, so never shifted.
  const suggestedBalanceDueDate = event && event.event_date >= dateIn(timeZone, new Date()) ? event.event_date : null;
  const activeAll = (versions ?? []).filter((v) => v.contract_templates?.active);
  // Versions published before usage modes can't be used (the database refuses them too).
  const active = activeAll.filter((v) => v.usage !== "legacy");
  // Default to the most recently published version; staff may choose another.
  const latest = active.reduce<(typeof active)[number] | null>((a, v) => (!a || (v.published_at ?? "") > (a.published_at ?? "") ? v : a), null);
  const options = active
    .sort((a, b) => (a.contract_templates!.name.localeCompare(b.contract_templates!.name) || b.version_number - a.version_number))
    .map((v) => ({
      id: v.id,
      label: `${v.contract_templates!.name} · version ${v.version_number} · ${USAGE_LABELS[v.usage as TemplateUsage]}${v.id === latest?.id ? " (latest published)" : ""}`,
      needsBalanceDueDate: v.placeholders.includes("payment.balance_due_date"),
      needsClientPhone: v.placeholders.includes("client.phone"),
    }));
  const rows = (contracts ?? []).map((c) => ({
    id: c.id,
    status: c.status,
    signing_mode: c.signing_mode,
    created_at: c.created_at,
    signed_at: c.signed_at,
    balance_due_date: c.balance_due_date,
    label: `${c.contract_template_versions?.contract_templates?.name ?? "Contract"} v${c.contract_template_versions?.version_number ?? "?"}, generated ${fmt(c.created_at)}`,
    frozen: c.status === "draft" || c.status === "sent" ? frozenDetails(c.party_snapshot) : null,
  }));
  return { contracts: rows, options, defaultVersionId: latest?.id ?? null, legacyHidden: activeAll.length - active.length, suggestedBalanceDueDate, fmt };
}

/**
 * The event's contract: the current one (signed, sent or draft) first, with
 * generation from the current approval when nothing is sent or signed, and
 * older drafts, replaced, superseded and void contracts in a history
 * disclosure. Staff only.
 */
export function ContractCard({
  slug,
  approvalId,
  data,
  signer = null,
  changes = [],
}: {
  slug: string;
  approvalId: string | null;
  data: Awaited<ReturnType<typeof loadContracts>>;
  /** The event's active signer, for adding a missing phone number in place. */
  signer?: { clientId: string; name: string; phone: string | null } | null;
  /** Event or signer details edited since the current draft or sent contract froze them. */
  changes?: string[];
}) {
  const { contracts, options, defaultVersionId, legacyHidden, suggestedBalanceDueDate, fmt } = data;
  const draft = contracts.find((c) => c.status === "draft");
  const sent = contracts.find((c) => c.status === "sent");
  const signed = contracts.find((c) => c.status === "signed");
  const current = signed ?? sent ?? draft ?? null;
  const history = contracts.filter((c) => c !== current);
  const href = (id: string) => `/staff/${slug}/contracts/${id}`;

  return (
    <Card id="contract" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Contract</CardTitle>
        <CardDescription>Generated from the approved selection. Generating a draft sends nothing; signing doesn&apos;t book the event by itself.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {signed ? (
          <p role="status">
            <Link className="font-medium underline" href={href(signed.id)}>{signed.label}</Link> was signed {sentence(fmt(signed.signed_at!))} A signed
            contract can&apos;t be voided, replaced or revised. Its signed copy is on the contract page.
          </p>
        ) : sent ? (
          <p role="status">
            <Link className="font-medium underline" href={href(sent.id)}>{sent.label}</Link> was sent and is waiting for the client&apos;s signature.
            To change it, void it on its page, then generate a replacement here.
            {changes.length > 0 ? (
              <span className="mt-1 block text-amber-800 dark:text-amber-300" data-testid="contract-changes">
                Changed since it was sent: {changes.join(", ")}. The sent contract keeps the earlier details.
              </span>
            ) : null}
          </p>
        ) : approvalId ? (
          <GenerateContractPanel
            slug={slug}
            approvalId={approvalId}
            versions={options}
            defaultVersionId={defaultVersionId}
            currentDraft={draft ? { id: draft.id, label: draft.label, signable: draft.signing_mode !== "none", balanceDueDate: draft.balance_due_date } : null}
            suggestedBalanceDueDate={suggestedBalanceDueDate}
            legacyHidden={legacyHidden}
            signer={signer}
            changes={draft ? changes : []}
          />
        ) : draft ? (
          <p>
            <Link className="font-medium underline" href={href(draft.id)}>{draft.label}</Link> is a draft. The proposal it came from is no longer the
            current approval.
          </p>
        ) : (
          <p className="text-muted-foreground">A contract can be generated once the current proposal is approved.</p>
        )}
        {history.length > 0 ? (
          <Disclosure id="contract-history" summary={`Contract history (${history.length})`}>
            <ul className="grid gap-1">
              {history.map((c) => (
                <li key={c.id}>
                  <Link className="underline" href={href(c.id)}>{c.label}</Link>
                  <span className="text-muted-foreground"> · {CONTRACT_STATUS_LABEL[c.status] ?? c.status} · {SIGNING_MODE_LABELS[c.signing_mode as SigningMode]}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The contract card with its own read, for pages that show it alone (the approved proposal). */
export async function LoadedContractCard({ staff, slug, eventId, approvalId }: { staff: StaffContext; slug: string; eventId: string; approvalId: string | null }) {
  const [data, { data: link }] = await Promise.all([
    loadContracts(staff, eventId),
    staff.supabase.from("event_clients").select("clients(id, name, phone, archived_at)").eq("tenant_id", staff.tenant.id).eq("event_id", eventId).eq("can_sign", true).maybeSingle(),
  ]);
  const c = link?.clients && !link.clients.archived_at ? link.clients : null;
  return <ContractCard slug={slug} approvalId={approvalId} data={data} signer={c ? { clientId: c.id, name: c.name, phone: c.phone } : null} />;
}
