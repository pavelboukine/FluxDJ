import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUMMARY_ELSEWHERE, questionSummary } from "@/lib/planning/question-summaries";
import { STAGE_EDITORS, STAGE_LAYOUT } from "@/lib/planning/stages";

/** Every editor in private.planning_library(), read from the committed schema snapshot (the database's own list). */
function libraryEditors(): string[] {
  const snapshot = readFileSync("supabase/schema-snapshot.sql", "utf8");
  const start = snapshot.indexOf('CREATE OR REPLACE FUNCTION "private"."planning_library"()');
  const body = snapshot.slice(start, snapshot.indexOf("$$;", start));
  const editors = new Set<string>();
  for (const row of body.matchAll(/^\s*\('(?:general|stage|moment)',.*$/gm)) {
    // (kind, key, parent_keys, default_label, description, editor, removable, library_order): the editor sits just before the boolean.
    const editor = /,\s*(?:'([a-z_]+)'|null::text|null)\s*,\s*(?:true|false)\s*,\s*\d+\s*\)/.exec(row[0])?.[1];
    if (editor) editors.add(editor);
  }
  return [...editors].sort();
}

describe("what clients are asked (template editor)", () => {
  it("every library editor has a summary, or is answered elsewhere", () => {
    const editors = libraryEditors();
    expect(editors.length).toBeGreaterThan(15);
    const missing = editors.filter((e) => !(SUMMARY_ELSEWHERE as readonly string[]).includes(e) && questionSummary(e) === null);
    expect(missing).toEqual([]);
    for (const e of SUMMARY_ELSEWHERE) expect(editors).toContain(e);
  });

  it("stage details list exactly the client form's questions, in its order", () => {
    for (const editor of STAGE_EDITORS) {
      const labels = questionSummary(editor)!.questions.map((q) => q.label);
      for (const block of STAGE_LAYOUT[editor]) {
        if ("label" in block) expect(labels).toContain(block.label.replace(/\s*\((needed|optional)\)$/, ""));
      }
    }
    expect(questionSummary("stage_ceremony")!.questions.slice(0, 3).map((q) => [q.label, q.need])).toEqual([
      ["Where is the ceremony?", "needed"],
      ["Room or outdoor area", "optional"],
      ["Guest arrival", "needed"],
    ]);
  });

  it("says how each question is answered and when it appears", () => {
    const preferences = questionSummary("preferences")!.questions;
    expect(preferences.find((q) => q.label === "Explicit lyrics")).toEqual({
      label: "Explicit lyrics",
      answer: "One choice: Clean versions only · Explicit lyrics are fine · Not sure yet — discuss with the DJ",
      need: "needed",
    });
    const entrance = questionSummary("stage_entrance")!.questions;
    expect(entrance.find((q) => q.label === "Planned grand entrance time")).toMatchObject({ answer: "Time", need: "needed", when: "a grand entrance is planned" });
    const firstDance = questionSummary("moment_songs")!;
    expect(firstDance.questions[0].answer).toContain("DJ's choice");
    expect(firstDance.questions[1].answer).toContain("cue label");
    expect(questionSummary("dedications")!.questions[1].need).toBe("optional");
  });

  it("lists the announcement language under DJ expectations only, never under Event basics", () => {
    const labels = (editor: string) => questionSummary(editor)!.questions.map((q) => q.label);
    expect(labels("basics")).toEqual(["Guest count", "Start time", "End time", "Where is the event?", "Room or space within the venue", "Parking, loading and access for the DJ"]);
    expect(JSON.stringify(questionSummary("basics"))).not.toMatch(/language/i);
    expect(questionSummary("preferences")!.questions.find((q) => q.label === "Announcement language")).toMatchObject({ need: "needed" });
  });

  it("has nothing for items without a form of their own", () => {
    expect(questionSummary(null)).toBeNull();
    expect(questionSummary("stage_details")).toBeNull();
    expect(questionSummary("included")).toBeNull();
  });
});
