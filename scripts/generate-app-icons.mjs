// Generates the temporary Flux DJ app icons (not a final logo): a white "F"
// with three small level bars on the app's near-black primary colour.
// Uses only what the repo already has: @napi-rs/canvas (dev dependency) and
// the bundled DejaVu font. Run with `node scripts/generate-app-icons.mjs`;
// the PNG/ICO files it writes are committed, so builds never run it.
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const INK = "#171717"; // --primary in globals.css (oklch 0.205 0 0)
const PAPER = "#ffffff";
GlobalFonts.registerFromPath(path.join("assets", "fonts", "dejavu", "DejaVuSans-Bold.ttf"), "FluxIcon");

/**
 * size: output pixels. content: share of the side the artwork may use
 * (maskable icons keep it inside the 80% safe zone). radius: corner radius
 * as a share of the side (0 = full bleed square, for maskable and Apple).
 */
function draw(size, { content = 0.72, radius = 0 } = {}) {
  const c = createCanvas(size, size);
  const g = c.getContext("2d");
  g.fillStyle = INK;
  if (radius > 0) {
    const r = size * radius;
    g.beginPath();
    g.roundRect(0, 0, size, size, r);
    g.fill();
  } else {
    g.fillRect(0, 0, size, size);
  }
  const box = size * content;
  const y0 = (size - box) / 2;
  // "F" then three level bars, centred together as one group.
  g.fillStyle = PAPER;
  g.font = `${Math.round(box * 0.8)}px FluxIcon`;
  g.textBaseline = "alphabetic";
  const m = g.measureText("F");
  const fWidth = m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
  const fHeight = m.actualBoundingBoxAscent;
  const barW = box * 0.085;
  const gap = box * 0.06;
  const groupW = fWidth + box * 0.1 + 3 * barW + 2 * gap;
  const left = (size - groupW) / 2;
  const baseline = y0 + box / 2 + fHeight / 2;
  g.fillText("F", left + m.actualBoundingBoxLeft, baseline);
  const barsLeft = left + fWidth + box * 0.1;
  [0.42, 0.7, 0.54].forEach((h, i) => {
    const height = fHeight * h;
    g.beginPath();
    g.roundRect(barsLeft + i * (barW + gap), baseline - height, barW, height, barW * 0.3);
    g.fill();
  });
  return c.toBuffer("image/png");
}

/** A Windows/legacy favicon: ICO container holding PNG images (supported everywhere modern). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

mkdirSync(path.join("public", "icons"), { recursive: true });
const out = {
  "public/icons/icon-192.png": draw(192, { radius: 0.22 }),
  "public/icons/icon-512.png": draw(512, { radius: 0.22 }),
  // Maskable: full bleed, artwork within the central 80% safe zone.
  "public/icons/maskable-512.png": draw(512, { content: 0.56 }),
  // Apple touch icon: opaque square (iOS rounds the corners itself).
  "src/app/apple-icon.png": draw(180, { content: 0.66 }),
  "src/app/favicon.ico": ico([16, 32, 48].map((size) => ({ size, data: draw(size, { content: 0.82, radius: 0.18 }) }))),
};
for (const [file, data] of Object.entries(out)) {
  writeFileSync(file, data);
  console.log(file, data.length, "bytes");
}
