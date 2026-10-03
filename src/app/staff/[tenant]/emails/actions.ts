"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { processOutbox } from "@/lib/email/outbox.server";
import { fail, ok, UUID_RE, type ActionState } from "@/lib/forms";

export async function retryEmail(slug: string, emailId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(emailId)) return fail("Email not found.");
  const { data, error } = await supabase.rpc("retry_email_outbox", { p_id: emailId });
  if (error) return fail(describeDbError(error));
  if (!data) return fail("Only failed emails can be retried.");
  await processOutbox({ tenantId: tenant.id, limit: 20 }).catch(() => undefined);
  revalidatePath(`/staff/${slug}/emails`);
  return ok("Queued for another attempt.");
}

/** Delivers this business's due emails now (the same work as pnpm outbox:work). */
export async function processQueue(slug: string): Promise<ActionState> {
  const { tenant } = await requireStaff(slug);
  try {
    const result = await processOutbox({ tenantId: tenant.id, limit: 50 });
    revalidatePath(`/staff/${slug}/emails`);
    return ok(`Processed ${result.claimed}: ${result.sent} sent, ${result.failed} failed, ${result.cancelled} cancelled.`);
  } catch {
    return fail("The queue could not be processed. Try again.");
  }
}
