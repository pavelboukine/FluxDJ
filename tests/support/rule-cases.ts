/**
 * Shared specifications for rules that both the app (for an early, field-level
 * answer) and the database (the authority) enforce. Each table states the
 * database's answer; tests/unit/rule-parity.test.ts checks the app's
 * functions against it and tests/integration/rule-parity.test.ts checks the
 * real database functions against it, so the two can't drift apart unnoticed
 * (like tests/support/quantity-cases.ts for quantity wording).
 *
 * Where the app is deliberately different, the case says so (`app`) and why.
 * A difference must only ever make the app stricter about what it sends, or
 * more lenient about what it reads back: never accept input the database
 * refuses, never refuse data the database produced.
 */

/**
 * private.is_https_url; app: isHttpsUrl (invoice links, song links) and
 * isPlaylistUrl (up to 1,000 characters). The app also refuses ports above
 * 65535 (`app: false`): the database's pattern allows five digits, but no
 * browser can open such a link.
 */
export const HTTPS_URL_CASES: { value: string; valid: boolean; app?: false }[] = [
  { value: "https://example.com", valid: true },
  { value: "https://example.com/path?x=1#frag", valid: true },
  { value: "https://sub.example.co.uk:8443/a", valid: true },
  { value: "https://1.2.3.4", valid: true },
  { value: "https://123.com", valid: true },
  { value: "https://a.c", valid: true },
  { value: "https://a.com?x", valid: true },
  { value: "https://a.com#x", valid: true },
  { value: "https://EXAMPLE.COM/Path", valid: true },
  { value: "https://a.com/café", valid: true },
  { value: "https://a.com/x'y{z}`%zz", valid: true },
  // Ports: up to five digits in the database; the app also stops at 65535.
  { value: "https://a.com:443/x", valid: true },
  { value: "https://a.com:65535", valid: true },
  { value: "https://a.com:65536/x", valid: true, app: false },
  { value: "https://a.com:99999", valid: true, app: false },
  { value: "https://a.com:123456", valid: false },
  { value: "https://a.com:", valid: false },
  // Only lowercase https://, exactly as typed.
  { value: "http://example.com", valid: false },
  { value: "HTTPS://example.com", valid: false },
  { value: "Https://example.com", valid: false },
  { value: "https:/a.com", valid: false },
  // Host names: dotted labels of letters and digits, inner hyphens only, ASCII only.
  { value: "https://localhost", valid: false },
  { value: "https://-a.com", valid: false },
  { value: "https://a-.com", valid: false },
  { value: "https://a-b.com", valid: true },
  { value: "https://a..com", valid: false },
  { value: "https://a.com.", valid: false },
  { value: "https://a_b.com", valid: false },
  { value: "https://exämple.com", valid: false },
  { value: "https://xn--exmple-cua.com", valid: true },
  // No credentials, whitespace, angle brackets, quotes or backslashes.
  { value: "https://user:pw@a.com", valid: false },
  { value: "https://user@a.com", valid: false },
  { value: " https://a.com", valid: false },
  { value: "https://a.com/x y", valid: false },
  { value: "https://a.com\t", valid: false },
  { value: "https://a.com/x y", valid: false },
  { value: "https://a.com/x y", valid: false },
  { value: "https://a.com/<x>", valid: false },
  { value: 'https://a.com/"x', valid: false },
  { value: "https://a.com/\\x", valid: false },
  // Length: at most 2,000 characters.
  { value: `https://a.com/${"x".repeat(1986)}`, valid: true },
  { value: `https://a.com/${"x".repeat(1987)}`, valid: false },
];

/** private.is_phone; app: isPhone (planning contacts and the day-of phone). */
export const PHONE_CASES: { value: string; valid: boolean }[] = [
  { value: "514 555-0100", valid: true },
  { value: "+1 (514) 555-0100", valid: true },
  { value: "514.555.0100", valid: true },
  { value: "1234567", valid: true },
  { value: "1 2 3 4 5 6 7", valid: true },
  { value: "+12345678901234567890", valid: true },
  { value: "123456", valid: false },
  { value: "123456789012345678901", valid: false },
  { value: "++15145550100", valid: false },
  { value: "+", valid: false },
  { value: "514 555 0100 x2", valid: false },
  { value: "٥١٤٥٥٥٠١٠٠", valid: false },
  { value: "514 555 0100", valid: false },
  { value: "5145550100\n", valid: false },
];

