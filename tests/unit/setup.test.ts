import { describe, expect, it } from "vitest";
import type { DashboardFacts } from "@/lib/dashboard";
import {
  GUIDANCE_OPTIONS,
  GUIDANCE_WORKFLOWS,
  fromSetup,
  isSetupGuidance,
  offerablePackages,
  readiness,
  reminders,
  requiredSetup,
  setupGuide,
  taskStatusLabel,
  type SetupExtras,
  type SetupGuidance,
} from "@/lib/setup";

type Setup = DashboardFacts["setup"] & { offerable_packages: number };
const configured: Setup = { identity_saved: true, tax_categories: ["standard"], used_tax_categories: ["standard"], active_packages: 3, offerable_packages: 3, usable_proposal_templates: 1, client_use_contract_templates: 1 };
const empty: Setup = { identity_saved: false, tax_categories: [], used_tax_categories: [], active_packages: 0, offerable_packages: 0, usable_proposal_templates: 0, client_use_contract_templates: 0 };
const fresh: SetupExtras = {
  hasLogo: false, hasBrandColor: false, depositPercent: 50, bookingPolicy: "on_deposit", bookingPolicyReviewed: false, activeGear: 0,
  activeQuestions: 0, activeContractTemplates: 0, activePlanningTemplates: 0, planningDefaults: [], planningLockDays: 14, events: 0,
};

const missing = (s: Setup) => requiredSetup(s, "dj").filter((t) => !t.done).map((t) => t.key);
const byKey = (s: Setup, x: SetupExtras, g: SetupGuidance = "proposals_and_contracts") => new Map(setupGuide(s, x, "dj", g).flatMap((grp) => grp.tasks).map((t) => [t.key, t]));

describe("required setup (dashboard card)", () => {
  it("is complete for a configured business; gear, a logo, templates and planning are not required", () => {
    expect(missing(configured)).toEqual([]);
    expect(missing({ ...configured, usable_proposal_templates: 0 })).toEqual([]); // proposals can be built without a template
  });
  it("accepts an explicit no-tax category", () => {
    expect(missing({ ...configured, tax_categories: ["exempt"], used_tax_categories: ["exempt"] })).toEqual([]);
  });
  it("lists exactly what's missing for a new business", () => {
    expect(missing(empty)).toEqual(["identity", "taxes", "packages", "contract-template"]);
  });
  it("flags a category used by active gear or packages without taxes", () => {
    const taxes = requiredSetup({ ...configured, used_tax_categories: ["standard", "alcohol"] }, "dj").find((t) => t.key === "taxes")!;
    expect(taxes.done).toBe(false);
    expect(taxes.status).toBe("attention");
    expect(taxes.hint).toContain("alcohol");
    expect(taxes.href).toBe("/staff/dj/settings/taxes");
  });
  it("needs three active packages, and marks owner-only steps", () => {
    expect(missing({ ...configured, active_packages: 2, offerable_packages: 2 })).toEqual(["packages"]);
    expect(requiredSetup(configured, "dj").filter((t) => t.ownerOnly).map((t) => t.key)).toEqual(["identity", "taxes", "contract-template"]);
  });
});

describe("packages that can be offered", () => {
  const pkg = (...gear: (boolean | null)[]) => ({ package_items: gear.map((active) => ({ gear_items: active === null ? null : { active } })) });
  it("counts active packages whose included gear is all active, as sending requires", () => {
    expect(offerablePackages([pkg(), pkg(true, true), pkg(true, false), pkg(null)])).toBe(2);
  });
  it("aren't ready with three active packages when one includes archived gear", () => {
    const packages = requiredSetup({ ...configured, offerable_packages: 2 }, "dj").find((t) => t.key === "packages")!;
    expect(packages.done).toBe(false);
    expect(packages.status).toBe("attention");
    expect(packages.hint).toBe("2 of 3 packages can be offered: 1 active package includes archived gear.");
    expect(readiness({ ...configured, offerable_packages: 2 }).proposals).toEqual(["Three packages"]);
  });
});

