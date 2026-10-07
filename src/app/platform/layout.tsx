import Link from "next/link";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/auth/confirm/actions";
import { requirePlatformAdmin } from "@/lib/auth/platform";

const NAV = [
  ["/platform/invitations", "DJ invitations"],
  ["/platform/workspaces", "Workspaces"],
] as const;

/** Platform administration. Every page and action checks the grant again. */
export default async function PlatformLayout({ children }: LayoutProps<"/platform">) {
  const { user } = await requirePlatformAdmin();
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span className="font-semibold">Flux DJ <span className="font-normal text-muted-foreground">· Platform</span></span>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Link className="underline" href="/staff">Your workspace</Link>
            <span className="hidden sm:inline">{user.email}</span>
            <form action={signOut}><Button size="sm" variant="outline" type="submit">Sign out</Button></form>
          </div>
        </div>
        <nav aria-label="Platform" className="mx-auto w-full max-w-4xl overflow-x-auto px-4">
          <ul className="flex gap-1 pb-2 text-sm">
            {NAV.map(([href, label]) => (
              <li key={href}>
                <Link className="block rounded-md px-2.5 py-1.5 whitespace-nowrap hover:bg-muted" href={href}>{label}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-6">{children}</main>
    </div>
  );
}
