import { describe, expect, it } from "vitest";
import { eventHubPath, hubNextStep, hubStatus, noPaymentDue, type HubFacts } from "@/lib/client-event";
import type { HomeEvent } from "@/lib/client-home";

const home: HomeEvent = {
  eventId: "e1", tenantSlug: "dj", tenantName: "DJ Co", title: "Gala", eventDate: "2027-06-12", timezone: "America/Toronto",
  venueName: null, lifecycle: "booked", contract: null, payments: null, plan: null,
};
const signedHome = { id: "c1", status: "signed" as const, signable: true, pdfReady: true, pdfPending: false };
const step = (over: Omit<Partial<HubFacts>, "home"> & { home?: Partial<HomeEvent> }) =>
  hubNextStep({ contract: null, plan: null, ...over, home: { ...home, ...over.home } });

describe("event hub: next step", () => {
  it("asks the signer to sign a sent contract, or to read one that can't be signed online", () => {
    expect(step({ home: { lifecycle: "awaiting_signature" }, contract: { id: "c1", status: "sent", totalCents: 100, signable: true } })).toEqual({
      title: "Review and sign your contract", text: expect.stringContaining("then sign online"), action: { label: "Review and sign", href: "/dj/contracts/c1" },
    });
    expect(step({ home: { lifecycle: "awaiting_signature" }, contract: { id: "c1", status: "sent", totalCents: 100, signable: false } }).action?.label).toBe("Read contract");
  });

  it("never calls a signed contract with its deposit outstanding a booking", () => {
    const s = step({
      home: { lifecycle: "awaiting_deposit", contract: signedHome, payments: { currency: "CAD", bookingStatus: "awaiting_deposit", depositOutstandingCents: 50000 } },
      contract: { id: "c1", status: "signed", totalCents: 200000, signable: true },
    });
    expect(s.title).toBe("Pay your deposit");
    expect(s.text).toContain("$500.00 deposit is still to pay");
    expect(s.text).toContain("Your booking is confirmed once they record it");
    expect(s.action).toEqual({ label: "See payment details", href: "#payments" });
    expect(hubStatus({ ...home, lifecycle: "awaiting_deposit", contract: signedHome }).label).toBe("Signed · awaiting deposit");
    // Someone at the event who isn't the signer: the step, without payment details.
    expect(step({ home: { lifecycle: "awaiting_deposit" } }).action).toBeNull();
  });

  it("booked: planning when it's open, a calm wait when it isn't ready, read-only when closed", () => {
    expect(step({ plan: { editing: "open", complete: false } }).action).toEqual({ label: "Continue planning", href: "/dj/planning/e1" });
    expect(step({ plan: { editing: "open", complete: true } }).action?.label).toBe("Review your plan");
    expect(step({ plan: null })).toEqual({ title: "Your DJ is getting planning ready", text: expect.stringContaining("DJ Co"), action: null });
    expect(step({ plan: { editing: "closed", complete: false } }).action).toEqual({ label: "View your plan", href: "/dj/planning/e1" });
  });

  it("an event booked elsewhere plans like a booked one, with nothing to sign or pay", () => {
    const s = step({ home: { lifecycle: "lead", bookingSource: "external" }, plan: { editing: "open", complete: false } });
    expect(s.action?.label).toBe("Continue planning");
    expect(JSON.stringify(s)).not.toMatch(/contract|deposit|pay/i);
  });

  it("earlier and later stages say who acts next, without links", () => {
    expect(step({ home: { lifecycle: "awaiting_signature" } }).title).toBe("Your contract is on its way");
    expect(step({ home: { lifecycle: "awaiting_signature" }, contract: { id: "c1", status: "signed", totalCents: 1, signable: true } }).title).toBe("Booking not confirmed yet");
    expect(step({ home: { lifecycle: "pending_approval" } }).action).toBeNull();
    expect(step({ home: { lifecycle: "cancelled" } }).title).toBe("This event was cancelled");
  });

  it("knows a legitimate $0 booking and builds the hub's address", () => {
    expect(noPaymentDue({ totalCents: 0 })).toBe(true);
    expect(noPaymentDue({ totalCents: 1 })).toBe(false);
    expect(noPaymentDue(null)).toBe(false);
    expect(eventHubPath("dj", "e1")).toBe("/dj/events/e1");
  });
});

describe("event hub: status", () => {
  it("uses the card's words, and a booking always reads as settled", () => {
    expect(hubStatus({ ...home, lifecycle: "lead", bookingSource: "external", plan: { editing: "open" } })).toEqual({ label: "Booked", tone: "done" });
    expect(hubStatus({ ...home, lifecycle: "awaiting_signature", contract: { ...signedHome, status: "sent" } }).tone).toBe("action");
  });
});