/** private.is_email; app: isEmail (planning contacts and vendors; never verified or contacted). */
export const CONTACT_EMAIL_CASES: { value: string; valid: boolean }[] = [
  { value: "a@b.co", valid: true },
  { value: "name@example.com", valid: true },
  { value: "Ä@b.co", valid: true },
  { value: "a@b.c.", valid: true },
  { value: `${"x".repeat(249)}@b.co`, valid: true },
  { value: `${"x".repeat(250)}@b.co`, valid: false },
  { value: "a@b", valid: false },
  { value: "a b@c.de", valid: false },
  { value: "a b@c.de", valid: false },
  { value: "a\tb@c.de", valid: false },
  { value: "a@@b.c", valid: false },
  { value: "@b.c", valid: false },
  { value: "a@b.", valid: false },
  { value: "a@.b", valid: false },
  { value: "a@b.c\n", valid: false },
];

/**
 * private.is_valid_email (accounts, clients, invitations: stored lowercase and
 * trimmed); app: emailAddress, which trims and lowercases what was typed
 * first, so these values are already in that form. The app is stricter by
 * design (it refuses some unusual addresses the database would store); it
 * must never accept one the database refuses.
 */
export const ACCOUNT_EMAIL_CASES: { value: string; valid: boolean; app?: false }[] = [
  { value: "a@b.co", valid: true },
  { value: "name@example.com", valid: true },
  { value: "a+tag@example.com", valid: true },
  { value: "a_b@example.com", valid: true },
  { value: "a'b@example.com", valid: true },
  { value: "a@b-.com", valid: true },
  { value: "a@123.com", valid: true },
  { value: "a@xn--exmple-cua.com", valid: true },
  { value: `${"x".repeat(300)}@example.com`, valid: true },
  { value: `${"x".repeat(309)}@example.com`, valid: false },
  { value: "a@b", valid: false },
  { value: "x@localhost", valid: false },
  { value: "a b@example.com", valid: false },
  // Stored by the database, refused by the app's stricter address check.
  { value: "a@b.c", valid: true, app: false },
  { value: "ä@example.com", valid: true, app: false },
  { value: "a@exämple.com", valid: true, app: false },
  { value: "a..b@example.com", valid: true, app: false },
  { value: "a@b_c.com", valid: true, app: false },
  { value: '"q"@example.com', valid: true, app: false },
];

/** private.is_valid_key; app: KEY_RE (forms) and KEY_PATTERN (offer snapshots), which must be the same rule. */
export const KEY_CASES: { value: string; valid: boolean }[] = [
  { value: "a", valid: true },
  { value: "standard", valid: true },
  { value: "uplights_4", valid: true },
  { value: `a${"b".repeat(63)}`, valid: true },
  { value: `a${"b".repeat(64)}`, valid: false },
  { value: "", valid: false },
  { value: "4uplights", valid: false },
  { value: "_a", valid: false },
  { value: "Standard", valid: false },
  { value: "a-b", valid: false },
  { value: "a b", valid: false },
  { value: "é", valid: false },
  { value: "a\n", valid: false },
];

/** private.playlist_url_key; app: playlistUrlKey (the same playlist pasted twice). */
export const PLAYLIST_KEY_CASES: { url: string; key: string | null }[] = [
  { url: "https://open.spotify.com/playlist/37i9?si=abc&utm_source=x", key: "open.spotify.com/playlist/37i9" },
  { url: "https://www.youtube.com/watch?v=abc&list=PL1&si=z", key: "youtube.com/watch?v=abc&list=PL1" },
  { url: "https://WWW.Music.Apple.com/ca/playlist/x/", key: "music.apple.com/ca/playlist/x" },
  { url: "https://tidal.com/browse/playlist/1//", key: "tidal.com/browse/playlist/1" },
  { url: "https://soundcloud.com/a/sets/b?utm_medium=x&utm_campaign=y", key: "soundcloud.com/a/sets/b" },
  { url: "https://deezer.com/x?&&a=1&", key: "deezer.com/x?a=1" },
  { url: "https://open.spotify.com/x#frag", key: "open.spotify.com/x" },
  { url: " https://open.spotify.com/x ", key: "open.spotify.com/x" },
  { url: "https://open.spotify.com/x?SI=1&UTM_x=2&Utm_Y=3", key: "open.spotify.com/x" },
  { url: "https://open.spotify.com/x?a=1&si", key: "open.spotify.com/x?a=1" },
  { url: "https://open.spotify.com/x?a=b=c", key: "open.spotify.com/x?a=b=c" },
  { url: "http://open.spotify.com/x", key: null },
  { url: "", key: null },
];

