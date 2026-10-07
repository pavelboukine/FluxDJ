"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { describeDbError } from "@/lib/db-errors";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { fail, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { platformInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";

const emailSchema = z.email().max(320);

function newLink() {
  const linkId = randomUUID();
  return { p_link_id: linkId, p_token_hash: sha256Hex(platformInviteToken(linkId)) };
}

const formatExpiry = (value: unknown) =>
  typeof value === "string"
    ? new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "America/Toronto" }).format(new Date(value))
    : "in 14 days";

/** Invites a DJ business owner. The database authorizes the platform administrator. */
export async function inviteDj(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requirePlatformAdmin();
  const email = emailSchema.safeParse(text(form, "email").toLowerCase());
  if (!email.success) return fail("Enter a valid email address.");
  const { data, error } = await supabase.rpc("create_platform_invitation", { p_email: email.data, ...newLink() });
  if (error) return fail(describeDbError(error));
  const result = data as { status?: string; state?: string; email?: string; expires_at?: string };
  revalidatePath("/platform/invitations");
  if (result.status === "exists") {
    return fail(
      result.state === "expired"
        ? `${result.email} already has an expired invitation. Use Resend on it below to send a new link.`
        : `${result.email} already has a pending invitation. Use Resend on it below if they need a new link.`,
    );
  }
  after(() => processOutboxQuietly());
  return ok(`Invitation sent to ${result.email}. It works until ${formatExpiry(result.expires_at)}.`);
}

/** Sends a fresh link; the previous one stops working. */
export async function resendDjInvitation(invitationId: string): Promise<ActionState> {
  const { supabase } = await requirePlatformAdmin();
  if (!UUID_RE.test(invitationId)) return fail("Not found.");
  const { data, error } = await supabase.rpc("resend_platform_invitation", { p_invitation_id: invitationId, ...newLink() });
  if (error) return fail(describeDbError(error));
  const result = data as { email?: string; expires_at?: string };
  revalidatePath("/platform/invitations");
  after(() => processOutboxQuietly());
  return ok(`A new link was sent to ${result.email}. It works until ${formatExpiry(result.expires_at)}; the previous link no longer works.`);
}

export async function revokeDjInvitation(invitationId: string): Promise<ActionState> {
  const { supabase } = await requirePlatformAdmin();
  if (!UUID_RE.test(invitationId)) return fail("Not found.");
  const { error } = await supabase.rpc("revoke_platform_invitation", { p_invitation_id: invitationId });
  if (error) return fail(describeDbError(error));
  revalidatePath("/platform/invitations");
  return ok("Invitation revoked. Its link no longer works.");
}
