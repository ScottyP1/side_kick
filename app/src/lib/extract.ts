import "server-only";
import path from "node:path";
import { HttpError } from "./auth";

// Turns an uploaded file into plain text. PDF, Word, Teams transcripts (.vtt) and text formats.
export const ACCEPTED = [".pdf", ".docx", ".txt", ".md", ".vtt", ".csv", ".json"];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function fileToText(name: string, buf: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (!ACCEPTED.includes(ext)) {
    throw new HttpError(415, `${ext || "This file type"} isn't supported yet. Upload PDF, Word (.docx), text, Markdown or a Teams transcript (.vtt).`);
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

// Teams WebVTT: "00:01:02.345 --> 00:01:05.000" followed by "<v Speaker Name>text</v>".
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

// Splits text into ~1,200-character passages on paragraph/line boundaries, keeping a location label.
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
