import { describe, expect, it } from "vitest";
import { eventDisplayStatus, eventStatusLabel, type EventRecords } from "@/lib/events/status";

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

describe("eventDisplayStatus", () => {
  const r = (over: Partial<EventRecords>): EventRecords => ({ lifecycle: "lead", proposalStatus: null, proposalDraft: false, contractStatus: null, ...over });

  it("describes the proposal stage from the proposal records", () => {
    expect(eventDisplayStatus(r({}))).toBe("New inquiry");
    expect(eventDisplayStatus(r({ proposalDraft: true }))).toBe("Proposal draft");
    expect(eventDisplayStatus(r({ proposalStatus: "sent" }))).toBe("Proposal sent");
    expect(eventDisplayStatus(r({ proposalStatus: "expired" }))).toBe("Proposal expired");
    expect(eventDisplayStatus(r({ proposalStatus: "declined" }))).toBe("Proposal declined");
    expect(eventDisplayStatus(r({ proposalStatus: "expired", proposalDraft: true }))).toBe("Revised proposal in progress");
    expect(eventDisplayStatus(r({ lifecycle: "pending_approval", proposalStatus: "submitted" }))).toBe("Choices submitted · review");
  });

  it("describes the contract stage from the contract records", () => {
    const approved = { lifecycle: "awaiting_signature", proposalStatus: "approved" };
    expect(eventDisplayStatus(r(approved))).toBe("Approved · contract to prepare");
    expect(eventDisplayStatus(r({ ...approved, contractStatus: "draft" }))).toBe("Contract draft");
    expect(eventDisplayStatus(r({ ...approved, contractStatus: "sent" }))).toBe("Contract sent");
    expect(eventDisplayStatus(r({ ...approved, contractStatus: "signed" }))).toBe("Contract signed · booking not checked yet");
  });

  it("never calls a signed event booked while the deposit policy still waits for the deposit", () => {
    expect(eventDisplayStatus(r({ lifecycle: "awaiting_deposit", proposalStatus: "approved", contractStatus: "signed" }))).toBe("Signed · awaiting deposit");
    expect(eventDisplayStatus(r({ lifecycle: "booked", proposalStatus: "approved", contractStatus: "signed" }))).toBe("Booked");
    expect(eventDisplayStatus(r({ lifecycle: "completed", contractStatus: "signed" }))).toBe("Completed");
    expect(eventDisplayStatus(r({ lifecycle: "cancelled" }))).toBe("Cancelled");
  });

  it("the stored stage wins: proposal or contract records never move an event forward", () => {
    expect(eventDisplayStatus(r({ lifecycle: "lead", contractStatus: "signed" }))).not.toMatch(/signed|booked/i);
    expect(eventDisplayStatus(r({ lifecycle: "pending_approval", contractStatus: "sent" }))).toBe("Choices submitted · review");
  });
});
