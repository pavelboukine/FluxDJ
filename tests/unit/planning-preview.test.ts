import { describe, expect, it } from "vitest";
import { SAMPLE_EVENT, clientVisibleStructure, eventPreviewView, templatePreviewView } from "@/lib/planning/preview";
import type { PlanStructure, StaffPlanningView } from "@/lib/planning/view";

const structure: PlanStructure = {
  general: [
    { id: "g1", key: "basics", label: "Event basics", editor: "basics", removable: false, disabled: false },
    { id: "g2", key: "contacts_vendors", label: "Contacts and vendors", editor: "contacts", removable: true, disabled: true },
  ],
  stages: [
    {
      id: "s1", key: "ceremony", label: "Ceremony", editor: "stage_ceremony", disabled: false,
      moments: [
        { id: "m1", key: "processional", label: "Processional", editor: "processional", disabled: false },
        { id: "m2", key: "recessional", label: "Recessional", editor: "moment_songs", disabled: true },
      ],
    },
    { id: "s2", key: "cocktail", label: "Cocktail", editor: "stage_cocktail", disabled: true, moments: [] },
  ],
};
const brand = { displayName: "DJ Co", brandColors: { primary: "#112233" } };

describe("template preview view", () => {
  const view = templatePreviewView({ structure, brand, djName: "Sam", eventType: "wedding", timezone: "America/Toronto", today: "2026-11-08" });

  it("is a clearly labelled sample event, three months out, with no answers, deadline or progress", () => {
    expect(view.event).toEqual({
      id: "preview", title: SAMPLE_EVENT.title, event_type: "wedding", event_date: "2027-02-06", timezone: "America/Toronto",
      venue_name: SAMPLE_EVENT.venueName, venue_address: null,
    });
    expect(view.editing).toBeNull();
    expect(view.basics).toEqual({ item_id: "g1", answers: {}, revision: 0 });
    expect([view.stage_details, view.music, view.moments, view.imported, view.event_contacts]).toEqual([{}, {}, {}, null, []]);
    expect(view.progress).toMatchObject({ items: [], requirements_total: 0, percent: null });
    expect(view.brand).toEqual({ display_name: "DJ Co", brand_colors: { primary: "#112233" } });
    expect(view.dj_name).toBe("Sam");
  });

  it("defaults the event type and keeps the template's structure as is", () => {
    expect(templatePreviewView({ structure, brand, djName: null, eventType: null, timezone: "UTC", today: "2026-12-15" }).event).toMatchObject({ event_type: "wedding", event_date: "2027-03-15" });
    expect(view.structure).toBe(structure);
  });
});

describe("event preview view", () => {
  const staff = {
    plan: {
      id: "p", origin: "template", initialized_via: "staff", created_at: "2026-10-01T00:00:00Z", source_template_id: null, source_template_name: null,
      structure_version: 3, client_opened_at: null, client_opened_by: null,
    },
    editing: {
      state: "closed", deadline: "2027-06-01T04:00:00Z", closes_at: null, closed_by_dj: true, timezone: "America/Toronto",
      now: "2026-11-08T00:00:00Z", cutoff_days: 14, business_days: 14, expected_deadline: "2027-06-01T04:00:00Z", schedule_changed: false,
      reopened_until: null, reopen_active: false, reopen_max_days: 14, closed_at: "2026-11-01T00:00:00Z", version: 2, history: [],
    },
    structure,
    basics: { item_id: "g1", answers: { guest_count: 120 }, revision: 4, updated_by: "client", updated_at: "2026-11-01T00:00:00Z" },
    stage_details: { s1: { answers: { start_time: "15:00" }, revision: 1 } },
    music: {},
    moments: { m1: { answers: { participants: [] }, revision: 2 } },
    event_contacts: [{ id: "c", name: "Ana", phone: null, primary: true }],
    timeline_warnings: [{ item_id: "s1", key: "x", message: "Check" }],
    imported: null,
    progress: { scope: "available_sections_only", items: [], requirements_total: 9, requirements_met: 3, percent: 33, available_sections: 3, complete_sections: 1, unavailable_sections: 0 },
  } as unknown as Extract<StaffPlanningView, { plan: object }>;
  const event = { id: "e", title: "Ana & Bo", event_type: "wedding", event_date: "2027-06-15", timezone: "America/Toronto", venue_name: "Hall", venue_address: null };
  const view = eventPreviewView({ view: staff, event, brand, djName: "Sam" });

  it("shows only what the client sees, with the answers saved so far", () => {
    expect(view.structure.general.map((g) => g.key)).toEqual(["basics"]);
    expect(view.structure.stages.map((s) => [s.key, s.moments.map((m) => m.key)])).toEqual([["ceremony", ["processional"]]]);
    expect(view.basics).toEqual({ item_id: "g1", answers: { guest_count: 120 }, revision: 4 });
    expect(view.stage_details).toBe(staff.stage_details);
    expect(view.moments).toBe(staff.moments);
    expect(view.event).toBe(event);
  });

  it("keeps the client's editing state, without staff-only details, and no progress or warnings", () => {
    expect(view.editing).toEqual({ state: "closed", deadline: "2027-06-01T04:00:00Z", closes_at: null, closed_by_dj: true, timezone: "America/Toronto" });
    expect(view.progress.items).toEqual([]);
    expect(view.timeline_warnings).toEqual([]);
    expect(eventPreviewView({ view: { ...staff, editing: null }, event, brand, djName: null }).editing).toBeNull();
  });

  it("clientVisibleStructure leaves out hidden items only", () => {
    expect(clientVisibleStructure({ general: [], stages: [] })).toEqual({ general: [], stages: [] });
  });
});
