import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { savePackageItems, updatePackage } from "../actions";
import { PackageFields } from "../package-fields";

export default async function EditPackage({ params }: PageProps<"/staff/[tenant]/packages/[packageId]">) {
  const { tenant: slug, packageId } = await params;
  if (!UUID_RE.test(packageId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: pkg } = await supabase
    .from("packages")
    .select("id, key, name, description, base_price_cents, tax_category, sort_order, is_popular, active, package_items(gear_item_id, quantity)")
    .eq("id", packageId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!pkg) notFound();
  const { data: gear } = await supabase
    .from("gear_items")
    .select("id, name, key, active, default_price_cents")
    .eq("tenant_id", tenant.id)
    .order("active", { ascending: false })
    .order("name");
  const included = new Map(pkg.package_items.map((i) => [i.gear_item_id, i.quantity]));
  const rows = (gear ?? []).filter((g) => g.active || included.has(g.id));

  return (
    <>
      <PageHeader title={pkg.name} description={<Link className="underline" href={`/staff/${slug}/packages`}>Back to packages</Link>} />
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={updatePackage.bind(null, slug, pkg.id)} submitLabel="Save package">
            <PackageFields pkg={pkg} taxCategories={Object.keys((tenant.tax_categories ?? {}) as object)} />
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Included gear</CardTitle>
          <CardDescription>Quantities covered by the base price. Leave 0 for gear that is not included.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={savePackageItems.bind(null, slug, pkg.id)} submitLabel="Save included gear">
            <ul className="grid gap-2">
              {rows.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3 border-b pb-2 text-sm">
                  <label htmlFor={`qty-${g.id}`} className="grid">
                    <span>
                      {g.name} {g.active ? null : <span className="text-xs text-muted-foreground">(archived)</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatCents(g.default_price_cents, tenant.currency)} each when sold separately</span>
                  </label>
                  <Input id={`qty-${g.id}`} name={`qty:${g.id}`} type="number" min={0} max={100} defaultValue={included.get(g.id) ?? 0} className="w-20" />
                </li>
              ))}
            </ul>
            {rows.length === 0 ? <p className="text-sm text-muted-foreground">Add gear items first.</p> : null}
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
