import { describe, expect, it } from "vitest";
import type { DashboardFacts } from "@/lib/dashboard";
import { fromSetup, offerablePackages, readiness, requiredSetup, setupGuide, type SetupExtras } from "@/lib/setup";

type Setup = DashboardFacts["setup"] & { offerable_packages: number };
const configured: Setup = { identity_saved: true, tax_categories: ["standard"], used_tax_categories: ["standard"], active_packages: 3, offerable_packages: 3, usable_proposal_templates: 1, client_use_contract_templates: 1 };
const empty: Setup = { identity_saved: false, tax_categories: [], used_tax_categories: [], active_packages: 0, offerable_packages: 0, usable_proposal_templates: 0, client_use_contract_templates: 0 };
const fresh: SetupExtras = {
  hasLogo: false, hasBrandColor: false, depositPercent: 50, bookingPolicy: "on_deposit", bookingPolicyReviewed: false, activeGear: 0,
  activeQuestions: 0, activeContractTemplates: 0, activePlanningTemplates: 0, planningDefaults: [], planningLockDays: 14, events: 0,
};

const missing = (s: Setup) => requiredSetup(s, "dj").filter((t) => !t.done).map((t) => t.key);
const byKey = (s: Setup, x: SetupExtras) => new Map(setupGuide(s, x, "dj").flatMap((g) => g.tasks).map((t) => [t.key, t]));

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
    expect(taxes.href).toBe("/staff/dj/settings#taxes");
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
    expect([...t.values()].map((x) => [x.key, x.level, x.status])).toEqual([
      ["identity", "required", "not_started"],
      ["branding", "optional", "optional"],
      ["booking", "recommended", "not_started"],
      ["taxes", "required", "not_started"],
      ["gear", "optional", "optional"],
      ["packages", "required", "not_started"],
      ["proposal-template", "recommended", "not_started"],
      ["questions", "optional", "optional"],
      ["contract-template", "required", "not_started"],
      ["planning", "recommended", "not_started"],
      ["first-event", "optional", "optional"],
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
  it("treats default booking settings as unreviewed until both are saved", () => {
    expect(byKey(empty, fresh).get("booking")!.hint).toBe("50% deposit; bookings confirmed when the contract is signed and the deposit is received. Not reviewed yet.");
    expect(byKey(configured, fresh).get("booking")!.status).toBe("attention");
    expect(byKey(configured, { ...fresh, bookingPolicyReviewed: true }).get("booking")!.status).toBe("ready");
  });
  it("describes branding by what is actually saved, and keeps it optional", () => {
    const branding = (x: Partial<SetupExtras>) => byKey(configured, { ...fresh, ...x }).get("branding")!;
    expect(branding({})).toMatchObject({ label: "Customize branding", level: "optional", status: "optional", hint: "Add your logo or choose a brand colour." });
    expect(branding({ hasLogo: true })).toMatchObject({ status: "ready", hint: "Logo added." });
    expect(branding({ hasBrandColor: true })).toMatchObject({ status: "ready", hint: "Brand colour configured." });
    expect(branding({ hasLogo: true, hasBrandColor: true }).hint).toBe("Logo and brand colour configured.");
    expect(readiness(configured).readyCount).toBe(4); // without any branding
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
    expect(readiness(empty)).toEqual({
      proposals: ["Taxes", "Three packages"],
      contracts: ["Taxes", "Three packages", "Business details", "Contract template"],
      readyCount: 0,
      total: 4,
    });
    expect(readiness({ ...configured, identity_saved: false })).toMatchObject({ proposals: [], contracts: ["Business details"], readyCount: 3 });
    expect(readiness(configured)).toMatchObject({ proposals: [], contracts: [], readyCount: 4 });
  });
});

describe("links from the setup guide", () => {
  it("mark the page and keep the section", () => {
    expect(fromSetup("/staff/dj/settings#taxes")).toBe("/staff/dj/settings?from=setup#taxes");
    expect(fromSetup("/staff/dj/packages")).toBe("/staff/dj/packages?from=setup");
  });
});
