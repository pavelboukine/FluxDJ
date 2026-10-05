"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { checkbox, fail, int, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";
import { parseMoneyToCents } from "@/lib/money";
import { isHttpsUrl } from "@/lib/payments";

/**
 * Manual payment tracking. Every action re-checks staff membership with
 * requireStaff, and every database function checks it again. Nothing here
 * changes the event's status, booking, contracts or planning access, and
 * nothing sends email.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Records a received payment. The form's idempotency key makes retries and double submits record it once. */
export async function recordPayment(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const key = text(form, "idempotency_key");
  if (!UUID_RE.test(key)) return fail("Reload the page and try again.");
  const amount = parseMoneyToCents(text(form, "amount"));
  if (amount === null || amount < 1) return fail("Enter the amount received, for example 500 or 1,250.50.");
  const paidOn = text(form, "paid_on");
  if (!DATE_RE.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) return fail("Enter the date the payment was received.");
  const reference = optionalText(form, "reference");
  if (reference && reference.length > 200) return fail("The reference is limited to 200 characters.");
  const note = optionalText(form, "note");
  if (note && note.length > 2000) return fail("The note is limited to 2,000 characters.");

  const { data, error } = await supabase.rpc("record_event_payment", {
    p_event_id: eventId,
    p_amount_cents: amount,
    p_paid_on: paidOn,
    p_reference: reference ?? "",
    p_note: note ?? "",
    p_idempotency_key: key,
    p_confirm_duplicate: checkbox(form, "confirm_duplicate"),
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  const result = data as { status: string; booking?: string };
  if (result.status === "replayed") return ok("This payment was already recorded.");
  // The booking email was queued with the booking; deliver it now (the
  // scheduled worker retries anything that fails).
  if (result.booking === "booked") after(() => processOutboxQuietly(tenant.id));
  return ok(result.booking === "booked" ? "Payment recorded. The deposit is covered, so the booking is confirmed and the client is emailed." : "Payment recorded.");
}

/**
 * Checks the event's booking against its signed contract, in the database.
 * Needed for contracts signed before booking policies existed (checked as
 * "signed and deposit received"); other events are checked automatically.
 */
export async function checkBooking(slug: string, eventId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const { data, error } = await supabase.rpc("check_event_booking", { p_event_id: eventId });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  const status = (data as { status: string }).status;
  if (status === "booked") after(() => processOutboxQuietly(tenant.id));
  const messages: Record<string, string> = {
    booked: "Booking confirmed. The client is emailed a booking confirmation.",
    already_booked: "This event is already booked.",
    awaiting_deposit: "Not booked yet: the deposit hasn't been received. It will be confirmed automatically once payments cover it.",
    archived: "Archived events can't be booked. Unarchive it first.",
    not_signed: "There is no signed contract for this event.",
  };
  return status === "booked" || status === "already_booked" ? ok(messages[status]) : fail(messages[status] ?? "This event can't be booked.");
}

/** Invalidates a wrong entry with a reason. The entry stays in the history; a correction is a new payment. */
export async function invalidatePayment(slug: string, eventId: string, paymentId: string, reason: string): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(paymentId)) return fail("Reload the page and try again.");
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length < 3 || trimmed.length > 500) return fail("Give a reason (3 to 500 characters).");
  const { data, error } = await supabase.rpc("invalidate_event_payment", { p_payment_id: paymentId, p_reason: trimmed });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  return ok((data as { status: string }).status === "already_invalidated" ? "This payment was already invalidated." : "Payment invalidated. It stays in the history.");
}

/** Sets or clears the external invoice link. A stale tab gets a conflict instead of overwriting newer changes. */
export async function saveInvoiceUrl(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const expected = int(form, "draft_version", 0, 2_000_000_000);
  if (expected === null) return fail("Reload the page and try again.");
  const url = text(form, "invoice_url");
  if (url && !isHttpsUrl(url)) return fail("Enter a full https:// address, for example https://invoice.example.com/abc, or leave it empty.");
  const { data: version, error } = await supabase.rpc("set_event_invoice_url", { p_event_id: eventId, p_invoice_url: url, p_expected_version: expected });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  return ok(url ? "Invoice link saved." : "Invoice link removed.", version);
}
