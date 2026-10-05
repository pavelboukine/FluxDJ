import "server-only";
import path from "node:path";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import type { SignedContractPdfData } from "./data";
import { PDF_FONT, SignedContractDocument } from "./signed-contract-document";

/** Recorded with every artifact; bump when the layout changes. */
export const PDF_RENDERER = "flux-signed-contract-pdf/1";

// Bundled fonts (assets/fonts/dejavu, Bitstream Vera/DejaVu licence): full
// Latin, French and other accents, with no network fetch while rendering.
// next.config.ts traces these files into the deployed functions.
const FONT_DIR = path.join(process.cwd(), "assets", "fonts", "dejavu");
let fontsRegistered = false;

function registerFonts() {
  if (fontsRegistered) return;
  Font.register({
    family: PDF_FONT,
    fonts: [
      { src: path.join(FONT_DIR, "DejaVuSans.ttf") },
      { src: path.join(FONT_DIR, "DejaVuSans-Bold.ttf"), fontWeight: "bold" },
      { src: path.join(FONT_DIR, "DejaVuSans-Oblique.ttf"), fontStyle: "italic" },
    ],
  });
  // No dictionary hyphenation (it mangles French and legal wording). Very
  // long unbroken strings (emails, URLs, tokens) still get break points so
  // they wrap instead of running off the page.
  Font.registerHyphenationCallback((word) => (word.length > 28 ? (word.match(/.{1,16}/g) ?? [word]) : [word]));
  fontsRegistered = true;
}

/** Renders the signed agreement to PDF bytes. The caller hashes these exact bytes. */
export async function renderSignedContractPdf(data: SignedContractPdfData, signaturePng: Buffer, generatedAt = new Date()): Promise<Buffer> {
  registerFonts();
  const bytes = await renderToBuffer(<SignedContractDocument data={data} signaturePng={signaturePng} generatedAt={generatedAt} />);
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("The renderer did not produce a PDF.");
  return buffer;
}
