import "server-only";
import sharp from "sharp";
import { LOGO_BUCKET } from "@/lib/branding/logo.server";
import { normalizeHex } from "@/lib/branding/colors";
import type { createAdminClient } from "@/lib/supabase/admin";
import { businessBrand, type EmailBrand } from "./layout";
import type { EmailAttachment } from "./transport.server";

type Admin = ReturnType<typeof createAdminClient>;

/** The logo's content id in the HTML (`cid:business-logo`). */
export const LOGO_CID = "business-logo";
/** Attached at up to twice the display size (220 x 56), so it is sharp on high-density screens. */
const LOGO_PIXELS = { width: 440, height: 112 };
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
 * row's own business folder, resized and attached inline (CID). Any problem
 * leaves the logo out: the email still goes, with the business name.
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
  if (!cache.has(path)) cache.set(path, loadLogo(admin, path));
  const logo = await cache.get(path)!;
  if (!logo) return { brand: businessBrand(name, color), attachments: [], replyTo };
  return {
    brand: businessBrand(name, color, { cid: LOGO_CID, width: logo.width, height: logo.height, darkBackground: frozen?.logo?.needs_dark_background === true }),
    attachments: [{ filename: "logo.png", contentType: "image/png", content: logo.png, contentId: LOGO_CID }],
    replyTo,
  };
}

export type LogoImage = { png: Buffer; width: number; height: number };

/** The stored (already verified and re-encoded) logo, fitted for email. Same input, same bytes. */
async function loadLogo(admin: Admin, path: string): Promise<LogoImage | null> {
  try {
    const { data, error } = await admin.storage.from(LOGO_BUCKET).download(path);
    if (error || !data) return null;
    return await fitLogo(Buffer.from(await data.arrayBuffer()));
  } catch {
    return null;
  }
}

/** Fits a logo inside the email box without enlarging, stretching or cropping; PNG, metadata dropped. */
export async function fitLogo(input: Buffer): Promise<LogoImage | null> {
  try {
    const { data, info } = await sharp(input)
      .resize({ ...LOGO_PIXELS, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > LOGO_MAX_BYTES) return null;
    // Pixel size; layout.logoDisplaySize shows it within 220 x 56, never larger than it is.
    return { png: data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}
