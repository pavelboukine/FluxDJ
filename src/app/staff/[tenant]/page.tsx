import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";

export default async function Dashboard({ params }: PageProps<"/staff/[tenant]">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const count = async (table: "gear_items" | "packages" | "proposal_templates" | "clients" | "events" | "logistics_questions") => {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id);
    return count ?? 0;
  };
  const [gear, packages, templates, clients, events, questions] = await Promise.all([
    count("gear_items"),
    count("packages"),
    count("proposal_templates"),
    count("clients"),
    count("events"),
    count("logistics_questions"),
  ]);
  const { data: drafts } = await supabase
    .from("proposals")
    .select("id, revision, updated_at, events!proposals_event_fk(title, event_date)")
    .eq("tenant_id", tenant.id)
    .eq("status", "draft")
    .order("updated_at", { ascending: false })
    .limit(5);

  const tiles = [
    ["Events", events, "events"],
    ["Clients", clients, "clients"],
    ["Gear items", gear, "gear"],
    ["Packages", packages, "packages"],
    ["Questions", questions, "questions"],
    ["Templates", templates, "templates"],
  ] as const;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Set up your catalog once, then build proposals for each event."
        actions={
          <Link className={buttonVariants()} href={`/staff/${slug}/events/new`}>
            New event
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, n, path]) => (
          <Link key={path} href={`/staff/${slug}/${path}`} className="rounded-xl border p-4 hover:bg-muted">
            <div className="text-2xl font-semibold">{n}</div>
            <div className="text-sm text-muted-foreground">{label}</div>
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Proposal drafts</CardTitle>
        </CardHeader>
        <CardContent>
          {drafts && drafts.length > 0 ? (
            <ul className="grid gap-2 text-sm">
              {drafts.map((d) => (
                <li key={d.id}>
                  <Link className="underline" href={`/staff/${slug}/proposals/${d.id}`}>
                    {d.events?.title ?? "Event"} · revision {d.revision}
                  </Link>{" "}
                  <span className="text-muted-foreground">({d.events?.event_date})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No drafts yet. Open an event and start a proposal.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
