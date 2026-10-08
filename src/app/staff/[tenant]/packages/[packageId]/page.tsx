import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/app/fields";
import { InlineEditor } from "@/components/app/inline-editor";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { savePackageItems, updatePackage } from "../actions";
import { loadGearChoices, type GearChoice } from "../gear-choices";
import { GearThumb, IncludedGearEditor } from "../included-gear-editor";
import { PackageFields } from "../package-fields";
import { PackageArchivePanel } from "./package-archive-panel";

/** At most this many templates in "Used in". */
const USES_LIMIT = 20;

/**
 * One package: its price and what it includes as clients will understand
 * them, Edit details and Edit included gear, the templates that offer it,
 * and archiving.
 */
export default async function PackagePage({ params, searchParams }: PageProps<"/staff/[tenant]/packages/[packageId]">) {
  const { tenant: slug, packageId } = await params;
  if (!UUID_RE.test(packageId)) notFound();
  const created = (await searchParams).created;
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const { data: pkg } = await supabase
    .from("packages")
    .select("id, key, name, description, base_price_cents, tax_category, sort_order, active, package_items(gear_item_id, quantity)")
    .eq("id", packageId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!pkg) notFound();

  const [{ choices, capped }, { data: templates }] = await Promise.all([
    loadGearChoices(staff, pkg.package_items.map((i) => i.gear_item_id)),
    supabase
      .from("proposal_template_packages")
      .select("sort_order, proposal_templates!proposal_template_packages_template_fk(id, name, active, default_package_id)")
      .eq("tenant_id", tenant.id)
      .eq("package_id", pkg.id)
      .limit(USES_LIMIT),
  ]);
  const byId = new Map(choices.map((c) => [c.id, c]));
  const included = pkg.package_items
    .map((i) => ({ quantity: i.quantity, gear: byId.get(i.gear_item_id) ?? null, id: i.gear_item_id }))
    .sort((a, b) => (a.gear?.name ?? "").localeCompare(b.gear?.name ?? ""));
  const archivedGear = included.filter((i) => i.gear && !i.gear.active).length;
  const configured = Object.keys((tenant.tax_categories ?? {}) as Record<string, unknown>);
  const uses = (templates ?? []).flatMap((t) => (t.proposal_templates ? [{ ...t.proposal_templates, position: t.sort_order }] : []));
  const activeTemplates = uses.filter((u) => u.active).length;

  return (
    <>
      <PageHeader
        title={pkg.name}
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/packages`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to packages
          </Link>
        }
        actions={pkg.active ? <Badge variant="outline">Active</Badge> : <Badge variant="secondary">Archived</Badge>}
      />
      {created === "1" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">Package created.</p>
      ) : created === "replayed" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
          This package was already saved: an earlier attempt went through, but its reply didn&apos;t arrive. Check its details and included gear below.
        </p>
      ) : null}
      {!pkg.active ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This package is archived. It can&apos;t be chosen for templates or proposal drafts, and proposals that still offer it can&apos;t be previewed or sent
          until you restore it or choose another package.
        </p>
      ) : null}
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Changes here apply to proposals prepared from now on. Proposals already sent keep the package, price and gear they were sent with.
      </p>

      <InlineEditor
        id="details"
        title="Details"
        editLabel="Edit details"
        view={<PackageOverview pkg={pkg} currency={tenant.currency} configured={configured} slug={slug} />}
        action={updatePackage.bind(null, slug, pkg.id)}
        submitLabel="Save details"
        discardMessage="Discard the changes you made to this package?"
      >
        <PackageFields pkg={pkg} taxCategories={configured} currency={tenant.currency} slug={slug} />
      </InlineEditor>

      <InlineEditor
        id="included"
        title="Included gear"
        editLabel="Edit included gear"
        view={<IncludedOverview items={included} slug={slug} archivedGear={archivedGear} />}
        action={savePackageItems.bind(null, slug, pkg.id)}
        submitLabel="Save included gear"
        discardMessage="Discard the changes you made to the included gear?"
      >
        <IncludedGearEditor choices={choices} initial={pkg.package_items.map((i) => ({ id: i.gear_item_id, quantity: i.quantity }))} capped={capped} />
      </InlineEditor>

      <section aria-labelledby="uses-heading" className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="uses-heading" className="text-base font-semibold">Used in</h2>
          <p className="text-sm text-muted-foreground">Proposal templates that offer this package.</p>
        </div>
        {uses.length > 0 ? (
          <ul className="grid gap-1.5 text-sm" data-testid="package-uses">
            {uses.map((u) => (
              <li key={u.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs text-muted-foreground">Proposal template</span>
                <Link className="font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/templates/${u.id}`}>{u.name}</Link>
                <span className="text-muted-foreground">package {u.position}{u.default_package_id === pkg.id ? ", recommended" : ""}</span>
                {u.active ? null : <Badge variant="secondary">Archived</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Not offered by any proposal template yet.</p>
        )}
        {uses.length >= USES_LIMIT ? <p className="text-xs text-muted-foreground">Showing the first {USES_LIMIT}.</p> : null}
      </section>

      <section aria-labelledby="manage-heading" className="grid gap-3 rounded-xl border p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="manage-heading" className="text-base font-semibold">{pkg.active ? "Manage package" : "Archived package"}</h2>
          <p className="text-sm text-muted-foreground">Archive instead of deleting: nothing is removed, and sent proposals keep their copy.</p>
        </div>
        <PackageArchivePanel slug={slug} packageId={pkg.id} name={pkg.name} archived={!pkg.active} templates={activeTemplates} />
      </section>
    </>
  );
}

