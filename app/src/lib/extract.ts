/**
 * @file Turning uploaded files into plain text, and plain text into searchable passages.
 *
 * Concepts
 * - **Extraction**: PDFs, Word files, PowerPoint decks and Teams transcripts are converted to plain text,
 *   keeping location markers (`[Page 3]` for PDFs, `[Slide 4]` for PowerPoint, `[00:12:40]` timestamps for
 *   transcripts) so answers can cite where a fact came from. Uploads and the Microsoft 365 files connector
 *   (lib/connector-m365.ts) both read files through `fileToText`.
 * - **Chunking**: long text is cut into passages of about 1,200 characters on paragraph or speaker
 *   boundaries. Small passages make search precise and keep what we send to Claude short (and cheap).
 */
import "server-only";
import path from "node:path";
import { HttpError } from "./http-error";
import { span } from "./trace";
import { docxUnpackedBytes } from "./security";
import { readZipParts } from "./zip";

/** File types Sidekick can read: PDF, Word, PowerPoint, Teams transcripts (.vtt) and text formats. */
export const ACCEPTED = [".pdf", ".docx", ".pptx", ".txt", ".md", ".vtt", ".csv", ".json"];
/** Largest file accepted, per file (25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Most files in one upload. */
export const MAX_FILES_PER_UPLOAD = 20;
/**
 * Most text kept from one document (2 million characters: a 1,000-page book, about 1,700 passages). A Word
 * or PDF file is compressed, so a small file can unpack into gigabytes of text ("zip bomb"); without a cap one
 * upload could exhaust the server's memory or, with Azure AI Search, cost thousands of embeddings.
 */
export const MAX_DOCUMENT_CHARS = 2_000_000;
/** Most a Word file's XML parts may unpack to (60 MB), checked before the file is opened. */
export const MAX_DOCX_UNPACKED_BYTES = 60 * 1024 * 1024;
/** Most pages read from one PDF. */
export const MAX_PDF_PAGES = 2000;
/** The accepted types in words, for error messages and the upload box. */
export const ACCEPTED_TEXT = "PDF, Word (.docx), PowerPoint (.pptx), text, Markdown, CSV, JSON or a Teams transcript (.vtt)";

/**
 * Why an upload can't be accepted at all (wrong type, empty, too large), or null if it may be read.
 * Checked before a document row is saved, so refused files never show up as "Failed" documents.
 */
export function uploadProblem(name: string, size: number): string | null {
  const ext = path.extname(name).toLowerCase();
  if (!ACCEPTED.includes(ext)) return `${ext || "This file type"} isn't supported. Upload ${ACCEPTED_TEXT}.`;
  if (size === 0) return "This file is empty.";
  if (size > MAX_UPLOAD_BYTES) return "File is larger than 25 MB.";
  return null;
}

/**
 * Longest meeting transcript accepted, pasted or from a file (300,000 characters: roughly five hours of
 * talk, about 75,000 tokens). The whole transcript goes to Claude in one request to write the notes, so this
 * keeps each import within Claude's context and its cost predictable (well under a dollar). Longer meetings
 * can be imported in parts.
 */
export const MAX_TRANSCRIPT_CHARS = 300_000;

/**
 * Extracts the text of an uploaded file. PDFs get a `[Page N]` marker per page, PowerPoint decks a `[Slide N]`
 * marker per slide (`pptxToText`); `.vtt` transcripts are converted to readable "[time] Speaker: words" lines.
 * @throws HttpError 415 for file types Sidekick can't read yet
 */
export async function fileToText(name: string, buf: Buffer): Promise<string> {
  return span("file", "Read the file", () => readFileText(name, buf), { type: path.extname(name).toLowerCase() || "none", kb: Math.round(buf.length / 1024) });
}

async function readFileText(name: string, buf: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (!ACCEPTED.includes(ext)) {
    throw new HttpError(415, `${ext || "This file type"} isn't supported. Upload ${ACCEPTED_TEXT}.`);
  }
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    if (pdf.numPages > MAX_PDF_PAGES) throw new HttpError(413, `This PDF has ${pdf.numPages.toLocaleString("en-US")} pages; the limit is ${MAX_PDF_PAGES.toLocaleString("en-US")}. Split it into smaller files.`);
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).map((t, i) => `[Page ${i + 1}]\n${t}`).join("\n\n");
  }
  if (ext === ".docx") {
    if (docxUnpackedBytes(buf) > MAX_DOCX_UNPACKED_BYTES) throw new HttpError(413, "This Word file unpacks to far more text than a real document holds, so it wasn't read. Save it again from Word, or split it.");
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (ext === ".pptx") {
    if (docxUnpackedBytes(buf) > MAX_DOCX_UNPACKED_BYTES) throw new HttpError(413, "This PowerPoint file unpacks to far more text than a real deck holds, so it wasn't read. Save it again from PowerPoint, or split it.");
    return pptxToText(buf);
  }
  const text = buf.toString("utf8");
  return ext === ".vtt" ? vttToTranscript(text) : text;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const xmlText = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e: string) =>
  e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : XML_ENTITIES[e.toLowerCase()] ?? m);

