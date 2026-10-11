import { describe, expect, it } from "vitest";
import { planSections } from "@/lib/planning/navigation";
import { addableItems, itemRoles, structureCounts, templateStructure, type LibraryEntry, type TemplateItemRow } from "@/lib/planning/template-structure";

// A slice of the database library (private.planning_library), with its real editors.
const lib = (kind: string, key: string, default_label: string, editor: string | null, parent_keys: string[] | null = null, removable = true): LibraryEntry => ({
  kind,
  key,
  parent_keys,
  default_label,
  description: null,
  editor,
  removable,
});
const library: LibraryEntry[] = [
  lib("general", "basics", "Event basics", "basics", null, false),
  lib("general", "contacts_vendors", "Contacts and vendors", "contacts"),
  lib("general", "dj_preferences", "DJ expectations and overall preferences", "preferences"),
  lib("stage", "ceremony", "Ceremony", "stage_ceremony"),
  lib("stage", "reception_entrance", "Reception entrance", "stage_entrance"),
  lib("stage", "special_dances", "Special dances", null),
  lib("stage", "arrival", "Guest arrival", null),
  lib("stage", "dinner", "Dinner", "stage_dinner"),
  lib("stage", "party", "Party", "stage_party"),
  lib("moment", "ceremony_details", "Ceremony details", "stage_details", ["ceremony"]),
  lib("moment", "processional", "Processional participants", "processional", ["ceremony"]),
  lib("moment", "recessional", "Recessional", "moment_songs", ["ceremony"]),
  lib("moment", "introductions", "Introductions", "introductions", ["reception_entrance"]),
  lib("moment", "entrance_participants", "Participants and names", "included", ["reception_entrance"]),
  lib("moment", "first_dance", "First dance", "moment_songs", ["special_dances"]),
  lib("moment", "speeches", "Speeches and toasts", "speeches", ["dinner", "party"]),
  lib("moment", "cake_cutting", "Cake cutting", "moment_songs", ["dinner", "party"]),
  lib("moment", "must_play", "Must play", "music_requests", ["party"]),
];

const row = (id: string, kind: string, key: string, label: string, position: number, parent_id: string | null = null): TemplateItemRow => ({ id, kind, key, label, position, parent_id });

// Saved in an order unlike the library's, with a custom label, rows shuffled.
const items: TemplateItemRow[] = [
  row("s2", "stage", "ceremony", "Vows", 2),
  row("g2", "general", "dj_preferences", "DJ preferences", 2),
  row("m3", "moment", "recessional", "Recessional", 1, "s2"),
  row("m4", "moment", "ceremony_details", "Ceremony details", 2, "s2"),
  row("s1", "stage", "special_dances", "Special dances", 1),
  row("m1", "moment", "first_dance", "First dance", 1, "s1"),
  row("g1", "general", "basics", "Event basics", 1),
  row("s3", "stage", "reception_entrance", "Reception entrance", 3),
  row("m5", "moment", "entrance_participants", "Participants and names", 1, "s3"),
  row("s4", "stage", "arrival", "Guest arrival", 4),
  row("s5", "stage", "dinner", "Dinner", 5),
  row("m6", "moment", "speeches", "Speeches and toasts", 1, "s5"),
];

describe("templateStructure", () => {
  const structure = templateStructure(items, library);

  it("keeps the saved order and labels, with moments under their stage", () => {
    expect(structure.general.map((g) => g.key)).toEqual(["basics", "dj_preferences"]);
    expect(structure.stages.map((s) => s.label)).toEqual(["Special dances", "Vows", "Reception entrance", "Guest arrival", "Dinner"]);
    expect(structure.stages[1].moments.map((m) => m.key)).toEqual(["recessional", "ceremony_details"]);
  });

  it("takes editors and removability from the library and hides nothing", () => {
    expect(structure.general[0]).toMatchObject({ editor: "basics", removable: false, disabled: false });
    expect(structure.stages[1].editor).toBe("stage_ceremony");
    expect([...structure.stages, ...structure.stages.flatMap((s) => s.moments)].every((i) => !i.disabled)).toBe(true);
  });

  it("gives the client sections a plan from it would have, in the saved order", () => {
    expect(planSections(structure).map((s) => s.key)).toEqual(["basics", "dj_preferences", "special_dances", "ceremony", "reception_entrance", "dinner"]);
  });
});

describe("itemRoles", () => {
  const structure = templateStructure(items, library);
  const roles = itemRoles(structure, library);

  it("says which items are client sections, and why Event basics stays", () => {
    expect(roles.get("basics")).toMatchObject({ kind: "section", text: expect.stringContaining("can't be removed") });
    expect(roles.get("dj_preferences")).toMatchObject({ kind: "section", text: expect.stringContaining("planning progress") });
    expect(roles.get("ceremony")).toMatchObject({ kind: "section", text: expect.stringContaining("1 moment to fill in") });
  });

  it("explains stages that only group moments, and stages clients never see", () => {
    expect(roles.get("special_dances")).toMatchObject({ kind: "group", text: expect.stringContaining("no questions") });
    expect(roles.get("arrival")).toMatchObject({ kind: "not_shown", text: "Not shown to clients until it has a moment to fill in." });
  });

  it("points placeholders to where they are answered", () => {
    expect(roles.get("ceremony_details")).toEqual({ kind: "details", text: "Asked in the Vows details, not as a separate moment." });
    // Introductions isn't in the template, so the hint says what to add.
    expect(roles.get("entrance_participants")).toMatchObject({ kind: "covered", text: expect.stringContaining("Answered in Introductions, which isn't in this stage") });
    const withIntro = templateStructure([...items, row("m7", "moment", "introductions", "Grand entrance", 2, "s3")], library);
    expect(itemRoles(withIntro, library).get("entrance_participants")?.text).toBe("Answered in Grand entrance. Clients see it as a pointer, not a separate task.");
  });

  it("marks moments with their own editor as filled in by the client", () => {
    expect(roles.get("first_dance")?.kind).toBe("fill");
    expect(roles.get("speeches")?.kind).toBe("fill");
  });
});

describe("addableItems", () => {
  const addable = addableItems(templateStructure(items, library), library);

  it("lists what the template doesn't have, by where it can go", () => {
    expect(addable.general.map((l) => l.key)).toEqual(["contacts_vendors"]);
    expect(addable.stages.map((l) => l.key)).toEqual(["party"]);
    expect(addable.momentsFor("ceremony").map((l) => l.key)).toEqual(["processional"]);
  });

  it("never offers a moment already in another stage (keys are unique per template)", () => {
    expect(addable.momentsFor("dinner").map((l) => l.key)).toEqual(["cake_cutting"]);
    expect(addable.momentsFor("party").map((l) => l.key)).toEqual(["cake_cutting", "must_play"]);
  });
});

it("structureCounts counts by kind", () => {
  expect(structureCounts(items)).toEqual({ general: 2, stages: 5, moments: 5 });
});
