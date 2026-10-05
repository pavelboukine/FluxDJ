/**
 * Test-only PDF inspection: text extraction and page rasterization with
 * pdf.js and @napi-rs/canvas (dev dependencies; never used by the app).
 */
import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: PdfJs | undefined;
async function load(): Promise<PdfJs> {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

async function open(bytes: Buffer) {
  const lib = await load();
  return lib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
}

/** Text of each page, with runs joined by spaces. */
export async function pdfPageTexts(bytes: Buffer): Promise<string[]> {
  const doc = await open(bytes);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " "));
  }
  await doc.cleanup();
  return pages;
}

/** Writes page-N.png files (for visual inspection) and returns their paths. */
export async function rasterizePdf(bytes: Buffer, outDir: string, scale = 1.6): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const doc = await open(bytes);
  const files: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    // pdf.js accepts a canvas-like 2D context; @napi-rs/canvas implements it.
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    const file = path.join(outDir, `page-${i}.png`);
    writeFileSync(file, canvas.toBuffer("image/png"));
    files.push(file);
  }
  await doc.cleanup();
  return files;
}
