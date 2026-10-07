import { describe, expect, it } from "vitest";
import { attentionItems, closesIn, dashboardSchema, relativeDay, setupChecklist, shortDate, upcomingRows, type DashboardFacts } from "@/lib/dashboard";

const NOW = "2026-10-07T16:00:00Z"; // 12:00 in Toronto, 05:00 on Oct 8 in Kiritimati

function facts(over: Partial<DashboardFacts> = {}): DashboardFacts {
  return dashboardSchema.parse({
    now: NOW,
    planning_window_days: 7,
    upcoming: [],
    upcoming_more: false,
    submitted: [],
    awaiting_deposit: [],
    booking_check: [],
    planning: [],
    failed_emails: 0,
    setup: { identity_saved: true, tax_categories: ["standard"], used_tax_categories: ["standard"], active_packages: 3, usable_proposal_templates: 1, client_use_contract_templates: 1 },
    ...over,
  });
}

const ev = <T extends object>(id: string, date: string, extra: T) => ({ event_id: id, title: `Event ${id}`, event_date: date, ...extra });

describe("dates", () => {
  it("formats calendar dates without shifting them", () => {
    expect(shortDate("2027-01-01")).toBe("Fri, Jan 1, 2027");
  });
  it("counts today and tomorrow in the event's own time zone", () => {
    const now = new Date(NOW);
    expect(relativeDay("2026-10-07", "America/Toronto", now)).toBe("Today");
    expect(relativeDay("2026-10-08", "America/Toronto", now)).toBe("Tomorrow");
    expect(relativeDay("2026-10-08", "Pacific/Kiritimati", now)).toBe("Today");
    expect(relativeDay("2026-10-12", "America/Toronto", now)).toBe("In 5 days");
    expect(relativeDay("2026-11-20", "America/Toronto", now)).toBeNull();
  });
  it("says how long until planning closes, in whole days", () => {
    const now = new Date(NOW);
    expect(closesIn("2026-10-08T04:00:00Z", now)).toBe("within a day");
    expect(closesIn("2026-10-08T16:00:00Z", now)).toBe("in 1 day");
    expect(closesIn("2026-10-10T20:00:00Z", now)).toBe("in 3 days");
    expect(closesIn("2026-10-11T15:59:00Z", now)).toBe("in 4 days"); // not "3" a minute early
  });
});

describe("upcoming events", () => {
  it("uses the existing status labels, tells booked apart and says when the venue is missing", () => {
    const rows = upcomingRows(
      facts({
        upcoming: [
          { id: "a", title: "A", event_date: "2026-10-07", timezone: "America/Toronto", venue_name: null, lifecycle_status: "awaiting_signature", client_name: null, contract_signed: true },
          { id: "b", title: "B", event_date: "2026-12-01", timezone: "America/Toronto", venue_name: "Le Windsor", lifecycle_status: "booked", client_name: "Jo", contract_signed: true },
          { id: "c", title: "C", event_date: "2026-12-02", timezone: "America/Toronto", venue_name: null, lifecycle_status: "awaiting_deposit", client_name: "Kai", contract_signed: true },
        ],
      }),
      "dj",
    );
    expect(rows.map((r) => [r.status, r.booked, r.venue, r.relative, r.href])).toEqual([
      ["Contract signed · booking not checked yet", false, "Venue not set", "Today", "/staff/dj/events/a"],
      ["Booked", true, "Le Windsor", null, "/staff/dj/events/b"],
      ["Signed · awaiting deposit", false, "Venue not set", null, "/staff/dj/events/c"],
    ]);
  });
});

