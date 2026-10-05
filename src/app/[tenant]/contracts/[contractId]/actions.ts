"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { processDocumentJobsQuietly } from "@/lib/contracts/documents.server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { revalidatePath } from "next/cache";
import { requestEvidence, signContractAs } from "@/lib/contracts/signing.server";
import type { SignInput, SignResult } from "@/lib/contracts/signing";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { allowRequest } from "@/lib/rate-limit.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Signs the contract as the signed-in client. Server Actions only accept
 * same-origin POSTs (Next.js checks Origin against Host). The identity comes
 * from auth.getUser(), which validates the session with the Auth server; the
 * browser supplies only the typed name, consent, the drawing and the hash of
 * the contract it displayed. Everything else (signer email, user id, time,
 * IP) is derived on the server and in the database.
 */
export async function signContract(slug: string, contractId: string, input: SignInput): Promise<SignResult> {
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(contractId) || !input || typeof input !== "object") {
    return { status: "error", code: "unavailable", message: "This contract isn't available." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { status: "error", code: "signed_out", message: "Your sign-in has expired. Sign in again to sign; your drawing is kept on this page." };
  }
  if (!(await allowRequest("contract_sign", data.user.id, 20, 600))) {
    return { status: "error", code: "rate_limited", message: "Too many attempts. Wait a few minutes and try again." };
  }
  const result = await signContractAs({
    userDb: supabase,
    userId: data.user.id,
    admin: createAdminClient(),
    slug,
    contractId,
    input,
    request: requestEvidence(await headers()),
  });
  if (result.status === "signed") {
    revalidatePath(`/${slug}/contracts/${contractId}`);
    // The signature is committed; generate the PDF and email the copies now
    // (the scheduled worker retries anything that fails here).
    if (!result.replayed) {
      after(async () => {
        await processDocumentJobsQuietly();
        await processOutboxQuietly();
      });
    }
  }
  return result;
}