/**
 * The text of a PowerPoint deck (.pptx): each slide's text boxes in slide order, one line per paragraph, under a
 * `[Slide N]` marker, with the speaker notes after "Notes:". Slides without text are left out. Reads only the
 * slide and notes parts (at most `MAX_DOCX_UNPACKED_BYTES`), never images or embedded files.
 * @throws HttpError 415 when the file isn't a PowerPoint deck Sidekick can open
 */
export function pptxToText(buf: Buffer): string {
  let parts;
  try {
    parts = readZipParts(buf, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n), MAX_DOCX_UNPACKED_BYTES);
  } catch {
    throw new HttpError(415, "This PowerPoint file couldn't be opened. Save it again from PowerPoint and try once more.");
  }
  const textOf = (xml: string) => xml
    .split(/<\/a:p>/)
    .map((para) => [...para.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => xmlText(m[1])).join(""))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const notes = new Map(parts.filter((p) => p.name.includes("notesSlide")).map((p) => [num(p.name), textOf(String(p.data))]));
  const slides = parts.filter((p) => p.name.startsWith("ppt/slides/")).sort((a, b) => num(a.name) - num(b.name));
  if (!slides.length) throw new HttpError(415, "This PowerPoint file has no slides Sidekick can read.");
  return slides
    .map((p) => {
      const n = num(p.name);
      const body = textOf(String(p.data));
      // Notes slides repeat the slide number as their last line; drop a bare number.
      const note = (notes.get(n) ?? "").split("\n").filter((l) => !/^\d+$/.test(l)).join("\n");
      return body || note ? `[Slide ${n}]\n${body}${note ? `\nNotes: ${note}` : ""}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Converts a Teams WebVTT transcript into readable lines like `[00:01:02] Maria Chen: We agreed to ...`.
 * Teams .vtt cues look like "00:01:02.345 --> 00:01:05.000" followed by "<v Speaker Name>text</v>".
 * Cue numbers, ids and NOTE lines are dropped, and consecutive lines from the same speaker are merged.
 */
export function vttToTranscript(vtt: string): string {
  const lines = vtt.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let stamp = "";
  for (const line of lines) {
    const t = line.match(/^(\d{2}:)?(\d{2}):(\d{2})[.,]\d{3}\s+-->/);
    if (t) {
      stamp = `${t[1] ? t[1].slice(0, 2) : "00"}:${t[2]}:${t[3]}`;
      continue;
    }
    const v = line.match(/^<v\s+([^>]+)>(.*?)(<\/v>)?$/);
    if (v) {
      out.push(`[${stamp}] ${v[1].trim()}: ${v[2].trim()}`);
    } else if (line.trim() && !/^WEBVTT|^NOTE|^\d+$|^[0-9a-f-]{36}(\/\d+-\d+)?$/i.test(line.trim())) {
      out.push(stamp ? `[${stamp}] ${line.trim()}` : line.trim());
    }
  }
  // Merge consecutive lines from the same speaker so the transcript reads naturally.
  const merged: string[] = [];
  for (const l of out) {
    const prev = merged[merged.length - 1];
    const who = (s: string) => s.match(/^\[[^\]]+\] ([^:]+):/)?.[1];
    if (prev && who(prev) && who(prev) === who(l)) merged[merged.length - 1] = prev + " " + l.replace(/^\[[^\]]+\] [^:]+:\s*/, "");
    else merged.push(l);
  }
  return merged.join("\n");
}

/**
 * Splits text into ~`size`-character passages on page, paragraph or speaker boundaries. Each passage keeps
 * the most recent location label (page or timestamp) so citations can point to it. Very long paragraphs
 * are cut into fixed-size slices.
 */
export function chunk(text: string, size = 1200): { text: string; loc: string }[] {
  const parts = text.split(/\n(?=\[(?:Page|Slide) \d+\])|\n{2,}|\n(?=\[\d{2}:\d{2}:\d{2}\])/);
  const chunks: { text: string; loc: string }[] = [];
  let buf = "";
  let loc = "";
  const locOf = (s: string) => s.match(/^\[((?:Page|Slide) \d+|\d{2}:\d{2}:\d{2})\]/)?.[1] ?? "";
  for (const p of parts) {
    const piece = p.trim();
    if (!piece) continue;
    if (!buf) loc = locOf(piece) || loc;
    if (buf && buf.length + piece.length > size) {
      chunks.push({ text: buf, loc });
      buf = "";
      loc = locOf(piece) || loc;
    }
    if (piece.length > size * 1.5) {
      for (let i = 0; i < piece.length; i += size) chunks.push({ text: piece.slice(i, i + size), loc });
      continue;
    }
    buf = buf ? `${buf}\n${piece}` : piece;
  }
  if (buf) chunks.push({ text: buf, loc });
  return chunks;
}
