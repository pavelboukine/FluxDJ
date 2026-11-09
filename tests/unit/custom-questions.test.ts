import { describe, expect, it } from "vitest";
import {
  customAnswerLines,
  customAnswersFromForm,
  customAnswerText,
  customForm,
  customQuestionsByItem,
  customSummary,
  draftProblem,
  draftsFromQuestions,
  draftsToPayload,
  newQuestionDraft,
  questionsField,
  withType,
  type CustomForm,
  type CustomQuestion,
} from "@/lib/planning/custom-questions";
import { planSections } from "@/lib/planning/navigation";
import { clientVisibleStructure } from "@/lib/planning/preview";
import { questionSummary } from "@/lib/planning/question-summaries";
import { isCustomKey, itemRoles, templateStructure } from "@/lib/planning/template-structure";
import { structureSchema } from "@/lib/planning/view";
import { buildRunSheet } from "@/lib/run-sheet/model";
import { renderRunSheetPdf } from "@/lib/run-sheet/render.server";
import { pdfPageTexts } from "../support/pdf";
import { input, planView, song } from "./fixtures/run-sheet";

// The cultural music section of the pgTAP tests, after staff removed a question and an option.
const QUESTIONS: CustomQuestion[] = [
  { id: "q_hora", type: "yes_no", label: "Will there be a hora?", required: true },
  { id: "q_style", type: "single_choice", label: "Which traditions?", required: true, options: [
    { id: "o_lebanese", label: "Lebanese" }, { id: "o_none", label: "None" }, { id: "o_greek", label: "Greek", archived: true },
  ] },
  { id: "q_langs", type: "multi_choice", label: "Languages", required: false, options: [{ id: "o_en", label: "English" }, { id: "o_fr", label: "French" }] },
  { id: "q_songs", type: "songs", label: "Traditional songs", required: true },
  { id: "q_when", type: "time", label: "Cultural set starts", required: false, help: "Roughly is fine." },
  { id: "q_name", type: "short_text", label: "Family name", required: false },
  { id: "q_notes", type: "long_text", label: "Anything else?", required: false },
  { id: "q_old", type: "short_text", label: "Removed question", required: true, archived: true },
];
const zorba = { id: "6f1c1a52-2f41-4d8e-9a39-0d0d6f9a1a01", title: "Zorba", artist: "Theodorakis" };
const STORED = {
  q_hora: false, q_style: "o_greek", q_langs: ["o_fr", "o_en"], q_songs: [zorba], q_when: { time: "00:30", next_day: true },
  q_name: "Papadopoulos", q_old: "Kept answer",
};

describe("custom question answers: the form and what is saved", () => {
  it("round-trips every type, and passes answers to questions no longer asked back as stored", () => {
    const form = customForm(QUESTIONS, STORED);
    expect(Object.keys(form)).not.toContain("q_old");
    expect(form.q_hora).toEqual({ type: "yes_no", answer: "no" });
    expect(form.q_when).toEqual({ type: "time", time: "00:30", nextDay: true });
    expect(customAnswersFromForm(QUESTIONS, form, STORED)).toEqual({ ok: true, answers: STORED });
  });

  it("leaves unanswered questions out, so incomplete answers save", () => {
    const form = customForm(QUESTIONS, {});
    expect(customAnswersFromForm(QUESTIONS, form, {})).toEqual({ ok: true, answers: {} });
    const some: CustomForm = { ...form, q_name: { type: "short_text", text: "  Nguyen " }, q_notes: { type: "long_text", text: "   " } };
    expect(customAnswersFromForm(QUESTIONS, some, {})).toEqual({ ok: true, answers: { q_name: "Nguyen" } });
  });

  it("points at the field the database would refuse", () => {
    const form = customForm(QUESTIONS, {});
    expect(customAnswersFromForm(QUESTIONS, { ...form, q_name: { type: "short_text", text: "x".repeat(501) } }, {}))
      .toEqual({ ok: false, field: "q:q_name", message: "Keep this under 500 characters." });
    expect(customAnswersFromForm(QUESTIONS, { ...form, q_when: { type: "time", time: "25:00", nextDay: false } }, {}))
      .toMatchObject({ ok: false, field: "q:q_when" });
    const songs = customForm(QUESTIONS, { q_songs: [{ ...zorba, artist: "" }] });
    expect(customAnswersFromForm(QUESTIONS, songs, {})).toEqual({ ok: false, field: `song:${zorba.id}:artist`, message: "Enter the artist." });
  });
});

