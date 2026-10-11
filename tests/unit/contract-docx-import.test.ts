import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importDocx, MAX_DOCX_BYTES, type ImportResult } from "@/lib/contracts/docx/import.server";
import { listEntries, readArchive, ZIP_LIMITS } from "@/lib/contracts/docx/zip.server";
import { docx, p, table, zip } from "../support/docx";

const CATALOG = [
  { key: "client.name", label: "Client name", description: "" },
  { key: "event.title", label: "Event title", description: "" },
  { key: "event.date", label: "Event date", description: "" },
  { key: "venue.name", label: "Venue name", description: "" },
  { key: "pricing.total", label: "Total", description: "" },
  { key: "payment.deposit", label: "Deposit", description: "" },
  { key: "payment.balance", label: "Balance", description: "" },
];
const BUSINESS = { legalName: "Example DJ Inc.", displayName: "Example DJ", email: "hello@example.com", address: null };
const run = (bytes: Buffer) => importDocx(bytes, CATALOG, BUSINESS);
const ok = (r: ImportResult) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};
const issue = (r: ImportResult, id: string) => (r.ok ? r.issues.find((i) => i.id === id) : undefined);

describe("Word import: conversion", () => {
  it("turns the title, headings, paragraphs and line breaks into sections, keeping the wording", async () => {
    const r = ok(await run(docx([
      p("Service Agreement", { style: "Title" }),
      p("Between the parties named below."),
      p("1. Payment", { style: "Heading1" }),
      p("The deposit is due on signing.\nThe balance is due on the day."),
      p("A second paragraph."),
      p("2. Cancellation", { style: "Heading1" }),
      p("Cancelling within 30 days: the balance is due. Accents: déjà vu, Ça va."),
    ].join(""))));
    expect(r.title).toBe("Service Agreement");
    expect(r.sections).toEqual([
      { heading: "Introduction", body: "Between the parties named below." },
      { heading: "1. Payment", body: "The deposit is due on signing.\nThe balance is due on the day.\n\nA second paragraph." },
      { heading: "2. Cancellation", body: "Cancelling within 30 days: the balance is due. Accents: déjà vu, Ça va." },
    ]);
    expect(r.addedHeadings).toEqual([0]);
    expect(issue(r, "missing")).toBeUndefined();
  });

  it("writes list numbers and bullets out as text, nested levels included, and flags the numbering", async () => {
    const r = ok(await run(docx([
      p("Terms", { style: "Heading1" }),
      p("First", { list: { num: 1 } }),
      p("Second", { list: { num: 1 } }),
      p("Detail", { list: { num: 1, level: 1 } }),
      p("Third", { list: { num: 1 } }),
      p("Between lists."),
      p("A point", { list: { num: 2 } }),
      p("A sub-point", { list: { num: 2, level: 1 } }),
    ].join(""))));
    expect(r.sections[0].body).toBe("1. First\n2. Second\na. Detail\n3. Third\n\nBetween lists.\n\n• A point\n◦ A sub-point");
    expect(issue(r, "numbering")).toMatchObject({ level: "review", title: "4 numbered list items: numbers written out by Flux" });
  });

  it("converts tables to one line per row, leaves empty rows out and flags the table", async () => {
    const r = ok(await run(docx([
      p("Price", { style: "Heading1" }),
      p("Equipment:"),
      table([["Item", "Price"], ["Speakers", "500"], ["", ""], ["Total", "$"]]),
    ].join(""))));
    expect(r.sections[0].body).toBe("Equipment:\n\nItem | Price\nSpeakers | 500\nTotal | $");
    expect(issue(r, "tables")).toMatchObject({ level: "review", items: ["After “Equipment:”: 3 rows with text, 1 empty row left out"] });
  });

  it("keeps link text with its web address", async () => {
    const link = `<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>our terms</w:t></w:r></w:hyperlink></w:p>`;
    const r = ok(await run(docx(p("Links", { style: "Heading1" }) + link)));
    expect(r.sections[0].body).toBe("See our terms (https://example.com/terms)");
  });

  it("keeps a heading with no text of its own as a line where it was, and gives text before any heading a heading", async () => {
    const r = ok(await run(docx([
      p("Agreement", { style: "Title" }),
      p("Opening words."),
      p("Terms and Conditions", { style: "Heading2" }),
      p("1. Setup", { style: "Heading3" }),
      p("Setup text."),
    ].join(""))));
    expect(r.sections).toEqual([
      { heading: "Introduction", body: "Opening words.\n\nTerms and Conditions" },
      { heading: "1. Setup", body: "Setup text." },
    ]);
    expect(issue(r, "group-headings")?.level).toBe("info");
  });

  it("uses the first line as the title when there's no title style, and says so", async () => {
    const r = ok(await run(docx([p("DJ SERVICES CONTRACT", { bold: true }), p("Parties", { style: "Heading1" }), p("Text.")].join(""))));
    expect(r.title).toBe("DJ SERVICES CONTRACT");
    expect(issue(r, "title")?.level).toBe("info");
  });

  it("never lets a body line start with “## ” (a non-breaking space keeps it looking the same)", async () => {
    const r = ok(await run(docx(p("A", { style: "Heading1" }) + p("## not a heading"))));
    expect(r.sections[0].body).toBe("## not a heading");
  });
});

