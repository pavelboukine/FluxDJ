import { describe, expect, it } from "vitest";
import { homeCard, splitByDate, type HomeEvent } from "@/lib/client-home";

const base: HomeEvent = {
  eventId: "e1", tenantSlug: "dj", tenantName: "DJ Co", title: "Wedding", eventDate: "2027-06-12", timezone: "America/Toronto",
  venueName: null, lifecycle: "lead", contract: null, payments: null, plan: null,
};
const sent = { id: "c1", status: "sent" as const, signable: true, pdfReady: false, pdfPending: false };
const signed = { id: "c1", status: "signed" as const, signable: true, pdfReady: true, pdfPending: false };
const card = (over: Partial<HomeEvent>) => homeCard({ ...base, ...over });

describe("client home actions", () => {
  it("asks only the signer to sign", () => {
    expect(card({ lifecycle: "awaiting_signature", contract: sent }).primary).toEqual({ label: "Review and sign contract", href: "/dj/contracts/c1", kind: "link" });
    const other = card({ lifecycle: "awaiting_signature", contract: null });
    expect(other.primary).toBeNull();
    expect(JSON.stringify(other)).not.toMatch(/sign it|Review and sign/i);
  });

  it("offers reading, not signing, when online signing isn't available", () => {
    const c = card({ lifecycle: "awaiting_signature", contract: { ...sent, signable: false } });
    expect(c.primary?.label).toBe("Read contract");
    expect(c.note).toMatch(/can't be signed online/);
  });

  it("never offers payment; awaiting deposit points to the details and says who records it", () => {
    const c = card({ lifecycle: "awaiting_deposit", contract: signed, payments: { currency: "CAD", bookingStatus: "awaiting_deposit", depositOutstandingCents: 123456 } });
    expect(c.status).toBe("Signed · awaiting deposit");
    expect(c.primary).toEqual({ label: "View deposit details", href: "/dj/contracts/c1#payments", kind: "link" });
    expect(c.note).toContain("$1,234.56 deposit still to pay");
    expect(c.secondary.map((a) => a.label)).toEqual(["View signed contract", "Download signed PDF"]);
    expect(JSON.stringify(c)).not.toMatch(/pay now|booked\b/i);
    // A non-signer at the same event: status only, no contract or payment links.
    const viewer = card({ lifecycle: "awaiting_deposit" });
    expect(viewer.primary).toBeNull();
    expect(viewer.secondary).toEqual([]);
  });

  it("plans when the database allows it; read-only once editing closes", () => {
    expect(card({ lifecycle: "booked", contract: signed, plan: { editing: "open" } }).primary?.label).toBe("Plan your event");
    expect(card({ lifecycle: "booked", contract: signed, plan: { editing: "reopened" } }).primary?.label).toBe("Plan your event");
    const closed = card({ lifecycle: "booked", contract: signed, plan: { editing: "closed" } });
    expect(closed.primary?.label).toBe("View planning");
    expect(closed.secondary.map((a) => a.kind)).toEqual(["link", "pdf"]);
    // Booked without planning access (not offered before the rules allow it).
    expect(card({ lifecycle: "booked", contract: signed, plan: null }).primary?.label).toBe("View signed contract");
    // A signed contract alone never opens planning.
    expect(card({ lifecycle: "awaiting_deposit", contract: signed }).primary?.label).not.toMatch(/plan/i);
  });

  it("keeps legacy signed contracts honest: booking not confirmed yet", () => {
    const c = card({ lifecycle: "awaiting_signature", contract: { ...signed, pdfReady: false } });
    expect(c.status).toBe("Contract signed · booking not confirmed yet");
    expect(c.primary?.label).toBe("View signed contract");
    expect(c.secondary).toEqual([]);
  });

  it("shows the PDF only once it exists", () => {
    expect(card({ lifecycle: "booked", contract: { ...signed, pdfReady: false, pdfPending: true } }).secondary).toEqual([]);
  });
});

describe("upcoming and past", () => {
  it("uses each event's own time zone for 'today' without shifting date-only values", () => {
    // 03:30 UTC on June 12 is still June 11 in Toronto.
    const now = new Date("2027-06-12T03:30:00Z");
    const events = [
      { id: "a", eventDate: "2027-06-11", timezone: "America/Toronto" },
      { id: "b", eventDate: "2027-06-11", timezone: "Europe/Paris" },
      { id: "c", eventDate: "2027-07-01", timezone: "America/Toronto" },
      { id: "d", eventDate: "2026-01-01", timezone: "America/Toronto" },
    ];
    const { upcoming, past } = splitByDate(events, now);
    expect(upcoming.map((e) => e.id)).toEqual(["a", "c"]);
    expect(past.map((e) => e.id)).toEqual(["b", "d"]);
  });
});
