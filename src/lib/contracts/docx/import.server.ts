import "server-only";
import mammoth from "mammoth";
import { scanPlaceholders, type CatalogField } from "../fields";
import { LIMITS, type TemplateSection } from "../template-text";
import { readArchive, ZipError } from "./zip.server";

/**
 * Converts a Word document (.docx) into the existing contract template
 * format: a one-line title and sections of {heading, plain-text body}. It
 * never produces HTML: Mammoth reads the document into its element tree
 * (transformDocument), and this file writes plain text from that tree, so the
 * result is shown only through the existing escaped renderers.
 *
 * Wording is never changed. What can't be represented is reported instead:
 *  - formatting (bold, italic, underline, alignment, page layout) is dropped;
 *  - list numbers are written out as text ("1.", "a."), bullets as "•";
 *  - tables become one line per row, cells separated by " | ";
 *  - links keep their text, followed by the web address in brackets;
 *  - footnotes and endnotes go into a final "Notes" section.
 * A separate pass lists every piece of text in the file (body, notes,
 * headers, footers, comments) and compares it with the result, so text the
 * converter missed is reported rather than silently lost.
 *
 * Refused: files that aren't .docx (old .doc, macro-enabled .docm, encrypted
 * or damaged files), archives over the size limits, and documents with
 * tracked changes (which text is "accepted" can't be decided here). Nothing
 * is fetched (Mammoth's external file access stays off) and nothing is
 * stored: the bytes live only in memory for the request.
 */

export const MAX_DOCX_BYTES = 4 * 1024 * 1024;

export type ImportIssue = {
  id: string;
  /** blocking: can't create a draft; review: must be acknowledged; info: shown. */
  level: "blocking" | "review" | "info";
  title: string;
  detail: string;
  items?: string[];
};

export type ImportResult =
  | { ok: false; error: string }
  | {
      ok: true;
      title: string;
      sections: TemplateSection[];
      /** Indexes of sections whose heading the importer added (the document had none there). */
      addedHeadings: number[];
      /** Text outside the converted body (headers, footers) that can be added as a final section. */
      extraSection: TemplateSection | null;
      stats: { sections: number; paragraphs: number; listItems: number; numberedItems: number; tables: number; images: number; pageBreaks: number };
      issues: ImportIssue[];
    };

const WORD_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

// ---------------------------------------------------------------------------
// XML text inventory (independent of the converter)
// ---------------------------------------------------------------------------

const decode = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (_, d, h, n) =>
    d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[n.toLowerCase()],
  );

/** The visible text of each paragraph in a WordprocessingML part (deleted text and field codes excluded). */
export function paragraphTexts(xml: string): string[] {
  return xml
    .split(/<\/w:p>/)
    .map((chunk) => [...chunk.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decode(m[1])).join(""))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const squash = (s: string) => s.normalize("NFC").replace(/[\s ​-‍﻿]+/g, "").toLowerCase();

// ---------------------------------------------------------------------------
// Converting Mammoth's element tree to plain text
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- Mammoth's element tree is untyped. */
type El = any;

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "text"; text: string; list: boolean }
  | { type: "table"; lines: string[]; skippedRows: number; label: string };

type Counters = {
  paragraphs: number;
  listItems: number;
  numberedItems: number;
  tables: number;
  images: number;
  pageBreaks: number;
  bold: number;
  italic: number;
  underline: number;
  strike: number;
  comments: number;
  otherLinks: number;
  notes: { type: string; id: string; n: number }[];
};

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];
const marker = (ordered: boolean, level: number, n: number) =>
  !ordered
    ? ["•", "◦", "▪"][Math.min(level, 2)]
    : level === 1
      ? `${String.fromCharCode(96 + (((n - 1) % 26) + 1))}.`
      : level === 2
        ? `${ROMAN[n - 1] ?? n}.`
        : `${n}.`;

