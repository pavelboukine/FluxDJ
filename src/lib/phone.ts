/**
 * A client's phone number as staff type it. Flux DJ is email-based: the
 * phone is contact information (and, when a business's contract template
 * prints {{client.phone}}, a value the contract needs), never a sign-in or
 * SMS channel, so nothing here verifies or reformats a number.
 *
 * Accepted: Canadian and international numbers as people write them, such
 * as "514 555-0100", "(514) 555-0100", "+1 514-555-0100", "+33 1 23 45 67 89"
 * or "+44 (0)20 7946 0958", with an optional extension ("ext. 12", "x12",
 * "#12"). The number keeps what was typed, including its country code; only
 * surrounding spaces are trimmed and runs of spaces collapsed.
 */

export const PHONE_MAX = 40;

const MAIN = /^\+?[0-9][0-9 ().\-/]*$/;
const EXTENSION = /\s*(?:ext\.?|extension|x|#)\s*([0-9]{1,6})$/i;

export const PHONE_HINT = "Include the country code for numbers outside North America, e.g. +33 1 23 45 67 89.";

export type PhoneCheck = { ok: true; value: string | null } | { ok: false; message: string };

/** Checks an optional phone number; blank means none. */
export function checkClientPhone(raw: string | null | undefined): PhoneCheck {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  if (value === "") return { ok: true, value: null };
  if (value.length > PHONE_MAX) return { ok: false, message: `Phone number is too long (${PHONE_MAX} characters at most).` };
  const main = value.replace(EXTENSION, "").trim();
  // A bracket pair may wrap a leading "+1" style prefix too: "(+1) 514…".
  const plain = main.replace(/^\((\+?[0-9]{1,4})\)/, "$1");
  if (!MAIN.test(plain) || (plain.match(/\+/g) ?? []).length > 1) {
    return { ok: false, message: "Use digits, spaces, brackets, dots or dashes, with + only at the start (an extension can follow as “ext. 12”)." };
  }
  if (!balanced(plain)) return { ok: false, message: "Check the brackets in the phone number." };
  const digits = plain.replace(/[^0-9]/g, "").length;
  if (digits < 7 || digits > 20) return { ok: false, message: "Enter a phone number with 7 to 20 digits, such as 514 555-0100 or +33 1 23 45 67 89." };
  return { ok: true, value };
}

function balanced(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0 || depth > 1) return false;
  }
  return depth === 0;
}

/** A tel: link target: digits with a leading + kept, extension dropped. Null when there is nothing dialable. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const main = phone.replace(EXTENSION, "");
  const digits = main.replace(/[^0-9+]/g, "").replace(/(?!^)\+/g, "");
  return digits.replace(/\D/g, "").length >= 3 ? `tel:${digits}` : null;
}
