"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { fail, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { sha256Hex, staffInviteToken } from "@/lib/proposals/tokens.server";

const emailSchema = z.email().max(320);

const formatExpiry = (value: unknown) =>
  typeof value === "string"
    ? new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "America/Toronto" }).format(new Date(value))
    : "in 7 days";

/**
 * Invites a staff member. Owner only: the page hides the form from staff, and
 * create_staff_invitation checks the owner role, the business's state and
 * the address again in the database. The form's request id makes a retried
 * submission return the invitation already created, with no second email.
 */
export async function inviteStaff(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can invite staff.");
  const requestId = text(form, "request_id");
  if (!UUID_RE.test(requestId)) return fail("Reload the page and try again.");
  const email = emailSchema.safeParse(text(form, "email").toLowerCase());
  if (!email.success) return fail("Enter a valid email address.");
  const linkId = randomUUID();
  const { data, error } = await supabase.rpc("create_staff_invitation", {
    p_tenant_id: tenant.id,
    p_invitation_id: requestId,
    p_email: email.data,
    p_link_id: linkId,
    p_token_hash: sha256Hex(staffInviteToken(linkId)),
  });
  if (error) return fail(describeDbError(error));
  const result = data as { status?: string; state?: string; email?: string; expires_at?: string };
  revalidatePath(`/staff/${slug}/team`);
  if (result.status === "member") return fail(`${result.email} already has access to this business.`);
  if (result.status === "exists") {
    return fail(
      result.state === "expired"
        ? `${result.email} already has an expired invitation. Use Resend on it below to send a new link.`
        : `${result.email} already has a pending invitation. Use Resend on it below if they need a new link.`,
    );
  }
  after(() => processOutboxQuietly(tenant.id));
  return ok(`Invitation sent to ${result.email}. It works until ${formatExpiry(result.expires_at)}.`);
}

/**
 * Sends a fresh link; the previous one stops working. The form's request id
 * becomes the new link id, so a retried resend is a replay, not another email.
 */
export async function resendStaffInvitation(slug: string, invitationId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can resend invitations.");
  const linkId = text(form, "request_id");
  if (!UUID_RE.test(invitationId) || !UUID_RE.test(linkId)) return fail("Reload the page and try again.");
  const { data, error } = await supabase.rpc("resend_staff_invitation", {
    p_tenant_id: tenant.id,
    p_invitation_id: invitationId,
    p_link_id: linkId,
    p_token_hash: sha256Hex(staffInviteToken(linkId)),
  });
  if (error) return fail(describeDbError(error));
  const result = data as { email?: string; expires_at?: string };
  revalidatePath(`/staff/${slug}/team`);
  after(() => processOutboxQuietly(tenant.id));
  return ok(`A new link was sent to ${result.email}. It works until ${formatExpiry(result.expires_at)}; the previous link no longer works.`);
}

export async function cancelStaffInvitation(slug: string, invitationId: string): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can cancel invitations.");
  if (!UUID_RE.test(invitationId)) return fail("Not found.");
  const { error } = await supabase.rpc("cancel_staff_invitation", { p_tenant_id: tenant.id, p_invitation_id: invitationId });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/team`);
  return ok("Invitation cancelled. Its link no longer works.");
}

/** Ends a staff member's access on their next request. Their past work keeps its attribution. */
export async function removeStaffMember(slug: string, membershipId: string): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can remove staff.");
  if (!UUID_RE.test(membershipId)) return fail("Not found.");
  const { error } = await supabase.rpc("remove_staff_member", { p_tenant_id: tenant.id, p_membership_id: membershipId });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/team`);
  return ok("Removed. They no longer have access to this business.");
}