describe("Word import: fields, blanks and parts Flux already adds", () => {
  it("lists known fields for confirmation and blocks unknown ones", async () => {
    const known = ok(await run(docx(p("A", { style: "Heading1" }) + p("Dear {{client.name}}, total {{ pricing.total }}."))));
    expect(issue(known, "fields")).toMatchObject({ level: "review", items: ["Client name ({{client.name}})", "Total ({{pricing.total}})"] });
    const unknown = ok(await run(docx(p("A", { style: "Heading1" }) + p("Dear {{client.nickname}} and {{Client Name}}."))));
    expect(issue(unknown, "unknown-fields")).toMatchObject({ level: "blocking", items: ["{{client.nickname}}", "“{{Client Name}}”"] });
  });

  it("suggests fields for labelled blanks without replacing anything", async () => {
    const r = ok(await run(docx([
      p("Event Details", { style: "Heading1" }),
      p("Event: ________", { list: { num: 2 } }),
      p("Date: ________", { list: { num: 2 } }),
      p("Start Time: ________", { list: { num: 2 } }),
      p("Total Fee: ______", { list: { num: 2 } }),
      p("Signatures", { style: "Heading1" }),
      p("[Client Name]: __________ Date: ______"),
    ].join(""))));
    const items = issue(r, "blanks")!.items!;
    expect(items).toEqual([
      "Event Details — “Event: ___” could be the field Event title ({{event.title}})",
      "Event Details — “Date: ___” could be the field Event date ({{event.date}})",
      "Event Details — “Start Time: ___” (no field for the start time yet: fill it in yourself)",
      "Event Details — “Total Fee: ___” could be the field Total ({{pricing.total}})",
      "Signatures — “[Client Name]: ___” could be the field Client name ({{client.name}})",
      // A signature-line date isn't the event date.
      "Signatures — “Date: ___”",
    ]);
    expect(r.sections[0].body).toContain("• Event: ________");
  });

  it("points out parties, event details, prices and signature lines that Flux already adds", async () => {
    const r = ok(await run(docx([
      p("Contract", { style: "Title" }),
      p("Made by and between Example DJ Inc. and the Client."),
      p("Event: ____"),
      p("Venue: ____"),
      table([["Item", "Quantity"], ["Grand Total", "$"]]),
      p("Signatures", { style: "Heading1" }),
      p("By signing below, both parties agree."),
    ].join(""))));
    const items = issue(r, "duplicates")!.items!.join("\n");
    expect(items).toMatch(/Parties and contact details \(in “Introduction”\)/);
    expect(items).toMatch(/Event details \(in “Introduction”\)/);
    expect(items).toMatch(/Equipment and price breakdown/);
    expect(items).toMatch(/Signature lines \(in “Signatures”\)/);
    // Nothing is removed.
    expect(r.sections[0].body).toContain("Made by and between Example DJ Inc. and the Client.");
  });
});

