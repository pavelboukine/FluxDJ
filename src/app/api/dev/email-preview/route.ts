import sharp from "sharp";
import { fitLogo } from "@/lib/email/branding.server";
import { PREVIEW_LOGO_SIZE, PREVIEW_VARIANTS, previewIndex, type PreviewVariant } from "@/lib/email/previews";

/**
 * Local email previews: every template with sample businesses (logo, light
 * logo on dark, no logo, long names), at desktop and phone width, with the
 * plain-text version. Development only: 404 everywhere else. Sample data
 * only; nothing is read from the database or sent.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const requested = url.searchParams.get("variant") ?? "logo";
  const variant: PreviewVariant = requested in PREVIEW_VARIANTS ? (requested as PreviewVariant) : "logo";
  const logo = async (dark: boolean) => {
    const { width, height } = PREVIEW_LOGO_SIZE;
    const ink = dark ? "#ffffff" : "#18181b";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="45" cy="45" r="32" fill="none" stroke="${ink}" stroke-width="8"/><circle cx="45" cy="45" r="8" fill="${ink}"/><text x="92" y="58" font-family="Helvetica,Arial" font-size="34" font-weight="700" fill="${ink}">LOGO</text></svg>`;
    const plated = await fitLogo(await sharp(Buffer.from(svg)).png().toBuffer(), dark);
    return `data:image/png;base64,${plated!.png.toString("base64")}`;
  };
  const [light, dark] = await Promise.all([logo(false), logo(true)]);
  const html = previewIndex(variant, (d) => (d ? dark : light), url.searchParams.get("email") ?? undefined);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
