import { z } from "zod";
import { musicAnswersFromForm, musicFormFromAnswers, type MusicForm, type Song } from "./music";
import { clock, songLine } from "./summaries";

/**
 * A DJ's own planning questions (custom sections and moments). The database
 * (private.normalize_custom_answers, private.plan_custom_requirements) is
 * authoritative: definitions come from the plan's own copy, answers are
 * checked there, and only required questions count toward progress. This
 * file reads them: the form an editor works on, and how an answer reads in
 * previews, summaries and the run sheet. One place, so every reader says the
 * same thing.
 *
 * Answers are stored by question id. A removed question that holds an answer,
 * and a removed option an answer still chooses, stay in the definitions as
 * "archived": clients no longer see the question; staff still read it.
 */

export const CUSTOM_QUESTION_TYPES = ["short_text", "long_text", "single_choice", "multi_choice", "yes_no", "songs", "time"] as const;
export type CustomQuestionType = (typeof CUSTOM_QUESTION_TYPES)[number];

/** Plain names for each type, as staff see them. */
export const CUSTOM_TYPE_LABEL: Record<CustomQuestionType, string> = {
  short_text: "Short answer",
  long_text: "Paragraph",
  single_choice: "Single choice",
  multi_choice: "Multiple choice",
  yes_no: "Yes / No",
  songs: "Songs",
  time: "Time",
};

const optionSchema = z.object({ id: z.string(), label: z.string(), archived: z.boolean().optional() });
export const customQuestionSchema = z.object({
  id: z.string(),
  type: z.enum(CUSTOM_QUESTION_TYPES),
  label: z.string(),
  help: z.string().optional(),
  required: z.boolean(),
  options: z.array(optionSchema).optional(),
  /** Removed by staff but kept for an answer it holds (staff views only). */
  archived: z.boolean().optional(),
});
export type CustomQuestion = z.infer<typeof customQuestionSchema>;
export type CustomTime = { time: string; next_day?: true };
export type CustomAnswers = Record<string, unknown>;

/** The questions still asked, in order (archived ones left out). */
function askedQuestions(questions: CustomQuestion[] | undefined): CustomQuestion[] {
  return (questions ?? []).filter((q) => !q.archived);
}

// ---------------------------------------------------------------------------
// The editor's form
// ---------------------------------------------------------------------------

/** One question's form value: text, the chosen option ids, "yes"/"no", a song list or a time. */
export type CustomFieldForm =
  | { type: "short_text" | "long_text"; text: string }
  | { type: "single_choice"; choice: string }
  | { type: "multi_choice"; choices: string[] }
  | { type: "yes_no"; answer: "" | "yes" | "no" }
  | { type: "songs"; music: MusicForm }
  | { type: "time"; time: string; nextDay: boolean };
export type CustomForm = Record<string, CustomFieldForm>;

function customFieldForm(q: CustomQuestion, value: unknown): CustomFieldForm {
  switch (q.type) {
    case "short_text":
    case "long_text":
      return { type: q.type, text: typeof value === "string" ? value : "" };
    case "single_choice":
      return { type: q.type, choice: typeof value === "string" ? value : "" };
    case "multi_choice":
      return { type: q.type, choices: Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [] };
    case "yes_no":
      return { type: q.type, answer: value === true ? "yes" : value === false ? "no" : "" };
    case "songs":
      return { type: q.type, music: { ...musicFormFromAnswers({ songs: Array.isArray(value) ? (value as Song[]) : [] }), playlists: undefined } };
    case "time": {
      const t = (value ?? {}) as Partial<CustomTime>;
      return { type: q.type, time: typeof t.time === "string" ? t.time : "", nextDay: t.next_day === true };
    }
  }
}

export function customForm(questions: CustomQuestion[], answers: CustomAnswers): CustomForm {
  return Object.fromEntries(askedQuestions(questions).map((q) => [q.id, customFieldForm(q, answers[q.id])]));
}

/** The field an error belongs to: "q:<question id>" (songs use the song list's own "song:<id>:<field>"). */
export const questionField = (id: string) => `q:${id}`;

const TEXT_LIMIT: Record<"short_text" | "long_text", number> = { short_text: 500, long_text: 4000 };

/**
 * The answers to save, checked as the database checks them so a field can be
 * pointed at before saving. Unanswered questions are left out (incomplete
 * answers save). Answers to questions no longer asked are passed back as
 * stored: the database keeps them whatever is sent, and the saved and current
 * answers then compare equal.
 */
