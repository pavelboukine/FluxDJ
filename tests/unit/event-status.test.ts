import { describe, expect, it } from "vitest";
import { eventStatusLabel } from "@/lib/events/status";

describe("eventStatusLabel", () => {
  it("shows the three booking states", () => {
    expect(eventStatusLabel("awaiting_signature", false)).toBe("awaiting signature");
    expect(eventStatusLabel("awaiting_deposit", true)).toBe("Signed · awaiting deposit");
    expect(eventStatusLabel("booked", true)).toBe("Booked");
  });

  it("asks staff to check a contract signed before booking policies existed", () => {
    expect(eventStatusLabel("awaiting_signature", true)).toBe("Contract signed · booking not checked yet");
  });

  it("keeps the stored lifecycle otherwise, never claiming a booking or payment", () => {
    expect(eventStatusLabel("pending_approval", false)).toBe("pending approval");
    expect(eventStatusLabel("lead", true)).toBe("lead");
    for (const status of ["lead", "pending_approval", "awaiting_signature", "cancelled", "completed"]) {
      expect(eventStatusLabel(status, true)).not.toMatch(/paid|deposit|booked/i);
    }
  });
});
