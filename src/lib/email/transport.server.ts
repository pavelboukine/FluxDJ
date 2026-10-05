import "server-only";
import { serverEnv } from "@/lib/env.server";

export type EmailAttachment = { filename: string; contentType: string; content: Buffer };

export type EmailMessage = {
  fromName: string;
  fromAddress: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
  /** Sent as real attachments by every transport (never stored in the outbox). */
  attachments?: EmailAttachment[];
  /**
   * Provider idempotency key (Resend keeps keys for 24 hours). Only for
   * emails whose content is identical on every retry; it must not be used
   * where a retry carries a fresh link.
   */
  idempotencyKey?: string;
};

export interface EmailTransport {
  readonly name: string;
  /** Returns the provider's message id. Throws on failure. */
  send(message: EmailMessage): Promise<{ id: string }>;
}

/** Local delivery to Mailpit's HTTP API. Nothing leaves the machine. */
export class MailpitTransport implements EmailTransport {
  readonly name = "mailpit";
  constructor(private readonly baseUrl: string) {}

  async send(message: EmailMessage) {
    const response = await fetch(`${this.baseUrl}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: { Email: message.fromAddress, Name: message.fromName },
        To: [{ Email: message.to }],
        ReplyTo: message.replyTo ? [{ Email: message.replyTo }] : [],
        Subject: message.subject,
        Text: message.text,
        HTML: message.html,
        Attachments: (message.attachments ?? []).map((a) => ({ Filename: a.filename, ContentType: a.contentType, Content: a.content.toString("base64") })),
      }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Mailpit responded ${response.status}`);
    const body = (await response.json()) as { ID?: string };
    return { id: body.ID ?? "mailpit" };
  }
}

/** Hosted delivery through Resend. Not used locally; requires RESEND_API_KEY. */
export class ResendTransport implements EmailTransport {
  readonly name = "resend";
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: `${message.fromName} <${message.fromAddress}>`,
        to: [message.to],
        reply_to: message.replyTo ?? undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments?.length
          ? message.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType }))
          : undefined,
      }),
      cache: "no-store",
    });
    // Never include the request body (links, attachments) in errors.
    if (!response.ok) throw new Error(`Resend responded ${response.status}`);
    const body = (await response.json()) as { id?: string };
    return { id: body.id ?? "resend" };
  }
}

/** Leaves emails queued (useful when no provider is configured). */
export class DisabledTransport implements EmailTransport {
  readonly name = "disabled";
  async send(): Promise<{ id: string }> {
    throw new Error("Email delivery is disabled (EMAIL_TRANSPORT=disabled)");
  }
}

export function configuredTransport(): EmailTransport {
  const env = serverEnv();
  if (env.EMAIL_TRANSPORT === "resend") return new ResendTransport(env.RESEND_API_KEY!);
  if (env.EMAIL_TRANSPORT === "disabled") return new DisabledTransport();
  return new MailpitTransport(env.MAILPIT_URL);
}