export function customAnswersFromForm(
  questions: CustomQuestion[],
  form: CustomForm,
  stored: CustomAnswers,
): { ok: true; answers: CustomAnswers } | { ok: false; field: string; message: string } {
  const asked = askedQuestions(questions);
  const askedIds = new Set(asked.map((q) => q.id));
  const out: CustomAnswers = {};
  for (const [id, value] of Object.entries(stored)) if (!askedIds.has(id)) out[id] = value;
  for (const q of asked) {
    const f = form[q.id] ?? customFieldForm(q, undefined);
    const field = questionField(q.id);
    switch (f.type) {
      case "short_text":
      case "long_text": {
        const text = f.text.trim();
        if (text.length > TEXT_LIMIT[f.type]) return { ok: false, field, message: `Keep this under ${TEXT_LIMIT[f.type].toLocaleString("en-CA")} characters.` };
        if (text) out[q.id] = text;
        break;
      }
      case "single_choice":
        if (f.choice) out[q.id] = f.choice;
        break;
      case "multi_choice":
        if (f.choices.length > 0) out[q.id] = f.choices;
        break;
      case "yes_no":
        if (f.answer) out[q.id] = f.answer === "yes";
        break;
      case "songs": {
        // A moment's song rules: up to 12, title and artist, an optional cue.
        const parsed = musicAnswersFromForm("moment_songs", { ...f.music, choice: "" });
        if (!parsed.ok) return parsed.field === "songs" ? { ...parsed, field } : parsed;
        if (parsed.answers.songs?.length) out[q.id] = parsed.answers.songs;
        break;
      }
      case "time":
        if (f.time) {
          if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(f.time)) return { ok: false, field, message: "Enter a time such as 18:30." };
          out[q.id] = f.nextDay ? { time: f.time, next_day: true } : { time: f.time };
        }
        break;
    }
  }
  return { ok: true, answers: out };
}

// ---------------------------------------------------------------------------
// Reading answers
// ---------------------------------------------------------------------------

const optionLabel = (q: CustomQuestion, id: unknown, audience: "client" | "staff"): string | null => {
  const o = q.options?.find((x) => x.id === id);
  if (!o) return null;
  return o.archived && audience === "staff" ? `${o.label} (no longer offered)` : o.label;
};

/** How one answer reads ("Greek", "Yes", "11:30 p.m. (next day)", "Zorba · Theodorakis"), or null when unanswered. */
export function customAnswerText(q: CustomQuestion, value: unknown, audience: "client" | "staff" = "staff"): string | null {
  if (value === undefined || value === null) return null;
  switch (q.type) {
    case "short_text":
    case "long_text":
      return typeof value === "string" && value.trim() ? value.trim() : null;
    case "single_choice":
      return optionLabel(q, value, audience);
    case "multi_choice": {
      const labels = Array.isArray(value) ? value.map((v) => optionLabel(q, v, audience)).filter((l): l is string => Boolean(l)) : [];
      return labels.length > 0 ? labels.join(", ") : null;
    }
    case "yes_no":
      return value === true ? "Yes" : value === false ? "No" : null;
    case "time": {
      const t = value as Partial<CustomTime>;
      return clock(t.time, t.next_day);
    }
    case "songs": {
      const lines = Array.isArray(value) ? value.map((s) => songLine(s as Record<string, unknown>)).filter((l): l is string => Boolean(l)) : [];
      return lines.length > 0 ? lines.join("; ") : null;
    }
  }
}

export type CustomAnswerLine = { id: string; label: string; value: string | null; type: CustomQuestionType; required: boolean; archived: boolean };

/**
 * Every question with its answer, in order: for clients the questions still asked; for staff also
 * removed ones that hold an answer, marked archived ("no longer asked").
 */
export function customAnswerLines(questions: CustomQuestion[] | undefined, answers: CustomAnswers, audience: "client" | "staff"): CustomAnswerLine[] {
  return (questions ?? [])
    .filter((q) => !q.archived || (audience === "staff" && answers[q.id] !== undefined))
    .map((q) => ({ id: q.id, label: q.label, value: customAnswerText(q, answers[q.id], audience), type: q.type, required: q.required, archived: q.archived === true }));
}

/** A one-line preview of a custom item's answers: the first few answers, then how many more. Null when nothing is answered. */
export function customSummary(questions: CustomQuestion[] | undefined, answers: CustomAnswers, audience: "client" | "staff" = "client"): string | null {
  const values = customAnswerLines(questions, answers, audience).filter((l) => !l.archived && l.value !== null);
  if (values.length === 0) return null;
  const shown = values.slice(0, 2).map((l) => (l.type === "songs" ? `${(answers[l.id] as unknown[]).length} song${(answers[l.id] as unknown[]).length === 1 ? "" : "s"}` : l.value!));
  return values.length > 2 ? `${shown.join(" · ")} +${values.length - 2} more` : shown.join(" · ");
}

/** The questions of a custom item by item id, from a plan structure (general sections and moments). */
export function customQuestionsByItem(structure: {
  general: { id: string; editor: string | null; questions?: CustomQuestion[] }[];
  stages: { moments: { id: string; editor: string | null; questions?: CustomQuestion[] }[] }[];
}): Record<string, CustomQuestion[]> {
  const out: Record<string, CustomQuestion[]> = {};
  for (const g of structure.general) if (g.editor === "custom") out[g.id] = g.questions ?? [];
  for (const s of structure.stages) for (const m of s.moments) if (m.editor === "custom") out[m.id] = m.questions ?? [];
  return out;
}

// ---------------------------------------------------------------------------
// Authoring (staff): the question list being edited
// ---------------------------------------------------------------------------

