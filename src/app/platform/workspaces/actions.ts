"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, ok, text, UUID_RE, type ActionState } from "@/lib/forms";

type Change = "suspend_workspace" | "restore_workspace";

async function change(fn: Change, tenantId: string, form: FormData): Promise<ActionState> {
  const { supabase } = await requirePlatformAdmin();
  if (!UUID_RE.test(tenantId)) return fail("Not found.");
  const version = int(form, "draft_version", 0, 2_000_000_000);
  if (version === null) return fail("Reload the page and try again.");
  const reason = text(form, "reason");
  if (reason.length < 3) return fail("Give an internal reason (3 to 500 characters).");
  const { data, error } = await supabase.rpc(fn, { p_tenant_id: tenantId, p_expected_version: version, p_reason: reason });
  if (error) return fail(describeDbError(error));
  const result = data as { replayed?: boolean; version?: number };
  revalidatePath("/platform/workspaces");
  if (fn === "suspend_workspace") return ok(result.replayed ? "This workspace was already suspended." : "Workspace suspended.", result.version);
  return ok(result.replayed ? "This workspace was already active." : "Workspace restored.", result.version);
}

/** Suspends a workspace (platform administrators; the database checks again). */
export async function suspendWorkspace(tenantId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  return change("suspend_workspace", tenantId, form);
}

export async function restoreWorkspace(tenantId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  return change("restore_workspace", tenantId, form);
}
