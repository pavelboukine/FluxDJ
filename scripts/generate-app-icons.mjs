// Generates Flux DJ's app icons and web wordmarks from the supplied artwork in
// assets/brand (never redrawn): flux-app-icon.png (the app icon, an opaque
// square) and flux-wordmark-black.png / flux-wordmark-white.png (the "Flux"
// wordmark on transparency). Run with `node scripts/generate-app-icons.mjs`;
// the files it writes are committed, so builds never run it.
//
// The app icon is only scaled, padded with its own background colour, and
// given rounded corners where a platform shows the file as-is. The source is
// the supplied 1080 x 1080 artwork; any square source works, and the script
// warns whenever an output is larger than its source, because upscaling
// cannot add detail.
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE_ICON = path.join("assets", "brand", "flux-app-icon.png");
const WORDMARKS = ["black", "white"];
// Rendered wordmark height in pixels: the header shows it at most ~28 CSS px,
// so this covers 3x screens with room to spare.
const WORDMARK_HEIGHT = 160;

const iconBytes = readFileSync(SOURCE_ICON);
const meta = await sharp(iconBytes).metadata();
if (meta.width !== meta.height) throw new Error(`${SOURCE_ICON} must be square (it is ${meta.width} x ${meta.height})`);
const side = meta.width;
// The icon's own background, read from its top-left pixel (the artwork is centred on it).
const { data: corner } = await sharp(iconBytes).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const background = { r: corner[0], g: corner[1], b: corner[2], alpha: 1 };

const warnings = new Set();
function noteUpscale(size) {
  if (size > side) warnings.add(size);
}

/**
 * size: output pixels. scale: share of the side the source square fills (the
 * rest is the icon's own background; maskable icons keep the artwork inside
 * the central safe circle). radius: corner radius as a share of the side
 * (0 = square, for maskable and Apple icons, which the platform shapes).
 */
async function icon(size, { scale = 1, radius = 0 } = {}) {
  const inner = Math.round(size * scale);
  noteUpscale(inner);
  let image = await sharp(iconBytes).resize(inner, inner, { kernel: "lanczos3" }).removeAlpha().png().toBuffer();
  if (inner !== size) {
    const pad = Math.floor((size - inner) / 2);
    image = await sharp(image).extend({ top: pad, left: pad, bottom: size - inner - pad, right: size - inner - pad, background }).png().toBuffer();
  }
  if (radius > 0) {
    const r = size * radius;
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}"/></svg>`);
    image = await sharp(image).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  }
  return sharp(image).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

/** The wordmark trimmed to its visible pixels (the supplied files carry wide transparent margins), never stretched. */
async function wordmark(colour) {
  const source = path.join("assets", "brand", `flux-wordmark-${colour}.png`);
  const trimmed = await sharp(source).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  return sharp(trimmed.data)
    .resize({ height: WORDMARK_HEIGHT, kernel: "lanczos3", withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
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
mkdirSync(path.join("public", "brand"), { recursive: true });
const out = {
  "public/icons/icon-192.png": await icon(192, { radius: 0.22 }),
  "public/icons/icon-512.png": await icon(512, { radius: 0.22 }),
  // Maskable: full bleed; the artwork (its farthest corner 36% of the side from
  // the centre in the supplied icon) shrinks to 85%, about 30%, so it sits well
  // inside the 40% safe circle.
  "public/icons/maskable-512.png": await icon(512, { scale: 0.85 }),
  // Apple touch icon, 180 x 180: a larger source is scaled down (a source of
  // exactly 180 x 180 is used byte for byte). iOS rounds the corners.
  "src/app/apple-icon.png": side === 180 ? iconBytes : await icon(180),
  "src/app/favicon.ico": ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await icon(size, { radius: 0.18 }) })))),
};
for (const colour of WORDMARKS) {
  const { data, info } = await wordmark(colour);
  out[`public/brand/flux-wordmark-${colour}.png`] = data;
  console.log(`flux-wordmark-${colour}.png ${info.width} x ${info.height}`);
}
for (const [file, data] of Object.entries(out)) {
  writeFileSync(file, data);
  console.log(file, data.length, "bytes");
}
if (warnings.size > 0) {
  console.warn(
    `Note: ${SOURCE_ICON} is ${side} x ${side}; the ${[...warnings].sort((a, b) => a - b).join(", ")} px artwork is upscaled and will look soft. ` +
      "Supply a 1024 x 1024 source for sharp large icons.",
  );
}