/**
 * The limits private.normalize_custom_questions enforces, so the editor can point at a problem
 * before saving. The database stays authoritative and checks everything again.
 */
export const QUESTION_LIMITS = { questions: 30, label: 200, help: 500, optionsMin: 2, optionsMax: 12, option: 120 } as const;

/** Types that offer choices. */
export const isChoiceType = (type: CustomQuestionType) => type === "single_choice" || type === "multi_choice";

/** One option being edited. `id` is the stored one (absent for a new option); `key` only tells React rows apart. */
export type OptionDraft = { key: string; id?: string; label: string };
/** One question being edited. `id` is the stored one (absent for a new question). */
export type QuestionDraft = { key: string; id?: string; type: CustomQuestionType; label: string; help: string; required: boolean; options: OptionDraft[] };

let draftKey = 0;
export const newDraftKey = () => `~${++draftKey}`;

/** The questions still asked, as editable drafts. Removed (archived) questions and options are never offered for editing. */
export function draftsFromQuestions(questions: CustomQuestion[] | undefined): QuestionDraft[] {
  return askedQuestions(questions).map((q) => ({
    key: q.id,
    id: q.id,
    type: q.type,
    label: q.label,
    help: q.help ?? "",
    required: q.required,
    options: (q.options ?? []).filter((o) => !o.archived).map((o) => ({ key: o.id, id: o.id, label: o.label })),
  }));
}

export function newQuestionDraft(type: CustomQuestionType = "short_text"): QuestionDraft {
  return {
    key: newDraftKey(), type, label: "", help: "", required: false,
    options: isChoiceType(type) ? [{ key: newDraftKey(), label: "" }, { key: newDraftKey(), label: "" }] : [],
  };
}

/** A draft whose type changed: choices gain two empty options; other types drop them. */
export function withType(d: QuestionDraft, type: CustomQuestionType): QuestionDraft {
  const options = isChoiceType(type)
    ? d.options.length > 0 ? d.options : [{ key: newDraftKey(), label: "" }, { key: newDraftKey(), label: "" }]
    : [];
  return { ...d, type, options };
}

/** Where a draft problem is: a question's field, or one of its options (by index). */
export type DraftProblem = { question: string; field: "label" | "help" | "options" | "list"; option?: string; message: string };

/** The first problem in the list, in order, or null when it can be saved. */
export function draftProblem(drafts: QuestionDraft[]): DraftProblem | null {
  if (drafts.length > QUESTION_LIMITS.questions) {
    return { question: drafts[QUESTION_LIMITS.questions].key, field: "list", message: `Keep this to ${QUESTION_LIMITS.questions} questions or fewer.` };
  }
  for (const d of drafts) {
    const label = d.label.trim();
    if (!label) return { question: d.key, field: "label", message: "Write the question." };
    if (label.length > QUESTION_LIMITS.label) return { question: d.key, field: "label", message: `Keep the question under ${QUESTION_LIMITS.label} characters.` };
    if (d.help.trim().length > QUESTION_LIMITS.help) return { question: d.key, field: "help", message: `Keep the help text under ${QUESTION_LIMITS.help} characters.` };
    if (!isChoiceType(d.type)) continue;
    if (d.options.length < QUESTION_LIMITS.optionsMin || d.options.length > QUESTION_LIMITS.optionsMax) {
      return { question: d.key, field: "options", message: `Offer ${QUESTION_LIMITS.optionsMin} to ${QUESTION_LIMITS.optionsMax} choices.` };
    }
    const seen = new Set<string>();
    for (const o of d.options) {
      const text = o.label.trim();
      if (!text) return { question: d.key, field: "options", option: o.key, message: "Write the choice, or remove it." };
      if (text.length > QUESTION_LIMITS.option) return { question: d.key, field: "options", option: o.key, message: `Keep each choice under ${QUESTION_LIMITS.option} characters.` };
      if (seen.has(text.toLowerCase())) return { question: d.key, field: "options", option: o.key, message: `"${text}" is listed twice.` };
      seen.add(text.toLowerCase());
    }
  }
  return null;
}

/** What set_*_item_questions receives: ids only for stored questions and options (new ones get theirs from the database). */
export function draftsToPayload(drafts: QuestionDraft[]) {
  return drafts.map((d) => ({
    ...(d.id ? { id: d.id } : {}),
    type: d.type,
    label: d.label.trim(),
    ...(d.help.trim() ? { help: d.help.trim() } : {}),
    required: d.required,
    ...(isChoiceType(d.type) ? { options: d.options.map((o) => ({ ...(o.id ? { id: o.id } : {}), label: o.label.trim() })) } : {}),
  }));
}

/** The kinds of item a DJ can create, as the add functions name them. */
export const CUSTOM_KINDS = ["general", "stage", "moment"] as const;

/** The "questions" field of an authoring form (a JSON list), or null when it isn't one. The database checks the rest. */
export function questionsField(value: FormDataEntryValue | null): unknown[] | null {
  if (typeof value !== "string" || value.length > 200_000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
