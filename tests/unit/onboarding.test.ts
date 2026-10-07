import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/auth/redirects";
import { describeDbError } from "@/lib/db-errors";
import { slugFromName } from "@/lib/forms";

describe("DJ onboarding helpers", () => {
  it("suggests a web address from the business name", () => {
    expect(slugFromName("DJ Maxwell Événements")).toBe("dj-maxwell-evenements");
    expect(slugFromName("  --Sound & Light!! ")).toBe("sound-light");
    expect(slugFromName("x".repeat(47) + " y")).toBe("x".repeat(47));
    expect(slugFromName("!!!")).toBe("");
  });

  it("continues a confirmed sign-in only to the invitation and invitations screens, never elsewhere", () => {
    const id = "0b1e5a6c-1d2e-4f30-8a9b-0c1d2e3f4a5b";
    expect(safeNext(`/join/${id}`)).toBe(`/join/${id}`);
    expect(safeNext("/platform/invitations")).toBe("/platform/invitations");
    expect(safeNext("/join")).toBe("/staff");
    expect(safeNext(`/join/${id}/x`)).toBe("/staff");
    expect(safeNext(`//evil.example/join/${id}`)).toBe("/staff");
    expect(safeNext("/platform")).toBe("/staff");
  });

  it("turns invitation errors into plain sentences without internal codes", () => {
    expect(describeDbError({ code: "22023", message: "invitation_resend_too_soon: this invitation was sent very recently. Wait a few minutes before resending" }))
      .toBe("This invitation was sent very recently. Wait a few minutes before resending.");
    expect(describeDbError({ code: "22023", message: "invitation_not_revocable: this invitation was already accepted and its workspace created" }))
      .toBe("This invitation was already accepted and its workspace created.");
    expect(describeDbError({ code: "42501", message: "only platform administrators can manage DJ invitations" })).toBe("You don't have permission to do that.");
  });
});