describe("needs attention", () => {
  const busy = facts({
    submitted: [ev("p", "2026-12-01", { proposal_id: "prop-1", revision: 2, submitted_at: NOW })],
    awaiting_deposit: [ev("d", "2026-11-01", { currency: "CAD", deposit_outstanding_cents: 50_000 }), ev("z", "2026-11-02", { currency: "CAD", deposit_outstanding_cents: null })],
    booking_check: [ev("l", "2026-10-30", {})],
    planning: [
      ev("soon", "2026-10-20", { timezone: "America/Toronto", state: "open", deadline: "2026-10-10T04:00:00Z", closes_at: "2026-10-10T04:00:00Z", requirements_met: 3, requirements_total: 8 }),
      ev("later", "2026-10-12", { timezone: "America/Toronto", state: "open", deadline: "2026-10-12T04:00:00Z", closes_at: "2026-10-12T04:00:00Z", requirements_met: 0, requirements_total: 2 }),
      ev("re", "2026-10-25", { timezone: "America/Toronto", state: "reopened", deadline: "2026-10-01T04:00:00Z", closes_at: "2026-10-09T20:00:00Z", requirements_met: 7, requirements_total: 8 }),
      ev("late", "2026-10-15", { timezone: "America/Toronto", state: "closed", deadline: "2026-10-01T04:00:00Z", closes_at: null, requirements_met: 1, requirements_total: 8 }),
      ev("full", "2026-10-16", { timezone: "America/Toronto", state: "open", deadline: "2026-10-09T04:00:00Z", closes_at: "2026-10-09T04:00:00Z", requirements_met: 8, requirements_total: 8 }),
    ],
  });
  const items = attentionItems(busy, "dj");

  it("words each task and links to where it can be done", () => {
    expect(items.map((i) => [i.kind, i.reason, i.href])).toEqual([
      ["proposal_submitted", "Proposal ready to review", "/staff/dj/proposals/prop-1"],
      ["planning_closed", "Planning closed with answers missing", "/staff/dj/events/late/planning"],
      ["planning_closing", "Reopened planning closes in 2 days", "/staff/dj/events/re/planning"],
      ["planning_closing", "Planning closes in 3 days", "/staff/dj/events/soon/planning"],
      ["planning_closing", "Planning closes in 5 days", "/staff/dj/events/later/planning"],
      ["deposit", "Signed · waiting for the deposit", "/staff/dj/events/d"],
      ["deposit", "Signed · waiting for the deposit", "/staff/dj/events/z"],
      ["booking_check", "Contract signed · booking not checked yet", "/staff/dj/events/l"],
    ]);
  });
  it("gives the amount when known and counts missing answers", () => {
    expect(items.find((i) => i.eventId === "d")?.detail).toBe("$500.00 still to receive before the booking is confirmed.");
    expect(items.find((i) => i.eventId === "z")?.detail).toBeNull();
    expect(items.find((i) => i.eventId === "late")?.detail).toBe("7 required answers missing. The client can no longer edit; you still can.");
    expect(items.find((i) => i.eventId === "re")?.detail).toBe("1 required answer missing.");
  });
  it("marks only closed planning as urgent and skips complete plans", () => {
    expect(items.filter((i) => i.tone === "urgent").map((i) => i.eventId)).toEqual(["late"]);
    expect(items.some((i) => i.eventId === "full")).toBe(false);
  });
  it("never lists the same task twice; different tasks of one event stay", () => {
    const twice = facts({
      awaiting_deposit: [ev("x", "2026-11-01", { currency: "CAD", deposit_outstanding_cents: 1 }), ev("x", "2026-11-01", { currency: "CAD", deposit_outstanding_cents: 1 })],
      planning: [ev("x", "2026-11-01", { timezone: "UTC", state: "closed", deadline: NOW, closes_at: null, requirements_met: 0, requirements_total: 1 })],
    });
    expect(attentionItems(twice, "dj").map((i) => i.key)).toEqual(["planning:x", "deposit:x"]);
  });
});

describe("setup checklist", () => {
  const keys = (f: DashboardFacts) => setupChecklist(f, "dj").filter((i) => !i.done).map((i) => i.key);

  it("is complete for a configured business, with gear, a logo and planning templates optional", () => {
    expect(keys(facts())).toEqual([]);
  });
  it("accepts an explicit no-tax category", () => {
    expect(keys(facts({ setup: { ...facts().setup, tax_categories: ["exempt"], used_tax_categories: ["exempt"] } }))).toEqual([]);
  });
  it("lists exactly what's missing for a new business", () => {
    const empty = facts({ setup: { identity_saved: false, tax_categories: [], used_tax_categories: [], active_packages: 0, usable_proposal_templates: 0, client_use_contract_templates: 0 } });
    expect(keys(empty)).toEqual(["identity", "taxes", "packages", "proposal-template", "contract-template"]);
  });
  it("flags a category used by active gear or packages without taxes", () => {
    const f = facts({ setup: { ...facts().setup, tax_categories: ["standard"], used_tax_categories: ["standard", "alcohol"] } });
    const taxes = setupChecklist(f, "dj").find((i) => i.key === "taxes")!;
    expect(taxes.done).toBe(false);
    expect(taxes.hint).toContain("alcohol");
    expect(taxes.href).toBe("/staff/dj/settings#taxes");
  });
  it("needs three active packages, and marks owner-only settings", () => {
    expect(keys(facts({ setup: { ...facts().setup, active_packages: 2 } }))).toEqual(["packages"]);
    expect(setupChecklist(facts(), "dj").filter((i) => i.ownerOnly).map((i) => i.key)).toEqual(["identity", "taxes", "contract-template"]);
  });
});
