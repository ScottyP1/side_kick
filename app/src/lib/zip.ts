/**
 * @file A tiny zip writer for data exports (lib/export.ts), and a reader for Office files (PowerPoint text in
 * lib/extract.ts), using only Node's built-in zlib.
 *
 * Concepts
 * - A zip file is each file's header and compressed bytes one after another, then a "central directory"
 *   listing them. Files are deflated (the usual zip compression) and names are stored as UTF-8, so every
 *   unzip tool (Windows Explorer, macOS Archive Utility, 7-Zip) opens them.
 * - Built in memory: fine for one group's export (documents are stored as their extracted text). A very
 *   large organization would want a streamed export on the job queue later (docs/PROGRESS.md).
 * - Reading (`readZipParts`) goes through the central directory, so it works for zips that Word and PowerPoint
 *   write (sizes after the data, "data descriptors"), and stops at a size cap so a "zip bomb" can't fill memory.
 * - Names are cleaned (`safeName`) so a document called "../../x" can't write outside the export folder
 *   when someone unzips it.
 */
import "server-only";
import zlib from "node:zlib";

/** One file in the zip: its path inside the archive ("documents/Runbook.txt") and its content. */
export type ZipEntry = { name: string; data: string | Buffer };

/** Zip's date format (MS-DOS): 2-second resolution, local fields from the UTC time. */
function dosTime(d: Date) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/**
 * A file or folder name that is safe inside a zip: no slashes, no "..", no control or reserved characters
 * (Windows), at most 100 characters, never empty.
 */
export function safeName(name: string, fallback = "untitled"): string {
  const clean = name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ").replace(/\.{2,}/g, "").replace(/\s+/g, " ").replace(/^[.\s]+/, "").slice(0, 100).trim();
  return clean || fallback;
}

/** Makes names unique within one folder by adding " (2)", " (3)"… before the extension. */
export function uniqueNames() {
  const seen = new Set<string>();
  return (name: string) => {
    const dot = name.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let out = name;
    for (let i = 2; seen.has(out.toLowerCase()); i++) out = `${base} (${i})${ext}`;
    seen.add(out.toLowerCase());
    return out;
  };
}

/** Builds a zip file from `entries` (deflated, UTF-8 names). Returns its bytes. */
export function buildZip(entries: ZipEntry[], at = new Date()): Buffer {
  const { time, date } = dosTime(at);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const packed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBytes, end]);
}

/** Reads back the file names and contents of a zip made by `buildZip` (for tests and checks). */
export function readZip(zip: Buffer): ZipEntry[] {
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const size = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extraLen = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    out.push({ name, data: zlib.inflateRawSync(zip.subarray(start, start + size)) });
    p = start + size;
  }
  return out;
}

/**
 * Reads the parts of a zip (an Office file such as .pptx) whose names pass `want`, through the central directory.
 * Only stored and deflated parts are read; each part, and all of them together, may unpack to at most `maxBytes`
 * (a bigger total throws, so a "zip bomb" can't exhaust memory). A file that isn't a zip returns no parts.
 * Who calls it: lib/extract.ts (PowerPoint text). Pure, no I/O.
 */
export function readZipParts(zip: Buffer, want: (name: string) => boolean, maxBytes: number): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  let total = 0;
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("The zip's directory is broken.");
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    if (!want(name) || (method !== 0 && method !== 8)) continue;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("The zip's directory is broken.");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    const room = maxBytes - total;
    if (room <= 0) throw new Error("The file unpacks to more than the limit.");
    // maxOutputLength makes zlib stop (and throw) instead of unpacking a bomb.
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: room });
    if (data.length > room) throw new Error("The file unpacks to more than the limit.");
    total += data.length;
    out.push({ name, data });
  }
  return out;
}
