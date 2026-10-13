import { businessBrand, escapeHtml, logoPlateSize, type EmailBrand, type RenderedEmail } from "./layout";
import {
  renderBookingConfirmedEmail,
  renderContractEmail,
  renderContractSignInEmail,
  renderContractVoidedEmail,
  renderEmail,
  renderPlatformInvitationEmail,
  renderPlatformSignInEmail,
  renderSignedCopyEmail,
  renderStaffInvitationEmail,
  renderStaffSignInEmail,
} from "./templates";

/**
 * Sample renders of every email for local review (/api/dev/email-preview).
 * Invented businesses and people only; no database, no real links.
 */

export const PREVIEW_VARIANTS = {
  logo: { label: "Logo, brand colour", name: "Northside Sound", color: "#7c3aed", logo: "light" },
  dark: { label: "Light logo on dark", name: "Midnight Events", color: "#0f766e", logo: "dark" },
  none: { label: "No logo, default colour", name: "Riverside DJ Co.", color: null, logo: null },
  long: { label: "Long names, pale colour", name: "The Extraordinarily Long-Named Wedding & Corporate Entertainment Company", color: "#fde68a", logo: null },
} as const;
export type PreviewVariant = keyof typeof PREVIEW_VARIANTS;

/** The sample logo artwork's pixel size; the preview route plates it as the worker does. */
export const PREVIEW_LOGO_SIZE = { width: 300, height: 90 };

export function previewEmails(variant: PreviewVariant): { key: string; label: string; email: RenderedEmail }[] {
  const v = PREVIEW_VARIANTS[variant];
  const brand: EmailBrand = businessBrand(
    v.name,
    v.color,
    v.logo ? { cid: "business-logo", ...logoPlateSize(PREVIEW_LOGO_SIZE.width, PREVIEW_LOGO_SIZE.height) } : null,
  );
  const long = variant === "long";
  const event = long ? "Alexandra & Christopher's Wedding Reception and After-Party at the Grand Riverside Ballroom" : "Patel & Chen Wedding";
  const app = "https://fluxdj.example";
  const common = { brand, canReply: variant !== "none", tenantDisplayName: v.name };
  const contract = { ...common, legalName: `${v.name} Inc.`, contactEmail: "hello@business.example", clientName: "Riya", eventTitle: event };
  return [
    { key: "proposal_sent", label: "Proposal sent (client)", email: renderEmail({ ...common, eventType: "proposal_sent", tenantSlug: "sample", proposalId: "sample", appUrl: app, proposalLink: `${app}/sample/p#sample-token`, payload: { event_title: event, event_date: "2027-06-12", client_name: "Riya", expires_at: "2027-01-31T17:00:00Z", revision: 1 } }) },
    { key: "proposal_link_opened", label: "Proposal link opened (team)", email: renderEmail({ ...common, eventType: "proposal_link_opened", tenantSlug: "sample", proposalId: "sample", appUrl: app, payload: { event_title: event, opened_at: "2027-01-10T15:00:00Z" } }) },
    { key: "proposal_submitted", label: "Selection submitted (team)", email: renderEmail({ ...common, eventType: "proposal_submitted", tenantSlug: "sample", proposalId: "sample", appUrl: app, payload: { event_title: event, total_cents: 412_345, currency: "CAD" } }) },
    { key: "proposal_approved", label: "Selection approved (client)", email: renderEmail({ ...common, eventType: "proposal_approved", tenantSlug: "sample", proposalId: "sample", appUrl: app, payload: { event_title: event, client_name: "Riya", total_cents: 412_345, currency: "CAD" } }) },
    { key: "contract_sent", label: "Contract ready to sign", email: renderContractEmail({ ...contract, depositCents: 123_700, depositPercent: 30, currency: "CAD", invitationLink: `${app}/sample/invite#sample-token`, expiresAt: "2027-02-14T17:00:00Z" }) },
    { key: "contract_sign_in", label: "Contract sign-in link", email: renderContractSignInEmail({ ...common, clientName: "Riya", eventTitle: event, verificationLink: `${app}/auth/confirm?token_hash=sample&type=email` }) },
    { key: "contract_voided", label: "Contract withdrawn", email: renderContractVoidedEmail(contract) },
    { key: "signed_client", label: "Signed copy (client)", email: renderSignedCopyEmail({ ...contract, recipientRole: "client", typedName: "Riya Patel", eventDate: "2027-06-12", signedAtLocal: "January 20, 2027 at 7:42 p.m. EST" }) },
    { key: "signed_business", label: "Signed copy (business)", email: renderSignedCopyEmail({ ...contract, recipientRole: "business", typedName: "Riya Patel", eventDate: "2027-06-12", signedAtLocal: "January 20, 2027 at 7:42 p.m. EST" }) },
    { key: "booking_confirmed", label: "Booking confirmed (deposit outstanding)", email: renderBookingConfirmedEmail({ ...contract, eventDate: "2027-06-12", currency: "CAD", totalCents: 412_345, depositCents: 123_700, receivedCents: 50_000, remainingCents: 362_345, creditCents: 0, balanceDueDate: "2027-05-29", bookedOn: "2027-01-21" }) },
    { key: "staff_invitation", label: "Staff invitation", email: renderStaffInvitationEmail({ ...common, invitationLink: `${app}/join/team#sample-token`, expiresAt: "2027-01-28T17:00:00Z" }) },
    { key: "staff_sign_in", label: "Staff sign-in link", email: renderStaffSignInEmail({ ...common, verificationLink: `${app}/auth/confirm?token_hash=sample&type=email` }) },
    { key: "platform_invitation", label: "Platform DJ invitation (Flux)", email: renderPlatformInvitationEmail({ invitationLink: `${app}/join#sample-token`, expiresAt: "2027-02-04T17:00:00Z" }) },
    { key: "platform_sign_in", label: "Platform sign-in link (Flux)", email: renderPlatformSignInEmail({ verificationLink: `${app}/auth/confirm?token_hash=sample&type=invite` }) },
  ];
}

