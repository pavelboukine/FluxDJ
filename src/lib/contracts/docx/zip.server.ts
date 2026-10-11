import "server-only";
import { inflateRawSync } from "node:zlib";

/**
 * A minimal, strict reader for the ZIP container of a .docx, used before the
 * converter sees the file: it lists the entries from the central directory
 * and inflates each one with a hard output cap, so a file that lies about its
 * sizes (a "zip bomb") is refused instead of exhausting memory. ZIP64,
 * encrypted entries and unknown compression methods are refused; a Word
 * document never needs them at this size.
 */

export const ZIP_LIMITS = {
  /** Entries in the archive. Word documents have a few dozen. */
  entries: 500,
  /** Total uncompressed size of all entries. */
  totalBytes: 40 * 1024 * 1024,
  /** Uncompressed size of any single entry. */
  entryBytes: 25 * 1024 * 1024,
};

export class ZipError extends Error {}

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number; encrypted: boolean };

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipError("not a zip archive");
}

/** The archive's entries, from its central directory, after checking the limits. */
export function listEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("too short");
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 is not supported");
  if (count > ZIP_LIMITS.entries) throw new ZipError("too many entries");
  if (cdOffset + cdSize > buf.length) throw new ZipError("truncated archive");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("damaged central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("zip64 is not supported");
    if (size > ZIP_LIMITS.entryBytes) throw new ZipError("an entry is too large");
    total += size;
    if (total > ZIP_LIMITS.totalBytes) throw new ZipError("the archive is too large when unpacked");
    entries.push({ name, method, compressedSize, size, localOffset, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's bytes, inflated with its declared size as a hard cap. */
export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.encrypted) throw new ZipError("encrypted entry");
  const h = entry.localOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new ZipError("damaged entry");
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ZipError("truncated entry");
  let out: Buffer;
  if (entry.method === 0) out = Buffer.from(data);
  else if (entry.method === 8) {
    try {
      // Never inflate past the declared size, whatever the data says.
      out = inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      throw new ZipError("an entry is damaged or larger than it declares");
    }
  } else throw new ZipError("unsupported compression");
  if (out.length !== entry.size) throw new ZipError("an entry doesn't match its declared size");
  return out;
}

/** Every entry inflated (verifying the declared sizes), by name. */
export function readArchive(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of listEntries(buf)) {
    if (entry.name.endsWith("/")) continue;
    files.set(entry.name, readEntry(buf, entry));
  }
  return files;
}