/**
 * A frozen rule's condition against its question: private.is_valid_rule_condition
 * and private.rule_condition_fits_question; app: the offer snapshot schema
 * (its condition shape and conditionFitsQuestion). The app reads frozen
 * offers, so it may be more lenient (`app: true`), never stricter.
 */
const OPTIONS = [{ value: "same_room", label: "Same room" }, { value: "separate_space", label: "Separate space" }, { value: "true", label: "Literally true" }];
type AnswerType = "boolean" | "single_choice" | "multi_choice" | "short_text";
export const RULE_CONDITION_CASES: { label: string; condition: unknown; answerType: AnswerType; fits: boolean; app?: true }[] = [
  { label: "yes", condition: { op: "equals", value: true }, answerType: "boolean", fits: true },
  { label: "no", condition: { op: "equals", value: false }, answerType: "boolean", fits: true },
  { label: "a yes/no question compared to text", condition: { op: "equals", value: "true" }, answerType: "boolean", fits: false },
  { label: "a yes/no question with a list", condition: { op: "in", values: ["same_room"] }, answerType: "boolean", fits: false },
  { label: "one option", condition: { op: "equals", value: "same_room" }, answerType: "single_choice", fits: true },
  { label: "an option named true", condition: { op: "equals", value: "true" }, answerType: "single_choice", fits: true },
  { label: "an unknown option", condition: { op: "equals", value: "nope" }, answerType: "single_choice", fits: false },
  { label: "options are case-sensitive keys", condition: { op: "equals", value: "Same_Room" }, answerType: "single_choice", fits: false },
  { label: "a single-choice question compared to yes", condition: { op: "equals", value: true }, answerType: "single_choice", fits: false },
  { label: "any of the options", condition: { op: "in", values: ["same_room", "separate_space"] }, answerType: "single_choice", fits: true },
  { label: "a list with an unknown option", condition: { op: "in", values: ["same_room", "nope"] }, answerType: "single_choice", fits: false },
  { label: "an empty list", condition: { op: "in", values: [] }, answerType: "single_choice", fits: false },
  { label: "more than 50 options", condition: { op: "in", values: Array.from({ length: 51 }, (_, i) => `k${i}`) }, answerType: "single_choice", fits: false },
  // Never built by the database (rules are checked when saved); reading one back would be harmless.
  { label: "a list naming an option twice", condition: { op: "in", values: ["same_room", "same_room"] }, answerType: "single_choice", fits: false, app: true },
  { label: "a single-choice question with contains", condition: { op: "contains", value: "same_room" }, answerType: "single_choice", fits: false },
  { label: "a multiple-choice option", condition: { op: "contains", value: "same_room" }, answerType: "multi_choice", fits: true },
  { label: "an option named true, chosen", condition: { op: "contains", value: "true" }, answerType: "multi_choice", fits: true },
  { label: "contains compared to yes", condition: { op: "contains", value: true }, answerType: "multi_choice", fits: false },
  { label: "an unknown multiple-choice option", condition: { op: "contains", value: "nope" }, answerType: "multi_choice", fits: false },
  { label: "a multiple-choice question with equals", condition: { op: "equals", value: "same_room" }, answerType: "multi_choice", fits: false },
  { label: "short text never has rules", condition: { op: "equals", value: true }, answerType: "short_text", fits: false },
  { label: "an extra field", condition: { op: "equals", value: true, extra: 1 }, answerType: "boolean", fits: false },
  { label: "no value", condition: { op: "equals" }, answerType: "boolean", fits: false },
  { label: "an unknown operator", condition: { op: "gt", value: 1 }, answerType: "single_choice", fits: false },
  { label: "a list that isn't a list", condition: { op: "in", values: "same_room" }, answerType: "single_choice", fits: false },
  { label: "a number", condition: { op: "equals", value: 1 }, answerType: "boolean", fits: false },
];
export const RULE_CONDITION_OPTIONS = (answerType: AnswerType) => (answerType === "single_choice" || answerType === "multi_choice" ? OPTIONS : []);

