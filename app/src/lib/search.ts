/**
 * @file Finding the passages that can answer a question. All search goes through this file.
 *
 * Concepts
 * - **Indexing**: when a document, transcript or tracked Teams chat message is added, its text is split into ~1,200-character
 *   passages (see `chunk` in extract.ts) and stored in a SQLite full-text index with its org, workspace
 *   and audience.
 * - **Retrieval (the "R" in RAG)**: Sidekick doesn't send whole documents to Claude. It looks up the
 *   handful of passages that best match the question and sends only those, numbered, as sources.
 * - **BM25**: the standard keyword-ranking formula: passages that use the question's rarer words more
 *   often rank higher. Title matches count double.
 * - **Audience**: `internal` passages are team-only; `shareable` ones may be used when client guests are
 *   present (a guest meeting, or a Teams channel marked as having client guests).
 *
 * - **Two engines, one door**: passages always go into the local SQLite index (the source of truth). When
 *   Azure AI Search is configured (see azure-search.ts), a copy also goes to Azure, and questions are
 *   answered with Azure's hybrid keyword + meaning search. If Azure is not configured or a call fails,
 *   search falls back to local keyword search, so answers keep working.
 */
import "server-only";
import { all, DIALECT, run } from "./db";
import { chunk } from "./extract";
import { span, spanAttrs } from "./trace";
import { azureCount, azureIndex, azureRemove, azureSearch, azureSearchConfigured, azureSetAudience } from "./azure-search";

/** One searchable piece of a document or transcript. `loc` is where it came from, like "Page 3" or "00:12:40". */
export type Passage = {
  rowid: number;
  text: string;
  title: string;
  loc: string;
  source_type: "document" | "meeting" | "chat";
  source_id: string;
  audience: string;
};

/**
 * Splits text into passages and adds them to the search index (local, plus Azure when configured).
 * Returns how many passages were stored. Call `removeIndexed` first when re-indexing the same source.
 * An Azure failure is logged, not thrown: the local copy is enough to keep answering.
 */
