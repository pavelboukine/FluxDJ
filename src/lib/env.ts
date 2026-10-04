import { z } from "zod";

/**
 * Public environment variables. These are inlined into browser bundles by
 * Next.js, so they must never contain secrets.
 */
/** The role claim of a legacy JWT API key, or null for new-format keys. */
export function legacyKeyRole(key: string): string | null {
  const payload = key.split(".")[1];
  if (!payload || key.split(".").length !== 3) return null;
  try {
    const json = JSON.parse(typeof atob === "function" ? atob(payload.replace(/-/g, "+").replace(/_/g, "/")) : "");
    return typeof json.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  // Supabase publishable key ("sb_publishable_..."). The legacy anon JWT is
  // accepted for older local setups. A secret or service-role key here would
  // be shipped to every browser, so it is refused outright.
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .min(1, "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    .refine((key) => !key.startsWith("sb_secret_") && legacyKeyRole(key) !== "service_role", {
      message: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be the publishable (or anon) key, never the secret key",
    }),
  NEXT_PUBLIC_APP_URL: z.url(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

let cachedPublicEnv: PublicEnv | undefined;

export function publicEnv(): PublicEnv {
  // Each NEXT_PUBLIC_ variable is referenced explicitly so Next.js can inline it.
  // NEXT_PUBLIC_SUPABASE_ANON_KEY is the legacy name, kept as a fallback.
  cachedPublicEnv ??= publicEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
  return cachedPublicEnv;
}