/**
 * The proposal discount on a subtotal: private.offer_discount_cents; app:
 * discountCents. Half-up on basis points; a fixed amount never exceeds the
 * subtotal.
 */
type Discount = { type: "percent"; percent_basis_points: number; label: string } | { type: "fixed"; amount_cents: number; label: string };
const pct = (percent_basis_points: number): Discount => ({ type: "percent", percent_basis_points, label: "Discount" });
const fixed = (amount_cents: number): Discount => ({ type: "fixed", amount_cents, label: "Discount" });
export const DISCOUNT_CASES: { subtotal: number; discount: Discount; cents: number }[] = [
  { subtotal: 0, discount: pct(1000), cents: 0 },
  { subtotal: 235_000, discount: pct(1000), cents: 23_500 },
  // Exactly half a cent rounds up; just under rounds down.
  { subtotal: 5, discount: pct(1000), cents: 1 },
  { subtotal: 4, discount: pct(1250), cents: 1 },
  { subtotal: 3, discount: pct(1500), cents: 0 },
  { subtotal: 50, discount: pct(100), cents: 1 },
  { subtotal: 49, discount: pct(100), cents: 0 },
  { subtotal: 1, discount: pct(5000), cents: 1 },
  { subtotal: 1, discount: pct(4999), cents: 0 },
  { subtotal: 99_995, discount: pct(1), cents: 10 },
  { subtotal: 12_345, discount: pct(3333), cents: 4_115 },
  { subtotal: 12_345, discount: pct(6667), cents: 8_230 },
  { subtotal: 151, discount: pct(9999), cents: 151 },
  { subtotal: 100_000_000, discount: pct(10_000), cents: 100_000_000 },
  { subtotal: 999_999_999_999, discount: pct(3333), cents: 333_300_000_000 },
  { subtotal: 200, discount: fixed(200), cents: 200 },
  { subtotal: 199, discount: fixed(200), cents: 199 },
  { subtotal: 0, discount: fixed(1), cents: 0 },
  { subtotal: 100_000_000, discount: fixed(100_000_000), cents: 100_000_000 },
];

/**
 * A draft offer's discount as staff typed it: the app's readDiscount, then the
 * database's private.is_valid_discount on what would be stored. `stored` is
 * what the app produces (or, where the app refuses, the value it would have
 * produced), so both layers are checked on the same limits.
 */
export const DRAFT_DISCOUNT_CASES: { label: string; fields: { kind: string; value: string; label: string }; app: "none" | "ok" | "refused"; stored?: Record<string, unknown>; valid?: boolean }[] = [
  { label: "no discount", fields: { kind: "none", value: "", label: "" }, app: "none" },
  { label: "zero percent is none", fields: { kind: "percent", value: "0", label: "" }, app: "none" },
  { label: "10%", fields: { kind: "percent", value: "10", label: "Wedding Special" }, app: "ok", stored: { type: "percent", percent_basis_points: 1000, label: "Wedding Special" }, valid: true },
  { label: "12.5% without a label", fields: { kind: "percent", value: "12.5", label: "" }, app: "ok", stored: { type: "percent", percent_basis_points: 1250, label: null }, valid: true },
  { label: "100%", fields: { kind: "percent", value: "100", label: "" }, app: "ok", stored: { type: "percent", percent_basis_points: 10_000, label: null }, valid: true },
  { label: "over 100%", fields: { kind: "percent", value: "100.01", label: "" }, app: "refused", stored: { type: "percent", percent_basis_points: 10_001, label: null }, valid: false },
  { label: "three decimals", fields: { kind: "percent", value: "12.345", label: "" }, app: "refused" },
  { label: "a fixed amount", fields: { kind: "fixed", value: "200.00", label: "Courtesy" }, app: "ok", stored: { type: "fixed", amount_cents: 20_000, label: "Courtesy" }, valid: true },
  { label: "the largest fixed amount", fields: { kind: "fixed", value: "1000000", label: "" }, app: "ok", stored: { type: "fixed", amount_cents: 100_000_000, label: null }, valid: true },
  { label: "over the largest fixed amount", fields: { kind: "fixed", value: "1000000.01", label: "" }, app: "refused", stored: { type: "fixed", amount_cents: 100_000_001, label: null }, valid: false },
  { label: "an 80-character label", fields: { kind: "percent", value: "5", label: "x".repeat(80) }, app: "ok", stored: { type: "percent", percent_basis_points: 500, label: "x".repeat(80) }, valid: true },
  { label: "an 81-character label", fields: { kind: "percent", value: "5", label: "x".repeat(81) }, app: "refused", stored: { type: "percent", percent_basis_points: 500, label: "x".repeat(81) }, valid: false },
];