function inlineText(children: El[], c: Counters, caps = false): string {
  let out = "";
  for (const el of children ?? []) {
    switch (el.type) {
      case "text":
        out += caps ? el.value.toUpperCase() : el.value;
        break;
      case "tab":
        out += " ";
        break;
      case "break":
        if (el.breakType === "line") out += "\n";
        else c.pageBreaks += el.breakType === "page" ? 1 : 0;
        break;
      case "run": {
        const t = inlineText(el.children, c, caps || el.isAllCaps);
        if (t.trim()) {
          if (el.isBold) c.bold++;
          if (el.isItalic) c.italic++;
          if (el.isUnderline) c.underline++;
          if (el.isStrikethrough) c.strike++;
        }
        out += t;
        break;
      }
      case "hyperlink": {
        const t = inlineText(el.children, c, caps);
        const href = typeof el.href === "string" ? el.href.trim() : "";
        if (href && /^(https?:|mailto:)/i.test(href)) {
          const shown = href.replace(/^mailto:/i, "");
          out += t.trim() && squash(t) !== squash(shown) && squash(t) !== squash(href) ? `${t} (${shown})` : t || shown;
        } else {
          if (href) c.otherLinks++;
          out += t;
        }
        break;
      }
      case "noteReference": {
        let note = c.notes.find((x) => x.type === el.noteType && x.id === el.noteId);
        if (!note) {
          note = { type: el.noteType, id: el.noteId, n: c.notes.length + 1 };
          c.notes.push(note);
        }
        out += `[${note.n}]`;
        break;
      }
      case "checkbox":
        out += el.checked ? "☒" : "☐";
        break;
      case "image":
        c.images++;
        break;
      case "commentReference":
        c.comments++;
        break;
      default:
        if (Array.isArray(el.children)) out += inlineText(el.children, c, caps);
    }
  }
  return out;
}