describe("setup guide", () => {
  it("separates required, recommended and optional steps for a new business", () => {
    const t = byKey(empty, fresh);
    expect([...t.values()].map((x) => [x.key, x.level, x.status, x.workflow])).toEqual([
      ["identity", "required", "not_started", "contracts"],
      ["branding", "optional", "optional", null],
      ["taxes", "required", "not_started", "proposals"],
      ["gear", "optional", "optional", "proposals"],
      ["packages", "required", "not_started", "proposals"],
      ["proposal-template", "recommended", "not_started", "proposals"],
      ["questions", "optional", "optional", "proposals"],
      ["contract-template", "required", "not_started", "contracts"],
      ["booking", "recommended", "not_started", "contracts"],
      ["planning", "recommended", "not_started", null],
      ["first-event", "optional", "optional", null],
    ]);
  });
  it("groups steps by business, workflow, planning and getting started", () => {
    expect(setupGuide(empty, fresh, "dj", "proposals_and_contracts").map((g) => [g.key, g.title])).toEqual([
      ["business", "Business"],
      ["proposals", "Proposals"],
      ["contracts", "Contracts"],
      ["planning", "Planning"],
      ["start", "Getting started"],
    ]);
  });
  it("shows partial progress as needing attention", () => {
    const t = byKey({ ...empty, active_packages: 1, offerable_packages: 1 }, { ...fresh, activeContractTemplates: 1, activePlanningTemplates: 2 });
    expect(t.get("packages")!.status).toBe("attention");
    expect(t.get("packages")!.hint).toBe("1 of 3 active packages.");
    expect(t.get("contract-template")!.status).toBe("attention");
    expect(t.get("planning")!.status).toBe("attention");
    expect(t.get("planning")!.hint).toContain("not yet the default");
  });
  it("treats booking settings as reviewed once the booking policy is saved, whatever the legal details", () => {
    expect(byKey(empty, fresh).get("booking")!.hint).toBe("50% deposit; bookings confirmed when the contract is signed and the deposit is received. Not reviewed yet.");
    // Saved legal details don't review the booking policy, and unsaved ones don't hold it back.
    expect(byKey(configured, fresh).get("booking")!.status).toBe("not_started");
    expect(byKey(empty, { ...fresh, bookingPolicyReviewed: true }).get("booking")!).toMatchObject({ done: true, status: "ready" });
    expect(byKey(configured, { ...fresh, bookingPolicyReviewed: true, bookingPolicy: "on_signature", depositPercent: 25 }).get("booking")!.hint).toBe(
      "25% deposit; bookings confirmed when the contract is signed.",
    );
  });
  it("never calls a recommended step a problem, whatever its stored status", () => {
    const booking = byKey(configured, fresh).get("booking")!;
    expect(booking.done).toBe(false);
    expect(taskStatusLabel(booking)).toBe("Recommended");
    expect(taskStatusLabel(byKey(configured, { ...fresh, bookingPolicyReviewed: true }).get("booking")!)).toBe("Ready");
    // A required step that's started but incomplete still does.
    const partial = requiredSetup({ ...configured, used_tax_categories: ["exempt"] }, "dj").find((t) => t.key === "taxes")!;
    expect(taskStatusLabel(partial)).toBe("Needs attention");
  });
  it("describes branding by what is actually saved, and keeps it optional", () => {
    const branding = (x: Partial<SetupExtras>) => byKey(configured, { ...fresh, ...x }).get("branding")!;
    expect(branding({})).toMatchObject({ label: "Customize branding", level: "optional", status: "optional", hint: "Add your logo or choose a brand colour." });
    expect(branding({ hasLogo: true })).toMatchObject({ status: "ready", hint: "Logo added." });
    expect(branding({ hasBrandColor: true })).toMatchObject({ status: "ready", hint: "Brand colour configured." });
    expect(branding({ hasLogo: true, hasBrandColor: true }).hint).toBe("Logo and brand colour configured.");
    expect(readiness(configured)).toEqual({ proposals: [], contracts: [] }); // without any branding
  });
  it("marks saved optional steps ready", () => {
    const t = byKey(configured, { ...fresh, hasLogo: true, activeGear: 4, events: 1, planningDefaults: ["Wedding"] });
    expect(t.get("branding")!.status).toBe("ready");
    expect(t.get("gear")!.hint).toBe("4 active items.");
    expect(t.get("first-event")!.status).toBe("ready");
    expect(t.get("planning")!.hint).toBe("Default for Wedding events.");
  });
});

describe("readiness", () => {
  it("says what each workflow still needs", () => {
    expect(readiness(empty)).toEqual({ proposals: ["Taxes", "Three packages"], contracts: ["Business details", "Contract template"] });
    expect(readiness({ ...configured, identity_saved: false })).toEqual({ proposals: [], contracts: ["Business details"] });
    // A contract-first business with no catalog can send contracts.
    expect(readiness({ ...configured, tax_categories: [], used_tax_categories: [], active_packages: 0, offerable_packages: 0 })).toEqual({
      proposals: ["Taxes", "Three packages"],
      contracts: [],
    });
  });
});

