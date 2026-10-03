import "server-only";
import { serverEnv } from "@/lib/env.server";

export type EmailMessage = {
  fromName: string;
  fromAddress: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
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
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${message.fromName} <${message.fromAddress}>`,
        to: [message.to],
        reply_to: message.replyTo ?? undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      cache: "no-store",
    });
    // Never include the request body (it contains the link) in errors.
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
