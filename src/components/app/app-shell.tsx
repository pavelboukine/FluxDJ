"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import {
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  CircleUserRound,
  FileSignature,
  FileText,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MailPlus,
  Package,
  Settings,
  Speaker,
  Store,
  Ticket,
  Users,
  Menu as MenuIcon,
  X,
  type LucideIcon,
} from "lucide-react";
import { signOut } from "@/app/auth/confirm/actions";
import { isActive, type NavGroup, type NavIcon } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/*
 * The signed-in staff and platform shell: a white top bar (Flux wordmark,
 * the active business's logo centred on the viewport, account menu), a
 * persistent sidebar from the lg breakpoint, and a left drawer below it.
 * Navigation is presentation only; every page checks access again.
 */

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  events: CalendarDays,
  clients: Users,
  gear: Speaker,
  packages: Package,
  "proposal-templates": FileText,
  "contract-templates": FileSignature,
  "planning-templates": ListChecks,
  questions: CircleHelp,
  emails: Mail,
  settings: Settings,
  invitations: MailPlus,
  workspaces: Building2,
  businesses: Store,
};

export type ShellWorkspace = { slug: string; displayName: string; role: string; suspended: boolean };

export type ShellAccount = {
  email: string;
  /** For example "Owner · Northside Sound" or "Platform administrator". */
  roleLabel: string;
  platformAdmin: boolean;
  /** Every business the user belongs to (the menu offers switching when there is more than one). */
  workspaces: ShellWorkspace[];
  currentSlug?: string;
  /** The user can also read client planning or contracts (/my). */
  clientArea: boolean;
};

