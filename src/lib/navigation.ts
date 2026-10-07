/**
 * The staff and platform navigation: which links exist, in which groups and
 * order, and which one is active for a path. Links only point at existing
 * routes; showing a link grants nothing (every page and action checks access
 * again). Contracts, payments, planning and run sheets are reached through
 * their event, so their pages highlight Events.
 */
export type NavIcon =
  | "dashboard"
  | "events"
  | "clients"
  | "gear"
  | "packages"
  | "proposal-templates"
  | "contract-templates"
  | "planning-templates"
  | "questions"
  | "emails"
  | "settings"
  | "invitations"
  | "workspaces"
  | "businesses";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  /** Active only on this exact path (a landing page whose children belong to other items). */
  exact?: boolean;
  /** Other route prefixes that belong to this item. */
  also?: string[];
};

export type NavGroup = { label: string; items: NavItem[] };

const ADMIN: NavGroup = {
  label: "Admin",
  items: [
    { href: "/platform/invitations", label: "DJ invitations", icon: "invitations" },
    { href: "/platform/workspaces", label: "Workspaces", icon: "workspaces" },
  ],
};

/** A business's staff navigation. The Admin group is only for platform administrators (never a tenant role). */
export function staffNavigation(slug: string, { platformAdmin }: { platformAdmin: boolean }): NavGroup[] {
  const base = `/staff/${slug}`;
  const groups: NavGroup[] = [
    {
      label: "Main",
      items: [
        { href: base, label: "Dashboard", icon: "dashboard", exact: true },
        { href: `${base}/events`, label: "Events", icon: "events", also: [`${base}/proposals`, `${base}/contracts`] },
        { href: `${base}/clients`, label: "Clients", icon: "clients" },
      ],
    },
    {
      label: "Catalog",
      items: [
        { href: `${base}/gear`, label: "Gear", icon: "gear" },
        { href: `${base}/packages`, label: "Packages", icon: "packages" },
      ],
    },
    {
      label: "Templates",
      items: [
        { href: `${base}/templates`, label: "Proposal templates", icon: "proposal-templates" },
        { href: `${base}/contract-templates`, label: "Contract templates", icon: "contract-templates" },
        { href: `${base}/planning-templates`, label: "Planning templates", icon: "planning-templates" },
        { href: `${base}/questions`, label: "Questions & rules", icon: "questions" },
      ],
    },
    {
      label: "Business",
      items: [
        { href: `${base}/emails`, label: "Emails", icon: "emails" },
        { href: `${base}/settings`, label: "Settings", icon: "settings" },
      ],
    },
  ];
  return platformAdmin ? [...groups, ADMIN] : groups;
}

/** Platform administration (no active business). Offers the way back to the user's businesses when they have any. */
export function platformNavigation({ hasWorkspaces }: { hasWorkspaces: boolean }): NavGroup[] {
  return hasWorkspaces ? [ADMIN, { label: "Workspace", items: [{ href: "/staff", label: "Your businesses", icon: "businesses", exact: true }] }] : [ADMIN];
}

const within = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isActive(item: NavItem, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (item.exact) return path === item.href;
  return within(path, item.href) || (item.also ?? []).some((prefix) => within(path, prefix));
}
