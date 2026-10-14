import { formatCents } from "@/lib/money";
import { businessBrand, FLUX_BRAND, render, type EmailBrand, type RenderedEmail } from "./layout";

export type { RenderedEmail } from "./layout";

export type OutboxEventType = "proposal_sent" | "proposal_link_opened" | "proposal_submitted" | "proposal_approved";
export type ContractOutboxEventType = "contract_sent" | "contract_sign_in" | "contract_voided" | "contract_signed_copy";

/**
 * Every transactional email the app sends, built on the shared layout
 * (layout.ts): the business's identity first, one clear action, the event
 * details the email actually carries, and a short footer. Subjects are
 * unchanged from earlier versions. `brand` defaults to the business name
 * without a logo; the worker passes the frozen branding (and logo) per row.
 * `canReply` says whether the business set a reply-to address.
 */
type Branding = { brand?: EmailBrand; canReply?: boolean };

export type TemplateInput = Branding & {
  eventType: OutboxEventType;
  tenantDisplayName: string;
  tenantSlug: string;
  proposalId: string;
  payload: Record<string, unknown>;
  appUrl: string;
  /** Proposal link (only for proposal_sent). Contains the bearer token: never log it. */
  proposalLink?: string;
};

const str = (value: unknown, fallback = "") => (typeof value === "string" && value.trim() ? value : fallback);

/** A timestamp as a date in Toronto (the platform's default zone), e.g. "January 15, 2027". */
function formatDate(value: unknown): string {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "America/Toronto" }).format(date);
}

/** A calendar date ("2027-06-12") without any time-zone shift, e.g. "Saturday, June 12, 2027". */
function formatDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return str(value);
  const [y, m, d] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

const brandOf = (input: Branding, name: string) => input.brand ?? businessBrand(name);

/** Footer for a client email from a business. */
function clientFooter(name: string, canReply: boolean | undefined): string[] {
  return [
    ...(canReply ? [`Reply to this email to reach ${name}.`] : []),
    `Sent by ${name} with Flux DJ.`,
  ];
}

/** Footer for a notification to the business's own team. */
const teamFooter = (name: string) => [`You're receiving this because you're on the ${name} team in Flux DJ.`];

const questions = (legalName: string, contactEmail: string | null, canReply?: boolean) =>
  contactEmail ? `Questions? Contact ${legalName} at ${contactEmail}.` : canReply ? "Questions? Reply to this email." : null;

export function renderEmail(input: TemplateInput): RenderedEmail {
  const dj = input.tenantDisplayName;
  const brand = brandOf(input, dj);
  const event = str(input.payload.event_title, "your event");
  const staffUrl = `${input.appUrl}/staff/${input.tenantSlug}/proposals/${input.proposalId}`;

  switch (input.eventType) {
    case "proposal_sent": {
      if (!input.proposalLink) throw new Error("proposal link missing");
      const expires = formatDate(input.payload.expires_at);
      const revised = typeof input.payload.revision === "number" && input.payload.revision > 1;
      return render(`${dj} sent you a proposal for ${event}`, {
        brand,
        preheader: `Choose your package and add-ons for ${event}.`,
        heading: revised ? "Your updated proposal is ready" : "Your proposal is ready",
        greeting: `Hi ${str(input.payload.client_name, "there")},`,
        paragraphs: [
          `${dj} has prepared a proposal for ${event}. Choose your package and any add-ons, answer a few questions about the venue, and submit your choices for ${dj} to review.`,
          ...(revised ? ["This updated proposal replaces the one you received before."] : []),
        ],
        details: [
          ["Event", event],
          ["Date", formatDay(input.payload.event_date)],
          ["Valid until", expires],
        ],
        action: { label: "Review your proposal", href: input.proposalLink },
        notes: ["No account or password is needed. Please don't forward this link: it opens your personal proposal."],
        footer: clientFooter(dj, input.canReply),
      });
    }
    case "proposal_link_opened": {
      return render(`Proposal link opened: ${event}`, {
        brand,
        preheader: `The proposal link for ${event} was opened.`,
        heading: "Your proposal link was opened",
        paragraphs: [
          `The proposal link for ${event} was opened on ${formatDate(input.payload.opened_at) || "a recent date"}.`,
          "This only shows that the link was opened. Email security scanners and link previews can open links automatically, so it does not prove the client has read the proposal.",
        ],
        action: { label: "View proposal", href: staffUrl },
        footer: teamFooter(dj),
      });
    }
    case "proposal_submitted": {
      const total =
        typeof input.payload.total_cents === "number" ? formatCents(input.payload.total_cents, str(input.payload.currency, "CAD")) : "";
      return render(`Submitted for your review: ${event}`, {
        brand,
        preheader: `The client submitted their selection for ${event}.`,
        heading: "A selection is ready for your review",
        paragraphs: [
          `The client submitted their selection for ${event}${total ? ` (total ${total})` : ""}.`,
          "Review the exact package, add-ons, required gear and answers, then approve it or send a revised offer.",
        ],
        details: [
          ["Event", event],
          ["Total", total],
        ],
        action: { label: "Review selection", href: staffUrl },
        footer: teamFooter(dj),
      });
    }
    case "proposal_approved": {
      const total =
        typeof input.payload.total_cents === "number" ? formatCents(input.payload.total_cents, str(input.payload.currency, "CAD")) : "";
      return render(`${dj} approved your selection for ${event}`, {
        brand,
        preheader: `Your contract for ${event} will follow.`,
        heading: "Your selection was approved",
        greeting: `Hi ${str(input.payload.client_name, "there")},`,
        paragraphs: [
          `${dj} has approved your selection for ${event}.`,
          "Your contract will follow in a separate email. Your booking is not confirmed until the contract is completed.",
        ],
        details: [
          ["Event", event],
          ["Approved total", total],
        ],
        footer: clientFooter(dj, input.canReply),
      });
    }
  }
}

