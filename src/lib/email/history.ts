/**
 * How staff see an email's delivery, from the outbox row alone.
 *
 * "sent" in the outbox means the email provider accepted it, nothing more.
 * Delivery, delays, bounces and complaints are known only when the provider's
 * webhook reported them (provider_status); without that, the label says
 * "Accepted by email provider" and explains that inbox placement is unknown.
 * Opens and clicks are never shown (scanners trigger them).
 */

export type OutboxRow = {
  id: string;
  event_type: string;
  recipient_email: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  sent_at: string | null;
  created_at: string;
  provider_status?: string | null;
  provider_status_at?: string | null;
  provider_detail?: string | null;
  payload?: unknown;
};

export type Tone = "normal" | "pending" | "good" | "attention";

export type DeliveryState = {
  label: string;
  tone: Tone;
  /** One sentence on what is actually known. */
  explanation: string;
  /** Staff should look at it (failed, bounced, complained…). */
  attention: boolean;
  /** retry_email_outbox accepts it (only failed submissions). */
  retryable: boolean;
  /** The time that matters for this state. */
  at: string | null;
};

const PURPOSE: Record<string, string> = {
  proposal_sent: "Proposal",
  proposal_link_opened: "Proposal link opened",
  proposal_submitted: "Selection submitted for review",
  proposal_approved: "Selection approved",
  contract_sent: "Contract ready to sign",
  contract_sign_in: "Contract sign-in link",
  contract_voided: "Contract withdrawn notice",
  contract_signed_copy: "Signed contract copy",
  booking_confirmed: "Booking confirmation",
  staff_invitation: "Team invitation",
  staff_sign_in: "Team invitation sign-in link",
  planning_invitation: "Planning invitation",
  planning_sign_in: "Planning sign-in link",
};

/** Emails addressed to the business's own team rather than the client. */
const TEAM_NOTICES = new Set(["proposal_link_opened", "proposal_submitted"]);

export function emailPurpose(row: Pick<OutboxRow, "event_type" | "payload">): { label: string; toTeam: boolean } {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  let label = PURPOSE[row.event_type] ?? "Email";
  if (row.event_type === "proposal_sent" && typeof payload.revision === "number" && payload.revision > 1) label = `Revised proposal (revision ${payload.revision})`;
  const businessCopy = row.event_type === "contract_signed_copy" && payload.recipient_role === "business";
  if (businessCopy) label = "Signed contract copy (your copy)";
  return { label, toTeam: TEAM_NOTICES.has(row.event_type) || businessCopy };
}

/**
 * A safe summary of the last error: our own worker messages are shown, a
 * provider refusal as its HTTP status only, anything else generically. Raw
 * provider text never reaches the page.
 */
export function errorSummary(error: string | null): string | null {
  if (!error) return null;
  // Outcomes where an earlier attempt may have reached the recipient: never a plain "not sent".
  // (The worker's POSSIBLY_DELIVERED, and the claim's "delivery did not complete" for an attempt that never finished.)
  if (/^An earlier attempt of this email may already have been delivered/.test(error)) {
    return "An earlier attempt may already have been delivered: the email provider refused a changed repeat. Check before retrying.";
  }
  if (/^delivery did not complete/.test(error)) return "The last attempt didn't finish, so it may have been delivered. Check before retrying.";
  const http = /responded (\d{3})/.exec(error);
  if (http) return `The email provider refused it (HTTP ${http[1]}).`;
  const known = [
    /^The link secret changed[^.]*\./,
    /^The signed PDF[^.]*\./,
    /^The sender could not be prepared\./,
    /^Could not create a verification link/,
    /^Email delivery is disabled/,
    /^Mailpit responded/,
  ];
  for (const re of known) {
    const match = re.exec(error);
    if (match) return match[0].endsWith(".") ? match[0] : `${match[0]}.`;
  }
  return "The last attempt failed.";
}

