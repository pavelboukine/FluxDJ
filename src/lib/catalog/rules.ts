import { KEY_RE, keyFromName } from "@/lib/forms";

/**
 * Questions and rules as staff read them. The data model (migration
 * 20261002000300) supports four answer types and three rule conditions:
 *   {"op":"equals","value": true|false}          yes/no questions
 *   {"op":"equals","value": "option"}            one choice
 *   {"op":"in","values": ["a","b"]}              one choice, any of several
 *   {"op":"contains","value": "option"}          several choices
 * A matching rule requires a quantity of one gear item. How that quantity is
 * charged is decided by the pricing engine (src/lib/pricing/price-selection.ts);
 * the wording here only describes it.
 */

export const ANSWER_TYPES = [
  ["boolean", "Yes / no"],
  ["single_choice", "One choice"],
  ["multi_choice", "Several choices"],
  ["short_text", "Short text"],
] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number][0];

export function answerTypeLabel(type: string): string {
  return ANSWER_TYPES.find(([t]) => t === type)?.[1] ?? type;
}

export type QuestionOption = { value: string; label: string };
export type RuleCondition = { op: "equals"; value: boolean | string } | { op: "in"; values: string[] } | { op: "contains"; value: string };

/** Whether rules can use this answer type (free text can't). */
export const canHaveRules = (type: string) => type !== "short_text";

const quote = (s: string) => `“${s}”`;

/** "is Yes", "is “A separate space”", "is “A” or “B”", "includes “Uplights”". */
export function conditionText(condition: unknown, options: QuestionOption[]): string {
  const c = condition as { op?: string; value?: unknown; values?: unknown };
  const label = (v: unknown) => quote(options.find((o) => o.value === v)?.label ?? String(v));
  if (c.op === "equals" && typeof c.value === "boolean") return `is ${c.value ? "Yes" : "No"}`;
  if (c.op === "equals") return `is ${label(c.value)}`;
  if (c.op === "in" && Array.isArray(c.values)) {
    const labels = c.values.map(label);
    return labels.length <= 1 ? `is ${labels[0] ?? "—"}` : `is ${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
  }
  if (c.op === "contains") return `includes ${label(c.value)}`;
  return "matches an unsupported condition";
}

/** The option values a condition depends on (none for yes/no). */
export function conditionValues(condition: unknown): string[] {
  const c = condition as { op?: string; value?: unknown; values?: unknown };
  if (c.op === "in" && Array.isArray(c.values)) return c.values.filter((v): v is string => typeof v === "string");
  if ((c.op === "equals" || c.op === "contains") && typeof c.value === "string") return [c.value];
  return [];
}

/** "When “Where is the ceremony?” is “A separate space”, require 1 × Speaker." */
export function ruleStatement(prompt: string, condition: unknown, options: QuestionOption[], quantity: number, gearName: string): string {
  return `When ${quote(prompt)} ${conditionText(condition, options)}, require ${quantity} × ${gearName}.`;
}

/**
 * Builds a condition from rule form fields:
 *   yes/no:          when=true|false
 *   one choice:      values=<option> (one or more; several become "any of")
 *   several choices: contains=<option>
 */
export function readCondition(
  answerType: string,
  options: QuestionOption[],
  form: { when?: string; values: string[]; contains?: string },
): { ok: true; condition: RuleCondition } | { ok: false; error: string } {
  const known = new Set(options.map((o) => o.value));
  if (answerType === "boolean") {
    if (form.when !== "true" && form.when !== "false") return { ok: false, error: "Choose Yes or No." };
    return { ok: true, condition: { op: "equals", value: form.when === "true" } };
  }
  if (answerType === "single_choice") {
    const values = [...new Set(form.values)];
    if (values.length === 0) return { ok: false, error: "Choose at least one answer that triggers this rule." };
    if (values.some((v) => !known.has(v))) return { ok: false, error: "Choose answers from this question's choices." };
    return { ok: true, condition: values.length === 1 ? { op: "equals", value: values[0] } : { op: "in", values } };
  }
  if (answerType === "multi_choice") {
    if (!form.contains || !known.has(form.contains)) return { ok: false, error: "Choose the answer that triggers this rule." };
    return { ok: true, condition: { op: "contains", value: form.contains } };
  }
  return { ok: false, error: "Short text answers can't trigger rules." };
}

/**
 * Choices from the option editor, in order: each row is an existing value
 * (kept as is, so rules and answers keep matching when a label changes) or
 * empty for a new choice, whose value is made from its label and kept unique.
 */
export function readOptions(values: string[], labels: string[]): { ok: true; options: QuestionOption[] } | { ok: false; error: string } {
  if (values.length !== labels.length) return { ok: false, error: "Reload the page and try again." };
  const rows = labels.map((l, i) => ({ value: values[i].trim(), label: l.trim().replace(/\s+/g, " ") })).filter((r) => r.value || r.label);
  if (rows.length === 0) return { ok: false, error: "Add at least one choice." };
  if (rows.length > 50) return { ok: false, error: "A question can have up to 50 choices." };
  if (rows.some((r) => r.label.length < 1)) return { ok: false, error: "Every choice needs a label." };
  if (rows.some((r) => r.label.length > 200)) return { ok: false, error: "Choice labels are limited to 200 characters." };
  const lower = rows.map((r) => r.label.toLowerCase());
  if (new Set(lower).size !== lower.length) return { ok: false, error: "Two choices have the same label." };
  const kept = rows.filter((r) => r.value);
  if (kept.some((r) => !KEY_RE.test(r.value))) return { ok: false, error: "Reload the page and try again." };
  const taken = new Set(kept.map((r) => r.value));
  if (taken.size !== kept.length) return { ok: false, error: "Reload the page and try again." };
  const options = rows.map((r) => {
    if (r.value) return { value: r.value, label: r.label };
    const base = keyFromName(r.label).slice(0, 56);
    let value = base;
    for (let n = 2; taken.has(value); n++) value = `${base}_${n}`;
    taken.add(value);
    return { value, label: r.label };
  });
  return { ok: true, options };
}