/**
 * Contract email (outbox event "contract_sent"). The link opens the
 * invitation page, whose token lives in the URL fragment. The token only lets
 * the client ask for a verification email; reading needs a verified sign-in.
 * The link carries a bearer token: never log it.
 */
export type ContractEmailInput = Branding & {
  tenantDisplayName: string;
  legalName: string;
  contactEmail: string | null;
  clientName: string;
  eventTitle: string;
  eventDate?: string | null;
  depositCents: number;
  depositPercent: number;
  currency: string;
  invitationLink: string;
  expiresAt?: string | null;
};

export function renderContractEmail(input: ContractEmailInput): RenderedEmail {
  const dj = input.tenantDisplayName;
  const expires = formatDate(input.expiresAt);
  return render(`${dj} sent your contract for ${input.eventTitle}`, {
    brand: brandOf(input, dj),
    preheader: `Review and sign your agreement for ${input.eventTitle}.`,
    heading: "Your contract is ready to review",
    greeting: `Hi ${input.clientName},`,
    paragraphs: [
      `${dj} has prepared your agreement for ${input.eventTitle}. Please read it carefully, then sign it securely through Flux DJ.`,
      "To keep your contract private, you'll confirm your email address before you can open it.",
    ],
    details: [
      ["Event", input.eventTitle],
      ["Date", input.eventDate ? formatDay(input.eventDate) : null],
      ["Deposit due on signing", `${formatCents(input.depositCents, input.currency)} (${input.depositPercent}% of the total)`],
    ],
    action: { label: "Read your contract", href: input.invitationLink },
    notes: [
      expires ? `This invitation link works until ${expires}. Please don't forward it.` : "Please don't forward this link.",
      questions(input.legalName, input.contactEmail, input.canReply) ?? "",
    ].filter(Boolean),
    footer: clientFooter(dj, input.canReply),
  });
}

/**
 * Verification email (outbox event "contract_sign_in"). The Supabase
 * verification link is generated at delivery time and never stored. It opens
 * the explicit "Sign in" confirmation page, so scanners cannot use it.
 */
export function renderContractSignInEmail(input: Branding & { tenantDisplayName: string; clientName: string; eventTitle: string; verificationLink: string }): RenderedEmail {
  const dj = input.tenantDisplayName;
  return render(`Confirm your email to read your contract from ${dj}`, {
    brand: brandOf(input, dj),
    preheader: "Confirm your email address to open your contract.",
    heading: "Confirm it's you",
    greeting: `Hi ${input.clientName},`,
    paragraphs: [`Use this link to confirm your email address and open your contract from ${dj} for ${input.eventTitle}.`],
    action: { label: "Confirm and continue", href: input.verificationLink },
    notes: ["It works once and expires in one hour. You can open it on any device. If you didn't ask for it, you can ignore this email."],
    footer: clientFooter(dj, input.canReply),
  });
}