/** The index page: every email of a variant side by side, desktop and phone width. */
export function previewIndex(variant: PreviewVariant, logoDataUri: (dark: boolean) => string, email?: string): string {
  const v = PREVIEW_VARIANTS[variant];
  const emails = previewEmails(variant).filter((e) => !email || e.key === email);
  const nav = (Object.keys(PREVIEW_VARIANTS) as PreviewVariant[])
    .map((k) => `<a href="?variant=${k}" style="margin-right:12px;${k === variant ? "font-weight:700" : ""}">${escapeHtml(PREVIEW_VARIANTS[k].label)}</a>`)
    .join("");
  const frames = emails
    .map(({ label, email: rendered }) => {
      const html = rendered.html.replaceAll("cid:business-logo", logoDataUri(v.logo === "dark"));
      const doc = escapeHtml(html);
      return `<section style="margin:32px 0"><h2 style="font:600 16px system-ui">${escapeHtml(label)} <small style="font-weight:400;color:#71717a">· ${escapeHtml(rendered.subject)}</small></h2>
<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
<iframe title="${escapeHtml(label)} (desktop)" sandbox="" srcdoc="${doc}" style="width:640px;height:760px;border:1px solid #ddd;background:#fff"></iframe>
<iframe title="${escapeHtml(label)} (phone)" sandbox="" srcdoc="${doc}" style="width:360px;height:760px;border:1px solid #ddd;background:#fff"></iframe>
<pre style="width:360px;height:760px;overflow:auto;margin:0;padding:12px;border:1px solid #ddd;background:#fafafa;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(rendered.text)}</pre>
</div></section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Email previews</title></head><body style="margin:24px;font:14px system-ui;color:#18181b">
<h1 style="font-size:20px">Email previews <small style="font-weight:400;color:#71717a">(local only; sample data)</small></h1><nav>${nav}</nav>${frames}</body></html>`;
}
