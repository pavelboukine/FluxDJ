"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { ANSWER_TYPES, readCondition, readOptions, type AnswerType, type QuestionOption } from "@/lib/catalog/rules";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, KEY_RE, keyFromName, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import type { Json } from "@/lib/supabase/database.types";

const isChoice = (type: string) => type === "single_choice" || type === "multi_choice";
const strings = (form: FormData, name: string) => form.getAll(name).filter((v): v is string => typeof v === "string");

/** Prompt, required, display order and (choice questions) the choices, in order. */
function readQuestion(form: FormData, type: string) {
  const prompt = text(form, "prompt").replace(/\s+/g, " ");
  const sortOrder = int(form, "sort_order", 0, 10000);
  if (prompt.length < 1 || prompt.length > 500) return { ok: false, error: "Write the question (up to 500 characters)." } as const;
  if (sortOrder === null) return { ok: false, error: "Display order must be a whole number from 0 to 10000." } as const;
  let options: QuestionOption[] = [];
  if (isChoice(type)) {
    const parsed = readOptions(strings(form, "option_value"), strings(form, "option_label"));
    if (!parsed.ok) return { ok: false, error: parsed.error } as const;
    options = parsed.options;
  }
  return { ok: true, values: { prompt, options, required: form.get("required") === "on", sort_order: sortOrder } } as const;
}

/**
 * Creates a question (one row: its choices are part of it, so it's saved
 * whole or not at all). A retry after a lost response meets the question's
 * unique key; when that existing question is the same one, it's shown
 * instead of an error.
 */
export async function createQuestion(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const type = text(form, "answer_type") as AnswerType;
  if (!ANSWER_TYPES.some(([t]) => t === type)) return fail("Choose an answer type.");
  const parsed = readQuestion(form, type);
  if (!parsed.ok) return fail(parsed.error);
  const key = text(form, "key") || keyFromName(parsed.values.prompt).slice(0, 40);
  if (!KEY_RE.test(key)) return fail("The key must start with a letter and use lowercase letters, digits and underscores.");
  const values = { tenant_id: tenant.id, key, answer_type: type, ...parsed.values, options: parsed.values.options as NonNullable<Json> };
  const { data, error } = await supabase.from("logistics_questions").insert(values).select("id").single();
  if (error?.code === "23505") {
    const { data: existing } = await supabase.from("logistics_questions").select("id, prompt, answer_type, options").eq("tenant_id", tenant.id).eq("key", key).maybeSingle();
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(((a ?? []) as QuestionOption[]).map((o) => [o.value, o.label])) === JSON.stringify(((b ?? []) as QuestionOption[]).map((o) => [o.value, o.label]));
    if (existing && existing.prompt === values.prompt && existing.answer_type === type && same(existing.options, values.options)) {
      redirect(`/staff/${slug}/questions/${existing.id}?created=replayed`);
    }
    return fail("Nothing was saved. Another question already uses this key; enter a different key under Other settings.");
  }
  if (error) return fail(`Nothing was saved. ${describeDbError(error)}`);
  revalidatePath(`/staff/${slug}/questions`);
  redirect(`/staff/${slug}/questions/${data.id}?created=1`);
}

export async function updateQuestion(slug: string, questionId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const { data: current } = await supabase.from("logistics_questions").select("id, answer_type").eq("id", questionId).eq("tenant_id", tenant.id).maybeSingle();
  if (!current) return fail("Question not found.");
  // The answer type and key never change (rules and sent proposals rely on them).
  const parsed = readQuestion(form, current.answer_type);
  if (!parsed.ok) return fail(parsed.error);
  // Archiving is its own confirmed action (setQuestionArchived); saving details never changes it.
  const { data, error } = await supabase
    .from("logistics_questions")
    .update({ ...parsed.values, options: parsed.values.options as NonNullable<Json> })
    .eq("id", questionId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) {
    if (error.code === "23514" && /invalidate existing logistics rules/.test(error.message ?? "")) {
      return fail("Nothing was saved. A rule (active or archived) uses a choice you removed. Change that rule to another choice first, then remove it.");
    }
    return fail(describeDbError(error));
  }
  if (!data?.length) return fail("Question not found.");
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Question saved.");
}

