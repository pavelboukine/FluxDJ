import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { formatCents } from "@/lib/money";

export default async function PackageList({ params }: PageProps<"/staff/[tenant]/packages">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: packages } = await supabase
    .from("packages")
    .select("id, key, name, base_price_cents, is_popular, active, package_items(count)")
    .eq("tenant_id", tenant.id)
    .order("active", { ascending: false })
    .order("sort_order")
    .order("name");
  return (
    <>
      <PageHeader
        title="Packages"
        description="Base price plus included gear. Proposals offer three of these."
        actions={<Link className={buttonVariants()} href={`/staff/${slug}/packages/new`}>New package</Link>}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Base price</TableHead>
            <TableHead className="hidden sm:table-cell">Included items</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(packages ?? []).map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <Link className="font-medium hover:underline" href={`/staff/${slug}/packages/${p.id}`}>{p.name}</Link>{" "}
                {p.is_popular ? <Badge>Popular</Badge> : null}
                <div className="text-xs text-muted-foreground">{p.key}</div>
              </TableCell>
              <TableCell>{formatCents(p.base_price_cents, tenant.currency)}</TableCell>
              <TableCell className="hidden sm:table-cell">{p.package_items[0]?.count ?? 0}</TableCell>
              <TableCell>{p.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}</TableCell>
            </TableRow>
          ))}
          {packages?.length === 0 ? (
            <TableRow><TableCell colSpan={4} className="text-muted-foreground">No packages yet.</TableCell></TableRow>
          ) : null}
        </TableBody>
      </Table>
    </>
  );
}