describe("reading custom answers", () => {
  it("reads each type in plain words; removed options are marked for staff only", () => {
    const q = (qid: string) => QUESTIONS.find((x) => x.id === qid)!;
    expect(customAnswerText(q("q_hora"), false)).toBe("No");
    expect(customAnswerText(q("q_style"), "o_greek", "staff")).toBe("Greek (no longer offered)");
    expect(customAnswerText(q("q_style"), "o_greek", "client")).toBe("Greek");
    expect(customAnswerText(q("q_langs"), ["o_fr", "o_en"])).toBe("French, English");
    expect(customAnswerText(q("q_when"), { time: "00:30", next_day: true })).toBe("12:30 a.m. (next day)");
    expect(customAnswerText(q("q_songs"), [zorba])).toBe("Zorba · Theodorakis");
    expect(customAnswerText(q("q_name"), undefined)).toBeNull();
  });

  it("staff also read removed questions that hold an answer; clients don't", () => {
    expect(customAnswerLines(QUESTIONS, STORED, "staff").map((l) => l.id)).toContain("q_old");
    expect(customAnswerLines(QUESTIONS, STORED, "client").map((l) => l.id)).not.toContain("q_old");
  });

  it("previews the first answers, then how many more", () => {
    expect(customSummary(QUESTIONS, STORED)).toBe("No · Greek +4 more");
    expect(customSummary(QUESTIONS, { q_songs: [zorba] })).toBe("1 song");
    expect(customSummary(QUESTIONS, {})).toBeNull();
  });

  it("has no built-in summary: the template editor lists a custom item's own questions", () => {
    expect(questionSummary("custom")).toBeNull();
  });
});

describe("custom items in the planning structure", () => {
  const library = [
    { kind: "general", key: "basics", parent_keys: null, default_label: "Event basics", description: null, editor: "basics", removable: false },
    { kind: "stage", key: "party", parent_keys: null, default_label: "Party", description: null, editor: "stage_party", removable: true },
  ];
  const rows = [
    { id: "g1", kind: "general", key: "basics", parent_id: null, label: "Event basics", position: 1, questions: null },
    { id: "g2", kind: "general", key: "custom_aaaa1111bbbb", parent_id: null, label: "Cultural music", position: 2, questions: QUESTIONS },
    { id: "s1", kind: "stage", key: "custom_cccc2222dddd", parent_id: null, label: "Cultural set", position: 1, questions: null },
    { id: "m1", kind: "moment", key: "custom_eeee3333ffff", parent_id: "s1", label: "Hora", position: 1, questions: [] },
    { id: "s2", kind: "stage", key: "party", parent_id: null, label: "Party", position: 2, questions: null },
    { id: "m2", kind: "moment", key: "custom_gggg4444hhhh", parent_id: "s2", label: "Late-night requests", position: 1, questions: [] },
  ];

  it("gives a template's custom items the editors the database gives a plan's", () => {
    expect(isCustomKey("custom_aaaa1111bbbb")).toBe(true);
    expect(isCustomKey("party")).toBe(false);
    const structure = templateStructure(rows, library);
    expect(structure.general.map((g) => [g.key, g.editor, g.questions?.length])).toEqual([["basics", "basics", undefined], ["custom_aaaa1111bbbb", "custom", 8]]);
    expect(structure.stages.map((s) => [s.label, s.editor, s.moments.map((m) => m.editor)])).toEqual([["Cultural set", null, ["custom"]], ["Party", "stage_party", ["custom"]]]);
    expect(planSections(structure).map((s) => s.label)).toEqual(["Event basics", "Cultural music", "Cultural set", "Party"]);
    expect(planSections(structure).find((s) => s.label === "Cultural set")?.moments.map((m) => m.label)).toEqual(["Hora"]);
    const roles = itemRoles(structure, library);
    expect(roles.get("custom_aaaa1111bbbb")?.kind).toBe("section");
    expect(roles.get("custom_cccc2222dddd")?.kind).toBe("group");
    expect(roles.get("custom_eeee3333ffff")?.kind).toBe("fill");
    expect(customQuestionsByItem(structure)).toEqual({ g2: QUESTIONS, m1: [], m2: [] });
  });

  it("the client's view of a plan leaves out removed questions but keeps removed options", () => {
    const structure = structureSchema.parse({
      general: [{ id: "g2", key: "custom_aaaa1111bbbb", label: "Cultural music", editor: "custom", removable: true, disabled: false, questions: QUESTIONS }],
      stages: [],
    });
    const visible = clientVisibleStructure(structure).general[0].questions!;
    expect(visible.map((q) => q.id)).not.toContain("q_old");
    expect(visible.find((q) => q.id === "q_style")?.options?.map((o) => o.id)).toContain("o_greek");
  });
});

