import { createHmac } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fitLogo } from "@/lib/email/branding.server";
import { deliveryState, emailPurpose, errorSummary, type OutboxRow } from "@/lib/email/history";
import { businessBrand, FLUX_BRAND, logoDisplaySize, logoPlateSize } from "@/lib/email/layout";
import { parseProviderEvent, verifyWebhookSignature } from "@/lib/email/provider-events";
import { previewEmails } from "@/lib/email/previews";
import { firstName, renderBookingConfirmedEmail, renderContractEmail, renderEmail, renderPlanningInvitationEmail, renderPlatformInvitationEmail, renderStaffInvitationEmail } from "@/lib/email/templates";

const base = { tenantSlug: "dj", proposalId: "p1", appUrl: "https://app.example" };
const proposal = (brand = businessBrand("BOUPROD", "#e11d48")) =>
  renderEmail({ ...base, brand, canReply: true, tenantDisplayName: "BOUPROD", eventType: "proposal_sent", proposalLink: "https://app.example/dj/p#TOKEN", payload: { event_title: "Gala", event_date: "2027-06-12", client_name: "Robin", expires_at: "2027-01-15T12:00:00Z" } });

describe("branded layout", () => {
  it("leads with the business: its logo by content id, its name as alt text and in the plain text", () => {
    const email = proposal(businessBrand("BOUPROD", "#e11d48", { cid: "business-logo", width: 248, height: 76 }));
    expect(email.html).toContain('src="cid:business-logo"');
    expect(email.html).toContain('alt="BOUPROD"');
    expect(email.html).toContain('width="248" height="76"');
    // The plate is in the image, so no background a client could recolour sits behind it.
    expect(email.html).not.toContain("background:#18181b");
    expect(email.text.split("\n")[0]).toBe("BOUPROD");
    expect(email.html).not.toMatch(/https?:\/\/[^"]*\.(png|jpe?g|gif)/); // no remote images, no tracking pixel
  });
  it("falls back to the business name in text when there is no logo", () => {
    const email = proposal();
    expect(email.html).not.toContain("cid:");
    expect(email.html).toContain(">BOUPROD</td>");
  });
  it("uses the brand colour with readable button text, and the default without one", () => {
    expect(proposal(businessBrand("Pale", "#fde68a")).html).toMatch(/background:#fde68a;"><a [^>]*color:#000000/i);
    expect(proposal(businessBrand("Dark", "#1e3a8a")).html).toMatch(/background:#1e3a8a;"><a [^>]*color:#ffffff/i);
    expect(proposal(businessBrand("Default", null)).html).toContain("background:#111827");
  });
  it("keeps logos in proportion within 220 x 56 and never enlarges them", () => {
    expect(logoDisplaySize(1000, 1000)).toEqual({ width: 56, height: 56 });
    expect(logoDisplaySize(880, 112)).toEqual({ width: 220, height: 28 });
    expect(logoDisplaySize(100, 40)).toEqual({ width: 100, height: 40 });
    // On its plate: 14 x 10 CSS pixels of padding around the artwork.
    expect(logoPlateSize(880, 112)).toEqual({ width: 248, height: 48 });
    expect(logoPlateSize(100, 40)).toEqual({ width: 128, height: 60 });
  });
  it("escapes business, event and client text everywhere", () => {
    const email = renderEmail({ ...base, brand: businessBrand("<b>DJ</b>", "#ff0000"), tenantDisplayName: "<b>DJ</b>", eventType: "proposal_approved", payload: { event_title: "<script>x</script>", client_name: '"Robin"' } });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>DJ</b>");
    expect(email.html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
  it("has the same information in HTML and plain text: event, date, action link", () => {
    const email = proposal();
    for (const part of ["Gala", "Saturday, June 12, 2027", "January 15, 2027", "https://app.example/dj/p#TOKEN", "Reply to this email to reach BOUPROD."]) {
      expect(email.text).toContain(part);
      expect(email.html).toContain(part.replace(/'/g, "&#39;"));
    }
  });
  it("platform emails are Flux's own; staff invitations show the inviting business", () => {
    const platform = renderPlatformInvitationEmail({ invitationLink: "https://app.example/join#t", expiresAt: null });
    expect(platform.text.split("\n")[0]).toBe("Flux DJ");
    const staff = renderStaffInvitationEmail({ brand: businessBrand("Northside"), tenantDisplayName: "Northside", invitationLink: "https://app.example/join/team#t", expiresAt: "2027-01-08T12:00:00Z" });
    expect(staff.text.split("\n")[0]).toBe("Northside");
    expect(staff.text).toContain("This invitation expires on January 8, 2027.");
    expect(FLUX_BRAND.kind).toBe("platform");
  });
  it("contract email states the deposit and offers replies only when the business set a reply-to", () => {
    const input = { tenantDisplayName: "BOUPROD", legalName: "BOUPROD Inc.", contactEmail: null, clientName: "Robin", eventTitle: "Gala", depositCents: 12_345, depositPercent: 30, currency: "CAD", invitationLink: "https://app.example/dj/invite#T" };
    expect(renderContractEmail({ ...input, canReply: false }).text).not.toContain("Reply to this email");
    expect(renderContractEmail({ ...input, canReply: true }).text).toContain("Questions? Reply to this email.");
    expect(renderContractEmail(input).text).toContain("Deposit due on signing: $123.45 (30% of the total)");
  });
  it("every preview renders at a modest size, with long names included", () => {
    for (const variant of ["logo", "dark", "none", "long"] as const) {
      for (const { email } of previewEmails(variant)) {
        expect(email.html.length).toBeLessThan(12_000);
        expect(email.text.length).toBeGreaterThan(100);
      }
    }
  });
});

/** RGBA of one pixel of a PNG. */
async function pixel(png: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [...data.subarray(i, i + 4)];
}

describe("logo for email", () => {
  it("is fitted into 440 x 112 pixels without stretching, on a plate at the same density, as PNG", async () => {
    const wide = await sharp({ create: { width: 2000, height: 400, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const fitted = await fitLogo(wide);
    expect(fitted).not.toBeNull();
    expect(fitted!.png.subarray(1, 4).toString()).toBe("PNG");
    // Artwork 440 x 88 pixels = 220 x 44 CSS pixels at 2x; plus the plate: 248 x 64 CSS, 496 x 128 pixels.
    expect([fitted!.width, fitted!.height]).toEqual([248, 64]);
    const meta = await sharp(fitted!.png).metadata();
    expect([meta.width, meta.height]).toEqual([496, 128]);
    expect(await pixel(fitted!.png, 248, 64)).toEqual([200, 0, 0, 255]); // the artwork, centred
  });
  it("keeps a dark logo on an opaque white plate and a light one on an opaque dark plate", async () => {
    // A transparent logo with dark ink, like most uploads: invisible on a darkened email without a plate.
    const ink = (colour: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect x="100" y="20" width="100" height="40" fill="${colour}"/></svg>`)).png().toBuffer();
    const light = (await fitLogo(await ink("#111111")))!;
    const dark = (await fitLogo(await ink("#ffffff"), true))!;
    for (const [logo, fill] of [[light, [255, 255, 255, 255]], [dark, [24, 24, 27, 255]]] as const) {
      expect(await pixel(logo.png, 20, logo.height)).toEqual(fill); // inside the plate, beside the artwork: opaque
      expect((await pixel(logo.png, 0, 0))[3]).toBeLessThan(255); // rounded corner
    }
  });
  it("leaves small logos at their size and refuses unreadable input", async () => {
    const small = await sharp({ create: { width: 120, height: 40, channels: 3, background: "#000" } }).png().toBuffer();
    const fitted = (await fitLogo(small))!;
    expect([fitted.width, fitted.height]).toEqual([148, 60]);
    const meta = await sharp(fitted.png).metadata();
    expect([meta.width, meta.height]).toEqual([148, 60]); // 1x: never enlarged
    expect(await fitLogo(Buffer.from("not an image"))).toBeNull();
  });
});

const row = (over: Partial<OutboxRow>): OutboxRow => ({
  id: "e1", event_type: "proposal_sent", recipient_email: "c@example.test", status: "sent", attempts: 1, max_attempts: 5,
  last_error: null, next_attempt_at: "2027-01-01T00:00:00Z", sent_at: "2027-01-01T10:00:00Z", created_at: "2027-01-01T09:59:00Z", ...over,
});

describe("delivery status shown to staff", () => {
  it("never calls an accepted email delivered without the provider's delivery event", () => {
    expect(deliveryState(row({})).label).toBe("Accepted by email provider");
    expect(deliveryState(row({})).explanation).toContain("no confirmation that it reached the inbox");
    expect(deliveryState(row({ provider_status: "delivered", provider_status_at: "2027-01-01T10:01:00Z" })).label).toBe("Delivered");
  });
  it("flags failures, bounces and complaints; only failed submissions can be retried", () => {
    const failed = deliveryState(row({ status: "failed", last_error: "Resend responded 422" }));
    expect(failed).toMatchObject({ label: "Couldn't be sent", attention: true, retryable: true });
    expect(failed.explanation).toContain("HTTP 422");
    for (const status of ["bounced", "complained", "suppressed", "failed"]) {
      expect(deliveryState(row({ provider_status: status, provider_status_at: "2027-01-02T00:00:00Z" }))).toMatchObject({ attention: true, retryable: false });
    }
    expect(deliveryState(row({ provider_status: "bounced", provider_status_at: "x", provider_detail: "Permanent · General" })).explanation).toContain("(Permanent · General)");
  });
  it("a soft (transient) bounce is shown honestly but isn't an attention item, as on the dashboard", () => {
    const soft = deliveryState(row({ provider_status: "bounced", provider_status_at: "x", provider_detail: "Transient · MailboxFull" }));
    expect(soft).toMatchObject({ label: "Temporarily refused", tone: "pending", attention: false, retryable: false });
    expect(soft.explanation).toContain("(Transient · MailboxFull)");
    expect(deliveryState(row({ provider_status: "bounced", provider_status_at: "x", provider_detail: null }))).toMatchObject({ label: "Bounced", attention: true });
  });
  it("tells queued, retrying and cancelled emails apart", () => {
    expect(deliveryState(row({ status: "pending", attempts: 0, sent_at: null })).label).toBe("Waiting to send");
    expect(deliveryState(row({ status: "pending", attempts: 2, sent_at: null, last_error: "Resend responded 503" })).label).toBe("Retrying");
    expect(deliveryState(row({ status: "cancelled", last_error: "Cancelled: the workspace was suspended before delivery." })).explanation).toBe("The workspace was suspended before delivery.");
  });
  it("never shows raw provider or unexpected error text", () => {
    expect(errorSummary("Unexpected token at https://internal/secret?key=abc")).toBe("The last attempt failed.");
    expect(errorSummary("Could not create a verification link (500)")).toBe("Could not create a verification link.");
  });
  it("names each email's purpose, marking the team's own copies", () => {
    expect(emailPurpose({ event_type: "proposal_sent", payload: { revision: 2 } })).toEqual({ label: "Revised proposal (revision 2)", toTeam: false });
    expect(emailPurpose({ event_type: "proposal_submitted", payload: {} }).toTeam).toBe(true);
    expect(emailPurpose({ event_type: "contract_signed_copy", payload: { recipient_role: "business" } })).toEqual({ label: "Signed contract copy (your copy)", toTeam: true });
  });
});

describe("Resend webhooks", () => {
  const secret = `whsec_${Buffer.from("test-signing-key-0123456789").toString("base64")}`;
  const sign = (id: string, ts: string, body: string) =>
    `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const now = 1_800_000_000;
  const body = JSON.stringify({ type: "email.delivered", created_at: "2027-01-01T10:00:00.000Z", data: { email_id: "re_123", to: ["c@example.test"] } });

  it("accepts a genuine signature and refuses forged, altered or stale ones", () => {
    const ts = String(now);
    expect(verifyWebhookSignature(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, body, now)).toBe(true);
    expect(verifyWebhookSignature(secret, { id: "msg_1", timestamp: ts, signature: `v1,bogus ${sign("msg_1", ts, body)}` }, body, now)).toBe(true); // one of several
    expect(verifyWebhookSignature(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, body.replace("re_123", "re_999"), now)).toBe(false);
    expect(verifyWebhookSignature(secret, { id: "msg_2", timestamp: ts, signature: sign("msg_1", ts, body) }, body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, { id: "msg_1", timestamp: String(now - 600), signature: sign("msg_1", String(now - 600), body) }, body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, { id: null, timestamp: ts, signature: null }, body, now)).toBe(false);
  });
  it("keeps delivery outcomes only, with a short category and no addresses", () => {
    expect(parseProviderEvent(JSON.parse(body))).toEqual({ messageId: "re_123", status: "delivered", occurredAt: "2027-01-01T10:00:00.000Z", detail: null });
    expect(parseProviderEvent({ type: "email.bounced", created_at: "2027-01-01T10:00:00Z", data: { email_id: "re_1", bounce: { type: "Permanent", subType: "General", message: "550 user@example.test unknown" } } }))
      .toMatchObject({ status: "bounced", detail: "Permanent · General" });
    for (const type of ["email.sent", "email.opened", "email.clicked", "email.received"]) {
      expect(parseProviderEvent({ type, created_at: "2027-01-01T10:00:00Z", data: { email_id: "re_1" } })).toBeNull();
    }
    expect(parseProviderEvent({ type: "email.delivered", data: {} })).toBeNull();
  });
});

describe("dashboard delivery problems", () => {
  it("counts provider-confirmed problems once per email, never acceptance or soft bounces", async () => {
    const { deliveryProblems } = await import("@/lib/dashboard");
    const p = (id: string, provider_status: string | null, provider_detail: string | null = null) => ({ id, provider_status, provider_detail });
    expect(deliveryProblems([])).toEqual({ undelivered: 0, complaints: 0 });
    expect(
      deliveryProblems([
        p("a", "bounced", "Permanent · General"),
        p("b", "bounced", "Transient · MailboxFull"),
        p("c", "failed", "invalid recipient"),
        p("d", "suppressed"),
        p("e", "complained"),
        p("f", "delivered"),
        p("g", "delayed"),
        p("h", null),
        p("a", "bounced", "Permanent · General"), // the same email twice
      ]),
    ).toEqual({ undelivered: 3, complaints: 1 });
  });
});

describe("planning invitation email", () => {
  const email = renderPlanningInvitationEmail({
    brand: businessBrand("Northside Sound"),
    canReply: true,
    tenantDisplayName: "Northside Sound",
    clientName: "Riya Patel",
    eventTitle: "Riya & Sam's wedding",
    eventDate: "2027-06-12",
    invitationLink: "https://app.example/northside/planning-invite#token",
    expiresAt: "2027-01-08T12:00:00Z",
  });

  it("is the same staff-sent email for every booking source, with the business's name and no booking claims", () => {
    expect(email.subject).toBe("It's time to plan your event!");
    expect(email.text).toContain("Hi Riya,");
    expect(email.text).toContain("We're ready to start planning your event!");
    expect(email.text).toContain("share your music preferences, important event details, timeline information");
    expect(email.text).toContain("Open your planning portal");
    expect(email.text).toContain("https://app.example/northside/planning-invite#token");
    expect(email.text).toContain("For security, you may be asked to verify your email address before accessing your event.");
    expect(email.text).toContain("We're looking forward to getting everything ready!");
    expect(email.text).toContain("Northside Sound");
    expect(email.text).not.toMatch(/proposal|contract|deposit|payment|registered|your account/i);
    expect(email.text).not.toMatch(/BOUPROD/);
    expect(email.html).toContain("Open your planning portal");
  });

  it("greets by first name, keeping titles and initials whole", () => {
    expect(firstName("Riya Patel")).toBe("Riya");
    expect(firstName("Dr. Smith")).toBe("Dr. Smith");
    expect(firstName("J. Doe")).toBe("J. Doe");
    expect(firstName("  Noam  ")).toBe("Noam");
  });

  it("stays separate from the booking confirmation, which never offers planning", () => {
    const booking = renderBookingConfirmedEmail({
      tenantDisplayName: "Northside Sound", legalName: "Northside Sound Inc.", contactEmail: null, clientName: "Riya Patel", eventTitle: "Wedding",
      eventDate: "2027-06-12", currency: "CAD", totalCents: 100_000, depositCents: 30_000, receivedCents: 30_000, remainingCents: 70_000, creditCents: 0,
      balanceDueDate: null, bookedOn: "2027-01-02",
    });
    expect(booking.subject).not.toBe(email.subject);
    expect(booking.text).not.toMatch(/planning-invite|planning portal/i);
  });
});