function PackageOverview({
  pkg,
  currency,
  configured,
  slug,
}: {
  pkg: { key: string; description: string | null; base_price_cents: number; tax_category: string; sort_order: number };
  currency: string;
  configured: string[];
  slug: string;
}) {
  const term = "text-xs font-medium text-muted-foreground";
  const taxReady = configured.includes(pkg.tax_category);
  return (
    <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
      <div className="grid gap-0.5">
        <dt className={term}>Base price</dt>
        <dd>
          <span className="text-lg font-semibold" data-testid="package-price">{formatCents(pkg.base_price_cents, currency)}</span>{" "}
          <span className="text-muted-foreground">before tax</span>
        </dd>
      </div>
      <div className="grid gap-0.5">
        <dt className={term}>Tax category</dt>
        <dd className="grid gap-1">
          <span>{pkg.tax_category}</span>
          {taxReady ? null : (
            <span className="text-xs text-amber-800 dark:text-amber-300" data-testid="package-tax-warning">
              {configured.length > 0 ? "Taxes aren't set up for this category" : "No taxes are set up yet"}, so proposals with this package can&apos;t be sent.{" "}
              <Link className="font-medium underline" href={`/staff/${slug}/settings#taxes`}>Open tax settings</Link> (owner only).
            </span>
          )}
        </dd>
      </div>
      <div className="grid gap-0.5 sm:col-span-2">
        <dt className={term}>Description</dt>
        <dd className="whitespace-pre-line">{pkg.description ?? <span className="text-muted-foreground italic">No description</span>}</dd>
      </div>
      <div className="grid gap-0.5 sm:col-span-2">
        <dt className={term}>How it&apos;s priced</dt>
        <dd className="text-muted-foreground">
          The client pays this base price for the package. Its included gear is part of it and never charged separately. Extras the client adds, and
          anything a rule requires beyond what&apos;s included, are charged at each gear item&apos;s unit price.
        </dd>
      </div>
      <div className="grid gap-0.5">
        <dt className={term}>Display order</dt>
        <dd>{pkg.sort_order}</dd>
      </div>
      <div className="grid gap-0.5">
        <dt className={term}>Key</dt>
        <dd className="font-mono text-xs">{pkg.key}</dd>
      </div>
    </dl>
  );
}

function IncludedOverview({ items, slug, archivedGear }: { items: { id: string; quantity: number; gear: GearChoice | null }[]; slug: string; archivedGear: number }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="included-none">No gear included. The package is offered at its base price alone.</p>;
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Part of the base price: shown to clients, never charged separately.</p>
      {archivedGear > 0 ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="archived-gear-warning">
          {archivedGear === 1 ? "1 included item is archived gear" : `${archivedGear} included items are archived gear`}. Proposals with this package can&apos;t be
          previewed or sent until you remove {archivedGear === 1 ? "it" : "them"} or restore the gear.
        </p>
      ) : null}
      <ul aria-label="Included gear" className="divide-y rounded-lg border" data-testid="included-list">
        {items.map((i) => (
          <li key={i.id} className="flex items-center gap-3 p-3 text-sm" data-testid="included-item">
            <GearThumb url={i.gear?.thumbUrl ?? null} />
            <span className="grid min-w-0 flex-1">
              {i.gear ? (
                <Link className="truncate font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/gear/${i.id}`}>{i.gear.name}</Link>
              ) : (
                <span className="font-medium text-muted-foreground">Unavailable gear item</span>
              )}
              {i.gear && !i.gear.active ? <span className="text-xs text-amber-800 dark:text-amber-300">Archived gear</span> : null}
            </span>
            <span className="shrink-0 text-right whitespace-nowrap">
              <span className="font-medium">× {i.quantity}</span> <span className="text-xs text-muted-foreground">{i.gear?.unitLabel}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
