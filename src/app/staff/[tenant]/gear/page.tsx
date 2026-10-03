import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { formatCents } from "@/lib/money";

export default async function GearList({ params, searchParams }: PageProps<"/staff/[tenant]/gear">) {
  const { tenant: slug } = await params;
  const { show } = await searchParams;
  const archived = show === "archived";
  const { supabase, tenant } = await requireStaff(slug);
  const { data: gear } = await supabase
    .from("gear_items")
    .select("id, key, name, default_price_cents, unit_label, tax_category, active, gear_media(count)")
    .eq("tenant_id", tenant.id)
    .eq("active", !archived)
    .order("name");

  return (
    <>
      <PageHeader
        title="Gear"
        description="Sellable catalog items. Prices and photos here feed new proposals; sent proposals keep their own copy."
        actions={
          <>
            <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}/gear${archived ? "" : "?show=archived"}`}>
              {archived ? "Show active" : "Show archived"}
            </Link>
            <Link className={buttonVariants()} href={`/staff/${slug}/gear/new`}>
              New gear item
            </Link>
          </>
        }
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Price</TableHead>
            <TableHead className="hidden sm:table-cell">Tax</TableHead>
            <TableHead className="hidden sm:table-cell">Media</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(gear ?? []).map((g) => (
            <TableRow key={g.id}>
              <TableCell>
                <Link className="font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/gear/${g.id}`}>
                  {g.name}
                </Link>
                <div className="text-xs text-muted-foreground">{g.key}</div>
              </TableCell>
              <TableCell>
                {formatCents(g.default_price_cents, tenant.currency)} <span className="text-xs text-muted-foreground">/ {g.unit_label}</span>
              </TableCell>
              <TableCell className="hidden sm:table-cell">{g.tax_category}</TableCell>
              <TableCell className="hidden sm:table-cell">{g.gear_media[0]?.count ?? 0}</TableCell>
              <TableCell>{g.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}</TableCell>
            </TableRow>
          ))}
          {gear?.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                {archived ? "No archived gear." : "No gear yet. Add your first item."}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </>
  );
}
