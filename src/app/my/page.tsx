import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/auth/confirm/actions";
import { requireUser } from "@/lib/auth/staff";
import { formatEventDate } from "@/lib/planning/view";

export const metadata: Metadata = { title: "Your events", robots: { index: false, follow: false } };

/** Client home after sign-in: only planning and contracts this verified identity may open. */
export default async function MyContracts() {
  const { supabase, user } = await requireUser();
  const [{ data: plans }, { data: contracts }, { count: memberships }] = await Promise.all([
    supabase.rpc("my_plans"),
    supabase.rpc("my_contracts"),
    supabase.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("user_id", user.id),
  ]);
  return (
    <main className="mx-auto grid w-full max-w-md gap-4 px-4 py-12">
      {plans && plans.length > 0 ? (
        <section aria-labelledby="planning-heading" className="grid gap-2">
          <h1 id="planning-heading" className="text-2xl font-semibold">Your event planning</h1>
          <ul className="grid gap-2 text-sm">
            {plans.map((p) => (
              <li key={p.event_id} className="rounded-xl border p-3">
                <Link className="font-medium underline" href={`/${p.tenant_slug}/planning/${p.event_id}`}>Plan {p.event_title}</Link>
                <div className="text-muted-foreground">
                  {p.tenant_display_name} · {formatEventDate(p.event_date)}
                  {p.requirements_total > 0 ? ` · ${p.requirements_met} of ${p.requirements_total} required answers in available sections` : ""}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {plans && plans.length > 0 ? <h2 className="text-lg font-semibold">Your contracts</h2> : <h1 className="text-2xl font-semibold">Your contracts</h1>}
      {contracts && contracts.length > 0 ? (
        <ul className="grid gap-2 text-sm">
          {contracts.map((c) => (
            <li key={c.contract_id} className="rounded-xl border p-3">
              <Link className="font-medium underline" href={`/${c.tenant_slug}/contracts/${c.contract_id}`}>{c.event_title}</Link>
              <div className="text-muted-foreground">
                {c.tenant_display_name} · {c.event_date} · {c.status === "signed" ? "Contract signed" : "Sent to you"}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{user.email} has no contracts to read yet. Your DJ will email you when one is ready.</p>
      )}
      {memberships ? <Link className="text-sm underline" href="/staff">Go to your staff workspace</Link> : null}
      <form action={signOut}><Button variant="outline" type="submit">Sign out</Button></form>
    </main>
  );
}
