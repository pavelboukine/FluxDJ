import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { buildSignedContractPdfData, formatSignedAt, signedPdfFileName } from "@/lib/contracts/pdf/data";
import { PDF_RENDERER, renderSignedContractPdf } from "@/lib/contracts/pdf/render.server";
import { pdfPageTexts, rasterizePdf } from "../support/pdf";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function signaturePng(): Buffer {
  const w = 900, h = 300;
  const rgba = Buffer.alloc(w * h * 4);
  for (let t = 0; t < 640; t++) {
    const x = 130 + t, y = Math.round(150 + Math.sin(t / 22) * 70 + Math.cos(t / 9) * 12);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      rgba[i] = 17; rgba[i + 1] = 24; rgba[i + 2] = 39; rgba[i + 3] = 255;
    }
  }
  return encodeRgbaPng(rgba, w, h);
}

const LONG_FR =
  "Le prestataire s’engage à fournir l’animation musicale décrite ci-dessus, y compris l’installation, les essais de son et le démontage. " +
  "Les modifications demandées par le client après la signature doivent être confirmées par écrit. Ça inclut les changements d’horaire, " +
  "de lieu ou de matériel. Événement, réception, cérémonie : chaque élément est décrit avec soin pour éviter toute ambiguïté. ";

function rows(opts: { long: boolean }) {
  const contentSha = "a".repeat(64);
  const sections = opts.long
    ? Array.from({ length: 14 }, (_, i) => ({
        heading: `${i + 1}. Article ${i + 1} — Conditions générales (DEMO)`,
        body: `${LONG_FR.repeat(3)}\n\nDeuxième paragraphe : élément ${i + 1}, crème brûlée, garçon, Noël, façade.\nLigne suivante sans paragraphe.`,
      }))
    : [{ heading: "Parties", body: "Between Example Sound Inc. and Dana & Lou." }];
  const contract = {
    id: randomUUID(),
    status: "signed",
    content_sha256: contentSha,
    currency: "CAD",
    total_cents: 252945,
    deposit_percent: 50,
    deposit_cents: 126473,
    balance_cents: 126472,
    balance_due_date: opts.long ? "2027-09-01" : null,
    rendered_content: { schema_version: 1, title: "DEMO, NOT FOR CLIENT USE: Contrat de services DJ pour Mariage Gagnon–Lévesque", sections },
    commercial_snapshot: {
      lines: [
        { name: "Forfait Signature", description: null, source: "package", quantity: 1, unit_price_cents: 220000, line_total_cents: 220000 },
        { name: "Haut-parleur pour lieu additionnel", description: null, source: "included", quantity: 1, unit_price_cents: 0, line_total_cents: 0 },
        { name: "Éclairage de piste (ensemble)", description: null, source: "optional", quantity: 1, unit_price_cents: 0, line_total_cents: 0 },
      ],
      subtotal_cents: 220000,
      tax_breakdown: [
        { code: "GST", label: "TPS / GST", rate_ppm: 50000, taxable_cents: 220000, amount_cents: 11000 },
        { code: "QST", label: "TVQ / QST", rate_ppm: 99750, taxable_cents: 220000, amount_cents: 21945 },
      ],
      tax_cents: 32945,
      total_cents: 252945,
    },
    party_snapshot: {
      business: {
        name: "Productions Éclair Inc.",
        legal_name: "Productions Éclair Inc.",
        display_name: "ÉCLAIR DJ",
        address: "1234, rue Saint-Joseph Est\nBureau 200\nGatineau (Québec)  J8Y 0A1",
        contact_email: "contrats@eclair.example.test",
      },
      client: { client_id: randomUUID(), name: "Chloé Gagnon & François Lévesque", email: "chloe.francois@example.test", phone: "+1 819 555-0199" },
      event: {
        event_id: randomUUID(),
        title: "Mariage Gagnon–Lévesque",
        date: "2027-09-18",
        timezone: "America/Toronto",
        venue_name: "Château Montebello",
        venue_address: "392, rue Notre-Dame\nMontebello (Québec)  J0V 1L0",
      },
    },
  };
  const signature = {
    typed_name: "Chloé Gagnon",
    signer_email: "chloe.francois@example.test",
    signed_at: "2026-10-04T23:30:12.345Z",
    signature_sha256: "b".repeat(64),
    content_sha256: contentSha,
    consent_version: "demo-v1",
    consent_text:
      "I have read the agreement shown above. I intend to sign it electronically, and I agree that my typed name and drawn signature are my signature on this agreement.",
    user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    client_ip: opts.long ? "203.0.113.9" : null,
    client_ip_source: opts.long ? "vercel" : "unavailable",
  };
  return { contract, signature };
}

