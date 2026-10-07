import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { registerFonts } from "@/lib/contracts/pdf/render.server";
import type { RunSheet } from "./model";
import { RunSheetDocument } from "./pdf";

/** Renders the run sheet on demand (bundled fonts, no network). Nothing is stored. */
export async function renderRunSheetPdf(sheet: RunSheet, revision: string): Promise<Buffer> {
  registerFonts();
  const bytes = await renderToBuffer(<RunSheetDocument sheet={sheet} revision={revision} />);
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("The renderer did not produce a PDF.");
  return buffer;
}