/** Plain text as stored: no zero-width or soft-hyphen characters, non-breaking spaces as spaces, no trailing spaces. */
function clean(text: string): string {
  return text
    .replace(/[​-‍﻿­]/g, "")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function headingLevel(p: El): number | null {
  const style = String(p.styleName ?? p.styleId ?? "");
  if (/^title$/i.test(style)) return 0;
  const m = /^heading\s*([1-9])$/i.exec(style);
  return m ? Number(m[1]) : null;
}

function toBlocks(children: El[], c: Counters): Block[] {
  const blocks: Block[] = [];
  const counters: number[] = [];
  let lastText = "";
  for (const el of children) {
    if (el.type === "paragraph") {
      const text = clean(inlineText(el.children, c));
      if (!text.trim()) continue;
      const level = headingLevel(el);
      if (el.numbering) {
        const lvl = Number(el.numbering.level) || 0;
        counters.length = lvl + 1;
        counters[lvl] = (counters[lvl] ?? 0) + 1;
        const ordered = !!el.numbering.isOrdered;
        c.listItems++;
        if (ordered) c.numberedItems++;
        blocks.push({ type: "text", text: `${marker(ordered, lvl, counters[lvl])} ${text}`, list: true });
      } else {
        counters.length = 0;
        c.paragraphs++;
        blocks.push(level !== null && !text.includes("\n") && text.length <= LIMITS.heading ? { type: "heading", level, text } : { type: "text", text, list: false });
      }
      lastText = text;
    } else if (el.type === "table") {
      counters.length = 0;
      c.tables++;
      const lines: string[] = [];
      let skipped = 0;
      for (const row of el.children ?? []) {
        if (row.type !== "tableRow") continue;
        const cells = (row.children ?? []).map((cell: El) =>
          toBlocks(cell.children ?? [], c)
            .map((b) => (b.type === "table" ? b.lines.join("; ") : b.text))
            .join("; ")
            .replace(/\n/g, " "),
        );
        if (cells.every((t: string) => !t.trim())) skipped++;
        else lines.push(cells.join(" | ").trim());
      }
      blocks.push({ type: "table", lines, skippedRows: skipped, label: lastText.split("\n")[0].slice(0, 80) });
    } else if (Array.isArray(el.children)) {
      blocks.push(...toBlocks(el.children, c));
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** A body line can't start with "## " (it once marked a section): a non-breaking space keeps the text visibly the same. */
const safeLines = (text: string) => text.replace(/(^|\n)## /g, "$1## ");

function toSections(blocks: Block[]) {
  let title = "";
  let titleFromParagraph = false;
  let i = 0;
  const first = blocks[0];
  // The first heading is the title only when no later heading is at its level or above (otherwise it's a section).
  const titleHeading = first?.type === "heading" && !blocks.slice(1).some((b) => b.type === "heading" && b.level <= first.level);
  if (first?.type === "heading" && titleHeading && first.text.length <= LIMITS.title) {
    title = first.text;
    i = 1;
  } else if (first?.type === "text" && !first.list && !first.text.includes("\n") && first.text.length <= 120) {
    title = first.text;
    titleFromParagraph = true;
    i = 1;
  }

  type Draft = { heading: string; added: boolean; parts: string[] };
  const drafts: Draft[] = [];
  let mergedHeadings = 0;
  for (; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "heading") {
      const next = blocks[i + 1];
      if (!next || next.type === "heading") {
        // A heading with no text of its own (a group heading, or the last line): kept as a line where it was.
        mergedHeadings++;
        if (drafts.length === 0) drafts.push({ heading: "Introduction", added: true, parts: [] });
        drafts[drafts.length - 1].parts.push(b.text);
        continue;
      }
      drafts.push({ heading: b.text, added: false, parts: [] });
      continue;
    }
    if (drafts.length === 0) drafts.push({ heading: "Introduction", added: true, parts: [] });
    const text = b.type === "table" ? b.lines.join("\n") : b.text;
    if (!text.trim()) continue;
    const parts = drafts[drafts.length - 1].parts;
    // List items and table rows stay on consecutive lines; paragraphs are separated by a blank line.
    const prev = blocks[i - 1];
    if (b.type === "text" && b.list && prev?.type === "text" && prev.list && parts.length) parts[parts.length - 1] += `\n${text}`;
    else parts.push(text);
  }

  // Long sections are split at paragraph boundaries ("(continued)"), never inside a paragraph.
  const sections: TemplateSection[] = [];
  const added: number[] = [];
  let splitSections = 0;
  let oversized = false;
  for (const d of drafts) {
    const chunks: string[][] = [[]];
    let size = 0;
    for (const part of d.parts) {
      if (part.length > LIMITS.body) oversized = true;
      if (size && size + part.length + 2 > LIMITS.body) {
        chunks.push([]);
        size = 0;
      }
      chunks[chunks.length - 1].push(part);
      size += part.length + 2;
    }
    if (chunks.length > 1) splitSections++;
    chunks.forEach((chunk, n) => {
      if (d.added && n === 0) added.push(sections.length);
      const heading = n === 0 ? d.heading : `${d.heading} (continued)`.slice(0, LIMITS.heading);
      sections.push({ heading, body: safeLines(chunk.join("\n\n")) });
    });
  }
  return { title, titleFromParagraph, sections: sections.filter((s) => s.body.trim()), added, mergedHeadings, splitSections, oversized };
}

// ---------------------------------------------------------------------------
// Blanks, fields and content Flux already adds
// ---------------------------------------------------------------------------

const SUGGEST: Record<string, string> = {
  "client": "client.name",
  "client name": "client.name",
  "name of client": "client.name",
  "client email": "client.email",
  "client phone": "client.phone",
  "event": "event.title",
  "event name": "event.title",
  "event title": "event.title",
  "event date": "event.date",
  "venue": "venue.name",
  "venue name": "venue.name",
  "location": "venue.name",
  "venue address": "venue.address",
  "total": "pricing.total",
  "total fee": "pricing.total",
  "total price": "pricing.total",
  "grand total": "pricing.total",
  "deposit": "payment.deposit",
  "final payment": "payment.balance",
  "balance": "payment.balance",
  "remaining balance": "payment.balance",
  "balance due date": "payment.balance_due_date",
};

/** A label of up to five words (single spaces) right before ": ___". */
const LABELLED_BLANK = /(\[[^\]\n]{1,40}\]|[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ&'/()-]*(?: [A-Za-zÀ-ÿ&'/()-]+){0,4})\s*:\s*_{3,}/g;

function blanks(sections: TemplateSection[], labels: Map<string, string>, mergeFields: string[]): string[] {
  const found: string[] = [];
  const field = (key: string) => ` could be the field ${labels.get(key) ?? key} ({{${key}}})`;
  for (const s of sections) {
    const where = s.heading.replace(/:$/, "");
    const lines = s.body.split("\n");
    const eventContext = lines.some((l) => /^\W*event\s*:/i.test(l));
    for (const line of lines) {
      for (const m of line.matchAll(LABELLED_BLANK)) {
        const label = m[1].replace(/\s*\(.*\)$/, "").trim();
        const plain = label.replace(/^\[|\]$/g, "").toLowerCase();
        const key = SUGGEST[plain] ?? (plain === "date" && eventContext ? "event.date" : undefined);
        found.push(`${where} — “${label}: ___”${key ? field(key) : plain === "start time" ? " (no field for the start time yet: fill it in yourself)" : ""}`);
      }
      const bare = line.replace(LABELLED_BLANK, "");
      if (/_{3,}/.test(bare)) found.push(`${where} — a blank: “${line.trim().length > 70 ? `${line.trim().slice(0, 70)}…` : line.trim()}”`);
    }
  }
  for (const f of mergeFields) found.push(`Word mail-merge field «${f}» (its current text was imported)`);
  return [...new Set(found)];
}

type Business = { legalName: string | null; displayName: string | null; email: string | null; address: string | null };

function fluxDuplicates(sections: TemplateSection[], images: number, business: Business): string[] {
  const out: string[] = [];
  const where = (test: (s: TemplateSection) => boolean) => sections.filter(test).map((s) => `“${s.heading}”`).join(", ");
  const has = (needle: string | null, s: TemplateSection) => !!needle && needle.trim().length > 3 && s.body.toLowerCase().includes(needle.trim().toLowerCase());
  const parties = where((s) => /by and between|\(\s*["“]?client["”]?\s*\)|service provider/i.test(s.body) || has(business.legalName, s) || has(business.email, s) || has(business.address, s));
  if (parties) out.push(`Parties and contact details (in ${parties}): every issued contract PDF starts with the parties: your business and the client who signs.`);
  const event = where((s) => s.body.split("\n").filter((l) => /^\W*(event|date|venue|start time|location)\s*:/i.test(l)).length >= 2);
  if (event) out.push(`Event details (in ${event}): the PDF adds the event's title, date and venue.`);
  const pricing = where((s) => /grand total|total fee|unit price|price \(|\| *quantity/i.test(s.body));
  if (pricing) out.push(`Equipment and price breakdown (in ${pricing}): the PDF adds the approved items, prices, taxes and total.`);
  const payment = where((s) => /^\W*(deposit|final payment|balance)\b[^\n]*_{3,}/im.test(s.body));
  if (payment) out.push(`Deposit and balance amounts (in ${payment}): the PDF shows the deposit and balance. Keep any payment terms that still apply (due dates, payment methods, refunds).`);
  const signatures = where((s) => /signature|signing below/i.test(s.body + s.heading));
  if (signatures) out.push(`Signature lines (in ${signatures}): clients sign online, and the PDF adds their signature and a signing record. Flux doesn't add a DJ signature.`);
  if (images > 0) out.push(`Logo and images: not imported. The contract shows your business name; images aren't part of the agreement text.`);
  return out;
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

export async function importDocx(bytes: Buffer, catalog: CatalogField[], business: Business): Promise<ImportResult> {
  if (bytes.length === 0) return { ok: false, error: "The file is empty." };
  if (bytes.length > MAX_DOCX_BYTES) return { ok: false, error: "The file is larger than 4 MB. Remove large images from the document (they aren't imported anyway) and try again." };
  if (bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    return { ok: false, error: "This file is password-protected or an old Word format (.doc). Open it in Word, remove the password if it has one, save it as a Word document (.docx) and upload that." };
  }
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return { ok: false, error: "This isn't a Word document (.docx)." };

  let files: Map<string, Buffer>;
  try {
    files = readArchive(bytes);
  } catch (e) {
    return { ok: false, error: e instanceof ZipError && /large|entries/.test(e.message) ? "This document is too large or complex to import." : "This file is damaged or isn't a Word document (.docx)." };
  }
  const types = files.get("[Content_Types].xml")?.toString("utf8") ?? "";
  if (/macroEnabled/i.test(types) || [...files.keys()].some((n) => /vbaProject\.bin$/i.test(n))) {
    return { ok: false, error: "This document contains macros (.docm). Save it as a regular Word document (.docx) and upload that." };
  }
  if (!types.includes(WORD_MAIN) || !files.has("word/document.xml")) {
    return { ok: false, error: "This isn't a Word document (.docx). Templates (.dotx) and other formats can't be imported; save it as a .docx first." };
  }
  const documentXml = files.get("word/document.xml")!.toString("utf8");
  const notesXml = ["word/footnotes.xml", "word/endnotes.xml"].map((n) => files.get(n)?.toString("utf8") ?? "").join("");
  if (/<w:(ins|del|moveFrom|moveTo)[\s>]/.test(documentXml + notesXml)) {
    return { ok: false, error: "This document has tracked changes. In Word, accept or reject all changes (Review › Accept all changes, or Reject), save, and upload it again." };
  }

  // Convert. The HTML Mammoth also produces is discarded unused; only the element tree is read.
  let tree: El = null;
  let messages: { type: string; message: string }[] = [];
  try {
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
        transformDocument: (doc: El) => {
          tree = doc;
          return doc;
        },
      },
    );
    messages = result.messages;
  } catch {
    return { ok: false, error: "This document couldn't be read. Open it in Word, save it again as a .docx, and try once more." };
  }
  if (!tree) return { ok: false, error: "This document couldn't be read." };

  const counters: Counters = { paragraphs: 0, listItems: 0, numberedItems: 0, tables: 0, images: 0, pageBreaks: 0, bold: 0, italic: 0, underline: 0, strike: 0, comments: 0, otherLinks: 0, notes: [] };
  const blocks = toBlocks((tree as El).children ?? [], counters);
  const built = toSections(blocks);
  const sections = built.sections;

  // Footnotes and endnotes, in reference order.
  if (counters.notes.length) {
    const notes = (tree as El).notes;
    const lines = counters.notes.map((ref) => {
      const note = notes?.findNoteByKey?.(`${ref.type}-${ref.id}`);
      const text = note ? clean(toBlocks(note.body ?? [], counters).map((b) => (b.type === "table" ? b.lines.join("\n") : b.text)).join("\n")) : "";
      return `[${ref.n}] ${text}`.trim();
    });
    sections.push({ heading: "Notes", body: safeLines(lines.join("\n")) });
  }

  if (!built.title && sections.length === 0) return { ok: false, error: "No text was found in this document." };
  const title = built.title || "Agreement";

  const issues: ImportIssue[] = [];
  const issue = (i: ImportIssue) => issues.push(i);
  const catalogKeys = new Set(catalog.map((f) => f.key));
  const labels = new Map(catalog.map((f) => [f.key, f.label]));

  if (sections.length === 0) {
    issue({ id: "empty", level: "blocking", title: "Nothing to import below the title", detail: "The document has a title but no text. Add the agreement's text in Word and upload it again." });
  }
  if (sections.length > LIMITS.sections) {
    issue({ id: "too-many", level: "blocking", title: `More than ${LIMITS.sections} sections`, detail: `The converted document has ${sections.length} sections; a contract template can have at most ${LIMITS.sections}. Combine some headings in Word, or split the agreement into two templates.` });
  }
  if (built.oversized) {
    issue({ id: "oversized", level: "blocking", title: "A paragraph is too long", detail: `One paragraph is longer than ${LIMITS.body.toLocaleString("en-CA")} characters, the most a section can hold. Split it in Word and upload again.` });
  }

  // Fields already written as {{…}}.
  const scan = scanPlaceholders([title, ...sections.flatMap((s) => [s.heading, s.body])].join("\n"), catalogKeys);
  if (scan.unknown.length || scan.malformed.length) {
    issue({
      id: "unknown-fields",
      level: "blocking",
      title: "Text that looks like a field but isn't one",
      detail: "Only Flux's own fields can be written in double braces. Change or remove these in Word, then upload again.",
      items: [...scan.unknown.map((k) => `{{${k}}}`), ...scan.malformed.map((m) => `“${m}”`)],
    });
  }
  if (scan.known.length) {
    issue({
      id: "fields",
      level: "review",
      title: "Fields found in the document",
      detail: "These are filled in automatically when a contract is generated, and each must have a value then. Confirm you want them as fields.",
      items: scan.known.map((k) => `${labels.get(k) ?? k} ({{${k}}})`),
    });
  }

  // Completeness: every paragraph of text in the converted parts should appear in the result.
  const output = squash([title, ...sections.flatMap((s) => [s.heading, s.body])].join(""));
  const missing = [...paragraphTexts(documentXml), ...paragraphTexts(notesXml)].filter((t) => !output.includes(squash(t)));
  if (missing.length) {
    issue({
      id: "missing",
      level: "review",
      title: "Text that may not have been imported",
      detail: "This text is in the document but couldn't be found in the result. Add it in the editor where it belongs, or confirm it isn't needed.",
      items: missing.slice(0, 30).map((t) => t.slice(0, 200)),
    });
  }

  // Text outside the body.
  const outside = [...files.keys()]
    .filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))
    .sort()
    .flatMap((n) => paragraphTexts(files.get(n)!.toString("utf8")).map((t) => ({ where: n.includes("header") ? "Header" : "Footer", text: t })));
  const uniqueOutside = [...new Map(outside.map((o) => [`${o.where}|${o.text}`, o])).values()];
  const extraSection = uniqueOutside.length
    ? { heading: "Header and footer text", body: safeLines(uniqueOutside.map((o) => `${o.where}: ${o.text}`).join("\n")) }
    : null;
  if (uniqueOutside.length) {
    issue({
      id: "header-footer",
      level: "review",
      title: "Header and footer text isn't part of the converted sections",
      detail: "Contracts in Flux have no page headers or footers. You can add this text as a final section, or confirm it isn't needed.",
      items: uniqueOutside.map((o) => `${o.where}: ${o.text}`),
    });
  }
  const comments = paragraphTexts(files.get("word/comments.xml")?.toString("utf8") ?? "");
  if (comments.length) {
    issue({ id: "comments", level: "review", title: "Comments aren't imported", detail: "Word comments are notes, not agreement text. Confirm none of them belongs in the contract.", items: comments.slice(0, 20) });
  }

  // Converted structures.
  if (counters.numberedItems) {
    issue({
      id: "numbering",
      level: "review",
      title: `${counters.numberedItems} numbered list item${counters.numberedItems === 1 ? "" : "s"}: numbers written out by Flux`,
      detail: "Word calculates list numbers; Flux writes them into the text (1., 2., a., i.). Check them against your document, especially any clause that refers to another by number.",
    });
  }
  const tables = blocks.filter((b): b is Extract<Block, { type: "table" }> => b.type === "table");
  if (tables.length) {
    issue({
      id: "tables",
      level: "review",
      title: `${tables.length} table${tables.length === 1 ? "" : "s"} converted to text`,
      detail: "Each row became one line with its cells separated by “ | ”. Check that the text reads correctly.",
      items: tables.map((t) => `${t.label ? `After “${t.label}”: ` : ""}${t.lines.length} row${t.lines.length === 1 ? "" : "s"} with text${t.skippedRows ? `, ${t.skippedRows} empty row${t.skippedRows === 1 ? "" : "s"} left out` : ""}`),
    });
  }
  if (/<w:txbxContent/.test(documentXml)) {
    issue({ id: "text-boxes", level: "review", title: "Text boxes", detail: "Text in text boxes was imported where Word anchors it, which may not be where it appears on the page. Check its position." });
  }
  if (/<w:sdt[\s>]|<w:ffData/.test(documentXml)) {
    issue({ id: "form-fields", level: "review", title: "Form fields and content controls", detail: "Their current text was imported as ordinary text. Check that nothing is missing." });
  }
  if (/<w:object[\s>]/.test(documentXml) || [...files.keys()].some((n) => n.startsWith("word/embeddings/"))) {
    issue({ id: "embedded", level: "review", title: "Embedded objects aren't imported", detail: "The document embeds other files or objects (for example a spreadsheet). Their content isn't imported; add anything important as text." });
  }
  if (/<w:r[\s>](?:(?!<\/w:r>)[\s\S])*?<w:vanish\/>/.test(documentXml)) {
    issue({ id: "hidden", level: "review", title: "Hidden text was imported", detail: "Some text is hidden in Word. It was imported and will be visible to clients. Remove it in the editor if it isn't part of the agreement." });
  }
  const odd = [...new Set([...sections.flatMap((s) => [s.heading, s.body]).join("")].filter((ch) => /[-�]/.test(ch)))];
  if (odd.length) {
    issue({ id: "symbols", level: "review", title: "Unusual symbols", detail: "Some characters come from a special Word font and may show as empty boxes. Replace them in the editor.", items: odd.map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`) });
  }
  const unrecognised = messages.filter((m) => /unrecognised element|unrecognized element/i.test(m.message)).length;
  if (unrecognised) {
    issue({ id: "unrecognised", level: "review", title: "Parts of the document weren't recognised", detail: `${unrecognised} part${unrecognised === 1 ? "" : "s"} of the document couldn't be read. Compare the result with your document.` });
  }
  if (built.splitSections) {
    issue({ id: "split", level: "info", title: "Long sections were split", detail: `${built.splitSections} section${built.splitSections === 1 ? " was" : "s were"} longer than ${LIMITS.body.toLocaleString("en-CA")} characters and continue in a section marked “(continued)”.` });
  }
  if (built.added.length) {
    issue({ id: "added-headings", level: "info", title: "Headings added", detail: "Text before the first heading was put under “Introduction”. Rename it in the editor if you like." });
  }
  if (built.mergedHeadings) {
    issue({ id: "group-headings", level: "info", title: "Headings without text of their own", detail: "Headings followed directly by another heading (like “Terms and Conditions”) were kept as a line in the text, in their original place." });
  }
  if (!built.title) {
    issue({ id: "no-title", level: "review", title: "No title found", detail: "The document doesn't start with a title, so the contract is titled “Agreement”. Change it in the editor." });
  }
  if (built.titleFromParagraph) {
    issue({ id: "title", level: "info", title: "Title", detail: "The document has no title style, so its first line was used as the contract title." });
  }
  if (counters.notes.length) {
    issue({ id: "notes", level: "info", title: "Footnotes and endnotes", detail: "They're numbered in the text ([1]) and listed in a final “Notes” section." });
  }

  const lost = [
    counters.bold && "bold",
    counters.italic && "italic",
    counters.underline && "underlining",
    counters.strike && "strikethrough",
  ].filter(Boolean) as string[];
  issue({
    id: "formatting",
    level: "info",
    title: "Formatting isn't kept",
    detail: `Contracts in Flux are plain text, so ${lost.length ? `${lost.join(", ")}, ` : ""}fonts, sizes, colours, alignment, columns and page layout aren't imported. The wording is kept exactly.${counters.pageBreaks ? " Page breaks were left out; the PDF flows onto pages by itself." : ""}${counters.otherLinks ? " Links to places inside the document were kept as plain text." : ""}`,
  });

  const fieldBlanks = blanks(sections, labels, [...new Set([...documentXml.matchAll(/MERGEFIELD\s+"?([^"\\\s<]+)/g)].map((m) => decode(m[1])))]);
  if (fieldBlanks.length) {
    issue({
      id: "blanks",
      level: "info",
      title: "Blanks to fill in",
      detail: "These look like spaces to fill in by hand. Nothing was replaced: in the editor, put a field where one fits (Insert field), or keep the line.",
      items: fieldBlanks,
    });
  }
  const dupes = fluxDuplicates(sections, counters.images, business);
  if (dupes.length) {
    issue({
      id: "duplicates",
      level: "info",
      title: "Parts Flux already adds to every contract",
      detail: "Nothing was removed. If you keep these, the contract shows them twice; remove or shorten them in the editor if you like.",
      items: dupes,
    });
  }

  return {
    ok: true,
    title: title.slice(0, LIMITS.title),
    sections,
    addedHeadings: built.added,
    extraSection,
    stats: {
      sections: sections.length,
      paragraphs: counters.paragraphs,
      listItems: counters.listItems,
      numberedItems: counters.numberedItems,
      tables: counters.tables,
      images: counters.images,
      pageBreaks: counters.pageBreaks,
    },
    issues,
  };
}