/**
 * Void notice (outbox event "contract_voided"). Says the agreement document is
 * no longer available and the DJ will follow up. It deliberately carries no
 * link, no internal void reason, and nothing suggesting the event is called off.
 */
export function renderContractVoidedEmail(
  input: Branding & { tenantDisplayName: string; legalName: string; contactEmail: string | null; clientName: string; eventTitle: string },
): RenderedEmail {
  const dj = input.tenantDisplayName;
  return render(`Your contract from ${dj} for ${input.eventTitle} is no longer available`, {
    brand: brandOf(input, dj),
    preheader: `The contract for ${input.eventTitle} was withdrawn.`,
    heading: "Contract no longer available",
    greeting: `Hi ${input.clientName},`,
    paragraphs: [
      `The contract ${dj} sent you for ${input.eventTitle} has been withdrawn and is no longer available to read or sign.`,
      `This concerns the contract document only. ${dj} will follow up with you about next steps.`,
    ],
    notes: [questions(input.legalName, input.contactEmail, input.canReply) ?? ""].filter(Boolean),
    footer: clientFooter(dj, input.canReply),
  });
}

/**
 * The signed copy, attached as the committed PDF. One email per party; the
 * business copy is addressed to the frozen business contact. It confirms the
 * signature only: it never says the event is booked or the deposit paid,
 * and carries no internal notes or audit metadata.
 */
export function renderSignedCopyEmail(
  input: Branding & {
    recipientRole: "client" | "business";
    tenantDisplayName: string;
    legalName: string;
    contactEmail: string | null;
    clientName: string;
    typedName: string;
    eventTitle: string;
    eventDate: string;
    signedAtLocal: string;
  },
): RenderedEmail {
  const dj = input.tenantDisplayName;
  const brand = brandOf(input, dj);
  const details: [string, string][] = [
    ["Event", input.eventTitle],
    ["Date", formatDay(input.eventDate)],
    ["Signed by", input.typedName],
    ["Signed on", input.signedAtLocal],
  ];
  if (input.recipientRole === "client") {
    return render(`Your signed contract with ${dj} for ${input.eventTitle}`, {
      brand,
      preheader: "Your signed agreement is attached as a PDF.",
      heading: "Your signed agreement",
      greeting: `Hi ${input.clientName},`,
      paragraphs: [
        `Your contract with ${input.legalName} for ${input.eventTitle} was signed electronically. Your signed copy is attached as a PDF; please keep it for your records.`,
        `${dj} will follow up with the next steps. This email confirms the signature only; it is not a booking or payment confirmation.`,
      ],
      details,
      notes: [questions(input.legalName, input.contactEmail, input.canReply) ?? ""].filter(Boolean),
      footer: clientFooter(dj, input.canReply),
    });
  }
  return render(`Signed contract: ${input.eventTitle} (${input.clientName})`, {
    brand,
    preheader: `The contract for ${input.eventTitle} was signed.`,
    heading: "Contract signed",
    paragraphs: [
      `The contract for ${input.eventTitle} was signed electronically by ${input.typedName}. The signed copy is attached as a PDF; the same copy was emailed to the client.`,
      "Booking confirmation follows your booking policy and is shown on the event page in Flux DJ. Signing records no payment.",
    ],
    details,
    footer: teamFooter(dj),
  });
}

/**
 * Booking confirmation for the client, queued with the booking. Built only
 * from the frozen payload (figures as of the booking), so every retry is the
 * same email. States what remains to be paid; promises no planning access.
 */
