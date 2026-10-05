import { z } from "zod";

/**
 * Everything a signed-contract PDF shows, built ONLY from the frozen contract
 * row (rendered content, party and commercial snapshots, content hash) and
 * the immutable signing evidence. Never from live templates, catalog,
 * clients, events or business settings.
 */
export type SignedContractPdfData = {
  contract: { id: string; contentSha256: string; title: string; sections: { heading: string; body: string }[]; currency: string; isDemo: boolean };
  business: { legalName: string; displayName: string | null; address: string | null; contactEmail: string | null };
  client: { name: string; email: string; phone: string | null };
  event: { title: string; date: string; timezone: string; venueName: string | null; venueAddress: string | null };
  commercial: {
    lines: { name: string; description: string | null; source: string; quantity: number; unitPriceCents: number; lineTotalCents: number }[];
    subtotalCents: number;
    taxes: { label: string; ratePpm: number; amountCents: number }[];
    taxCents: number;
    totalCents: number;
    depositPercent: number;
    depositCents: number;
    balanceCents: number;
    balanceDueDate: string | null;
  };
  signature: {
    typedName: string;
    signerEmail: string;
    signedAt: string;
    signatureSha256: string;
    consentVersion: string;
    consentText: string;
    userAgent: string | null;
    clientIp: string | null;
    clientIpSource: string;
  };
};

const text = z.string();
const nullableText = z.string().nullish().transform((v) => (v && v.trim() ? v : null));
const cents = z.number().int().nonnegative();

const contractRow = z.object({
  id: z.uuid(),
  status: z.literal("signed"),
  // Frozen at generation. Only DEMO and client-use contracts can be signed.
  signing_mode: z.enum(["demo", "client_use"]),
  consent_version: text,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  total_cents: cents,
  deposit_percent: z.number().int().min(0).max(100),
  deposit_cents: cents,
  balance_cents: cents,
  balance_due_date: z.string().nullable(),
  rendered_content: z.object({ title: text, sections: z.array(z.object({ heading: text, body: text })) }),
  commercial_snapshot: z.object({
    lines: z
      .array(
        z.object({
          name: text,
          description: z.string().nullable().optional(),
          source: text,
          quantity: z.number().int(),
          unit_price_cents: cents,
          line_total_cents: cents,
        }),
      )
      .nullable(),
    subtotal_cents: cents,
    tax_breakdown: z.array(z.object({ label: text, rate_ppm: z.number().int(), amount_cents: cents })),
    tax_cents: cents,
    total_cents: cents,
  }),
  party_snapshot: z.object({
    business: z.object({
      name: text,
      legal_name: z.string().nullish(),
      display_name: z.string().nullish(),
      address: z.string().nullish(),
      contact_email: z.string().nullish(),
    }),
    client: z.object({ name: text, email: text, phone: z.string().nullish() }),
    event: z.object({
      title: text,
      date: text,
      timezone: z.string().nullish(),
      venue_name: z.string().nullish(),
      venue_address: z.string().nullish(),
    }),
  }),
});

const signatureRow = z.object({
  typed_name: text,
  signer_email: text,
  signed_at: text,
  signature_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  consent_version: text,
  consent_text: text,
  user_agent: z.string().nullable(),
  client_ip: z.unknown().nullable(),
  client_ip_source: text,
});

/** Validates the frozen rows and maps them to what the PDF shows. Throws on anything unexpected. */
export function buildSignedContractPdfData(contract: unknown, signature: unknown): SignedContractPdfData {
  const c = contractRow.parse(contract);
  const s = signatureRow.parse(signature);
  if (s.content_sha256 !== c.content_sha256) throw new Error("The signature evidence is for different contract content.");
  if (s.consent_version !== c.consent_version) throw new Error("The signature evidence has a different consent version than the contract.");
  const business = c.party_snapshot.business;
  const legalName = business.legal_name?.trim() || business.name;
  const displayName = business.display_name?.trim() || null;
  return {
    contract: {
      id: c.id,
      contentSha256: c.content_sha256,
      title: c.rendered_content.title,
      sections: c.rendered_content.sections,
      currency: c.currency,
      // The contract's frozen signing mode, never its wording.
      isDemo: c.signing_mode === "demo",
    },
    business: {
      legalName,
      displayName: displayName && displayName !== legalName ? displayName : null,
      address: nullableText.parse(business.address),
      contactEmail: nullableText.parse(business.contact_email),
    },
    client: { name: c.party_snapshot.client.name, email: c.party_snapshot.client.email, phone: nullableText.parse(c.party_snapshot.client.phone) },
    event: {
      title: c.party_snapshot.event.title,
      date: c.party_snapshot.event.date,
      timezone: c.party_snapshot.event.timezone?.trim() || "America/Toronto",
      venueName: nullableText.parse(c.party_snapshot.event.venue_name),
      venueAddress: nullableText.parse(c.party_snapshot.event.venue_address),
    },
    commercial: {
      lines: (c.commercial_snapshot.lines ?? []).map((l) => ({
        name: l.name,
        description: l.description ?? null,
        source: l.source,
        quantity: l.quantity,
        unitPriceCents: l.unit_price_cents,
        lineTotalCents: l.line_total_cents,
      })),
      subtotalCents: c.commercial_snapshot.subtotal_cents,
      taxes: c.commercial_snapshot.tax_breakdown.map((t) => ({ label: t.label, ratePpm: t.rate_ppm, amountCents: t.amount_cents })),
      taxCents: c.commercial_snapshot.tax_cents,
      totalCents: c.commercial_snapshot.total_cents,
      depositPercent: c.deposit_percent,
      depositCents: c.deposit_cents,
      balanceCents: c.balance_cents,
      balanceDueDate: c.balance_due_date,
    },
    signature: {
      typedName: s.typed_name,
      signerEmail: s.signer_email,
      signedAt: s.signed_at,
      signatureSha256: s.signature_sha256,
      consentVersion: s.consent_version,
      consentText: s.consent_text,
      userAgent: s.user_agent,
      clientIp: s.client_ip === null || s.client_ip === undefined ? null : String(s.client_ip),
      clientIpSource: s.client_ip_source,
    },
  };
}

/** "October 4, 2026 at 7:30:12 p.m. EDT (America/Toronto)" and the same instant in UTC. */
export function formatSignedAt(iso: string, timeZone: string): { local: string; utc: string } {
  const date = new Date(iso);
  let local: string;
  try {
    local = `${new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "long", timeZone }).format(date)} (${timeZone})`;
  } catch {
    local = `${new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" }).format(date)} (UTC)`;
  }
  const utc = `${date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
  return { local, utc };
}

/** ASCII file name for downloads and attachments: "signed-contract-<event>-<date>.pdf". */
export function signedPdfFileName(eventTitle: string, eventDate: string): string {
  const base = `${eventTitle} ${eventDate}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `signed-contract-${base || "agreement"}.pdf`;
}
