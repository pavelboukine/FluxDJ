import { describe, expect, it } from "vitest";
import { legacyKeyRole, publicEnvSchema } from "@/lib/env";
import { serverEnvSchema } from "@/lib/env.server";

// Shape-only fixtures (not real keys): header.payload.signature with a role claim.
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;
const base = { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_APP_URL: "https://app.example.com" };
const server = { PROPOSAL_LINK_SECRET: "x".repeat(32) };

describe("Supabase key configuration", () => {
  it("accepts publishable and legacy anon keys for the browser", () => {
    expect(publicEnvSchema.safeParse({ ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc" }).success).toBe(true);
    expect(publicEnvSchema.safeParse({ ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt("anon") }).success).toBe(true);
  });

  it("refuses to ship a secret or service-role key to the browser", () => {
    for (const key of ["sb_secret_abc", jwt("service_role")]) {
      const result = publicEnvSchema.safeParse({ ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("never the secret key");
    }
  });

  it("accepts secret and legacy service-role keys on the server, and rejects the publishable key there", () => {
    expect(serverEnvSchema.safeParse({ ...server, SUPABASE_SECRET_KEY: "sb_secret_abc" }).success).toBe(true);
    expect(serverEnvSchema.safeParse({ ...server, SUPABASE_SECRET_KEY: jwt("service_role") }).success).toBe(true);
    expect(serverEnvSchema.safeParse({ ...server, SUPABASE_SECRET_KEY: "sb_publishable_abc" }).success).toBe(false);
    expect(serverEnvSchema.safeParse({ ...server, SUPABASE_SECRET_KEY: jwt("anon") }).success).toBe(false);
  });

  it("reads only the role of legacy JWT keys", () => {
    expect(legacyKeyRole(jwt("anon"))).toBe("anon");
    expect(legacyKeyRole("sb_publishable_abc")).toBeNull();
    expect(legacyKeyRole("not.a-valid.jwt")).toBeNull();
  });
});