export function renderBookingConfirmedEmail(
  input: Branding & {
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
  },
): RenderedEmail {
  const dj = input.tenantDisplayName;
  const money = (cents: number) => formatCents(cents, input.currency);
  const depositMissing = input.receivedCents < input.depositCents;
  return render(`Your booking with ${dj} is confirmed: ${input.eventTitle}`, {
    brand: brandOf(input, dj),
    preheader: `${dj} confirmed your booking for ${input.eventTitle}.`,
    heading: "Booking confirmed",
    greeting: `Hi ${input.clientName},`,
    paragraphs: [
      `${dj} has confirmed your booking for ${input.eventTitle} (${formatDay(input.eventDate)}).`,
      input.remainingCents > 0
        ? `Still to pay: ${money(input.remainingCents)}${input.balanceDueDate ? `, due by ${formatDay(input.balanceDueDate)}` : ""}.` +
          (depositMissing ? ` This includes the deposit of ${money(input.depositCents)}, which hasn't been received yet.` : "")
        : input.creditCents > 0
          ? `Nothing remains to be paid. You have paid ${money(input.creditCents)} more than the total; ${dj} will contact you about it.`
          : "Nothing remains to be paid.",
      `${dj} will be in touch about the next steps.`,
    ],
    details: [
      ["Event", input.eventTitle],
      ["Date", formatDay(input.eventDate)],
      ["Total", money(input.totalCents)],
      [`Received as of ${formatDay(input.bookedOn)}`, money(input.receivedCents)],
    ],
    notes: [
      `Payments are recorded by hand by ${dj}, so a very recent payment may not be included. Pay only as arranged with ${dj}.`,
      questions(input.legalName, input.contactEmail, input.canReply) ?? "",
    ].filter(Boolean),
    footer: clientFooter(dj, input.canReply),
  });
}

/**
 * DJ invitation (outbox event "platform_invitation"), from Flux DJ itself. The
 * link opens /join, whose token stays in the URL fragment; it only lets the
 * invited address ask for a verification email. Carries a bearer token: never log it.
 */
export function renderPlatformInvitationEmail(input: { invitationLink: string; expiresAt: string | null }): RenderedEmail {
  const expires = formatDate(input.expiresAt);
  return render("You're invited to set up your DJ business on Flux DJ", {
    brand: FLUX_BRAND,
    preheader: "Create your own Flux DJ workspace for proposals, contracts and event planning.",
    heading: "Your Flux DJ invitation",
    greeting: "Hi,",
    paragraphs: [
      "You're invited to set up your DJ business on Flux DJ: branded proposals, contracts and event planning for your clients.",
      "To keep your workspace private, you'll first confirm this email address. Then you name your business and choose its web address.",
    ],
    action: { label: "Accept the invitation", href: input.invitationLink },
    notes: [
      expires ? `This invitation works until ${expires}. Please don't forward it.` : "Please don't forward this invitation.",
      "If you weren't expecting it, you can ignore this email.",
    ],
    footer: ["Flux DJ · Proposals, contracts and event planning for DJs.", "You received this because a Flux DJ administrator invited this address."],
  });
}

/**
 * Verification for a DJ invitation (outbox event "platform_sign_in"). The
 * Supabase link is generated at delivery time and never stored; it opens the
 * explicit "Sign in" confirmation page, so scanners cannot use it.
 */
export function renderPlatformSignInEmail(input: { verificationLink: string }): RenderedEmail {
  return render("Confirm your email to set up Flux DJ", {
    brand: FLUX_BRAND,
    preheader: "Confirm your email address to set up your DJ business.",
    heading: "Confirm it's you",
    greeting: "Hi,",
    paragraphs: ["Use this link to confirm your email address and set up your DJ business on Flux DJ."],
    action: { label: "Confirm and continue", href: input.verificationLink },
    notes: ["It works once and expires in one hour. You can open it on any device. If you didn't ask for it, you can ignore this email."],
    footer: ["Flux DJ · Proposals, contracts and event planning for DJs."],
  });
}

/**
 * Staff invitation (outbox event "staff_invitation"), from the business via
 * Flux DJ. The link opens /join/team, whose token stays in the URL fragment;
 * it only lets the invited address ask for a verification email. Carries a
 * bearer token: never log it.
 */
