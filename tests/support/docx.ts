/**
 * Builds small .docx files in memory for importer tests: a stored/deflated
 * ZIP with the given parts (no Word needed). Paragraph helpers write plain
 * WordprocessingML; tests pass raw XML for anything unusual.
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive of the given files (deflated). `lie` overrides an entry's declared uncompressed size. */
export function zip(files: Record<string, string | Buffer>, lie: Record<string, number> = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const size = lie[name] ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A paragraph: style ("Heading1", "Title"), list (numId 1 = numbered, 2 = bullets), bold. Line breaks become <w:br/>. */
export function p(text: string, opts: { style?: string; list?: { num: 1 | 2; level?: number }; bold?: boolean } = {}): string {
  const ppr = [
    opts.style ? `<w:pStyle w:val="${opts.style}"/>` : "",
    opts.list ? `<w:numPr><w:ilvl w:val="${opts.list.level ?? 0}"/><w:numId w:val="${opts.list.num}"/></w:numPr>` : "",
  ].join("");
  const rpr = opts.bold ? "<w:rPr><w:b/></w:rPr>" : "";
  const runs = text.split("\n").map((line, i) => `${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(line)}</w:t>`).join("");
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}<w:r>${rpr}${runs}</w:r></w:p>`;
}

export function table(rows: string[][]): string {
  return `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>${[
  ["Title", "Title"],
  ["Heading1", "heading 1"],
  ["Heading2", "heading 2"],
  ["Heading3", "heading 3"],
].map(([id, name]) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`).join("")}</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;

/** A .docx whose body is the given paragraphs/tables XML. Extra parts (headers, comments…) can be added. */
export function docx(body: string, extra: Record<string, string | Buffer> = {}, contentTypes?: string): Buffer {
  const overrides = Object.keys(extra)
    .filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n) || n === "word/comments.xml")
    .map((n) => `<Override PartName="/${n}" ContentType="application/xml"/>`)
    .join("");
  return zip({
    "[Content_Types].xml":
      contentTypes ??
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${overrides}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/terms" TargetMode="External"/></Relationships>`,
    "word/styles.xml": STYLES,
    "word/numbering.xml": NUMBERING,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...extra,
  });
}
