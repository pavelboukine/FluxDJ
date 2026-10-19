import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, SelectField } from "@/components/app/fields";
import { ProposalPreview } from "@/components/proposal/proposal-preview";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { TaxSetupLink } from "@/components/app/tax-setup-link";
import { requireStaff } from "@/lib/auth/staff";
import { loadGearChoices } from "@/lib/catalog/gear-choices.server";
import { applyTemplate, saveDraft } from "../actions";
import { loadPreview, loadProposal, staffMediaBase } from "./load";
import { DraftOfferProvider, LivePreview, OfferEditor, type DraftOfferInput } from "./offer-editor";
import { SendPanel } from "./send-panel";
import { SentProposalView } from "./sent-view";

type DraftOffer = Partial<DraftOfferInput>;

const REPLACES =
  "Applying a template replaces the packages, add-ons, questions, intro and expiry with the template's. Custom prices stay for the packages and gear the template also offers. The discount stays.";

export default async function ProposalBuilder({ params, searchParams }: PageProps<"/staff/[tenant]/proposals/[proposalId]">) {
  const { tenant: slug, proposalId } = await params;
  // Set by applyTemplate: remounts the editor so it shows the template's contents.
  // Ordinary saves never change it, so edits typed during a save are kept.
  const { applied } = await searchParams;
  const editorKey = typeof applied === "string" ? `applied-${applied}` : "editor";
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const proposal = await loadProposal(staff, proposalId);
  if (proposal.status !== "draft") return <SentProposalView staff={staff} slug={slug} proposalId={proposal.id} />;
  const frozen = proposal.offer_frozen_at !== null;
  const draft = (proposal.draft_offer ?? {}) as DraftOffer;
  const addonIds = (draft.addons ?? []).map((a) => a.gear_item_id);
  const overrideIds = (draft.price_overrides ?? []).flatMap((o) => ("gear_item_id" in o ? [o.gear_item_id] : []));

  const [{ data: packages }, { choices: gear }, { data: questions }, { data: templates }, preview] = await Promise.all([
    supabase.from("packages").select("id, name, base_price_cents, active").eq("tenant_id", tenant.id).order("sort_order"),
    // Active gear plus anything the draft still references (archived gear is shown, flagged, never dropped).
    loadGearChoices(staff, [...new Set([...addonIds, ...overrideIds])]),
    supabase
      .from("logistics_questions")
      .select("id, prompt, active, sort_order, logistics_rules(gear_item_id, active)")
      .eq("tenant_id", tenant.id)
      .order("sort_order"),
    supabase.from("proposal_templates").select("id, name, active").eq("tenant_id", tenant.id).order("name"),
    loadPreview(staff, proposal.id),
  ]);
  const { data: primary } = await supabase
    .from("event_clients")
    .select("clients(name, email, archived_at)")
    .eq("event_id", proposal.event_id)
    .eq("is_primary", true)
    .maybeSingle();
  const recipient = primary?.clients && !primary.clients.archived_at ? { name: primary.clients.name, email: primary.clients.email } : null;

  const chosenPackages = draft.packages ?? [];
  const event = proposal.events!;
  const activeTemplates = (templates ?? []).filter((t) => t.active);
  const sourceTemplate = (templates ?? []).find((t) => t.id === (draft.template_id ?? proposal.source_template_id));
  // A draft that already has contents (from a template, a previous revision or
  // earlier edits) opens straight into editing; a template is then a deliberate change.
  const started = Boolean(draft.template_id) || chosenPackages.length > 0 || (draft.addons ?? []).length > 0 || (draft.question_ids ?? []).length > 0;
  const initial: DraftOfferInput = {
    template_id: draft.template_id ?? null,
    intro: draft.intro ?? null,
    expiry_days: draft.expiry_days ?? 14,
    packages: chosenPackages,
    addons: draft.addons ?? [],
    question_ids: draft.question_ids ?? [],
    price_overrides: draft.price_overrides ?? [],
    ...(draft.discount ? { discount: draft.discount } : {}),
  };
  const templateForm = (
    <ActionForm
      action={applyTemplate.bind(null, slug, proposal.id)}
      version={proposal.draft_version}
      navigateOnSuccess={`/staff/${slug}/proposals/${proposal.id}?applied={version}`}
      confirmIfUnsaved={`${REPLACES} Your unsaved changes will be lost. Continue?`}
      confirm={started ? `${REPLACES} Continue?` : undefined}
      submitLabel="Apply template"
      variant="outline"
      inline
    >
      <SelectField label="Template" name="template_id" options={activeTemplates.map((t) => ({ value: t.id, label: t.name }))} placeholder="— choose —" className="min-w-48 flex-1" />
    </ActionForm>
  );

  return (
    <>
      <PageHeader
        title={`Proposal for ${event.title}`}
        description={
          <>
            <Link className="underline" href={`/staff/${slug}/events/${event.id}`}>Back to event</Link> · revision {proposal.revision} · {event.event_date}
            {sourceTemplate ? <> · from template {sourceTemplate.name}</> : null}
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

      <DraftVersionProvider version={proposal.draft_version}>
        <DraftOfferProvider>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-6">
              {frozen ? (
                <Card>
                  <CardContent className="text-sm">This offer is frozen and can no longer be edited.</CardContent>
                </Card>
              ) : (
                <>
                  {started ? null : (
                    <Card>
                      <CardHeader>
                        <CardTitle>Start from a template</CardTitle>
                        <CardDescription>Fills in the packages, add-ons, questions, intro and expiry below. Or choose them yourself.</CardDescription>
                      </CardHeader>
                      <CardContent>{templateForm}</CardContent>
                    </Card>
                  )}
                  <Card>
                    <CardHeader>
                      <CardTitle>Offer</CardTitle>
                      <CardDescription>Saved in place as a draft. Saving never sends or freezes the offer.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ActionForm key={editorKey} action={saveDraft.bind(null, slug, proposal.id)} version={proposal.draft_version} submitLabel="Save draft" trackUnsaved>
                        <OfferEditor
                          currency={tenant.currency}
                          packages={(packages ?? []).map((p) => ({ id: p.id, name: p.name, priceCents: p.base_price_cents, active: p.active }))}
                          gear={gear}
                          questions={(questions ?? []).map((q) => ({
                            id: q.id,
                            prompt: q.prompt,
                            active: q.active,
                            ruleGearIds: [...new Set(q.logistics_rules.filter((r) => r.active).map((r) => r.gear_item_id))],
                          }))}
                          initial={initial}
                        />
                      </ActionForm>
                    </CardContent>
                  </Card>
                  {started ? (
                    // A plain disclosure (not Disclosure, which isolates its forms) so applying sees the editor's unsaved changes.
                    <details id="change-template" className="group/template rounded-lg border">
                      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium outline-none select-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/template:rotate-90" />
                        <span className="min-w-0 flex-1">Change template</span>
                        {sourceTemplate ? <span className="text-xs font-normal text-muted-foreground">Started from {sourceTemplate.name}</span> : null}
                      </summary>
                      <div className="grid gap-3 border-t p-3">
                        <p className="text-sm text-muted-foreground">{REPLACES} Nothing changes until you apply one.</p>
                        {templateForm}
                      </div>
                    </details>
                  ) : null}
                  <Card>
                    <CardHeader>
                      <CardTitle>Send to client</CardTitle>
                      <CardDescription>Freezes the saved offer and emails a private link to the primary contact.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <SendPanel
                        slug={slug}
                        proposalId={proposal.id}
                        version={proposal.draft_version}
                        revision={proposal.revision}
                        recipient={recipient}
                        event={{ title: event.title, event_date: event.event_date }}
                        expiryDays={preview.ok ? preview.offer.expiry_days : null}
                        notReadyReason={preview.ok ? null : preview.message}
                        replacesSentOffer={event.active_proposal_id !== null}
                      />
                    </CardContent>
                  </Card>
                </>
              )}
            </div>

            <Card className="content-start lg:sticky lg:top-4 lg:self-start">
              <CardHeader>
                <CardTitle>Client preview</CardTitle>
                <CardDescription>Live pricing with the same engine the server uses. Staff only; nothing is sent.</CardDescription>
              </CardHeader>
              <CardContent>
                {frozen ? (
                  preview.ok ? (
                    <ProposalPreview offer={preview.offer} mediaBase={staffMediaBase(slug, proposal.id)} logo={preview.logo} event={event} contained />
                  ) : (
                    <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                      {preview.message} <TaxSetupLink slug={slug} message={preview.message} />
                    </p>
                  )
                ) : (
                  <LivePreview slug={slug} proposalId={proposal.id} saved={preview} event={event} mediaBase={staffMediaBase(slug, proposal.id)} />
                )}
              </CardContent>
            </Card>
          </div>
        </DraftOfferProvider>
      </DraftVersionProvider>
    </>
  );
}
