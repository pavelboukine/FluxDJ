import { describe, expect, it } from "vitest";
import {
  PROVIDED_SECTION,
  firstIncompleteSection,
  neighbours,
  planSections,
  resolveSection,
  sectionSearch,
  sectionStatus,
} from "@/lib/planning/navigation";
import type { PlanProgress, PlanStructure } from "@/lib/planning/view";

const m = (id: string, key: string, label: string, editor: string | null) => ({ id, key, label, editor, disabled: false });

// A wedding-like plan with custom labels and an order unlike the library's.
const structure: PlanStructure = {
  general: [
    { id: "g1", key: "basics", label: "The basics", editor: "basics", removable: false, disabled: false },
    { id: "g2", key: "dj_preferences", label: "What matters to us", editor: "preferences", removable: true, disabled: false },
    { id: "g3", key: "contacts_vendors", label: "Who to call", editor: "contacts", removable: true, disabled: false },
  ],
  stages: [
    {
      id: "s1", key: "cocktail", label: "Drinks first", editor: "stage_cocktail", disabled: false,
      moments: [m("m1", "cocktail_details", "Where and when", "stage_details"), m("m2", "cocktail_music", "Background", "music_background")],
    },
    {
      id: "s2", key: "ceremony", label: "Vows", editor: "stage_ceremony", disabled: false,
      moments: [m("m3", "processional", "Walk in", "processional"), { ...m("m4", "couple_entrance", "Couple", "moment_songs"), disabled: true }],
    },
    // A container with nothing to fill in.
    { id: "s3", key: "special_dances", label: "Dances", editor: null, disabled: false, moments: [m("m5", "first_dance_placeholder", "Soon", null)] },
    {
      id: "s4", key: "reception_entrance", label: "Grand entrance", editor: "stage_entrance", disabled: false,
      moments: [m("m6", "introductions", "Introductions", "introductions"), m("m7", "entrance_participants", "Names", "included"), m("m8", "dedications", "Dedications", null)],
    },
    { id: "s5", key: "closing", label: "Hidden", editor: "stage_closing", disabled: true, moments: [] },
  ],
};

function progress(items: { id: string; key: string; states: ("answered" | "unanswered" | "not_applicable")[]; discuss?: boolean; started?: boolean }[]): PlanProgress {
  const out = items.map((i) => {
    const met = i.states.filter((s) => s !== "unanswered").length;
    return {
      item_id: i.id, key: i.key,
      state: (met === i.states.length ? "complete" : met > 0 || i.started ? "in_progress" : "not_started") as "complete" | "in_progress" | "not_started",
      requirements: i.states.map((state, n) => ({ key: `r${n}`, state, ...(i.discuss && state === "unanswered" ? { discuss: true } : {}) })),
      met, total: i.states.length,
    };
  });
  const total = out.reduce((n, i) => n + i.total, 0);
  const met = out.reduce((n, i) => n + i.met, 0);
  return {
    scope: "available_sections_only", items: out, requirements_total: total, requirements_met: met, percent: total ? Math.floor((met * 100) / total) : null,
    available_sections: out.length, complete_sections: out.filter((i) => i.state === "complete").length, unavailable_sections: 0,
  };
}