/**
 * Tax settings as the owner submits them: the app's parseTaxSettingsForm, then
 * the database's private.is_valid_tax_config and is_valid_tax_categories (the
 * tenants table's checks) on what would be stored. update_tax_settings checks
 * more (owner, version, taxes in use); pgTAP 19 covers that.
 */
type TaxRow = { label: string; rate: string };
export const TAX_SETTINGS_CASES: {
  label: string;
  rows: TaxRow[];
  categories?: Record<string, "none" | "unset" | number[]>;
  app: "ok" | "refused";
  stored?: { config: unknown; categories: unknown };
  valid?: boolean;
}[] = [
  { label: "two taxes on standard", rows: [{ label: "GST", rate: "5" }, { label: "QST", rate: "9.975" }], categories: { standard: [0, 1], exempt: "none" }, app: "ok", valid: true },
  { label: "a 0% and a 100% rate", rows: [{ label: "Zero", rate: "0" }, { label: "All", rate: "100" }], categories: { standard: [1] }, app: "ok", valid: true },
  { label: "five taxes", rows: [1, 2, 3, 4, 5].map((n) => ({ label: `Tax ${n}`, rate: "1" })), app: "ok", valid: true },
  {
    label: "six taxes",
    rows: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `Tax ${n}`, rate: "1" })),
    app: "refused",
    stored: { config: [1, 2, 3, 4, 5, 6].map((n) => ({ code: `TAX_${n}`, label: `Tax ${n}`, rate_ppm: 10_000 })), categories: {} },
    valid: false,
  },
  { label: "a 40-character name", rows: [{ label: "x".repeat(40), rate: "5" }], app: "ok", valid: true },
  { label: "a 41-character name", rows: [{ label: "x".repeat(41), rate: "5" }], app: "refused", stored: { config: [{ code: "X", label: "x".repeat(41), rate_ppm: 50_000 }], categories: {} }, valid: false },
  { label: "over 100%", rows: [{ label: "Too much", rate: "100.0001" }], app: "refused", stored: { config: [{ code: "TOO_MUCH", label: "Too much", rate_ppm: 1_000_001 }], categories: {} }, valid: false },
  { label: "twenty categories", rows: [{ label: "GST", rate: "5" }], categories: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, [0]])), app: "ok", valid: true },
  {
    label: "twenty-one categories",
    rows: [{ label: "GST", rate: "5" }],
    categories: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i}`, [0]])),
    app: "refused",
    stored: { config: [{ code: "GST", label: "GST", rate_ppm: 50_000 }], categories: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i}`, ["GST"]])) },
    valid: false,
  },
  {
    label: "an invalid category key",
    rows: [{ label: "GST", rate: "5" }],
    categories: { Standard: [0] },
    app: "refused",
    stored: { config: [{ code: "GST", label: "GST", rate_ppm: 50_000 }], categories: { Standard: ["GST"] } },
    valid: false,
  },
];

/** The Settings tax editor's form fields for a case (see parseTaxSettingsForm). */
export function taxForm(c: (typeof TAX_SETTINGS_CASES)[number]): FormData {
  const form = new FormData();
  c.rows.forEach((row, i) => {
    form.append("tax_row", `r${i}`);
    form.append(`tax_code:r${i}`, "");
    form.append(`tax_label:r${i}`, row.label);
    form.append(`tax_rate:r${i}`, row.rate);
  });
  for (const [key, mode] of Object.entries(c.categories ?? {})) {
    form.append("category", key);
    form.append(`category_mode:${key}`, Array.isArray(mode) ? "taxes" : mode);
    if (Array.isArray(mode)) for (const i of mode) form.append(`category_tax:${key}`, `r${i}`);
  }
  return form;
}
