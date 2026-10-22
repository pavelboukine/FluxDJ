"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { logOutboxFailure, OutboxRunError, processOutbox, type OutboxRunResult } from "@/lib/email/outbox.server";
import { fail, ok, UUID_RE, type ActionState } from "@/lib/forms";

export async function retryEmail(slug: string, emailId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(emailId)) return fail("Email not found.");
  const { data, error } = await supabase.rpc("retry_email_outbox", { p_id: emailId });
  if (error) return fail(describeDbError(error));
  if (!data) return fail("Only failed emails can be retried.");
  // Queued either way: a failed run here is logged, and the scheduled worker picks the email up.
  await processOutbox({ tenantId: tenant.id, limit: 20 }).catch((cause: unknown) => logOutboxFailure("staff retry", cause));
  // The Emails page and every event's email history show it.
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Queued for another attempt.");
}

const processed = (r: OutboxRunResult) => `Processed ${r.claimed}: ${r.sent} sent, ${r.failed} failed, ${r.cancelled} cancelled.`;

/** Delivers this business's due emails now (the same work as pnpm outbox:work). */
export async function processQueue(slug: string): Promise<ActionState> {
  const { tenant } = await requireStaff(slug);
  try {
    const result = await processOutbox({ tenantId: tenant.id, limit: 50 });
    revalidatePath(`/staff/${slug}/emails`);
    return ok(processed(result));
  } catch (cause) {
    logOutboxFailure("staff queue run", cause);
    revalidatePath(`/staff/${slug}/emails`);
    if (cause instanceof OutboxRunError) {
      return fail(`${processed(cause.result)} Some emails couldn't be processed because of a temporary problem; they'll be retried automatically.`);
    }
    return fail("The queue could not be processed. Try again.");
  }
}