/** Why an email was not sent. Cancellations carry Flux's own wording (never provider text). */
function cancelReason(reason: string | null): string {
  const text = (reason ?? "").replace(/^Cancelled:\s*/i, "").trim();
  if (!text) return "It was cancelled before delivery.";
  const sentence = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function deliveryState(row: OutboxRow, now = new Date()): DeliveryState {
  const base = { attention: false, retryable: false };
  switch (row.status) {
    case "pending":
      if (row.attempts > 0) {
        const soon = new Date(row.next_attempt_at).getTime() <= now.getTime();
        return {
          ...base,
          label: "Retrying",
          tone: "pending",
          explanation: `${errorSummary(row.last_error) ?? "The last attempt failed."} Flux tries again automatically${soon ? " shortly" : ""}.`,
          at: row.next_attempt_at,
        };
      }
      return { ...base, label: "Waiting to send", tone: "pending", explanation: "Queued. It usually goes out within a few minutes.", at: row.created_at };
    case "sending":
      return { ...base, label: "Sending", tone: "pending", explanation: "Being handed to the email provider now.", at: row.created_at };
    case "failed":
      return {
        label: "Couldn't be sent",
        tone: "attention",
        explanation: `${errorSummary(row.last_error) ?? "Every attempt failed."} You can retry it.`,
        attention: true,
        retryable: true,
        at: row.created_at,
      };
    case "cancelled":
      return { ...base, label: "Not sent", tone: "normal", explanation: cancelReason(row.last_error), at: row.created_at };
    case "sent":
      return sentState(row);
    default:
      return { ...base, label: "Unknown", tone: "normal", explanation: "Flux has no delivery information for this email.", at: row.created_at };
  }
}

/**
 * A soft bounce: Resend reports "bounced" with a "Transient" category for a
 * temporary refusal (a full mailbox, a server busy for a while). Only a
 * permanent bounce means the address doesn't work. The dashboard's delivery
 * problems and the event's email list use this same rule.
 */
export function isTransientBounce(detail: string | null | undefined): boolean {
  return /^transient/i.test(detail ?? "");
}

function sentState(row: OutboxRow): DeliveryState {
  const at = row.provider_status_at ?? row.sent_at;
  const detail = row.provider_detail ? ` (${row.provider_detail})` : "";
  switch (row.provider_status) {
    case "delivered":
      return { label: "Delivered", tone: "good", explanation: "The recipient's mail server accepted it. It can still be filtered to spam.", attention: false, retryable: false, at };
    case "delayed":
      return { label: "Delivery delayed", tone: "pending", explanation: "The recipient's mail server hasn't accepted it yet; the provider keeps trying.", attention: false, retryable: false, at };
    case "bounced":
      if (isTransientBounce(row.provider_detail)) {
        return {
          label: "Temporarily refused",
          tone: "pending",
          explanation: `The recipient's mail server refused it for now${detail}, for example because the mailbox is full. It may not have arrived; if the client says it didn't, ask them to check their mailbox.`,
          attention: false,
          retryable: false,
          at,
        };
      }
      return { label: "Bounced", tone: "attention", explanation: `The recipient's mail server rejected it${detail}. Check the address with the client.`, attention: true, retryable: false, at };
    case "complained":
      return { label: "Marked as spam", tone: "attention", explanation: "The recipient reported it as spam. Contact them another way.", attention: true, retryable: false, at };
    case "suppressed":
      return { label: "Not delivered", tone: "attention", explanation: "The provider didn't deliver it because this address bounced or reported spam before.", attention: true, retryable: false, at };
    case "failed":
      return { label: "Provider couldn't deliver", tone: "attention", explanation: `The email provider accepted it but couldn't deliver it${detail}.`, attention: true, retryable: false, at };
    default:
      return {
        label: "Accepted by email provider",
        tone: "normal",
        explanation: "The email provider accepted it for delivery. Flux has no confirmation that it reached the inbox.",
        attention: false,
        retryable: false,
        at: row.sent_at,
      };
  }
}
