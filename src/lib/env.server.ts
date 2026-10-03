import "server-only";
import { z } from "zod";

/**
 * Server-only configuration and secrets. Importing this module from a Client
 * Component fails the build because of the "server-only" import above.
 */
const serverEnvSchema = z
  .object({
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    // Derives proposal link tokens: token = HMAC-SHA256(secret, link id).
    // Rotating it breaks retries of not-yet-delivered proposal emails (they
    // fail visibly); links already delivered keep working.
    PROPOSAL_LINK_SECRET: z.string().min(32, "PROPOSAL_LINK_SECRET must be at least 32 characters"),
    // "mailpit" (local), "resend" (hosted), or "disabled" (queue only).
    EMAIL_TRANSPORT: z.enum(["mailpit", "resend", "disabled"]).default("mailpit"),
    EMAIL_FROM_ADDRESS: z.email().default("proposals@fluxdj.local"),
    MAILPIT_URL: z.url().default("http://127.0.0.1:54324"),
    RESEND_API_KEY: z.string().min(1).optional(),
    // Bearer secret for the outbox worker endpoint (pnpm outbox:work, cron).
    OUTBOX_WORKER_SECRET: z.string().min(32).optional(),
  })
  .refine((env) => env.EMAIL_TRANSPORT !== "resend" || env.RESEND_API_KEY, {
    message: "RESEND_API_KEY is required when EMAIL_TRANSPORT=resend",
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedServerEnv: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cachedServerEnv ??= serverEnvSchema.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    PROPOSAL_LINK_SECRET: process.env.PROPOSAL_LINK_SECRET,
    EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT || undefined,
    EMAIL_FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS || undefined,
    MAILPIT_URL: process.env.MAILPIT_URL || undefined,
    RESEND_API_KEY: process.env.RESEND_API_KEY || undefined,
    OUTBOX_WORKER_SECRET: process.env.OUTBOX_WORKER_SECRET || undefined,
  });
  return cachedServerEnv;
}
