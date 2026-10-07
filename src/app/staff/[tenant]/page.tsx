import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { InstallHelp } from "@/components/app/pwa";
import { requireStaff } from "@/lib/auth/staff";

export default async function Dashboard({ params, searchParams }: PageProps<"/staff/[tenant]">) {
  const { tenant: slug } = await params;
  const { welcome } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: identity } = await supabase.from("tenants").select("business_address, contact_email").eq("id", tenant.id).single();
  // update_business_settings always sets both, so either missing means the legal identity was never saved.
  const setupIncomplete = !identity?.business_address || !identity?.contact_email;
  const count = async (table: "gear_items" | "packages" | "proposal_templates" | "clients" | "events" | "logistics_questions") => {
    let query = supabase.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id);
    // Archived events are not counted, matching the default events list.
    if (table === "events") query = query.is("archived_at", null);
    const { count } = await query;
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
    .select("id, revision, updated_at, events!proposals_event_fk!inner(title, event_date, archived_at)")
    .eq("tenant_id", tenant.id)
    .eq("status", "draft")
    .is("events.archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(5);

  const tiles = [
    ["Events", events, "events"],
    ["Clients", clients, "clients"],
    ["Gear items", gear, "gear"],
    ["Packages", packages, "packages"],
    ["Questions", questions, "questions"],
    ["Proposal templates", templates, "templates"],
  ] as const;

  return (
    <>
      {welcome === "1" && membership.role === "owner" ? (
        <Card>
          <CardHeader>
            <CardTitle>Welcome to Flux DJ, {tenant.display_name}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>Your workspace is ready and empty: nothing was added for you. A good order to set it up:</p>
            <ol className="grid list-decimal gap-1 pl-5">
              <li><Link className="underline" href={`/staff/${slug}/settings`}>Settings</Link>: your legal business name, address, contact email and taxes.</li>
              <li><Link className="underline" href={`/staff/${slug}/gear`}>Gear</Link> and <Link className="underline" href={`/staff/${slug}/packages`}>packages</Link>: what you offer and its prices.</li>
              <li><Link className="underline" href={`/staff/${slug}/templates`}>Proposal templates</Link>, <Link className="underline" href={`/staff/${slug}/contract-templates`}>contract templates</Link> and <Link className="underline" href={`/staff/${slug}/planning-templates`}>planning templates</Link>.</li>
            </ol>
            <p className="text-muted-foreground">
              Using Flux DJ from your phone&apos;s home screen? Sign in there with the code from the sign-in email: the home-screen app keeps
              its own sign-in, separate from your browser.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {setupIncomplete ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          Setup isn&apos;t finished: your legal business name, address and contact email aren&apos;t saved yet, so contracts can&apos;t be sent.{" "}
          {membership.role === "owner" ? (
            <Link className="underline" href={`/staff/${slug}/settings`}>Complete them in Settings</Link>
          ) : (
            "The owner can complete them in Settings."
          )}
        </p>
      ) : null}
      <InstallHelp compact />
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
