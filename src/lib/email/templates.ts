import { formatCents } from "@/lib/money";

export type OutboxEventType = "proposal_sent" | "proposal_link_opened" | "proposal_submitted" | "proposal_approved";
export type ContractOutboxEventType = "contract_sent" | "contract_sign_in" | "contract_voided";

export type TemplateInput = {
  eventType: OutboxEventType;
  tenantDisplayName: string;
  tenantSlug: string;
  proposalId: string;
  payload: Record<string, unknown>;
  appUrl: string;
  /** Proposal link (only for proposal_sent). Contains the bearer token: never log it. */
  proposalLink?: string;
};

export type RenderedEmail = { subject: string; text: string; html: string };

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const str = (value: unknown, fallback = "") => (typeof value === "string" && value.trim() ? value : fallback);

function formatDate(value: unknown): string {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "America/Toronto" }).format(date);
}

function layout(heading: string, paragraphs: string[], action?: { label: string; href: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join("");
  const button = action
    ? `<p style="margin:20px 0"><a href="${escapeHtml(action.href)}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${escapeHtml(action.label)}</a></p>`
    : "";
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;color:#111827"><h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>${body}${button}</div>`;
}

export function renderEmail(input: TemplateInput): RenderedEmail {
  const dj = input.tenantDisplayName;
  const event = str(input.payload.event_title, "your event");
  const staffUrl = `${input.appUrl}/staff/${input.tenantSlug}/proposals/${input.proposalId}`;

  switch (input.eventType) {
    case "proposal_sent": {
      if (!input.proposalLink) throw new Error("proposal link missing");
      const expires = formatDate(input.payload.expires_at);
      const lines = [
        `Hi ${str(input.payload.client_name, "there")},`,
        `${dj} has prepared a proposal for ${event}. Choose your package and extras, answer a few questions about the venue, and submit it for ${dj} to review.`,
        expires ? `This offer is valid until ${expires}.` : "",
        "No account or password is needed. Please don't forward this link: it opens your personal proposal.",
      ].filter(Boolean);
      return {
        subject: `${dj} sent you a proposal for ${event}`,
        text: `${lines.join("\n\n")}\n\nView your proposal: ${input.proposalLink}\n`,
        html: layout(`Your proposal from ${dj}`, lines, { label: "View your proposal", href: input.proposalLink }),
      };
    }
    case "proposal_link_opened": {
      const lines = [
        `The proposal link for ${event} was opened on ${formatDate(input.payload.opened_at) || "a recent date"}.`,
        "This only shows that the link was opened. Email security scanners and link previews can open links automatically, so it does not prove the client has read the proposal.",
      ];
      return {
        subject: `Proposal link opened: ${event}`,
        text: `${lines.join("\n\n")}\n\nProposal: ${staffUrl}\n`,
        html: layout("Proposal link opened", lines, { label: "View proposal", href: staffUrl }),
      };
    }
    case "proposal_submitted": {
      const total =
        typeof input.payload.total_cents === "number" ? formatCents(input.payload.total_cents, str(input.payload.currency, "CAD")) : "";
      const lines = [
        `The client submitted their selection for ${event}${total ? ` (total ${total})` : ""}.`,
        "Review the exact package, extras, required gear and answers, then approve it or send a revised offer.",
      ];
      return {
        subject: `Submitted for your review: ${event}`,
        text: `${lines.join("\n\n")}\n\nReview: ${staffUrl}\n`,
        html: layout("Selection submitted for review", lines, { label: "Review selection", href: staffUrl }),
      };
    }
    case "proposal_approved": {
      const lines = [
        `Hi ${str(input.payload.client_name, "there")},`,
        `${dj} has approved your selection for ${event}.`,
        "Your contract will follow in a separate email. Your booking is not confirmed until the contract is completed.",
      ];
      return {
        subject: `${dj} approved your selection for ${event}`,
        text: `${lines.join("\n\n")}\n`,
        html: layout("Your selection was approved", lines),
      };
    }
  }
}

/**
 * Contract email (outbox event "contract_sent"). The link opens the
 * invitation page, whose token lives in the URL fragment. The token only lets
 * the client ask for a verification email; reading needs a verified sign-in.
 * The link carries a bearer token: never log it.
 */
export type ContractEmailInput = {
  tenantDisplayName: string;
  legalName: string;
  contactEmail: string | null;
  clientName: string;
  eventTitle: string;
  depositCents: number;
  depositPercent: number;
  currency: string;
  invitationLink: string;
  expiresAt?: string | null;
};

export function renderContractEmail(input: ContractEmailInput): RenderedEmail {
  const dj = input.tenantDisplayName;
  const expires = formatDate(input.expiresAt);
  const lines = [
    `Hi ${input.clientName},`,
    `${dj} has sent your contract for ${input.eventTitle}. Please read it carefully.`,
    `A deposit of ${formatCents(input.depositCents, input.currency)} (${input.depositPercent}% of the total) will be due on signing.`,
    "To keep your contract private, you will confirm your email address before you can read it. Online signing is not available yet.",
    expires ? `This invitation link works until ${expires}. Please don't forward it.` : "Please don't forward this link.",
    input.contactEmail ? `Questions? Contact ${input.legalName} at ${input.contactEmail}.` : `Questions? Reply to this email.`,
  ];
  return {
    subject: `${dj} sent your contract for ${input.eventTitle}`,
    text: `${lines.join("\n\n")}\n\nRead your contract: ${input.invitationLink}\n`,
    html: layout(`Your contract from ${dj}`, lines, { label: "Read your contract", href: input.invitationLink }),
  };
}

/**
 * Verification email (outbox event "contract_sign_in"). The Supabase
 * verification link is generated at delivery time and never stored. It opens
 * the explicit "Sign in" confirmation page, so scanners cannot use it.
 */
export function renderContractSignInEmail(input: { tenantDisplayName: string; clientName: string; eventTitle: string; verificationLink: string }): RenderedEmail {
  const lines = [
    `Hi ${input.clientName},`,
    `Use this link to confirm your email address and open your contract from ${input.tenantDisplayName} for ${input.eventTitle}.`,
    "It works once and expires in one hour. You can open it on any device. If you didn't ask for it, you can ignore this email.",
  ];
  return {
    subject: `Confirm your email to read your contract from ${input.tenantDisplayName}`,
    text: `${lines.join("\n\n")}\n\nConfirm and continue: ${input.verificationLink}\n`,
    html: layout("Confirm it's you", lines, { label: "Confirm and continue", href: input.verificationLink }),
  };
}

/**
 * Void notice (outbox event "contract_voided"). Says the agreement document is
 * no longer available and the DJ will follow up. It deliberately carries no
 * link, no internal void reason, and nothing suggesting the event is called off.
 */
export function renderContractVoidedEmail(input: { tenantDisplayName: string; legalName: string; contactEmail: string | null; clientName: string; eventTitle: string }): RenderedEmail {
  const dj = input.tenantDisplayName;
  const lines = [
    `Hi ${input.clientName},`,
    `The contract ${dj} sent you for ${input.eventTitle} has been withdrawn and is no longer available to read or sign.`,
    `This concerns the contract document only. ${dj} will follow up with you about next steps.`,
    input.contactEmail ? `Questions? Contact ${input.legalName} at ${input.contactEmail}.` : "Questions? Reply to this email.",
  ];
  return {
    subject: `Your contract from ${dj} for ${input.eventTitle} is no longer available`,
    text: `${lines.join("\n\n")}\n`,
    html: layout("Contract no longer available", lines),
  };
}
