import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ImageOff, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/app/fields";
import { InlineEditor } from "@/components/app/inline-editor";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { updateGear } from "../actions";
import { GearFields } from "../gear-fields";
import { GearArchivePanel } from "./gear-archive-panel";
import { MediaGallery } from "./media-gallery";
import { MediaManager } from "./media-manager";
import { MediaUploader } from "./media-uploader";

/** At most this many links per kind in "Used in". */
const USES_LIMIT = 20;

/**
 * One gear item: what clients will see (photos and videos, description,
 * price), Edit details, media management, where it's used, and archiving.
 */
export default async function GearItem({ params, searchParams }: PageProps<"/staff/[tenant]/gear/[gearId]">) {
  const { tenant: slug, gearId } = await params;
  if (!UUID_RE.test(gearId)) notFound();
  const created = (await searchParams).created === "1";
  const { supabase, tenant } = await requireStaff(slug);
  const { data: gear } = await supabase
    .from("gear_items")
    .select("id, key, name, description, unit_label, default_price_cents, tax_category, active")
    .eq("id", gearId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!gear) notFound();

  const [{ data: media }, { data: packages }, { data: addons }, { data: rules }] = await Promise.all([
    supabase
      .from("gear_media")
      .select("id, storage_path, kind, content_type, alt_text, sort_order, active")
      .eq("tenant_id", tenant.id)
      .eq("gear_item_id", gear.id)
      .order("sort_order")
      .order("created_at")
      .order("storage_path")
      .limit(200),
    supabase
      .from("package_items")
      .select("quantity, packages!package_items_package_fk(id, name, active)")
      .eq("tenant_id", tenant.id)
      .eq("gear_item_id", gear.id)
      .limit(USES_LIMIT),
    supabase
      .from("proposal_template_addons")
      .select("max_quantity, proposal_templates!proposal_template_addons_template_fk(id, name, active)")
      .eq("tenant_id", tenant.id)
      .eq("gear_item_id", gear.id)
      .limit(USES_LIMIT),
    supabase
      .from("logistics_rules")
      .select("id, required_quantity, active, logistics_questions!logistics_rules_question_fk(id, prompt, active)")
      .eq("tenant_id", tenant.id)
      .eq("gear_item_id", gear.id)
      .limit(USES_LIMIT),
  ]);

  // Short-lived signed URLs, issued to this staff user only (Storage RLS applies).
  const paths = (media ?? []).map((m) => m.storage_path);
  const { data: signed } = paths.length
    ? await supabase.storage.from("gear-media").createSignedUrls(paths, 600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlFor = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const all = (media ?? []).map((m) => ({ id: m.id, url: urlFor.get(m.storage_path) ?? null, kind: m.kind, contentType: m.content_type, alt: m.alt_text, active: m.active }));
  const shown = all.filter((m) => m.active);

  const configured = Object.keys((tenant.tax_categories ?? {}) as Record<string, unknown>);
  const taxReady = configured.includes(gear.tax_category);
  const uses = [
    ...(packages ?? []).flatMap((p) => (p.packages ? [{ key: `p-${p.packages.id}`, href: `/staff/${slug}/packages/${p.packages.id}`, label: p.packages.name, kind: "Package", note: `includes ${p.quantity}`, active: p.packages.active }] : [])),
    ...(addons ?? []).flatMap((a) =>
      a.proposal_templates ? [{ key: `t-${a.proposal_templates.id}`, href: `/staff/${slug}/templates/${a.proposal_templates.id}`, label: a.proposal_templates.name, kind: "Proposal template", note: `add-on, up to ${a.max_quantity}`, active: a.proposal_templates.active }] : [],
    ),
    ...(rules ?? []).flatMap((r) =>
      r.logistics_questions ? [{ key: `r-${r.id}`, href: `/staff/${slug}/questions/${r.logistics_questions.id}`, label: r.logistics_questions.prompt, kind: "Rule", note: `requires ${r.required_quantity}`, active: r.active && r.logistics_questions.active }] : [],
    ),
  ];
  const activeUses = uses.filter((u) => u.active).length;
  const capped = [packages, addons, rules].some((list) => (list?.length ?? 0) >= USES_LIMIT);

  return (
    <>
      <PageHeader
        title={gear.name}
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/gear`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to gear
          </Link>
        }
        actions={gear.active ? <Badge variant="outline">Active</Badge> : <Badge variant="secondary">Archived</Badge>}
      />
      {created ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
          Gear item created. <a className="font-medium underline" href="#media">Add photos and videos</a> below.
        </p>
      ) : null}
      {!gear.active ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This gear item is archived. It can&apos;t be picked for packages, add-ons or rules, and proposals that still include it can&apos;t be sent
          until you restore it or remove it there.
        </p>
      ) : null}
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Changes here apply to proposals prepared from now on. Proposals already sent keep the name, price, tax and photos they were sent with.
      </p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <section aria-label="Photos and videos preview" className="rounded-xl border bg-card p-4 sm:p-5">
          {shown.length > 0 ? (
            <MediaGallery items={shown} />
          ) : (
            <div className="grid aspect-[4/3] place-content-center justify-items-center gap-2 rounded-lg bg-muted p-4 text-center text-sm text-muted-foreground" data-testid="gear-no-media">
              <ImageOff aria-hidden className="size-6" />
              <p>No photos or videos shown to clients yet.</p>
              <a className="font-medium text-foreground underline" href="#media">Add a photo or video</a>
            </div>
          )}
        </section>
        <InlineEditor
          id="details"
          title="Details"
          editLabel="Edit details"
          view={<GearOverview gear={gear} currency={tenant.currency} taxReady={taxReady} anyTaxes={configured.length > 0} slug={slug} />}
          action={updateGear.bind(null, slug, gear.id)}
          submitLabel="Save details"
          discardMessage="Discard the changes you made to this gear item?"
        >
          <GearFields gear={gear} taxCategories={configured} currency={tenant.currency} slug={slug} />
        </InlineEditor>
      </div>

      <section id="media" aria-labelledby="media-heading" className="scroll-mt-20 grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="media-heading" className="text-base font-semibold">Photos and videos</h2>
          <p className="text-sm text-muted-foreground">
            Shown to clients on new proposals, in this order; the first is shown first. Archive one to hide it from new proposals: the file is kept,
            so proposals already sent still show it.
          </p>
        </div>
        <MediaUploader slug={slug} gearId={gear.id} />
        {all.length > 0 ? <MediaManager slug={slug} gearId={gear.id} media={all} /> : null}
      </section>

      <section aria-labelledby="uses-heading" className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="uses-heading" className="text-base font-semibold">Used in</h2>
          <p className="text-sm text-muted-foreground">Packages, proposal templates and rules that use this item.</p>
        </div>
        {uses.length > 0 ? (
          <ul className="grid gap-1.5 text-sm" data-testid="gear-uses">
            {uses.map((u) => (
              <li key={u.key} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs text-muted-foreground">{u.kind}</span>
                <Link className="font-medium underline-offset-4 hover:underline" href={u.href}>{u.label}</Link>
                <span className="text-muted-foreground">{u.note}</span>
                {u.active ? null : <Badge variant="secondary">Archived</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Not used in any package, proposal template or rule yet.</p>
        )}
        {capped ? <p className="text-xs text-muted-foreground">Showing the first {USES_LIMIT} of each kind.</p> : null}
      </section>

      <section aria-labelledby="manage-heading" className="grid gap-3 rounded-xl border p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="manage-heading" className="text-base font-semibold">{gear.active ? "Manage gear item" : "Archived gear item"}</h2>
          <p className="text-sm text-muted-foreground">Archive instead of deleting: nothing is removed, and sent proposals keep their copy.</p>
        </div>
        <GearArchivePanel slug={slug} gearId={gear.id} name={gear.name} active={gear.active} uses={activeUses} />
      </section>
    </>
  );
}

function GearOverview({
  gear,
  currency,
  taxReady,
  anyTaxes,
  slug,
}: {
  gear: { key: string; description: string | null; unit_label: string; default_price_cents: number; tax_category: string };
  currency: string;
  taxReady: boolean;
  anyTaxes: boolean;
  slug: string;
}) {
  const term = "text-xs font-medium text-muted-foreground";
  return (
    <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
      <div className="grid gap-0.5">
        <dt className={term}>Unit price</dt>
        <dd>
          <span className="text-lg font-semibold" data-testid="gear-price">{formatCents(gear.default_price_cents, currency)}</span>{" "}
          <span className="text-muted-foreground">per {gear.unit_label}, before tax</span>
        </dd>
      </div>
      <div className="grid gap-0.5">
        <dt className={term}>Tax category</dt>
        <dd className="grid gap-1">
          <span>{gear.tax_category}</span>
          {taxReady ? null : (
            <span className="text-xs text-amber-800 dark:text-amber-300" data-testid="gear-tax-warning">
              {anyTaxes ? "Taxes aren't set up for this category" : "No taxes are set up yet"}, so proposals with this item can&apos;t be sent.{" "}
              <Link className="font-medium underline" href={`/staff/${slug}/settings#taxes`}>Open tax settings</Link> (owner only).
            </span>
          )}
        </dd>
      </div>
      <div className="grid gap-0.5 sm:col-span-2">
        <dt className={term}>Description</dt>
        <dd className="whitespace-pre-line">{gear.description ?? <span className="text-muted-foreground italic">No description</span>}</dd>
      </div>
      <div className="grid gap-0.5 sm:col-span-2">
        <dt className={term}>Pricing</dt>
        <dd className="text-muted-foreground">Charged per {gear.unit_label} when the client adds it or a rule requires it. Quantities a package includes are not charged again.</dd>
      </div>
      <div className="grid gap-0.5">
        <dt className={term}>Key</dt>
        <dd className="font-mono text-xs">{gear.key}</dd>
      </div>
    </dl>
  );
}
