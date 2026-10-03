import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { ProposalPreview } from "@/components/proposal/proposal-preview";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { requireStaff } from "@/lib/auth/staff";
import { formatCents } from "@/lib/money";
import { applyTemplate, saveDraft } from "../actions";
import { loadPreview, loadProposal } from "./load";

type DraftOffer = {
  intro?: string | null;
  expiry_days?: number | null;
  packages?: { package_id: string; is_popular: boolean }[];
  addons?: { gear_item_id: string; recommended_quantity: number; max_quantity: number }[];
  question_ids?: string[];
};

export default async function ProposalBuilder({ params, searchParams }: PageProps<"/staff/[tenant]/proposals/[proposalId]">) {
  const { tenant: slug, proposalId } = await params;
  // Set by applyTemplate: remounts the editor so it shows the template's contents.
  // Ordinary saves never change it, so edits typed during a save are kept.
  const { applied } = await searchParams;
  const editorKey = typeof applied === "string" ? `applied-${applied}` : "editor";
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const proposal = await loadProposal(staff, proposalId);
  const frozen = proposal.offer_frozen_at !== null;
  const draft = (proposal.draft_offer ?? {}) as DraftOffer;

  const [{ data: packages }, { data: gear }, { data: questions }, { data: templates }, preview] = await Promise.all([
    supabase.from("packages").select("id, name, base_price_cents, active").eq("tenant_id", tenant.id).order("sort_order"),
    supabase.from("gear_items").select("id, name, default_price_cents, active").eq("tenant_id", tenant.id).order("name"),
    supabase.from("logistics_questions").select("id, prompt, required, active").eq("tenant_id", tenant.id).order("sort_order"),
    supabase.from("proposal_templates").select("id, name").eq("tenant_id", tenant.id).eq("active", true).order("name"),
    loadPreview(staff, proposal.id),
  ]);

  const chosenPackages = draft.packages ?? [];
  const addonByGear = new Map((draft.addons ?? []).map((a) => [a.gear_item_id, a]));
  const asked = new Set(draft.question_ids ?? []);
  // Show active records, plus any inactive record the draft still references (so staff see why it is invalid).
  const packageOptions = (packages ?? [])
    .filter((p) => p.active || chosenPackages.some((c) => c.package_id === p.id))
    .map((p) => ({ value: p.id, label: `${p.name} (${formatCents(p.base_price_cents, tenant.currency)})${p.active ? "" : " — archived"}` }));
  const gearRows = (gear ?? []).filter((g) => g.active || addonByGear.has(g.id));
  const questionRows = (questions ?? []).filter((q) => q.active || asked.has(q.id));
  const popularIndex = chosenPackages.findIndex((p) => p.is_popular);
  const event = proposal.events!;

  return (
    <>
      <PageHeader
        title={`Proposal for ${event.title}`}
        description={
          <>
            <Link className="underline" href={`/staff/${slug}/events/${event.id}`}>Back to event</Link> · revision {proposal.revision} · {event.event_date}
          </>
        }
        actions={
          <>
            <Badge variant="outline">{frozen ? "Offer frozen" : "Draft — not sent"}</Badge>
            <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}/proposals/${proposal.id}/preview`} target="_blank">
              Full-page preview
            </Link>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          {frozen ? (
            <Card>
              <CardContent className="text-sm">This offer is frozen and can no longer be edited.</CardContent>
            </Card>
          ) : (
            <DraftVersionProvider version={proposal.draft_version}>
              <Card>
                <CardHeader>
                  <CardTitle>Start from a template</CardTitle>
                  <CardDescription>Replaces the packages, extras, questions, intro and expiry below.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ActionForm
                    action={applyTemplate.bind(null, slug, proposal.id)}
                    version={proposal.draft_version}
                    navigateOnSuccess={`/staff/${slug}/proposals/${proposal.id}?applied={version}`}
                    submitLabel="Apply template"
                    variant="outline"
                    inline
                  >
                    <SelectField label="Template" name="template_id" options={(templates ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="— choose —" className="min-w-48 flex-1" />
                  </ActionForm>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Offer</CardTitle>
                  <CardDescription>Saved in place as a draft. Saving never sends or freezes the offer.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ActionForm key={editorKey} action={saveDraft.bind(null, slug, proposal.id)} version={proposal.draft_version} submitLabel="Save draft" trackUnsaved>
                    <fieldset className="grid gap-3">
                      <legend className="mb-1 text-sm font-medium">Three packages (exactly one most popular)</legend>
                      {[1, 2, 3].map((n) => (
                        <div key={n} className="grid grid-cols-[1fr_auto] items-end gap-3">
                          <SelectField label={`Package ${n}`} name={`package_${n}`} id={`package_${n}`} defaultValue={chosenPackages[n - 1]?.package_id ?? ""} options={packageOptions} placeholder="— none —" />
                          <label className="flex h-8 items-center gap-1.5 text-sm">
                            <input type="radio" name="popular" value={String(n)} defaultChecked={popularIndex === n - 1} className="size-4 accent-primary" />
                            Most popular
                          </label>
                        </div>
                      ))}
                    </fieldset>
                    <fieldset className="grid gap-2">
                      <legend className="mb-1 text-sm font-medium">Optional extras</legend>
                      {gearRows.map((g) => {
                        const a = addonByGear.get(g.id);
                        return (
                          <div key={g.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b pb-2 text-sm">
                            <label className="flex items-center gap-2">
                              <input type="checkbox" name="addon" value={g.id} defaultChecked={Boolean(a)} className="size-4 accent-primary" />
                              <span>
                                {g.name} {g.active ? null : <span className="text-xs text-destructive">(archived)</span>}
                                <span className="block text-xs text-muted-foreground">{formatCents(g.default_price_cents, tenant.currency)}</span>
                              </span>
                            </label>
                            <label className="flex items-center gap-1 text-xs">Preselect<Input name={`rec:${g.id}`} type="number" min={0} max={100} defaultValue={a?.recommended_quantity ?? 0} className="w-16" /></label>
                            <label className="flex items-center gap-1 text-xs">Max<Input name={`max:${g.id}`} type="number" min={1} max={100} defaultValue={a?.max_quantity ?? 1} className="w-16" /></label>
                          </div>
                        );
                      })}
                    </fieldset>
                    <fieldset className="grid gap-2">
                      <legend className="mb-1 text-sm font-medium">Logistics questions</legend>
                      {questionRows.map((q) => (
                        <label key={q.id} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" name="question" value={q.id} defaultChecked={asked.has(q.id)} className="size-4 accent-primary" />
                          {q.prompt}
                          {q.active ? null : <span className="text-xs text-destructive">(archived)</span>}
                        </label>
                      ))}
                    </fieldset>
                    <TextField label="Offer valid for (days after sending)" name="expiry_days" type="number" min={1} max={365} defaultValue={draft.expiry_days ?? 14} />
                    <TextAreaField label="Intro shown to the client" name="intro" rows={4} maxLength={10000} defaultValue={draft.intro ?? ""} />
                  </ActionForm>
                </CardContent>
              </Card>
            </DraftVersionProvider>
          )}
        </div>

        <Card className="content-start">
          <CardHeader>
            <CardTitle>Client preview</CardTitle>
            <CardDescription>Live pricing with the same engine the server uses. Staff only; nothing is sent.</CardDescription>
          </CardHeader>
          <CardContent>
            {preview.ok ? (
              <ProposalPreview offer={preview.offer} mediaUrls={preview.mediaUrls} event={event} />
            ) : (
              <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                {preview.message}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
