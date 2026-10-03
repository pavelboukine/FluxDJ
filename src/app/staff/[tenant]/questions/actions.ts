"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import type { Json } from "@/lib/supabase/database.types";
import { checkbox, fail, int, KEY_RE, keyFromName, ok, text, UUID_RE, type ActionState } from "@/lib/forms";

const TYPES = ["boolean", "single_choice", "multi_choice", "short_text"] as const;
type AnswerType = (typeof TYPES)[number];

/** One option per line: "value | Label" or just "Label". */
function parseOptions(raw: string): { value: string; label: string }[] | string {
  const options = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split("|").map((p) => p.trim());
      return right ? { value: left, label: right } : { value: keyFromName(left), label: left };
    });
  if (options.some((o) => !KEY_RE.test(o.value))) return "Option values must be lowercase keys like separate_space.";
  if (new Set(options.map((o) => o.value)).size !== options.length) return "Option values must be unique.";
  if (options.some((o) => o.label.length > 200)) return "Option labels are limited to 200 characters.";
  return options;
}

export async function createQuestion(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const prompt = text(form, "prompt");
  const type = text(form, "answer_type") as AnswerType;
  const key = text(form, "key") || keyFromName(prompt).slice(0, 40);
  const sortOrder = int(form, "sort_order", 0, 10000) ?? 0;
  if (prompt.length < 1 || prompt.length > 500) return fail("Write the question (up to 500 characters).");
  if (!TYPES.includes(type)) return fail("Choose an answer type.");
  if (!KEY_RE.test(key)) return fail("Key must start with a letter and use lowercase letters, digits and underscores.");
  const choice = type === "single_choice" || type === "multi_choice";
  const options = choice ? parseOptions(text(form, "options")) : [];
  if (typeof options === "string") return fail(options);
  if (choice && options.length === 0) return fail("Choice questions need at least one option.");

  const { data, error } = await supabase
    .from("logistics_questions")
    .insert({ tenant_id: tenant.id, key, prompt, answer_type: type, options, required: checkbox(form, "required"), sort_order: sortOrder })
    .select("id")
    .single();
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/questions`);
  redirect(`/staff/${slug}/questions/${data.id}`);
}

export async function updateQuestion(slug: string, questionId: string, choice: boolean, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const prompt = text(form, "prompt");
  const sortOrder = int(form, "sort_order", 0, 10000);
  if (prompt.length < 1 || prompt.length > 500) return fail("Write the question (up to 500 characters).");
  if (sortOrder === null) return fail("Order must be a whole number.");
  const options = choice ? parseOptions(text(form, "options")) : [];
  if (typeof options === "string") return fail(options);
  if (choice && options.length === 0) return fail("Choice questions need at least one option.");
  const { data, error } = await supabase
    .from("logistics_questions")
    .update({ prompt, options, required: checkbox(form, "required"), active: checkbox(form, "active"), sort_order: sortOrder })
    .eq("id", questionId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) {
    if (error.code === "23514" && /invalidate existing logistics rules/.test(error.message)) {
      return fail("A rule depends on an option you removed. Archive that rule first.");
    }
    return fail(describeDbError(error));
  }
  if (!data?.length) return fail("Question not found.");
  revalidatePath(`/staff/${slug}/questions`);
  return ok("Saved.");
}

export async function createRule(slug: string, questionId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const { data: question } = await supabase
    .from("logistics_questions")
    .select("id, answer_type")
    .eq("id", questionId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!question) return fail("Question not found.");

  let condition: Json;
  if (question.answer_type === "boolean") {
    condition = { op: "equals", value: text(form, "bool_value") === "true" };
  } else if (question.answer_type === "single_choice") {
    const values = form.getAll("values").filter((v): v is string => typeof v === "string");
    if (values.length === 0) return fail("Choose at least one answer that triggers this rule.");
    condition = values.length === 1 ? { op: "equals", value: values[0] } : { op: "in", values };
  } else if (question.answer_type === "multi_choice") {
    const value = text(form, "contains_value");
    if (!value) return fail("Choose the option that triggers this rule.");
    condition = { op: "contains", value };
  } else {
    return fail("Free-text questions cannot drive rules.");
  }

  const gearId = text(form, "gear_item_id");
  const quantity = int(form, "required_quantity", 1, 100);
  const reason = text(form, "reason");
  if (!UUID_RE.test(gearId)) return fail("Choose the required gear.");
  if (quantity === null) return fail("Quantity must be from 1 to 100.");
  if (reason.length < 1 || reason.length > 500) return fail("Explain to the client why this gear is required.");

  const { error } = await supabase.from("logistics_rules").insert({
    tenant_id: tenant.id,
    question_id: question.id,
    condition,
    gear_item_id: gearId,
    required_quantity: quantity,
    reason,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/questions/${questionId}`);
  return ok("Rule added.");
}

export async function setRuleActive(slug: string, questionId: string, ruleId: string, active: boolean): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const { error } = await supabase.from("logistics_rules").update({ active }).eq("id", ruleId).eq("tenant_id", tenant.id);
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/questions/${questionId}`);
  return ok(active ? "Rule restored." : "Rule archived.");
}
