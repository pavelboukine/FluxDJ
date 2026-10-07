/**
 * Generated logo fixtures (never a real business's logo). Each returns the
 * bytes of a file as a browser would upload it.
 */
import sharp from "sharp";

/** A coloured shape on a transparent background, width x height. */
export async function transparentPng(width: number, height: number, rgb: [number, number, number] = [225, 29, 72]): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x > width * 0.1 && x < width * 0.9 && y > height * 0.2 && y < height * 0.8;
      const i = (y * width + x) * 4;
      if (inside) [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]] = [...rgb, 255];
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export const opaqueJpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 17, g: 94, b: 89 } } }).jpeg().toBuffer();

export const opaqueWebp = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 30, g: 64, b: 175, alpha: 1 } } }).webp().toBuffer();

/** White artwork on transparency: needs a dark backdrop on light pages. */
export const whiteOnTransparentPng = (width: number, height: number) => transparentPng(width, height, [255, 255, 255]);

export const fullyTransparentPng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

export const animatedWebp = () =>
  sharp({ create: { width: 32, height: 32, channels: 4, background: "#ff0000" } }).webp().toBuffer().then(async (frame) =>
    sharp([frame, await sharp({ create: { width: 32, height: 32, channels: 4, background: "#0000ff" } }).webp().toBuffer()], { join: { animated: true } }).webp().toBuffer());

export const svgLogo = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
/** HTML bytes behind a .png name and an image/png type. */
export const htmlDisguisedAsPng = () => Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>");
/** A real PNG signature followed by garbage. */
export const corruptPng = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