describe("dashboard reminders", () => {
  const keys = (r: ReturnType<typeof reminders>) => r.map((x) => [x.workflow, x.tasks.map((t) => t.key)]);
  it("lists the missing required steps of each workflow asked about, in the order asked", () => {
    expect(keys(reminders(empty, "dj", ["contracts", "proposals"]))).toEqual([
      ["contracts", ["identity", "contract-template"]],
      ["proposals", ["taxes", "packages"]],
    ]);
    expect(keys(reminders(empty, "dj", ["contracts"]))).toEqual([["contracts", ["identity", "contract-template"]]]);
    expect(reminders(empty, "dj", [])).toEqual([]);
  });
  it("leaves out a workflow that's ready, and is empty once everything asked about is", () => {
    const contractsOnly = { ...configured, tax_categories: [], used_tax_categories: [], active_packages: 0, offerable_packages: 0 };
    expect(keys(reminders(contractsOnly, "dj", ["contracts", "proposals"]))).toEqual([["proposals", ["taxes", "packages"]]]);
    expect(reminders(contractsOnly, "dj", ["contracts"])).toEqual([]);
    expect(reminders(configured, "dj", ["contracts", "proposals"])).toEqual([]);
  });
  it("links each step to its page", () => {
    expect(reminders(empty, "dj", ["proposals"])[0].tasks.map((t) => t.href)).toEqual(["/staff/dj/settings/taxes", "/staff/dj/packages"]);
  });
});

describe("links from the setup guide", () => {
  it("mark the page and keep the section", () => {
    expect(fromSetup("/staff/dj/settings#taxes")).toBe("/staff/dj/settings?from=setup#taxes");
    expect(fromSetup("/staff/dj/packages")).toBe("/staff/dj/packages?from=setup");
  });
});

describe("setup guidance", () => {
  const statuses = (s: Setup, x: SetupExtras, g: SetupGuidance) => Object.fromEntries([...byKey(s, x, g).values()].map((t) => [t.key, t.status]));
  const skippedGroups = (g: SetupGuidance) => setupGuide(empty, fresh, "dj", g).filter((grp) => grp.skipped).map((grp) => grp.key);

  it("has exactly the three stored choices, each reminding about coherent workflows", () => {
    expect(GUIDANCE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["proposals_and_contracts", "Proposals and contracts"],
      ["contracts_only", "Contracts only"],
      ["none", "Planning only"],
    ]);
    expect(GUIDANCE_WORKFLOWS).toEqual({ proposals_and_contracts: ["contracts", "proposals"], contracts_only: ["contracts"], none: [] });
    expect([isSetupGuidance("contracts_only"), isSetupGuidance("proposals_only"), isSetupGuidance(null)]).toEqual([true, false, false]);
  });
  it("skips nothing by default", () => {
    expect(skippedGroups("proposals_and_contracts")).toEqual([]);
    expect(Object.values(statuses(empty, fresh, "proposals_and_contracts"))).not.toContain("skipped");
  });
  it("contracts only: unfinished proposal steps read Skipped, everything else is unchanged", () => {
    expect(skippedGroups("contracts_only")).toEqual(["proposals"]);
    expect(statuses(empty, fresh, "contracts_only")).toEqual({
      ...statuses(empty, fresh, "proposals_and_contracts"),
      taxes: "skipped", gear: "skipped", packages: "skipped", "proposal-template": "skipped", questions: "skipped",
    });
    const packages = byKey(empty, fresh, "contracts_only").get("packages")!;
    expect(taskStatusLabel(packages)).toBe("Skipped");
    expect(packages.done).toBe(false); // never pretends to be complete
    expect(taskStatusLabel(byKey(empty, fresh, "contracts_only").get("proposal-template")!)).toBe("Skipped"); // not "Recommended"
  });
  it("planning only: proposal and contract steps, including business details, read Skipped", () => {
    expect(skippedGroups("none")).toEqual(["proposals", "contracts"]);
    const t = statuses(empty, fresh, "none");
    expect(Object.entries(t).filter(([, v]) => v === "skipped").map(([k]) => k)).toEqual(
      ["identity", "taxes", "gear", "packages", "proposal-template", "questions", "contract-template", "booking"],
    );
    expect([t.branding, t.planning, t["first-event"]]).toEqual(["optional", "not_started", "optional"]);
  });
  it("keeps a finished step Ready in a skipped workflow", () => {
    const t = byKey({ ...empty, tax_categories: ["standard"] }, { ...fresh, activeGear: 2, bookingPolicyReviewed: true }, "none");
    expect([t.get("taxes")!.status, t.get("gear")!.status, t.get("booking")!.status]).toEqual(["ready", "ready", "ready"]);
    expect(t.get("packages")!.status).toBe("skipped");
  });
  it("never changes what can actually be sent", () => {
    // readiness takes no guidance: a skipped workflow is reported exactly as it is.
    expect(readiness(empty)).toEqual({ proposals: ["Taxes", "Three packages"], contracts: ["Business details", "Contract template"] });
  });
  it("decides the dashboard's reminders", () => {
    const keys = (g: SetupGuidance) => reminders(empty, "dj", GUIDANCE_WORKFLOWS[g]).map((r) => r.workflow);
    expect(keys("proposals_and_contracts")).toEqual(["contracts", "proposals"]);
    expect(keys("contracts_only")).toEqual(["contracts"]);
    expect(keys("none")).toEqual([]);
  });
});