export async function indexText(opts: {
  orgId: string;
  workspaceId: string;
  sourceType: "document" | "meeting" | "chat";
  sourceId: string;
  title: string;
  audience: "internal" | "shareable";
  text: string;
}): Promise<number> {
  return span("index", "Index passages", async () => {
  const pieces = chunk(opts.text);
  spanAttrs({ passages: pieces.length, source: opts.sourceType, azure: azureSearchConfigured() });
  const stmt = `INSERT INTO passages (text, title, loc, source_type, source_id, workspace_id, org_id, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const p of pieces) await run(stmt, p.text, opts.title, p.loc, opts.sourceType, opts.sourceId, opts.workspaceId, opts.orgId, opts.audience);
  if (azureSearchConfigured()) await azureIndex({ ...opts, pieces }).catch((e) => console.error("Azure AI Search: indexing failed (local index still updated)", e));
  return pieces.length;
  });
}

/** Removes every passage of one document or meeting from the index (on delete or reprocess). */
export async function removeIndexed(sourceId: string) {
  await run("DELETE FROM passages WHERE source_id = ?", sourceId);
  if (azureSearchConfigured()) await azureRemove(sourceId).catch((e) => console.error("Azure AI Search: delete failed", e));
}

/**
 * Removes every passage of one workspace from the index (when the workspace is deleted): each source from
 * Azure when configured, then all local passages of that org + workspace.
 */
export async function removeWorkspaceIndex(orgId: string, workspaceId: string) {
  if (azureSearchConfigured()) {
    const sources = await all<{ source_id: string }>("SELECT DISTINCT source_id FROM passages WHERE workspace_id = ? AND org_id = ?", workspaceId, orgId);
    for (const s of sources) await azureRemove(s.source_id).catch((e) => console.error("Azure AI Search: delete failed", e));
  }
  await run("DELETE FROM passages WHERE workspace_id = ? AND org_id = ?", workspaceId, orgId);
}

/** Changes whether a source's passages are internal or shareable (when a document is re-tagged). */
export async function setAudience(sourceId: string, audience: string) {
  await run("UPDATE passages SET audience = ? WHERE source_id = ?", audience, sourceId);
  if (azureSearchConfigured()) await azureSetAudience(sourceId, audience).catch((e) => console.error("Azure AI Search: audience update failed", e));
}

/**
 * Copies every local passage into Azure, grouped by source. Runs automatically the first time Azure is
 * used with an empty index (so switching Azure on just works), and can be run again to rebuild it.
 * Returns how many sources were copied.
 */
export async function reindexAzure(): Promise<number> {
  const rows = await all<{ text: string; title: string; loc: string; source_type: string; source_id: string; workspace_id: string; org_id: string; audience: string }>(
    "SELECT text, title, loc, source_type, source_id, workspace_id, org_id, audience FROM passages ORDER BY source_id, rowid",
  );
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r]);
  for (const [sourceId, ps] of bySource) {
    const f = ps[0];
    await azureIndex({ orgId: f.org_id, workspaceId: f.workspace_id, sourceType: f.source_type, sourceId, title: f.title, audience: f.audience, pieces: ps.map((p) => ({ text: p.text, loc: p.loc })) });
  }
  return bySource.size;
}

declare global {
  var __sidekickAzureBackfill: Promise<void> | undefined;
}

/** Backfills the Azure index once per server start if it's empty but local passages exist. */
function ensureBackfilled() {
  globalThis.__sidekickAzureBackfill ??= (async () => {
    const local = (await all<{ n: number }>("SELECT COUNT(*) AS n FROM passages"))[0]?.n ?? 0;
    if (local && (await azureCount()) === 0) {
      const n = await reindexAzure();
      console.log(`Azure AI Search: copied ${n} documents/meetings from the local index`);
    }
  })().catch((e) => {
    globalThis.__sidekickAzureBackfill = undefined; // try again next time
    throw e;
  });
  return globalThis.__sidekickAzureBackfill;
}

// Common words that say nothing about the topic ("what", "the", ...). Dropped from questions before searching.
const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about again also any just more most much not now only other over some such too very did done get got let make made need should".split(" "),
);

/** The meaningful words of a question (lower-case letters/digits, stop words removed, no duplicates). */
function keywords(question: string): string[] {
  return [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)))];
}

/**
 * Finds the passages that best answer a question, scoped to one workspace in one org: the core of every
 * answer. Uses Azure hybrid search when configured, otherwise (or if Azure fails) local keyword search.
 *
 * @param orgId       always filtered on, so results never cross organizations
 * @param workspaceId always filtered on, so results never cross workspaces (callers check access first)
 * @param opts.guests when true, only `shareable` passages are returned (client guests are present)
 * @param opts.limit  maximum passages to return (default 12)
 */
export async function searchPassages(orgId: string, workspaceId: string, question: string, opts: { guests?: boolean; limit?: number } = {}): Promise<Passage[]> {
  return span("search", "Search the workspace", async () => {
    if (azureSearchConfigured() && question.trim()) {
      try {
        await ensureBackfilled();
        const hits = await azureSearch(orgId, workspaceId, question, { guests: opts.guests, limit: opts.limit ?? 12 });
        spanAttrs({ engine: "Azure AI Search", results: hits.length });
        return hits;
      } catch (e) {
        console.error("Azure AI Search failed; falling back to local keyword search", e);
        spanAttrs({ fallback: "Azure AI Search failed, used local keyword search" });
      }
    }
    const hits = await keywordSearch(orgId, workspaceId, question, opts);
    spanAttrs({ engine: "local keyword", results: hits.length });
    return hits;
  }, { guests: Boolean(opts.guests) });
}

/**
 * Local keyword search: the fallback, and the only engine when Azure is not configured.
 * - SQLite: FTS5 with BM25 ranking (title weighted 2x), prefix matching on each word.
 * - Postgres: the generated `tsv` column (English stemming, title weighted higher) ranked with ts_rank,
 *   matching any of the question's meaningful words (and words starting with them).
 */
async function keywordSearch(orgId: string, workspaceId: string, question: string, opts: { guests?: boolean; limit?: number }): Promise<Passage[]> {
  const words = keywords(question);
  if (!words.length) return [];
  const audienceClause = opts.guests ? "AND audience = 'shareable'" : "";
  if (DIALECT === "postgres") {
    // to_tsquery syntax: word:* = prefix match, | = OR. Words are letters/digits only, so they're safe here,
    // and the whole query still goes in as a bound parameter.
    return await all<Passage>(
      `SELECT rowid, text, title, loc, source_type, source_id, audience
         FROM passages
        WHERE tsv @@ to_tsquery('english', ?) AND org_id = ? AND workspace_id = ? ${audienceClause}
        ORDER BY ts_rank(tsv, to_tsquery('english', ?)) DESC LIMIT ?`,
      words.map((w) => `${w}:*`).join(" | "), orgId, workspaceId, words.map((w) => `${w}:*`).join(" | "), opts.limit ?? 12,
    );
  }
  return await all<Passage>(
    `SELECT rowid, text, title, loc, source_type, source_id, audience
       FROM passages
      WHERE passages MATCH ? AND org_id = ? AND workspace_id = ? ${audienceClause}
      ORDER BY bm25(passages, 1.0, 2.0) LIMIT ?`,
    words.map((w) => `"${w}"*`).join(" OR "),
    orgId,
    workspaceId,
    opts.limit ?? 12,
  );
}

/* ---------- Help knowledge: the support assistant's and the help bot's sources ---------- */

/**
 * One piece of help knowledge the support assistant or the public help bot may answer from: a section of a
 * help-center guide, an FAQ answer, a plan, or a support article (lib/knowledge.ts builds the lists). Not
 * client data, so it isn't in the passage index: the whole list is small and ranked in memory.
 */
export type KnowledgeDoc = { key: string; kind: "guide" | "faq" | "pricing" | "article"; title: string; url: string | null; text: string; articleId?: string };

// Words too common to say anything about which help article fits.
const HELP_STOP = new Set("a an and are as at be but by can do does for from how i if in is it its me my of on or our so that the their them there this to us was we what when where which who why will with you your sidekick".split(" "));
/** Lower-case words with a light plural/verb ending removed, so "chats" finds "chat" and "linking" finds "link". */
const terms = (t: string) =>
  t.toLowerCase().split(/[^a-z0-9@]+/).filter((w) => w.length > 1 && !HELP_STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "") || w);

/**
 * The help knowledge that best matches a question, best first (at most `limit`, only ones sharing a word with
 * it). Score: each question word found in the title counts 3, in the text 1 per mention (up to 3), so short
 * focused sections beat long ones that mention a word in passing. Pure, used by lib/support-assistant.ts and
 * lib/helpbot.ts after the question is checked and made standalone.
 */
export function rankKnowledge(docs: KnowledgeDoc[], question: string, limit = 6): KnowledgeDoc[] {
  const q = [...new Set(terms(question))];
  if (!q.length) return [];
  return docs
    .map((d) => {
      const title = new Set(terms(d.title));
      const counts = new Map<string, number>();
      for (const w of terms(d.text)) counts.set(w, (counts.get(w) ?? 0) + 1);
      let score = 0;
      for (const w of q) score += (title.has(w) ? 3 : 0) + Math.min(3, counts.get(w) ?? 0);
      return { d, score: score / Math.sqrt(1 + d.text.length / 1500) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.d);
}
