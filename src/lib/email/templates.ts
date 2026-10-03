import { formatCents } from "@/lib/money";

export type OutboxEventType = "proposal_sent" | "proposal_link_opened" | "proposal_submitted" | "proposal_approved";

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