describe("signed contract PDF", () => {
  it("renders a long French agreement with multiline parties and a signature, on numbered pages", async () => {
    const { contract, signature } = rows({ long: true });
    const data = buildSignedContractPdfData(contract, signature);
    const png = signaturePng();
    const bytes = await renderSignedContractPdf(data, png, new Date("2026-10-05T00:00:00Z"));
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const pages = await pdfPageTexts(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(4);
    const all = pages.join(" ");
    pages.forEach((page, i) => {
      expect(page).toContain(`Page ${i + 1} of ${pages.length}`);
      expect(page).toContain("DEMO, NOT FOR CLIENT USE");
      expect(page).toContain(`Contract ${contract.id}`);
    });
    for (const expected of [
      "Productions Éclair Inc.", "Operating as ÉCLAIR DJ", "1234, rue Saint-Joseph Est", "Bureau 200", "Gatineau (Québec) J8Y 0A1",
      "Chloé Gagnon & François Lévesque", "+1 819 555-0199", "Château Montebello", "Montebello (Québec) J0V 1L0",
      "14. Article 14 — Conditions générales (DEMO)", "crème brûlée, garçon, Noël, façade", "Ligne suivante sans paragraphe.",
      "Forfait Signature", "Included", "TPS / GST (5%)", "TVQ / QST (9.975%)", "$2,529.45", "Deposit due on signing (50%)", "$1,264.73",
      "$1,264.72", "2027-09-01", "Client signature", "Chloé Gagnon", "EDT (America/Toronto)", "2026-10-04 23:30:12 UTC",
      "It does not contain a signature by Productions Éclair Inc.", "Total, including taxes", "Signing record", "a".repeat(64), "b".repeat(64),
      "Consent (demo-v1)", "my typed name and drawn signature are my signature", "203.0.113.9", "Mobile/15E148",
      "It is not a hash of this PDF file.",
    ]) {
      expect(all).toContain(expected);
    }
    // Every section heading made it in, in order.
    let at = -1;
    for (let i = 1; i <= 14; i++) {
      const next = all.indexOf(`${i}. Article ${i} —`);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    // The final-byte hash is not inside the file it describes.
    expect(bytes.toString("latin1")).not.toContain(sha(bytes));
    expect(all).not.toMatch(/countersign|booked|deposit (has been )?paid/i);
    expect(all).not.toContain("Inc..");
    // The price table and its totals stay on one page.
    const pricePage = pages.findIndex((p) => p.includes("Agreed price and payment terms"));
    expect(pages[pricePage]).toContain("Total, including taxes");

    const files = await rasterizePdf(bytes, "test-results/pdf-samples/long");
    expect(files.length).toBe(pages.length);
  }, 60_000);

  it("renders a short agreement with no IP or balance date honestly", async () => {
    const { contract, signature } = rows({ long: false });
    const bytes = await renderSignedContractPdf(buildSignedContractPdfData(contract, signature), signaturePng());
    const all = (await pdfPageTexts(bytes)).join(" ");
    expect(all).toContain("Not recorded (not reliably known for this request)");
    expect(all).toContain("Not specified in this agreement");
    await rasterizePdf(bytes, "test-results/pdf-samples/short");
  }, 60_000);

  it("refuses evidence for different content and unexpected rows", () => {
    const { contract, signature } = rows({ long: false });
    expect(() => buildSignedContractPdfData(contract, { ...signature, content_sha256: "c".repeat(64) })).toThrow(/different contract content/);
    expect(() => buildSignedContractPdfData({ ...contract, status: "sent" }, signature)).toThrow();
  });

  it("formats times and file names", () => {
    expect(formatSignedAt("2026-01-15T17:00:00Z", "America/Toronto").local).toMatch(/EST \(America\/Toronto\)$/);
    expect(formatSignedAt("2026-01-15T17:00:00Z", "Not/AZone").local).toMatch(/\(UTC\)$/);
    expect(signedPdfFileName("Mariage Gagnon–Lévesque", "2027-09-18")).toBe("signed-contract-mariage-gagnon-levesque-2027-09-18.pdf");
    expect(PDF_RENDERER).toMatch(/^flux-signed-contract-pdf\//);
  });
});