describe("custom items on the run sheet", () => {
  const view = planView({
    general: [{ key: "custom_aaaa1111bbbb", editor: "custom", label: "Cultural music", questions: QUESTIONS, answers: STORED }],
    stages: [
      { key: "party", editor: "stage_party", label: "Party", answers: { start_time: "21:00" }, moments: [
        { key: "custom_gggg4444hhhh", editor: "custom", label: "Hora", answers: { q_start: { time: "22:15" }, q_lead: "Uncle Nikos leads", q_music: [song("Hasapiko", "Traditional", { cue: "Circle" })] }, questions: [
          { id: "q_start", type: "time", label: "When?", required: true },
          { id: "q_lead", type: "short_text", label: "Who leads it?", required: false },
          { id: "q_music", type: "songs", label: "Songs", required: false },
        ] },
        { key: "custom_iiii5555jjjj", editor: "custom", label: "Money dance", questions: [{ id: "q_x", type: "yes_no", label: "Happening?", required: true }] },
      ] },
    ],
    unanswered: [{ stageKey: "custom_iiii5555jjjj", key: "q_x" }],
  });
  const sheet = buildRunSheet(input(view));

  it("places a custom moment on the timeline at its own time, with its songs and answers", () => {
    const rows = sheet.stages[0].rows;
    expect(rows[0]).toMatchObject({ title: "Hora", when: { kind: "time", time: "22:15", nextDay: false }, notes: ["Who leads it?: Uncle Nikos leads"], status: null });
    expect(rows[0].songs.map((x) => [x.title, x.cue])).toEqual([["Hasapiko", "Circle"]]);
    expect(rows[1]).toMatchObject({ title: "Money dance", when: { kind: "sequence" }, status: { text: "Not answered yet" } });
  });

  it("lists a custom section's questions and answers, keeping removed ones that were answered", () => {
    expect(sheet.custom).toEqual([{
      id: expect.any(String), label: "Cultural music", answers: [
        { label: "Will there be a hora?", value: "No" },
        { label: "Which traditions?", value: "Greek (no longer offered)" },
        { label: "Languages", value: "French, English" },
        { label: "Traditional songs", value: "Zorba · Theodorakis" },
        { label: "Cultural set starts", value: "12:30 a.m. (next day)" },
        { label: "Family name", value: "Papadopoulos" },
        { label: "Anything else?", value: "Not answered" },
        { label: "Removed question (no longer asked)", value: "Kept answer" },
      ],
    }]);
  });

  it("names an open required question by its wording", () => {
    expect(sheet.warnings.find((w) => w.kind === "unresolved")?.text).toBe("Party · Money dance: Happening?");
  });

  it("prints the same in the PDF", async () => {
    const text = (await pdfPageTexts(await renderRunSheetPdf(sheet, "CQ000001"))).join("\n");
    for (const expected of ["Cultural music", "Which traditions?", "Greek (no longer offered)", "Removed question (no longer asked)", "Hora", "Who leads it?: Uncle Nikos leads", "Hasapiko"]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("q_");
  });
});

describe("authoring: the question list staff edit", () => {
  it("offers only the questions and choices still asked, with their stored ids", () => {
    const drafts = draftsFromQuestions(QUESTIONS);
    expect(drafts.map((d) => d.id)).not.toContain("q_old");
    expect(drafts.find((d) => d.id === "q_style")?.options.map((o) => o.id)).toEqual(["o_lebanese", "o_none"]);
    // Unchanged drafts send back exactly what is stored (archived entries are the database's to keep).
    expect(draftsToPayload(drafts)).toEqual(QUESTIONS.filter((q) => !q.archived).map((q) => ({
      id: q.id, type: q.type, label: q.label, required: q.required,
      ...(q.help ? { help: q.help } : {}),
      ...(q.options ? { options: q.options.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label })) } : {}),
    })));
  });

  it("new questions and choices go without ids, trimmed; empty help is left out", () => {
    const d = { ...newQuestionDraft("multi_choice"), label: "  Languages ", help: "  " };
    d.options = d.options.map((o, i) => ({ ...o, label: ` ${["English", "French"][i]} ` }));
    expect(draftsToPayload([d])).toEqual([{ type: "multi_choice", label: "Languages", required: false, options: [{ label: "English" }, { label: "French" }] }]);
  });

  it("changing the type adds two empty choices for choice types and drops them otherwise", () => {
    const text = newQuestionDraft("short_text");
    expect(withType(text, "single_choice").options).toHaveLength(2);
    expect(withType(withType(text, "single_choice"), "time").options).toEqual([]);
  });

  it("points at the first problem the database would refuse", () => {
    const ok = { ...newQuestionDraft("yes_no"), label: "Hora?" };
    expect(draftProblem([ok])).toBeNull();
    expect(draftProblem([{ ...ok, label: " " }])).toMatchObject({ question: ok.key, field: "label", message: "Write the question." });
    expect(draftProblem([{ ...ok, label: "x".repeat(201) }])).toMatchObject({ field: "label" });
    expect(draftProblem([{ ...ok, help: "x".repeat(501) }])).toMatchObject({ field: "help" });
    const choice = { ...newQuestionDraft("single_choice"), label: "Which?" };
    expect(draftProblem([choice])).toMatchObject({ field: "options", option: choice.options[0].key, message: "Write the choice, or remove it." });
    const twice = { ...choice, options: [{ key: "a", label: "Greek" }, { key: "b", label: " greek" }] };
    expect(draftProblem([twice])).toMatchObject({ option: "b", message: '"greek" is listed twice.' });
    expect(draftProblem([{ ...choice, options: [{ key: "a", label: "Only" }] }])).toMatchObject({ field: "options", message: "Offer 2 to 12 choices." });
    expect(draftProblem(Array.from({ length: 31 }, (_, i) => ({ ...ok, key: `k${i}` })))).toMatchObject({ field: "list", message: "Keep this to 30 questions or fewer." });
  });

  it("reads the authoring form's question list, refusing anything else", () => {
    expect(questionsField('[{"type":"yes_no"}]')).toEqual([{ type: "yes_no" }]);
    expect(questionsField('{"type":"yes_no"}')).toBeNull();
    expect(questionsField("not json")).toBeNull();
    expect(questionsField(null)).toBeNull();
  });
});
