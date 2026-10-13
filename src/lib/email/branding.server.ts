import "server-only";
import sharp from "sharp";
import { LOGO_BUCKET } from "@/lib/branding/logo.server";
import { normalizeHex } from "@/lib/branding/colors";
import type { createAdminClient } from "@/lib/supabase/admin";
import { businessBrand, logoDisplaySize, logoPlateSize, type EmailBrand } from "./layout";
import type { EmailAttachment } from "./transport.server";

type Admin = ReturnType<typeof createAdminClient>;

/** The logo's content id in the HTML (`cid:business-logo`). */
export const LOGO_CID = "business-logo";
/** Artwork at up to twice its display size (220 x 56), so it is sharp on high-density screens. */
const LOGO_PIXELS = { width: 440, height: 112 };
/** The plate behind the artwork (layout.ts: why it is part of the image), by the logo's frozen "needs a dark background". */
const PLATE = { light: { fill: "#ffffff", edge: "#e4e4e7" }, dark: { fill: "#18181b", edge: "#3f3f46" } } as const;
const PLATE_RADIUS = 10;
/** Larger results are dropped (the email is sent with the business name instead). */
const LOGO_MAX_BYTES = 120 * 1024;

type FrozenBranding = {
  display_name?: unknown;
  reply_to?: unknown;
  primary_color?: unknown;
  logo?: { path?: unknown; needs_dark_background?: unknown } | null;
};

/**
 * `replyTo`: the reply-to frozen with the branding (null: none), or undefined
 * for rows frozen before reply-tos were (the caller then uses the current one).
 */
export type EmailBranding = { brand: EmailBrand; attachments: EmailAttachment[]; replyTo?: string | null };

/**
 * The branding of one outbox row: frozen at its first attempt by
 * freeze_email_branding (the proposal's frozen branding for proposal emails,
 * the business's current branding otherwise), so every retry renders the same
 * email. The logo is read from private Storage server-side, only from the
 * row's own business folder, resized onto its plate and attached inline
 * (CID). Any problem leaves the logo out: the email still goes, with the
 * business name.
 *
 * `cache` shares logo work between rows of one worker run.
 */
export async function emailBranding(
  admin: Admin,
  row: { id: string; tenant_id: string | null },
  fallbackName: string,
  cache: Map<string, Promise<LogoImage | null>>,
): Promise<EmailBranding> {
  const { data } = await admin.rpc("freeze_email_branding", { p_id: row.id });
  const frozen = (data ?? null) as FrozenBranding | null;
  const name = typeof frozen?.display_name === "string" && frozen.display_name.trim() ? frozen.display_name : fallbackName;
  const color = normalizeHex(frozen?.primary_color);
  const path = typeof frozen?.logo?.path === "string" ? frozen.logo.path : null;
  const replyTo = frozen && "reply_to" in frozen ? (typeof frozen.reply_to === "string" ? frozen.reply_to : null) : undefined;
  // Never read another business's file, whatever the row says.
  if (!path || !row.tenant_id || !path.startsWith(`${row.tenant_id}/`)) return { brand: businessBrand(name, color), attachments: [], replyTo };
  const onDark = frozen?.logo?.needs_dark_background === true;
  const key = `${path} ${onDark ? "dark" : "light"}`;
  if (!cache.has(key)) cache.set(key, loadLogo(admin, path, onDark));
  const logo = await cache.get(key)!;
  if (!logo) return { brand: businessBrand(name, color), attachments: [], replyTo };
  return {
    brand: businessBrand(name, color, { cid: LOGO_CID, width: logo.width, height: logo.height }),
    attachments: [{ filename: "logo.png", contentType: "image/png", content: logo.png, contentId: LOGO_CID }],
    replyTo,
  };
}

/** `width`/`height`: the display size in CSS pixels (the PNG is up to twice that). */
export type LogoImage = { png: Buffer; width: number; height: number };

/** The stored (already verified and re-encoded) logo, fitted for email. Same input, same bytes. */
async function loadLogo(admin: Admin, path: string, onDark: boolean): Promise<LogoImage | null> {
  try {
    const { data, error } = await admin.storage.from(LOGO_BUCKET).download(path);
    if (error || !data) return null;
    return await fitLogo(Buffer.from(await data.arrayBuffer()), onDark);
  } catch {
    return null;
  }
}

/**
 * Fits a logo inside the email box without enlarging, stretching or cropping,
 * centred on an opaque rounded plate with a hairline edge (white, or
 * near-black when the logo is mostly light), at the artwork's own pixel
 * density; PNG, metadata dropped. Transparent artwork stays crisp on the
 * plate, and the plate keeps it visible when a client darkens the email.
 */
export async function fitLogo(input: Buffer, onDark = false): Promise<LogoImage | null> {
  try {
    const { data: art, info } = await sharp(input)
      .resize({ ...LOGO_PIXELS, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    // Image pixels per CSS pixel (1 to 2): the plate is drawn at the same density.
    const density = info.width / logoDisplaySize(info.width, info.height).width;
    const display = logoPlateSize(info.width, info.height);
    const width = Math.round(display.width * density);
    const height = Math.round(display.height * density);
    const plate = PLATE[onDark ? "dark" : "light"];
    const half = density / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${half}" y="${half}" width="${width - density}" height="${height - density}" rx="${PLATE_RADIUS * density}" fill="${plate.fill}" stroke="${plate.edge}" stroke-width="${density}"/></svg>`;
    const png = await sharp(Buffer.from(svg))
      .composite([{ input: art, left: Math.round((width - info.width) / 2), top: Math.round((height - info.height) / 2) }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (png.length > LOGO_MAX_BYTES) return null;
    return { png, width: display.width, height: display.height };
  } catch {
    return null;
  }
}
