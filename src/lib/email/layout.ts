import { brandTheme } from "@/lib/branding/colors";

/**
 * The shared transactional email layout. One content description renders
 * both the HTML (table-based, inline styles only, for Gmail, Outlook, Apple
 * Mail and phones) and the plain-text alternative, so they always carry the
 * same information. The business is the primary identity; Flux DJ appears
 * only in the footer (platform emails are Flux's own).
 *
 * No tracking pixels, no remote images: a logo is an inline (CID) attachment
 * added by the worker, and the business name is always shown in text too, so
 * the email reads the same when images are blocked.
 */

export type EmailLogo = { cid: string; width: number; height: number; darkBackground: boolean };

export type EmailBrand = {
  /** The business (or "Flux DJ" for platform emails). */
  name: string;
  /** #rrggbb or null for the default dark grey. */
  color: string | null;
  logo: EmailLogo | null;
  kind: "business" | "platform";
};

export type EmailContent = {
  brand: EmailBrand;
  /** Inbox preview line (hidden in the body). */
  preheader: string;
  heading: string;
  greeting?: string;
  paragraphs: string[];
  /** Label/value pairs shown as a compact summary (event, date, amounts). Empty values are skipped. */
  details?: [string, string | null | undefined][];
  action?: { label: string; href: string };
  /** Smaller notes after the action (link safety, expiry, questions). */
  notes?: string[];
  /** Why the recipient got this email / who to contact. */
  footer: string[];
};

export type RenderedEmail = { subject: string; text: string; html: string };

export const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTED = "#71717a";
const TEXT = "#18181b";
const BORDER = "#e4e4e7";
const PAGE = "#f4f4f5";

/** Logo display size: at most 220 x 56 CSS pixels, aspect ratio kept (the attached image is about twice that). */
export function logoDisplaySize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 160, height: 48 };
  const scale = Math.min(220 / width, 56 / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function header(brand: EmailBrand): string {
  const theme = brandTheme(brand.color);
  const name = escapeHtml(brand.name);
  if (brand.logo) {
    const size = logoDisplaySize(brand.logo.width, brand.logo.height);
    const img = `<img src="cid:${escapeHtml(brand.logo.cid)}" width="${size.width}" height="${size.height}" alt="${name}" style="display:block;border:0;outline:none;text-decoration:none;width:${size.width}px;height:${size.height}px;max-width:100%;font-family:${FONT};font-size:18px;font-weight:700;color:${TEXT};">`;
    return brand.logo.darkBackground
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#18181b;border-radius:10px;padding:10px 14px;">${img}</td></tr></table>`
      : img;
  }
  // No logo: the name in text, with a small brand-colour mark.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:10px;height:10px;background:${theme.color};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td><td style="padding-left:10px;font-family:${FONT};font-size:19px;line-height:1.3;font-weight:700;color:${TEXT};">${name}</td></tr></table>`;
}

function button(action: { label: string; href: string }, color: string | null): string {
  const theme = brandTheme(color);
  const href = escapeHtml(action.href);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 10px;"><tr><td align="center" bgcolor="${theme.color}" style="border-radius:8px;background:${theme.color};"><a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:15px;line-height:1.2;font-weight:600;color:${theme.foreground};text-decoration:none;border-radius:8px;">${escapeHtml(action.label)}</a></td></tr></table>
<p style="margin:0 0 4px;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">If the button doesn't work, copy this link into your browser:<br><a href="${href}" style="color:${MUTED};word-break:break-all;">${href}</a></p>`;
}

function detailsTable(details: [string, string][]): string {
  const rows = details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;font-family:${FONT};font-size:13px;line-height:1.4;color:${MUTED};vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:6px 0;font-family:${FONT};font-size:14px;line-height:1.4;color:${TEXT};font-weight:600;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 4px;background:#fafafa;border:1px solid ${BORDER};border-radius:8px;"><tr><td style="padding:10px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr></table>`;
}

const filled = (details: EmailContent["details"]) =>
  (details ?? []).filter((d): d is [string, string] => typeof d[1] === "string" && d[1].trim() !== "");

export function renderHtml(subject: string, c: EmailContent): string {
  const theme = brandTheme(c.brand.color);
  const p = (text: string) => `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.6;color:${TEXT};">${escapeHtml(text)}</p>`;
  const note = (text: string) => `<p style="margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:1.55;color:${MUTED};">${escapeHtml(text)}</p>`;
  const details = filled(c.details);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};"><tr><td align="center" style="padding:28px 12px;">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="padding:0 4px 18px;">${header(c.brand)}</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${BORDER};border-top:4px solid ${theme.color};border-radius:12px;padding:28px 28px 26px;">
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${TEXT};">${escapeHtml(c.heading)}</h1>
${c.greeting ? p(c.greeting) : ""}${c.paragraphs.map(p).join("")}${details.length ? detailsTable(details) : ""}${c.action ? button(c.action, c.brand.color) : ""}${(c.notes ?? []).map(note).join("")}
</td></tr>
<tr><td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">${c.footer.map(escapeHtml).join("<br>")}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}

export function renderText(c: EmailContent): string {
  const blocks: string[] = [c.brand.name, c.heading];
  if (c.greeting) blocks.push(c.greeting);
  blocks.push(...c.paragraphs);
  const details = filled(c.details);
  if (details.length) blocks.push(details.map(([label, value]) => `${label}: ${value}`).join("\n"));
  if (c.action) blocks.push(`${c.action.label}: ${c.action.href}`);
  blocks.push(...(c.notes ?? []));
  blocks.push(`--\n${c.footer.join("\n")}`);
  return `${blocks.join("\n\n")}\n`;
}

export function render(subject: string, c: EmailContent): RenderedEmail {
  return { subject, text: renderText(c), html: renderHtml(subject, c) };
}

/** A business brand with no logo (the worker adds the logo when one is available). */
export function businessBrand(name: string, color: string | null = null, logo: EmailLogo | null = null): EmailBrand {
  return { name, color, logo, kind: "business" };
}

export const FLUX_BRAND: EmailBrand = { name: "Flux DJ", color: "#111827", logo: null, kind: "platform" };