describe("Word import: content outside the converted text", () => {
  it("reports header, footer and comment text instead of dropping it, and offers it as a section", async () => {
    const hdr = (t: string) => `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p(t)}</w:hdr>`;
    const r = ok(await run(docx(p("A", { style: "Heading1" }) + p("Body."), {
      "word/header1.xml": hdr("Confidential"),
      "word/footer1.xml": hdr("Page footer text").replace(/w:hdr/g, "w:ftr"),
      "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0">${p("Check this clause")}</w:comment></w:comments>`,
    })));
    expect(issue(r, "header-footer")).toMatchObject({ level: "review", items: ["Footer: Page footer text", "Header: Confidential"] });
    expect(r.extraSection).toEqual({ heading: "Header and footer text", body: "Footer: Page footer text\nHeader: Confidential" });
    expect(issue(r, "comments")).toMatchObject({ level: "review", items: ["Check this clause"] });
  });

  it("flags text in the document that didn't make it into the result", async () => {
    // Text inside an element the converter doesn't recognise (it skips it with a technical warning).
    const odd = `<w:p><w:r><w:t>Visible.</w:t></w:r><w:unknownWrapper><w:r><w:t>Hidden from the converter.</w:t></w:r></w:unknownWrapper></w:p>`;
    const r = ok(await run(docx(p("A", { style: "Heading1" }) + odd)));
    expect(r.sections[0].body).toBe("Visible.");
    expect(issue(r, "missing")).toMatchObject({ level: "review", items: ["Visible.Hidden from the converter."] });
    expect(issue(r, "unrecognised")).toMatchObject({ level: "review" });
  });

  it("notes formatting it can't keep, without changing the words", async () => {
    const r = ok(await run(docx(p("A", { style: "Heading1" }) + p("Bold words.", { bold: true }))));
    expect(r.sections[0].body).toBe("Bold words.");
    expect(issue(r, "formatting")!.detail).toMatch(/^Contracts in Flux are plain text, so bold, fonts/);
  });
});

describe("Word import: refused files", () => {
  it("refuses empty, oversized, non-Word, old .doc / encrypted and macro-enabled files", async () => {
    expect(await run(Buffer.alloc(0))).toEqual({ ok: false, error: "The file is empty." });
    expect((await run(Buffer.alloc(MAX_DOCX_BYTES + 1))) as { error: string }).toMatchObject({ error: expect.stringMatching(/larger than 4 MB/) });
    expect(await run(Buffer.from("%PDF-1.7 not a docx"))).toEqual({ ok: false, error: "This isn't a Word document (.docx)." });
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
    expect((await run(ole)) as { error: string }).toMatchObject({ error: expect.stringMatching(/password-protected or an old Word format/) });
    const docm = docx(p("A"), {}, `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>`);
    expect((await run(docm)) as { error: string }).toMatchObject({ error: expect.stringMatching(/contains macros/) });
    expect((await run(zip({ "hello.txt": "hi" }))) as { error: string }).toMatchObject({ error: expect.stringMatching(/isn't a Word document/) });
  });

  it("refuses damaged archives and archives that lie about their size", async () => {
    const good = docx(p("A", { style: "Heading1" }) + p("Text."));
    expect((await run(good.subarray(0, good.length - 30))) as { error: string }).toMatchObject({ error: expect.stringMatching(/damaged/) });
    const bomb = zip({ "[Content_Types].xml": "x", "word/document.xml": "a".repeat(1_000_000) }, { "word/document.xml": 1000 });
    expect(() => readArchive(bomb)).toThrow(/larger than it declares|declared size/);
    expect((await run(bomb)) as { error: string }).toMatchObject({ ok: false });
  });

  it("refuses archives with too many entries or too much unpacked data before reading them", () => {
    const many = zip(Object.fromEntries(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => [`f${i}.xml`, "x"])));
    expect(() => listEntries(many)).toThrow(/too many entries/);
    const huge = zip({ "a.xml": "x" }, { "a.xml": ZIP_LIMITS.entryBytes + 1 });
    expect(() => listEntries(huge)).toThrow(/too large/);
  });

  it("refuses tracked changes, since the accepted text can't be decided here", async () => {
    const tracked = `<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>new</w:t></w:r></w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>old</w:delText></w:r></w:del></w:p>`;
    expect((await run(docx(tracked))) as { error: string }).toMatchObject({ ok: false, error: expect.stringMatching(/tracked changes/) });
  });
});

/**
 * The BOUPROD agreement, a real Word (Google Docs) export, read from a local
 * path that is never committed: FLUX_BOUPROD_DOCX=/path/to/file.docx. Set
 * FLUX_IMPORT_DUMP=/path/out.json to write the full conversion for review.
 */
const BOUPROD = process.env.FLUX_BOUPROD_DOCX;
describe.skipIf(!BOUPROD || !existsSync(BOUPROD))("Word import: the BOUPROD agreement", () => {
  it("keeps the title, every clause's wording, the lists, the table and the signature lines, and reports what it changed", async () => {
    const r = ok(await importDocx(readFileSync(BOUPROD!), [...CATALOG, { key: "business.legal_name", label: "Legal business name", description: "" }], { legalName: null, displayName: null, email: null, address: null }));
    if (process.env.FLUX_IMPORT_DUMP) writeFileSync(process.env.FLUX_IMPORT_DUMP, JSON.stringify(r, null, 2));
    expect(r.title).toBe("DJ/AV SERVICE AGREEMENT");
    const headings = r.sections.map((s) => s.heading);
    expect(headings).toEqual([
      "Introduction",
      "1. Equipment and Setup:",
      "2. Cancellation Policy:",
      "3. Performance Schedule:",
      "4. Replacement DJ:",
      "5. Equipment Liability:",
      "6. Payment Terms:",
      "7. Force Majeure:",
      "8. Music Selection & Requests:",
      "Acceptance of Agreement:",
    ]);
    const body = (h: string) => r.sections.find((s) => s.heading === h)!.body;
    expect(body("1. Equipment and Setup:")).toBe(
      'The DJ shall provide all equipment listed in the "Guaranteed Equipment and Services" section and set up at the venue at least 2 hours prior to the event start time. The DJ is responsible for ensuring the functionality of the equipment before the event begins.',
    );
    expect(body("2. Cancellation Policy:")).toBe(
      "• A non-refundable deposit of 50% is required at the time of signing.\n• If the Client cancels within 30 days of the event, the full remaining balance is due.",
    );
    expect(body("6. Payment Terms:")).toBe(
      "• Deposit: ____________ (Due at contract signing; non-refundable)\n• Final Payment: ____________ (Due on the day of the event before performance begins)\n• Payments can be made via e-transfer, cash, or certified cheque.",
    );
    expect(body("7. Force Majeure:")).toMatch(/^Neither party shall be held liable [\s\S]* government-imposed restrictions\.$/);
    const intro = body("Introduction");
    // The business block keeps its line breaks: a name line, then four contact lines (address, city, phone, email).
    expect(intro).toMatch(/Boukine Productions(\n[^\n]+){4}\n\n\("DJ" or "Service Provider"\)/);
    expect(intro).toContain("• Event: ___________________");
    expect(intro).toContain("Item | Price (CAD) | Quantity | Total (CAD)");
    expect(intro).toMatch(/Grand Total \| +\| +\| \$/);
    expect(intro.endsWith("Terms and Conditions:")).toBe(true);
    expect(body("Acceptance of Agreement:")).toContain("[Client Name]: ________________________  Date: ____________");
    // Every piece of text in the document is in the result.
    expect(issue(r, "missing")).toBeUndefined();
    expect(r.stats).toMatchObject({ tables: 1, images: 1, numberedItems: 0 });
    expect(issue(r, "tables")!.items).toEqual(["After “Guaranteed Equipment and Services:”: 2 rows with text, 21 empty rows left out"]);
  });
});
