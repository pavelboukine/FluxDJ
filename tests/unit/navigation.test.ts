import { describe, expect, it } from "vitest";
import { isActive, legacySettingsHref, platformNavigation, settingsNavigation, staffNavigation, type NavGroup } from "@/lib/navigation";

const labels = (groups: NavGroup[]) => groups.map((g) => [g.label, g.items.map((i) => i.label)]);
const activeLabels = (groups: NavGroup[], path: string) => groups.flatMap((g) => g.items).filter((i) => isActive(i, path)).map((i) => i.label);

describe("staff navigation", () => {
  it("lists the groups in order, with Admin only for platform administrators", () => {
    expect(labels(staffNavigation("dj", { platformAdmin: false }))).toEqual([
      ["Main", ["Dashboard", "Events", "Clients"]],
      ["Catalog", ["Gear", "Packages"]],
      ["Templates", ["Proposal templates", "Contract templates", "Planning templates", "Questions & rules"]],
      ["Business", ["Emails", "Settings"]],
    ]);
    const admin = staffNavigation("dj", { platformAdmin: true });
    expect(labels(admin).at(-1)).toEqual(["Admin", ["DJ invitations", "Workspaces", "Operations"]]);
  });

  it("points only at existing routes", () => {
    const hrefs = staffNavigation("dj", { platformAdmin: true }).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toEqual([
      "/staff/dj",
      "/staff/dj/events",
      "/staff/dj/clients",
      "/staff/dj/gear",
      "/staff/dj/packages",
      "/staff/dj/templates",
      "/staff/dj/contract-templates",
      "/staff/dj/planning-templates",
      "/staff/dj/questions",
      "/staff/dj/emails",
      "/staff/dj/settings",
      "/platform/invitations",
      "/platform/workspaces",
      "/platform/operations",
    ]);
  });

  it("highlights exactly one item on list and detail pages", () => {
    const nav = staffNavigation("dj", { platformAdmin: true });
    expect(activeLabels(nav, "/staff/dj")).toEqual(["Dashboard"]);
    expect(activeLabels(nav, "/staff/dj/")).toEqual(["Dashboard"]);
    expect(activeLabels(nav, "/staff/dj/events/new")).toEqual(["Events"]);
    expect(activeLabels(nav, "/staff/dj/events/abc/run-sheet")).toEqual(["Events"]);
    expect(activeLabels(nav, "/staff/dj/proposals/abc")).toEqual(["Events"]);
    expect(activeLabels(nav, "/staff/dj/contracts/abc")).toEqual(["Events"]);
    expect(activeLabels(nav, "/staff/dj/templates/abc")).toEqual(["Proposal templates"]);
    expect(activeLabels(nav, "/staff/dj/contract-templates/abc")).toEqual(["Contract templates"]);
    expect(activeLabels(nav, "/staff/dj/planning-templates")).toEqual(["Planning templates"]);
    expect(activeLabels(nav, "/staff/dj/questions/abc")).toEqual(["Questions & rules"]);
    expect(activeLabels(nav, "/platform/workspaces")).toEqual(["Workspaces"]);
    expect(activeLabels(nav, "/platform/operations")).toEqual(["Operations"]);
    // Another business's pages, or a slug that merely starts the same, light nothing.
    expect(activeLabels(nav, "/staff/dj2/events")).toEqual([]);
    expect(activeLabels(nav, "/staff/other")).toEqual([]);
  });
});

describe("platform navigation", () => {
  it("offers the way back only to administrators who have a business", () => {
    expect(labels(platformNavigation({ hasWorkspaces: false }))).toEqual([["Admin", ["DJ invitations", "Workspaces", "Operations"]]]);
    expect(labels(platformNavigation({ hasWorkspaces: true })).at(-1)).toEqual(["Workspace", ["Your businesses"]]);
    expect(activeLabels(platformNavigation({ hasWorkspaces: true }), "/staff/dj")).toEqual([]);
  });
});

describe("settings navigation", () => {
  it("groups the six pages, with Team and Setup still highlighting Settings in the staff menu", () => {
    expect(settingsNavigation("dj").map((g) => [g.label, g.pages.map((p) => p.label)])).toEqual([
      ["General", ["Business profile", "Branding", "Team & access"]],
      ["Operations", ["Bookings", "Taxes & payments", "Client planning"]],
    ]);
    const nav = staffNavigation("dj", { platformAdmin: false });
    for (const path of ["/staff/dj/settings", "/staff/dj/settings/taxes", "/staff/dj/settings/team", "/staff/dj/setup"]) {
      expect(activeLabels(nav, path)).toEqual(["Settings"]);
    }
  });

  it("highlights exactly one settings page", () => {
    const pages = settingsNavigation("dj").flatMap((g) => g.pages);
    expect(pages.filter((p) => isActive(p, "/staff/dj/settings/taxes")).map((p) => p.label)).toEqual(["Taxes & payments"]);
    expect(pages.filter((p) => isActive(p, "/staff/dj/settings"))).toEqual([]);
  });

  it("forwards every anchor of the old single page, keeping the query", () => {
    const expected: Record<string, string> = {
      "#profile": "profile",
      "#legal": "profile#legal",
      "#reply-to": "profile#reply-to",
      "#branding": "branding",
      "#branding-section": "branding",
      "#bookings": "bookings",
      "#booking": "bookings",
      "#proposal-default": "bookings#proposal-default",
      "#taxes": "taxes",
      "#planning": "planning",
      "#planning-defaults": "planning",
      "#dj-name": "planning#dj-name",
      "#access": "team",
    };
    for (const [hash, target] of Object.entries(expected)) expect(legacySettingsHref("dj", hash)).toBe(`/staff/dj/settings/${target}`);
    expect(legacySettingsHref("dj", "#taxes", "?from=setup")).toBe("/staff/dj/settings/taxes?from=setup");
    expect(legacySettingsHref("dj", "#legal", "?from=setup")).toBe("/staff/dj/settings/profile?from=setup#legal");
  });

  it("ignores anything that was not an anchor of the old page", () => {
    for (const hash of ["", "#", "#unknown", "#constructor", "#__proto__", "taxes"]) expect(legacySettingsHref("dj", hash)).toBeNull();
  });
});
