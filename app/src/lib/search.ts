import "server-only";
import { all, run } from "./db";
import { chunk } from "./extract";

export type Passage = {
  rowid: number;
  text: string;
  title: string;
  loc: string;
  source_type: "document" | "meeting";
  source_id: string;
  audience: string;
};

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

export function removeIndexed(sourceId: string) {
  run("DELETE FROM passages WHERE source_id = ?", sourceId);
}

export function setAudience(sourceId: string, audience: string) {
  run("UPDATE passages SET audience = ? WHERE source_id = ?", audience, sourceId);
}

const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about again also any just more most much not now only other over some such too very did done get got let make made need should".split(" "),
);

function toQuery(question: string): string | null {
  const words = (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return null;
  return [...new Set(words)].map((w) => `"${w}"*`).join(" OR ");
}

/**
 * Keyword (BM25) search scoped to one workspace in one org.
 * When external guests are present, passages tagged "internal" are excluded.
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
