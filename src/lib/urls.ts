/**
 * An absolute https:// address, as private.is_https_url (the authority)
 * decides it: lowercase "https://", a dotted host name of ASCII letters,
 * digits and inner hyphens, an optional port, then nothing with whitespace,
 * angle brackets, quotes or a backslash (so no credentials either), at most
 * 2,000 characters. The same pattern, so the app never accepts what the
 * database refuses (tests/support/rule-cases.ts), plus one deliberate extra:
 * a port above 65535, which the database's pattern allows but no browser can
 * open, is refused here.
 */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?([/?#][^\s<>"\\]*)?$/;
/** The port of an address that passed HTTPS_URL (the host has no colon, so the first one starts the port). */
const PORT = /^https:\/\/[^/?#:]+:([0-9]+)/;
export function isHttpsUrl(value: string): boolean {
  if (value.length > 2000 || !HTTPS_URL.test(value)) return false;
  const port = PORT.exec(value)?.[1];
  return port === undefined || Number(port) <= 65535;
}

/** The host shown next to a link (an invoice, a song), so people see where it goes. */
export function linkHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}
