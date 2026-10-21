/**
 * @file Short source excerpts for answers: plain text, taken from the part of a passage that matches the
 * question. No I/O, so it is unit-tested (tests/db.test.mjs).
 *
 * Concepts
 * - **Plain text**: passages keep the source's own Markdown (headings, `**bold**`, table pipes). Excerpts
 *   are shown as plain text in the portal and in Teams cards, so the markup is removed first.
 * - **The matching part**: a passage is up to ~1,200 characters, but an excerpt is ~280. Instead of always
 *   showing the passage's start, the excerpt starts just before the stretch with the most question words.
 *
 * Caller: `ask()` in sidekick.ts (the excerpt is cleaned by the guardrails afterwards).
 */

// Words too common to locate the matching part of a passage.
const STOP = new Set("what when where which while with would could should about there their them they this that from have does were your into than then also just only who whom whose why how the and for are was our out can will not any all its it's".split(" "));

/** Removes Markdown markup (headings, emphasis, code ticks, links, list markers, table pipes and rules). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, " ") // table separator rows
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s{0,3}>\s?/gm, "") // quotes
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "") // list markers
    .replace(/\*\*|__|`+|~~/g, "") // bold, code, strike
    .replace(/(^|\s)[*_](\S)/g, "$1$2") // italics, opening
    .replace(/(\S)[*_](?=\s|[.,;:!?]|$)/g, "$1") // italics, closing
    .replace(/\s*\|\s*/g, " · ") // table cells
    .replace(/(?:^|\s)·\s*(?=·|$)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*·\s*|\s*·\s*$/g, "")
    .trim();
}

/**
 * A plain-text excerpt of about `len` characters from `text`, starting near the part that best matches
 * `question` (the passage's start when nothing matches). Cut on word boundaries; a leading "…" marks
 * an excerpt that doesn't start at the beginning.
 */
export function excerptFor(text: string, question: string, len = 280): string {
  const plain = stripMarkdown(text);
  if (plain.length <= len) return plain;
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP.has(w));
  const lower = plain.toLowerCase();
  let best = 0;
  let bestScore = 0;
  for (const t of terms) {
    for (let at = lower.indexOf(t); at !== -1; at = lower.indexOf(t, at + 1)) {
      const start = Math.max(0, at - 40);
      const window = lower.slice(start, start + len);
      const score = terms.filter((x) => window.includes(x)).length;
      if (score > bestScore) [best, bestScore] = [start, score];
    }
  }
  let start = best;
  if (start > 0) {
    const space = plain.lastIndexOf(" ", start);
    start = space === -1 ? 0 : space + 1;
  }
  start = Math.min(start, Math.max(0, plain.length - len));
  if (start > 0 && plain[start - 1] !== " ") start = plain.indexOf(" ", start) + 1;
  let piece = plain.slice(start, start + len);
  if (start + len < plain.length && piece.includes(" ")) piece = piece.slice(0, piece.lastIndexOf(" "));
  return (start > 0 ? "…" : "") + piece.trim();
}