export function renderStaffInvitationEmail(input: Branding & { tenantDisplayName: string; invitationLink: string; expiresAt: string | null }): RenderedEmail {
  const business = input.tenantDisplayName;
  const expires = formatDate(input.expiresAt);
  return render(`You've been invited to join ${business} on Flux DJ`, {
    brand: brandOf(input, business),
    preheader: `Join the ${business} team on Flux DJ.`,
    heading: `Join ${business} on Flux DJ`,
    greeting: "Hi,",
    paragraphs: [
      `${business} has invited you to join their team on Flux DJ.`,
      "Accept your invitation to access the business's events, clients and planning tools. You'll first confirm this email address; no password is needed.",
    ],
    action: { label: "Accept invitation", href: input.invitationLink },
    notes: [
      expires ? `This invitation expires on ${expires}. Please don't forward it.` : "Please don't forward this invitation.",
      "If you weren't expecting it, you can ignore this email.",
    ],
    footer: [`Sent by ${business} with Flux DJ.`],
  });
}

/**
 * Verification for a staff invitation (outbox event "staff_sign_in"). The
 * Supabase link is generated at delivery time and never stored; it opens the
 * explicit "Sign in" confirmation page, so scanners cannot use it.
 */
export function renderStaffSignInEmail(input: Branding & { tenantDisplayName: string; verificationLink: string }): RenderedEmail {
  return render(`Confirm your email to join ${input.tenantDisplayName} on Flux DJ`, {
    brand: brandOf(input, input.tenantDisplayName),
    preheader: `Confirm your email address to join ${input.tenantDisplayName}.`,
    heading: "Confirm it's you",
    greeting: "Hi,",
    paragraphs: [`Use this link to confirm your email address and join ${input.tenantDisplayName} on Flux DJ.`],
    action: { label: "Confirm and continue", href: input.verificationLink },
    notes: ["It works once and expires in one hour. You can open it on any device. If you didn't ask for it, you can ignore this email."],
    footer: [`Sent by ${input.tenantDisplayName} with Flux DJ.`],
  });
}

/**
 * Planning invitation for an event booked outside Flux DJ (outbox event
 * "planning_invitation"). It says the event is booked and planning is ready;
 * it never mentions a proposal, contract, deposit or payment, and never
 * suggests Flux DJ took the booking. The link only lets the invited address
 * ask for a verification email.
 */
export function renderPlanningInvitationEmail(
  input: Branding & { tenantDisplayName: string; clientName: string; eventTitle: string; eventDate: string | null; invitationLink: string; expiresAt: string | null },
): RenderedEmail {
  const dj = input.tenantDisplayName;
  const expires = formatDate(input.expiresAt);
  return render(`Plan your event with ${dj}: ${input.eventTitle}`, {
    brand: brandOf(input, dj),
    preheader: `Your event is booked. Let's plan the details of ${input.eventTitle}.`,
    heading: "Let's plan your event",
    greeting: `Hi ${input.clientName},`,
    paragraphs: [
      `Your event is booked. ${dj} uses Flux DJ to plan the details with you: timing, music, people and vendors.`,
      "To keep your planning private, you'll confirm your email address before you open it. No password is needed.",
    ],
    details: [
      ["Event", input.eventTitle],
      ["Date", input.eventDate ? formatDay(input.eventDate) : null],
    ],
    action: { label: "Start planning", href: input.invitationLink },
    notes: [
      expires ? `This invitation link works until ${expires}. Please don't forward it.` : "Please don't forward this link.",
      input.canReply ? "Questions? Reply to this email." : "",
    ].filter(Boolean),
    footer: clientFooter(dj, input.canReply),
  });
}

/**
 * Verification for a planning invitation (outbox event "planning_sign_in").
 * The Supabase link is generated at delivery time and never stored; it opens
 * the explicit "Sign in" confirmation page, so scanners cannot use it.
 */
export function renderPlanningSignInEmail(input: Branding & { tenantDisplayName: string; clientName: string; eventTitle: string; verificationLink: string }): RenderedEmail {
  const dj = input.tenantDisplayName;
  return render(`Confirm your email to plan your event with ${dj}`, {
    brand: brandOf(input, dj),
    preheader: "Confirm your email address to open your event planning.",
    heading: "Confirm it's you",
    greeting: `Hi ${input.clientName},`,
    paragraphs: [`Use this link to confirm your email address and open the planning for ${input.eventTitle} with ${dj}.`],
    action: { label: "Confirm and continue", href: input.verificationLink },
    notes: ["It works once and expires in one hour. You can open it on any device. If you didn't ask for it, you can ignore this email."],
    footer: clientFooter(dj, input.canReply),
  });
}
