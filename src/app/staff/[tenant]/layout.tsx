import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireStaff } from "@/lib/auth/staff";
import { signOut } from "@/app/auth/confirm/actions";

const NAV = [
  ["", "Dashboard"],
  ["/events", "Events"],
  ["/clients", "Clients"],
  ["/gear", "Gear"],
  ["/packages", "Packages"],
  ["/questions", "Questions"],
  ["/templates", "Templates"],
  ["/planning-templates", "Planning templates"],
  ["/contract-templates", "Contract templates"],
  ["/emails", "Emails"],
  ["/settings", "Settings"],
] as const;

export default async function StaffTenantLayout({ children, params }: LayoutProps<"/staff/[tenant]">) {
  const { tenant: slug } = await params;
  const { tenant, user, membership } = await requireStaff(slug);
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link href={`/staff/${tenant.slug}`} className="font-semibold">
            {tenant.display_name} <span className="font-normal text-muted-foreground">· Flux DJ staff</span>
          </Link>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="hidden sm:inline">
              {user.email} ({membership.role})
            </span>
            <form action={signOut}>
              <Button size="sm" variant="outline" type="submit">
                Sign out
              </Button>
            </form>
          </div>
        </div>
        <nav aria-label="Staff" className="mx-auto w-full max-w-6xl overflow-x-auto px-4">
          <ul className="flex gap-1 pb-2 text-sm">
            {NAV.map(([path, label]) => (
              <li key={path}>
                <Link className="block rounded-md px-2.5 py-1.5 whitespace-nowrap hover:bg-muted" href={`/staff/${tenant.slug}${path}`}>
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6">{children}</main>
    </div>
  );
}
