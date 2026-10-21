/**
 * @file A tiny PDF writer for plain text documents (deletion certificates, lib/rolloff.ts), with no
 * library: one standard font (Helvetica), A4 pages, lines wrapped to fit.
 *
 * Concepts
 * - A PDF is a list of numbered objects (pages, fonts, the text of each page) and a table of where each
 *   starts (the "xref"), so a reader can jump to any page. Text uses the font's standard character set, so
 *   characters outside it (most non-Latin scripts) are replaced; certificates only hold counts, dates and
 *   names, which keeps this fine for now.
 * - Headings: a line starting with "# " is printed larger and bold.
 */
import "server-only";
import { BRAND } from "./brand";

const PAGE_W = 595; // A4 in points
const PAGE_H = 842;
const MARGIN = 56;
const SIZE = 10.5;
const LEADING = 15;
const WRAP = 92; // characters per line at this size, roughly

/** Turns text into characters the standard PDF fonts can show, and escapes PDF's special characters. */
function pdfText(s: string) {
  const plain = s
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/…/g, "...").replace(/→/g, "->").replace(/·/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  return plain.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Wraps one line to `WRAP` characters on spaces. */
function wrap(line: string): string[] {
  if (line.length <= WRAP) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > WRAP) {
    const cut = rest.lastIndexOf(" ", WRAP);
    const at = cut > 20 ? cut : WRAP;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return [...out, rest];
}

/** Builds a PDF from plain text lines ("# " = heading). Returns its bytes. */
export function textPdf(title: string, lines: string[]): Buffer {
  const rows = lines.flatMap((l) => (l.startsWith("# ") ? [l] : wrap(l)));
  const perPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
  const pages: string[][] = [];
  for (let i = 0; i < rows.length; i += perPage) pages.push(rows.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // object number = index + 1
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages, filled in below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  add(`<< /Title (${pdfText(title)}) /Producer (${BRAND.name}) >>`);
  const kids: number[] = [];
  for (const page of pages) {
    let y = PAGE_H - MARGIN;
    const ops = page.map((l) => {
      const heading = l.startsWith("# ");
      const op = `BT /${heading ? "F2" : "F1"} ${heading ? 14 : SIZE} Tf ${MARGIN} ${y} Td (${pdfText(heading ? l.slice(2) : l)}) Tj ET`;
      y -= LEADING;
      return op;
    }).join("\n");
    const content = Buffer.from(ops, "latin1");
    add(`<< /Length ${content.length} >>\nstream\n${ops}\nendstream`);
    const contentNo = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
