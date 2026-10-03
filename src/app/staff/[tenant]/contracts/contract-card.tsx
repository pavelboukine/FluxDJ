import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StaffContext } from "@/lib/auth/staff";
import { CONTRACT_STATUS_LABEL } from "@/lib/contracts/content";
import { GenerateContractPanel } from "./generate-panel";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** Contract drafts for an event, and generation from its current approval. Staff only. */
export async function ContractCard({ staff, slug, eventId, approvalId }: { staff: StaffContext; slug: string; eventId: string; approvalId: string | null }) {
  const { supabase, tenant } = staff;
  const [{ data: versions }, { data: contracts }] = await Promise.all([
    supabase
      .from("contract_template_versions")
      .select("id, version_number, placeholders, contract_templates!contract_template_versions_template_fk(name, active)")
      .eq("tenant_id", tenant.id)
      .not("published_at", "is", null)
      .order("version_number", { ascending: false }),
    supabase
      .from("contracts")
      .select("id, status, created_at, template_version_id, contract_template_versions!contracts_template_version_fk(version_number, contract_templates!contract_template_versions_template_fk(name))")
      .eq("tenant_id", tenant.id)
      .eq("event_id", eventId)
      .order("created_at", { ascending: false }),
  ]);
  const options = (versions ?? [])
    .filter((v) => v.contract_templates?.active)
    .sort((a, b) => (a.contract_templates!.name.localeCompare(b.contract_templates!.name) || b.version_number - a.version_number))
    .map((v) => ({
      id: v.id,
      label: `${v.contract_templates!.name} · version ${v.version_number}`,
      needsBalanceDueDate: v.placeholders.includes("payment.balance_due_date"),
    }));
  const label = (c: NonNullable<typeof contracts>[number]) =>
    `${c.contract_template_versions?.contract_templates?.name ?? "Contract"} v${c.contract_template_versions?.version_number ?? "?"}, generated ${fmt(c.created_at)}`;
  const draft = (contracts ?? []).find((c) => c.status === "draft");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract</CardTitle>
        <CardDescription>
          Generated from the approved selection and a published template version. Generating a draft sends nothing, does not book the
          event and gives the client no access. Sending and signing are not built yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {approvalId ? (
          <GenerateContractPanel slug={slug} approvalId={approvalId} versions={options} currentDraft={draft ? { id: draft.id, label: label(draft) } : null} />
        ) : (
          <p className="text-sm text-muted-foreground">A contract can be generated once the current proposal is approved.</p>
        )}
        {(contracts ?? []).length > 0 ? (
          <ul className="grid gap-1 text-sm">
            {contracts!.map((c) => (
              <li key={c.id}>
                <Link className="underline" href={`/staff/${slug}/contracts/${c.id}`}>{label(c)}</Link>
                <span className="text-muted-foreground"> · {CONTRACT_STATUS_LABEL[c.status] ?? c.status}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