/** Archives or restores a question. Its rules and choices are kept; templates keep it in their list. */
export async function setQuestionArchived(slug: string, questionId: string, archived: boolean): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(questionId)) return fail("Question not found.");
  const { data, error } = await supabase.from("logistics_questions").update({ active: !archived }).eq("id", questionId).eq("tenant_id", tenant.id).select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Question not found.");
  revalidatePath(`/staff/${slug}`, "layout");
  return ok(archived ? "Question archived." : "Question restored.");
}

/** A rule from its form, for the question it belongs to. */
async function readRule(slug: string, questionId: string, form: FormData) {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(questionId)) return { ok: false, error: "Question not found." } as const;
  const { data: question } = await supabase.from("logistics_questions").select("id, answer_type, options").eq("id", questionId).eq("tenant_id", tenant.id).maybeSingle();
  if (!question) return { ok: false, error: "Question not found." } as const;
  const condition = readCondition(question.answer_type, (question.options ?? []) as QuestionOption[], {
    when: text(form, "when") || undefined,
    values: strings(form, "values"),
    contains: text(form, "contains") || undefined,
  });
  if (!condition.ok) return { ok: false, error: condition.error } as const;
  const gearId = text(form, "gear_item_id");
  const quantity = int(form, "required_quantity", 1, 100);
  const reason = text(form, "reason").replace(/\s+/g, " ");
  if (!UUID_RE.test(gearId)) return { ok: false, error: "Choose the gear this rule requires." } as const;
  if (quantity === null) return { ok: false, error: "The quantity must be a whole number from 1 to 100." } as const;
  if (reason.length < 1 || reason.length > 500) return { ok: false, error: "Explain to the client why this gear is needed (up to 500 characters)." } as const;
  return { ok: true, supabase, tenant, question, values: { condition: condition.condition as NonNullable<Json>, gear_item_id: gearId, required_quantity: quantity, reason } } as const;
}

/** The database's refusal of an identical active rule (trigger logistics_rules_no_duplicates). */
const isDuplicateRule = (error: { code?: string; message?: string } | null) => error?.code === "23505" && /rule_duplicate/.test(error.message ?? "");

/**
 * Adds a rule. The database never keeps two identical active rules (same
 * answer, gear, quantity and reason): quantities from matching rules add up,
 * so a duplicate, e.g. from a retry after a lost response or two submissions
 * at once, would double what clients must take.
 */
export async function createRule(slug: string, questionId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const r = await readRule(slug, questionId, form);
  if (!r.ok) return fail(r.error);
  const { error } = await r.supabase.from("logistics_rules").insert({ tenant_id: r.tenant.id, question_id: r.question.id, ...r.values });
  if (isDuplicateRule(error)) {
    revalidatePath(`/staff/${slug}/questions/${questionId}`);
    return ok("This exact rule is already saved, so it wasn't added again. If you just retried, your first save went through.");
  }
  if (error) return fail(`Nothing was saved. ${describeDbError(error)}`);
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Rule added.");
}

/** Changes a rule's answer, gear, quantity or reason (one update: all or nothing). */
export async function updateRule(slug: string, questionId: string, ruleId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  if (!UUID_RE.test(ruleId)) return fail("Rule not found.");
  const r = await readRule(slug, questionId, form);
  if (!r.ok) return fail(r.error);
  const { data, error } = await r.supabase
    .from("logistics_rules")
    .update(r.values)
    .eq("id", ruleId)
    .eq("question_id", r.question.id)
    .eq("tenant_id", r.tenant.id)
    .select("id");
  if (isDuplicateRule(error)) return fail("Nothing was saved. Another active rule already says exactly this; change this one, or archive one of them.");
  if (error) return fail(`Nothing was saved. ${describeDbError(error)}`);
  if (!data?.length) return fail("Rule not found.");
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Rule saved.");
}

export async function setRuleActive(slug: string, questionId: string, ruleId: string, active: boolean): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(ruleId)) return fail("Rule not found.");
  const { data, error } = await supabase.from("logistics_rules").update({ active }).eq("id", ruleId).eq("question_id", questionId).eq("tenant_id", tenant.id).select("id");
  if (isDuplicateRule(error)) return fail("Not restored: an identical rule is already active, so this one would double its quantity.");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Rule not found.");
  revalidatePath(`/staff/${slug}`, "layout");
  return ok(active ? "Rule restored." : "Rule archived.");
}
