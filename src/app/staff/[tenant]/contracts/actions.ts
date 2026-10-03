"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import type { MissingItem } from "@/lib/contracts/content";
import { describeDbError } from "@/lib/db-errors";
import { UUID_RE } from "@/lib/forms";

export type GenerateResult =
  | { status: "created" | "replayed"; contractId: string }
  | { status: "incomplete"; missing: MissingItem[] }
  | { status: "draft_exists"; contractId: string }
  | { status: "error"; message: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Generates (or explicitly replaces) the event's contract draft from an
 * approval and a published template version. All rendering and checks happen
 * in generate_contract_draft, in one transaction under the event lock.
 * Generating never sends anything, books the event or grants client access.
 */
export async function generateContract(
  slug: string,
  approvalId: string,
  input: { templateVersionId: string; balanceDueDate: string; replaceContractId: string | null },
): Promise<GenerateResult> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(approvalId)) return { status: "error", message: "Reload the page and try again." };
  if (!UUID_RE.test(input.templateVersionId)) return { status: "error", message: "Choose a published template version." };
  if (input.replaceContractId !== null && !UUID_RE.test(input.replaceContractId)) return { status: "error", message: "Reload the page and try again." };
  const balanceDueDate = input.balanceDueDate.trim();
  if (balanceDueDate && !DATE_RE.test(balanceDueDate)) return { status: "error", message: "Enter the balance due date as a date." };

  const { data, error } = await supabase.rpc("generate_contract_draft", {
    p_approval_id: approvalId,
    p_template_version_id: input.templateVersionId,
    ...(balanceDueDate ? { p_balance_due_date: balanceDueDate } : {}),
    ...(input.replaceContractId ? { p_replace_contract_id: input.replaceContractId } : {}),
  });
  if (error) return { status: "error", message: describeDbError(error) };
  const result = data as { status: string; contract_id?: string | null; missing?: MissingItem[] };
  revalidatePath(`/staff/${slug}`, "layout");
  switch (result.status) {
    case "created":
    case "replayed":
      return { status: result.status, contractId: result.contract_id! };
    case "incomplete":
      return { status: "incomplete", missing: result.missing ?? [] };
    case "draft_exists":
      return { status: "draft_exists", contractId: result.contract_id! };
    case "conflict":
      return { status: "error", message: "The contract draft changed since this page loaded. Reload the page and try again." };
    default:
      return { status: "error", message: "Something went wrong. Try again." };
  }
}