export function AppShell({
  navLabel,
  groups,
  homeHref,
  center,
  account,
  children,
}: {
  /** Accessible name of the navigation landmark ("Staff", "Platform"). */
  navLabel: string;
  groups: NavGroup[];
  /** Where the Flux wordmark leads (the staff landing route). */
  homeHref: string;
  /** Centre of the top bar: the business logo or name, or a neutral label. */
  center: ReactNode;
  account: ShellAccount;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-shell">
      <header className="sticky top-0 z-40 border-b bg-background pt-[env(safe-area-inset-top)]">
        {/* Equal side columns and equal side padding (the larger safe-area inset on both sides) keep the
            centre on the viewport's centre line, whatever the sides hold. */}
        <div className="grid h-14 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-[max(0.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] lg:px-5">
          <div className="flex min-w-0 items-center gap-1 justify-self-start">
            <NavDrawer navLabel={navLabel} groups={groups} homeHref={homeHref} />
            <FluxWordmark href={homeHref} className="h-5 lg:h-[1.625rem]" />
          </div>
          <div className="flex min-w-0 max-w-[calc(100vw-15rem)] justify-center sm:max-w-[calc(100vw-20rem)] lg:max-w-80">{center}</div>
          <div className="flex min-w-0 justify-self-end">
            <AccountMenu account={account} />
          </div>
        </div>
      </header>
      <div className="flex flex-1">
        {/* The tinted column runs the page's full height; the navigation inside it stays in view. */}
        <div className="hidden w-60 shrink-0 border-r bg-sidebar lg:block">
          <aside className="sticky top-14 h-[calc(100dvh-3.5rem)] overflow-y-auto">
            <NavGroups label={navLabel} groups={groups} className="px-3 py-5" />
          </aside>
        </div>
        <main className="min-w-0 flex-1 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] sm:p-6 lg:p-8">
          <div className="mx-auto grid w-full max-w-6xl gap-6 bg-background px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:rounded-xl sm:border sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/** The Flux wordmark (shared platform artwork, never a business's logo), linking to the staff landing route. */
export function FluxWordmark({ href, className }: { href: string; className?: string }) {
  return (
    <Link href={href} aria-label="Flux DJ home" className="inline-flex shrink-0 items-center rounded-md px-1 py-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      {/* 452 x 160 trimmed artwork: height set here, width follows (never stretched). */}
      {/* eslint-disable-next-line @next/next/no-img-element -- small static PNG; next/image adds nothing here */}
      <img src="/brand/flux-wordmark-black.png" alt="" width={452} height={160} className={cn("block w-auto", className)} />
    </Link>
  );
}

function NavGroups({ label, groups, className, onNavigate }: { label: string; groups: NavGroup[]; className?: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={cn("grid gap-5", className)}>
      {groups.map((group) => (
        <div key={group.label} className="grid gap-1">
          <h2 className="px-3 text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">{group.label}</h2>
          <ul className="grid gap-0.5">
            {group.items.map((item) => {
              const active = isActive(item, pathname);
              const Icon = ICONS[item.icon];
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                      active
                        ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-border"
                        : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
                    )}
                  >
                    <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
                    <span className="min-w-0 truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

const iconButton =
  "inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted";

/** Below lg: the same navigation in a modal drawer from the left (focus trapped, page scroll locked, Escape closes). */
function NavDrawer({ navLabel, groups, homeHref }: { navLabel: string; groups: NavGroup[]; homeHref: string }) {
  const [open, setOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={cn(iconButton, "lg:hidden")} aria-label="Open menu">
        <MenuIcon aria-hidden className="size-5" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 min-h-dvh bg-black/30 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute lg:hidden" />
        <Dialog.Popup
          initialFocus={closeButton}
          data-testid="nav-drawer"
          className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,calc(100vw-3rem))] flex-col border-r bg-sidebar pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] shadow-xl outline-none transition-transform duration-200 ease-out data-ending-style:-translate-x-full data-starting-style:-translate-x-full lg:hidden"
        >
          <Dialog.Title className="sr-only">Menu</Dialog.Title>
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background pr-2 pl-3">
            <span onClickCapture={close}>
              <FluxWordmark href={homeHref} className="h-5" />
            </span>
            <Dialog.Close ref={closeButton} className={iconButton} aria-label="Close menu">
              <X aria-hidden className="size-5" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <NavGroups label={navLabel} groups={groups} onNavigate={close} className="px-3 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]" />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const menuItem =
  "flex min-h-9 w-full cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none select-none data-highlighted:bg-muted data-disabled:text-muted-foreground";

function AccountMenu({ account }: { account: ShellAccount }) {
  const switchable = account.workspaces.length > 1;
  const signOutForm = useRef<HTMLFormElement>(null);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Account"
        data-testid="account-menu"
        className={cn(iconButton, "w-auto gap-1 px-1.5 text-muted-foreground hover:text-foreground lg:px-2")}
      >
        <CircleUserRound aria-hidden className="size-6" strokeWidth={1.6} />
        <ChevronDown aria-hidden className="hidden size-4 lg:block" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" collisionPadding={8} className="z-50 outline-none">
          <Menu.Popup className="max-h-[var(--available-height)] w-72 max-w-[calc(100vw-1rem)] origin-[var(--transform-origin)] overflow-y-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <div className="grid gap-0.5 px-2.5 pt-1.5 pb-2" data-testid="account-identity">
              <span className="text-xs text-muted-foreground">Signed in as</span>
              <span className="text-sm font-medium break-all">{account.email}</span>
              <span className="text-xs text-muted-foreground">{account.roleLabel}</span>
              {account.platformAdmin && account.currentSlug ? <span className="text-xs text-muted-foreground">Platform administrator</span> : null}
            </div>
            {switchable ? (
              <>
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.Group>
                  <Menu.GroupLabel className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">
                    Switch business
                  </Menu.GroupLabel>
                  {account.workspaces.map((w) =>
                    w.suspended ? (
                      <Menu.Item key={w.slug} disabled className={menuItem}>
                        <span className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{w.displayName}</span>
                        <span className="text-xs">unavailable</span>
                      </Menu.Item>
                    ) : (
                      <Menu.LinkItem
                        key={w.slug}
                        closeOnClick
                        className={menuItem}
                        aria-current={w.slug === account.currentSlug ? "page" : undefined}
                        render={<Link href={`/staff/${w.slug}`} />}
                      >
                        {w.slug === account.currentSlug ? <Check aria-hidden className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
                        <span className="min-w-0 flex-1 truncate">{w.displayName}</span>
                        <span className="text-xs text-muted-foreground">{w.role}</span>
                      </Menu.LinkItem>
                    ),
                  )}
                </Menu.Group>
              </>
            ) : null}
            {account.clientArea ? (
              <>
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.LinkItem closeOnClick className={menuItem} render={<Link href="/my" />}>
                  <Ticket aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  Your events as a client
                </Menu.LinkItem>
              </>
            ) : null}
            <Menu.Separator className="my-1 h-px bg-border" />
            <form ref={signOutForm} action={signOut}>
              <Menu.Item className={menuItem} closeOnClick={false} onClick={() => signOutForm.current?.requestSubmit()}>
                <LogOut aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                Sign out
              </Menu.Item>
            </form>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
