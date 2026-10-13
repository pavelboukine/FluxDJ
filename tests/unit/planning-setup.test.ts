import { describe, expect, it } from "vitest";
import { clientPlanningViewSchema, planAwaitingSetup, type StaffPlanningView } from "@/lib/planning/view";

type Plan = Extract<StaffPlanningView, { plan: object }>;

function view(over: { origin?: "template" | "fallback"; via?: "booking" | "backfill" | "staff"; general?: Plan["structure"]["general"]; stages?: Plan["structure"]["stages"] } = {}): StaffPlanningView {
  return {
    plan: {
      id: "p",
      origin: over.origin ?? "fallback",
      initialized_via: over.via ?? "booking",
      created_at: "2026-10-13T03:28:17Z",
      source_template_id: over.origin === "template" ? "t" : null,
      source_template_name: over.origin === "template" ? "Wedding" : null,
      structure_version: 1,
    },
    structure: {
      general: over.general ?? [{ id: "b", key: "basics", label: "Event basics", editor: "basics", removable: false, disabled: false }],
      stages: over.stages ?? [],
    },
  } as unknown as StaffPlanningView;
}

const stage = (disabled: boolean, moments: boolean[] = []) => ({
  id: "s", key: "party", label: "Party", editor: null, disabled,
  moments: moments.map((d, i) => ({ id: `m${i}`, key: `m${i}`, label: "Moment", editor: null, disabled: d })),
});

describe("planning awaiting setup", () => {
  it("booking (or backfill) with Event basics only awaits staff setup", () => {
    expect(planAwaitingSetup(view())).toBe(true);
    expect(planAwaitingSetup(view({ via: "backfill" }))).toBe(true);
    expect(planAwaitingSetup(view({ stages: [stage(true, [true])] }))).toBe(true);
  });

  it("is set up once a template is applied, staff chose Event basics only, or anything else is enabled", () => {
    expect(planAwaitingSetup(view({ origin: "template" }))).toBe(false);
    expect(planAwaitingSetup(view({ origin: "template", stages: [stage(true)] }))).toBe(false);
    expect(planAwaitingSetup(view({ via: "staff" }))).toBe(false);
    expect(planAwaitingSetup(view({ stages: [stage(false)] }))).toBe(false);
    expect(planAwaitingSetup(view({ stages: [stage(true, [false])] }))).toBe(false);
    expect(
      planAwaitingSetup(view({ general: [
        { id: "b", key: "basics", label: "Event basics", editor: "basics", removable: false, disabled: false },
        { id: "d", key: "dj_preferences", label: "DJ preferences", editor: "dj_preferences", removable: true, disabled: false },
      ] })),
    ).toBe(false);
    expect(planAwaitingSetup({ plan: null })).toBe(false);
  });

  it("the client view's setting_up state carries only the safe event details", () => {
    const parsed = clientPlanningViewSchema.parse({
      state: "setting_up",
      brand: { display_name: "BOUPROD", brand_colors: {} },
      event: { id: "e", title: "Wedding", event_type: "wedding", event_date: "2027-08-28", timezone: "America/Toronto", venue_name: null, venue_address: null },
    });
    expect(parsed.state).toBe("setting_up");
    expect(Object.keys(parsed).sort()).toEqual(["brand", "event", "state"]);
  });
});
