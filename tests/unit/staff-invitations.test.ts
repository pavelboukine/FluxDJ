import { describe, expect, it } from "vitest";
import { retrySignInHref, safeNext } from "@/lib/auth/redirects";
import { describeDbError } from "@/lib/db-errors";
import { renderStaffInvitationEmail, renderStaffSignInEmail } from "@/lib/email/templates";
import { isActive, staffNavigation } from "@/lib/navigation";

const ID = "0b1e5a6c-1d2e-4f30-8a9b-0c1d2e3f4a5b";

describe("staff invitation sign-in destinations", () => {
  it("continue only to a staff invitation's acceptance page", () => {
    expect(safeNext(`/join/team/${ID}`)).toBe(`/join/team/${ID}`);
    expect(safeNext("/join/team")).toBe("/staff");
    expect(safeNext(`/join/team/${ID}/x`)).toBe("/staff");
    expect(safeNext(`//evil.example/join/team/${ID}`)).toBe("/staff");
  });
  it("retry from the DJ sign-in page", () => {
    expect(retrySignInHref(`/join/team/${ID}`)).toBe(`/login?role=dj&next=%2Fjoin%2Fteam%2F${ID}&error=link`);
  });
});

describe("staff invitation emails", () => {
  it("name the business, the access granted, the action and the expiry", () => {
    const email = renderStaffInvitationEmail({ tenantDisplayName: "DJ <Max>", invitationLink: "https://app.example/join/team#tok", expiresAt: "2026-10-20T15:00:00Z" });
    expect(email.subject).toBe("You've been invited to join DJ <Max> on Flux DJ");
    expect(email.text).toContain("DJ <Max> has invited you to join their team on Flux DJ.");
    expect(email.text).toContain("events, clients and planning tools");
    expect(email.text).toContain("This invitation expires on October 20, 2026.");
    expect(email.text).toContain("Accept invitation: https://app.example/join/team#tok");
    expect(email.html).toContain("DJ &lt;Max&gt;");
    expect(email.html).not.toContain("<Max>");
  });
  it("send the verification link for the business", () => {
    const email = renderStaffSignInEmail({ tenantDisplayName: "DJ Max", verificationLink: "https://app.example/auth/confirm?x=1" });
    expect(email.subject).toBe("Confirm your email to join DJ Max on Flux DJ");
    expect(email.text).toContain("Confirm and continue: https://app.example/auth/confirm?x=1");
  });
});

describe("team errors and navigation", () => {
  it("explain refusals in plain sentences", () => {
    expect(describeDbError({ code: "42501", message: "member_owner_protected: the business owner can't be removed" })).toBe("The business owner can't be removed.");
    expect(describeDbError({ code: "22023", message: "invitation_not_cancellable: this invitation was already accepted. Remove the staff member instead" }))
      .toBe("This invitation was already accepted. Remove the staff member instead.");
    expect(describeDbError({ code: "42501", message: "only the owner can manage the team" })).toBe("You don't have permission to do that.");
    expect(describeDbError({ code: "PT423", message: "workspace_suspended: this workspace is suspended" })).toBe("This workspace is unavailable right now, so nothing was saved.");
  });
  it("highlight Settings on the team page without a new menu item", () => {
    const items = staffNavigation("dj", { platformAdmin: false }).flatMap((g) => g.items);
    expect(items.some((i) => i.href.endsWith("/team"))).toBe(false);
    expect(isActive(items.find((i) => i.label === "Settings")!, "/staff/dj/team")).toBe(true);
  });
});
