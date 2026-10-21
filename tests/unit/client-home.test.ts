import { describe, expect, it } from "vitest";
import { homeCard, splitByDate, type HomeEvent } from "@/lib/client-home";

const base: HomeEvent = {
  eventId: "e1", tenantSlug: "dj", tenantName: "DJ Co", title: "Wedding", eventDate: "2027-06-12", timezone: "America/Toronto",
  venueName: null, lifecycle: "lead", contract: null, payments: null, plan: null,
};
const sent = { id: "c1", status: "sent" as const, signable: true, pdfReady: false, pdfPending: false };
const signed = { id: "c1", status: "signed" as const, signable: true, pdfReady: true, pdfPending: false };
const card = (over: Partial<HomeEvent>) => homeCard({ ...base, ...over });

describe("client home status", () => {
  it("a contract waiting for its signer; for anyone else, the contract stage", () => {
    expect(card({ lifecycle: "awaiting_signature", contract: sent })).toEqual({ status: "Contract ready to sign", tone: "action" });
    expect(card({ lifecycle: "awaiting_signature", contract: { ...sent, signable: false } }).status).toBe("Contract ready to read");
    expect(card({ lifecycle: "awaiting_signature", contract: null }).status).toBe("Contract stage");
  });

  it("never calls a signed contract with its deposit outstanding a booking", () => {
    expect(card({ lifecycle: "awaiting_deposit", contract: signed }).status).toBe("Signed · awaiting deposit");
    expect(card({ lifecycle: "awaiting_deposit" }).status).toBe("Signed · awaiting deposit");
    expect(card({ lifecycle: "awaiting_signature", contract: signed }).status).toBe("Contract signed · booking not confirmed yet");
    expect(card({ lifecycle: "booked", contract: signed })).toEqual({ status: "Booked", tone: "done" });
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

describe("events booked elsewhere", () => {
  const external = (over: Partial<HomeEvent>) => card({ bookingSource: "external", lifecycle: "lead", ...over });

  it("read as booked, with no proposal, contract or payment wording", () => {
    expect(external({ plan: { editing: "open" } })).toEqual({ status: "Booked", tone: "done" });
    expect(external({ plan: null }).status).toBe("Booked");
  });

  it("a cancelled event reads as cancelled, never booked", () => {
    expect(external({ lifecycle: "cancelled", plan: { editing: "open" } })).toEqual({ status: "Cancelled", tone: "neutral" });
  });
});
