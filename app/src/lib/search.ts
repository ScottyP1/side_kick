/**
 * @file Finding the passages that can answer a question. All search goes through this file.
 *
 * Concepts
 * - **Indexing**: when a document or transcript is added, its text is split into ~1,200-character
 *   passages (see `chunk` in extract.ts) and stored in a SQLite full-text index with its org, workspace
 *   and audience.
 * - **Retrieval (the "R" in RAG)**: Sidekick doesn't send whole documents to Claude. It looks up the
 *   handful of passages that best match the question and sends only those, numbered, as sources.
 * - **BM25**: the standard keyword-ranking formula: passages that use the question's rarer words more
 *   often rank higher. Title matches count double.
 * - **Audience**: `internal` passages are team-only; `shareable` ones may be used when client guests are
 *   present (a guest meeting, or a Teams channel marked as having client guests).
 *
 * Today this is keyword search. Production swaps in Azure AI Search (keyword + meaning-based "vector"
 * search) behind these same functions, so callers don't change.
 */
import "server-only";
import { all, run } from "./db";
import { chunk } from "./extract";

/** One searchable piece of a document or transcript. `loc` is where it came from, like "Page 3" or "00:12:40". */
export type Passage = {
  rowid: number;
  text: string;
  title: string;
  loc: string;
  source_type: "document" | "meeting";
  source_id: string;
  audience: string;
};

/**
 * Splits text into passages and adds them to the search index. Returns how many passages were stored.
 * Call `removeIndexed` first when re-indexing the same source.
 */
export function indexText(opts: {
  orgId: string;
  workspaceId: string;
  sourceType: "document" | "meeting";
  sourceId: string;
  title: string;
  audience: "internal" | "shareable";
  text: string;
}): number {
  const pieces = chunk(opts.text);
  const stmt = `INSERT INTO passages (text, title, loc, source_type, source_id, workspace_id, org_id, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const p of pieces) run(stmt, p.text, opts.title, p.loc, opts.sourceType, opts.sourceId, opts.workspaceId, opts.orgId, opts.audience);
  return pieces.length;
}

/** Removes every passage of one document or meeting from the index (on delete or reprocess). */
export function removeIndexed(sourceId: string) {
  run("DELETE FROM passages WHERE source_id = ?", sourceId);
}

/** Changes whether a source's passages are internal or shareable (when a document is re-tagged). */
export function setAudience(sourceId: string, audience: string) {
  run("UPDATE passages SET audience = ? WHERE source_id = ?", audience, sourceId);
}

// Common words that say nothing about the topic ("what", "the", ...). Dropped from questions before searching.
const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about again also any just more most much not now only other over some such too very did done get got let make made need should".split(" "),
);

/**
 * Turns a plain-language question into a full-text query: keeps meaningful words, matches each as a
 * prefix ("migrat"* finds migrate/migration), and ORs them together. Null if nothing is left to search.
 */
function toQuery(question: string): string | null {
  const words = (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return null;
  return [...new Set(words)].map((w) => `"${w}"*`).join(" OR ");
}

/**
 * Keyword (BM25) search scoped to one workspace in one org: the core of every answer.
 *
 * @param orgId       always filtered on, so results never cross organizations
 * @param workspaceId always filtered on, so results never cross workspaces (callers check access first)
 * @param opts.guests when true, only `shareable` passages are returned (client guests are present)
 * @param opts.limit  maximum passages to return (default 12)
 */
export function searchPassages(orgId: string, workspaceId: string, question: string, opts: { guests?: boolean; limit?: number } = {}): Passage[] {
  const q = toQuery(question);
  if (!q) return [];
  const audienceClause = opts.guests ? "AND audience = 'shareable'" : "";
  return all<Passage>(
    `SELECT rowid, text, title, loc, source_type, source_id, audience
       FROM passages
      WHERE passages MATCH ? AND org_id = ? AND workspace_id = ? ${audienceClause}
      ORDER BY bm25(passages, 1.0, 2.0) LIMIT ?`,
    q,
    orgId,
    workspaceId,
    opts.limit ?? 12,
  );
}
