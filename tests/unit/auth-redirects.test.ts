import { describe, expect, it } from "vitest";
import { allowedNext, loginHref, nextFromRedirectTo, retrySignInHref, safeNext, signInDestination, signInRole } from "@/lib/auth/redirects";

const UUID = "0b9c7f3e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

describe("sign-in destinations", () => {
  it("allows only same-site app pages, including a client's contract and planning pages", () => {
    for (const ok of ["/staff", "/staff/bouprod", "/staff/bouprod/events/new", "/my", `/bouprod/contracts/${UUID}`, `/bouprod/planning/${UUID}`, `/bouprod/planning-invitations/${UUID}`, `/join/${UUID}`]) {
      expect(allowedNext(ok)).toBe(ok);
    }
    for (const bad of [
      "https://evil.example/staff",
      "//evil.example/staff",
      "/\\evil.example",
      "/my?x=1",
      `/bouprod/planning/${UUID}/../../staff`,
      `/bouprod/planning/not-a-uuid`,
      `/bouprod/planning-invitations/not-a-uuid`,
      `/bouprod/planning-invite`,
      "/%2F%2Fevil.example",
      "javascript:alert(1)",
      "",
      undefined,
      ["/my"],
    ]) {
      expect(allowedNext(bad)).toBeNull();
      expect(safeNext(bad)).toBe("/staff");
    }
  });

  it("words the page by role but never trusts anything else", () => {
    expect(signInRole("dj")).toBe("dj");
    expect(signInRole("client")).toBe("client");
    expect(signInRole("admin")).toBeNull();
    expect(signInRole(undefined)).toBeNull();
  });

  it("continues to the requested page, else the role's home", () => {
    expect(signInDestination("client", `/bouprod/contracts/${UUID}`)).toBe(`/bouprod/contracts/${UUID}`);
    expect(signInDestination("client", null)).toBe("/my");
    expect(signInDestination("client", "https://evil.example")).toBe("/my");
    expect(signInDestination("dj", "/staff/bouprod/gear")).toBe("/staff/bouprod/gear");
    expect(signInDestination("dj", null)).toBe("/staff");
    expect(signInDestination(null, null)).toBe("/staff");
  });

  it("builds sign-in links that carry only an allowed destination", () => {
    expect(loginHref("dj")).toBe("/login?role=dj");
    expect(loginHref("client", `/bouprod/planning/${UUID}`)).toBe(`/login?role=client&next=%2Fbouprod%2Fplanning%2F${UUID}`);
    expect(loginHref("client", "https://evil.example")).toBe("/login?role=client");
  });
});

describe("destinations carried by the sign-in email", () => {
  const app = "https://fluxdj.com";
  const planning = `/bouprod/planning/${UUID}`;

  it("reads an allow-listed next from this app's own confirm address", () => {
    expect(nextFromRedirectTo(`https://fluxdj.com/auth/confirm?next=${encodeURIComponent(planning)}`, app)).toBe(planning);
    // As the email template writes it (already decoded once by the query string).
    expect(nextFromRedirectTo(`https://fluxdj.com/auth/confirm?next=%2Fmy`, app)).toBe("/my");
  });

  it("ignores other sites, the bare site address Supabase falls back to, and unsafe destinations", () => {
    expect(nextFromRedirectTo(`https://evil.example/auth/confirm?next=%2Fmy`, app)).toBeNull();
    expect(nextFromRedirectTo(`https://fluxdj.com.evil.example/auth/confirm?next=%2Fmy`, app)).toBeNull();
    expect(nextFromRedirectTo("https://fluxdj.com", app)).toBeNull();
    expect(nextFromRedirectTo(`https://fluxdj.com/auth/confirm?next=${encodeURIComponent("//evil.example")}`, app)).toBeNull();
    expect(nextFromRedirectTo("not a url", app)).toBeNull();
    expect(nextFromRedirectTo(undefined, app)).toBeNull();
  });

  it("sends a failed link back to sign-in, keeping where it was going", () => {
    expect(retrySignInHref("/staff")).toBe("/login?error=link");
    expect(retrySignInHref(planning)).toBe(`/login?role=client&next=${encodeURIComponent(planning)}&error=link`);
    expect(retrySignInHref("/staff/bouprod/gear")).toBe(`/login?role=dj&next=${encodeURIComponent("/staff/bouprod/gear")}&error=link`);
  });
});
