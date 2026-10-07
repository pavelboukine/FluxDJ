import { formatCents } from "@/lib/money";

export type OutboxEventType = "proposal_sent" | "proposal_link_opened" | "proposal_submitted" | "proposal_approved";
export type ContractOutboxEventType = "contract_sent" | "contract_sign_in" | "contract_voided" | "contract_signed_copy";

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
    "To keep your contract private, you will confirm your email address before you can open it.",
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

/**
 * The signed copy, attached as the committed PDF. One email per party; the
 * business copy is addressed to the frozen business contact. It confirms the
 * signature only: it never says the event is booked or the deposit paid,
 * and carries no internal notes or audit metadata.
 */
export function renderSignedCopyEmail(input: {
  recipientRole: "client" | "business";
  tenantDisplayName: string;
  legalName: string;
  contactEmail: string | null;
  clientName: string;
  typedName: string;
  eventTitle: string;
  eventDate: string;
  signedAtLocal: string;
}): RenderedEmail {
  const dj = input.tenantDisplayName;
  const lines =
    input.recipientRole === "client"
      ? [
          `Hi ${input.clientName},`,
          `Your contract with ${input.legalName} for ${input.eventTitle} (${input.eventDate}) was signed electronically by ${input.typedName} on ${input.signedAtLocal}.`,
          "Your signed copy is attached as a PDF. Please keep it for your records.",
          `${dj} will follow up with the next steps. This email confirms the signature only; it is not a booking or payment confirmation.`,
          input.contactEmail ? `Questions? Contact ${input.legalName} at ${input.contactEmail}.` : "Questions? Reply to this email.",
        ]
      : [
          `The contract for ${input.eventTitle} (${input.eventDate}) was signed electronically by ${input.typedName} on ${input.signedAtLocal}.`,
          "The signed copy is attached as a PDF. The same copy was emailed to the client.",
          "Booking confirmation follows your booking policy and is shown on the event page in Flux DJ. Signing records no payment.",
        ];
  const subject =
    input.recipientRole === "client"
      ? `Your signed contract with ${dj} for ${input.eventTitle}`
      : `Signed contract: ${input.eventTitle} (${input.clientName})`;
  return { subject, text: `${lines.join("\n\n")}\n`, html: layout("Contract signed", lines) };
}

/**
 * Booking confirmation for the client, queued with the booking. Built only
 * from the frozen payload (figures as of the booking), so every retry is the
 * same email. States what remains to be paid; promises no planning access.
 */
export function renderBookingConfirmedEmail(input: {
  tenantDisplayName: string;
  legalName: string;
  contactEmail: string | null;
  clientName: string;
  eventTitle: string;
  eventDate: string;
  currency: string;
  totalCents: number;
  depositCents: number;
  receivedCents: number;
  remainingCents: number;
  creditCents: number;
  balanceDueDate: string | null;
  bookedOn: string;
}): RenderedEmail {
  const dj = input.tenantDisplayName;
  const money = (cents: number) => formatCents(cents, input.currency);
  const lines = [
    `Hi ${input.clientName},`,
    `${dj} has confirmed your booking for ${input.eventTitle} (${input.eventDate}).`,
    `Payments as of ${input.bookedOn}: total ${money(input.totalCents)}, received ${money(input.receivedCents)}.`,
    input.remainingCents > 0
      ? `Still to pay: ${money(input.remainingCents)}${input.balanceDueDate ? `, due by ${input.balanceDueDate}` : ""}.` +
        (input.receivedCents < input.depositCents ? ` This includes the deposit of ${money(input.depositCents)}, which hasn't been received yet.` : "")
      : input.creditCents > 0
        ? `Nothing remains to be paid. You have paid ${money(input.creditCents)} more than the total; ${dj} will contact you about it.`
        : "Nothing remains to be paid.",
    `Payments are recorded by hand by ${dj}, so a very recent payment may not be included. Pay only as arranged with ${dj}.`,
    `${dj} will be in touch about the next steps.`,
    input.contactEmail ? `Questions? Contact ${input.legalName} at ${input.contactEmail}.` : "Questions? Reply to this email.",
  ];
  return { subject: `Your booking with ${dj} is confirmed: ${input.eventTitle}`, text: `${lines.join("\n\n")}\n`, html: layout("Booking confirmed", lines) };
}

/**
 * DJ invitation (outbox event "platform_invitation"), from Flux DJ itself. The
 * link opens /join, whose token stays in the URL fragment; it only lets the
 * invited address ask for a verification email. Carries a bearer token: never log it.
 */
export function renderPlatformInvitationEmail(input: { invitationLink: string; expiresAt: string | null }): RenderedEmail {
  const expires = formatDate(input.expiresAt);
  const lines = [
    "Hi,",
    "You're invited to set up your DJ business on Flux DJ: branded proposals, contracts and event planning for your clients.",
    "To keep your workspace private, you will first confirm this email address. Then you name your business and choose its web address.",
    expires ? `This invitation works until ${expires}. Please don't forward it.` : "Please don't forward this invitation.",
    "If you weren't expecting it, you can ignore this email.",
  ];
  return {
    subject: "You're invited to set up your DJ business on Flux DJ",
    text: `${lines.join("\n\n")}\n\nAccept the invitation: ${input.invitationLink}\n`,
    html: layout("Your Flux DJ invitation", lines, { label: "Accept the invitation", href: input.invitationLink }),
  };
}

/**
 * Verification for a DJ invitation (outbox event "platform_sign_in"). The
 * Supabase link is generated at delivery time and never stored; it opens the
 * explicit "Sign in" confirmation page, so scanners cannot use it.
 */
export function renderPlatformSignInEmail(input: { verificationLink: string }): RenderedEmail {
  const lines = [
    "Hi,",
    "Use this link to confirm your email address and set up your DJ business on Flux DJ.",
    "It works once and expires in one hour. You can open it on any device. If you didn't ask for it, you can ignore this email.",
  ];
  return {
    subject: "Confirm your email to set up Flux DJ",
    text: `${lines.join("\n\n")}\n\nConfirm and continue: ${input.verificationLink}\n`,
    html: layout("Confirm it's you", lines, { label: "Confirm and continue", href: input.verificationLink }),
  };
}
