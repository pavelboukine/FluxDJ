import { describe, expect, it } from "vitest";
import { eventStatusLabel } from "@/lib/events/status";

describe("eventStatusLabel", () => {
  it("shows a signed contract with booking confirmation still pending", () => {
    expect(eventStatusLabel("awaiting_signature", true)).toBe("Contract signed · booking confirmation pending");
  });

  it("keeps the stored lifecycle otherwise, never claiming a booking or payment", () => {
    expect(eventStatusLabel("awaiting_signature", false)).toBe("awaiting signature");
    expect(eventStatusLabel("pending_approval", false)).toBe("pending approval");
    expect(eventStatusLabel("lead", true)).toBe("lead");
    expect(eventStatusLabel("booked", true)).toBe("booked");
    for (const status of ["lead", "pending_approval", "awaiting_signature", "cancelled", "completed"]) {
      expect(eventStatusLabel(status, true)).not.toMatch(/paid|deposit|booked/i);
    }
  });
});