describe("planning sections", () => {
  const sections = planSections(structure);

  it("keeps the configured order and labels, by key; drops hidden items and containers with nothing to fill in", () => {
    expect(sections.map((s) => [s.key, s.label])).toEqual([
      ["basics", "The basics"],
      ["dj_preferences", "What matters to us"],
      ["contacts_vendors", "Who to call"],
      ["cocktail", "Drinks first"],
      ["ceremony", "Vows"],
      ["reception_entrance", "Grand entrance"],
    ]);
  });

  it("lists only moments with their own editor; covered moments aren't separate tasks; unavailable ones are named", () => {
    const cocktail = sections.find((s) => s.key === "cocktail")!;
    expect(cocktail.moments.map((x) => x.key)).toEqual(["cocktail_music"]);
    expect(cocktail.detailsLabel).toBe("Where and when");
    expect(cocktail.itemIds).toEqual(["s1", "m2"]);
    const ceremony = sections.find((s) => s.key === "ceremony")!;
    expect(ceremony.moments.map((x) => x.key)).toEqual(["processional"]);
    const entrance = sections.find((s) => s.key === "reception_entrance")!;
    expect(entrance.moments.map((x) => x.key)).toEqual(["introductions"]);
    expect(entrance.unavailable).toEqual(["Dedications"]);
    expect(entrance.covered).toEqual([{ label: "Names", by: "Introductions" }]);
  });

  it("a Simple Party plan stays small", () => {
    const party = planSections({
      general: [{ id: "b", key: "basics", label: "Event basics", editor: "basics", removable: false, disabled: false }],
      stages: [{ id: "p", key: "party", label: "Party", editor: "stage_party", disabled: false, moments: [m("mp", "must_play", "Must play", "music_requests")] }],
    });
    expect(party.map((s) => s.key)).toEqual(["basics", "party"]);
  });

  it("summarizes the database's progress per section without new rules", () => {
    const p = progress([
      { id: "g1", key: "basics", states: ["answered", "answered"] },
      { id: "g2", key: "dj_preferences", states: ["not_applicable"] },
      { id: "s1", key: "cocktail", states: ["answered", "unanswered"], discuss: true },
      { id: "m2", key: "cocktail_music", states: ["unanswered"] },
      { id: "s2", key: "ceremony", states: ["unanswered"] },
      { id: "m3", key: "processional", states: ["unanswered"] },
    ]);
    const status = (key: string, warnings = [] as { item_id: string; key: string; message: string }[]) =>
      sectionStatus(sections.find((s) => s.key === key)!, p, warnings);
    expect(status("basics").state).toBe("complete");
    expect(status("dj_preferences").state).toBe("not_applicable");
    // Discuss with DJ stays open: never complete.
    expect(status("cocktail")).toMatchObject({ state: "in_progress", met: 1, total: 3, discuss: 1, firstOpenItem: "s1" });
    expect(status("ceremony")).toMatchObject({ state: "not_started", met: 0, total: 2 });
    expect(status("contacts_vendors").state).toBe("nothing");
    expect(status("basics", [{ item_id: "g1", key: "basics", message: "x" }])).toMatchObject({ state: "complete", warnings: 1, firstOpenItem: "g1" });
    expect(firstIncompleteSection(sections, p, [])?.key).toBe("cocktail");
  });

  it("finds nothing to continue when every available requirement is answered or not applicable", () => {
    const p = progress([
      { id: "g1", key: "basics", states: ["answered"] },
      { id: "s1", key: "cocktail", states: ["not_applicable"] },
    ]);
    expect(firstIncompleteSection(sections, p, [])).toBeNull();
  });

  it("resolves the section parameter safely", () => {
    expect(resolveSection("ceremony", sections)).toBe("ceremony");
    expect(resolveSection(null, sections)).toBeNull();
    expect(resolveSection("closing", sections)).toBeNull(); // hidden
    expect(resolveSection("special_dances", sections)).toBeNull(); // nothing to fill in
    expect(resolveSection("Vows", sections)).toBeNull(); // labels are never identifiers
    expect(resolveSection(PROVIDED_SECTION, sections, [])).toBeNull();
    expect(resolveSection(PROVIDED_SECTION, sections, [PROVIDED_SECTION])).toBe(PROVIDED_SECTION);
  });

  it("orders Previous and Next from the overview to the extra views", () => {
    expect(neighbours(sections, [PROVIDED_SECTION], null)).toEqual({ previous: null, next: { key: "basics" } });
    expect(neighbours(sections, [PROVIDED_SECTION], "basics")).toEqual({ previous: { key: null }, next: { key: "dj_preferences" } });
    expect(neighbours(sections, [PROVIDED_SECTION], "reception_entrance").next).toEqual({ key: PROVIDED_SECTION });
    expect(neighbours(sections, [], "reception_entrance").next).toBeNull();
  });

  it("builds the URL search while keeping other parameters", () => {
    expect(sectionSearch("", "ceremony")).toBe("?section=ceremony");
    expect(sectionSearch("?section=ceremony&x=1", null)).toBe("?x=1");
    expect(sectionSearch("?section=ceremony", null)).toBe("");
  });
});
