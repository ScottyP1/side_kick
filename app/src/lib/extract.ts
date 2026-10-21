/**
 * @file Turning uploaded files into plain text, and plain text into searchable passages.
 *
 * Concepts
 * - **Extraction**: PDFs, Word files and Teams transcripts are converted to plain text, keeping location
 *   markers (`[Page 3]` for PDFs, `[00:12:40]` timestamps for transcripts) so answers can cite where a
 *   fact came from.
 * - **Chunking**: long text is cut into passages of about 1,200 characters on paragraph or speaker
 *   boundaries. Small passages make search precise and keep what we send to Claude short (and cheap).
 */
import "server-only";
import path from "node:path";
import { HttpError } from "./auth";
import { span } from "./trace";

/** File types Sidekick can read: PDF, Word, Teams transcripts (.vtt) and text formats. */
export const ACCEPTED = [".pdf", ".docx", ".txt", ".md", ".vtt", ".csv", ".json"];
/** Largest file accepted, per file (25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The accepted types in words, for error messages and the upload box. */
export const ACCEPTED_TEXT = "PDF, Word (.docx), text, Markdown, CSV, JSON or a Teams transcript (.vtt)";

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
 * Extracts the text of an uploaded file. PDFs get a `[Page N]` marker per page; `.vtt` transcripts are
 * converted to readable "[time] Speaker: words" lines.
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
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).map((t, i) => `[Page ${i + 1}]\n${t}`).join("\n\n");
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  const text = buf.toString("utf8");
  return ext === ".vtt" ? vttToTranscript(text) : text;
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
  const parts = text.split(/\n(?=\[Page \d+\])|\n{2,}|\n(?=\[\d{2}:\d{2}:\d{2}\])/);
  const chunks: { text: string; loc: string }[] = [];
  let buf = "";
  let loc = "";
  const locOf = (s: string) => s.match(/^\[(Page \d+|\d{2}:\d{2}:\d{2})\]/)?.[1] ?? "";
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
