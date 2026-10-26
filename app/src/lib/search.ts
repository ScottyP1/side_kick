/**
 * @file Finding the passages that can answer a question. All search goes through this file.
 *
 * Concepts
 * - **Indexing**: when a document, transcript, meeting's notes or tracked Teams chat message is added, its text is
 *   split into ~1,200-character passages (see `chunk` in extract.ts) and stored in a SQLite full-text index with
 *   its org, workspace (group) and audience.
 * - **Retrieval (the "R" in RAG)**: Sidekick doesn't send whole documents to Claude. It looks up the
 *   handful of passages that best match the question and sends only those, numbered, as sources.
 * - **BM25**: the standard keyword-ranking formula: passages that use the question's rarer words more
 *   often rank higher. Title matches count double.
 * - **Audience**: `internal` passages are team-only; `shareable` ones may be used when client guests are
 *   present (a guest meeting, or a Teams channel marked as having client guests).
 * - **Firm library** (lib/firm.ts): org-wide documents (policies, standards, templates). Their passages are
 *   indexed **once per org** under the workspace id `FIRM_SCOPE` ("firm"), not copied into each group. A
 *   group's search covers that group **plus** its org's firm library, never another group or org. A firm document
 *   can be **limited to chosen groups** ("Applies to", `firm_docs.applies_to = 'some'` + `firm_doc_groups`): then
 *   only those groups' searches include it (`limitedFirmClause` locally, `excludeSources` on Azure).
 * - **Held documents** (lib/upload-guard.ts) are never indexed while held, so search can't find them; when kept
 *   they're indexed normally, and when moved `moveIndexed` takes their passages out of the old scope first.
 * - **Source types**: `document` (a group's upload), `meeting` (a transcript), `notes` (the notes Sidekick wrote
 *   for a meeting: summary, decisions, facts; source id `<meeting id>:notes`), `chat` (a tracked Teams message)
 *   `firm` (a firm library document), `workitem` (an Azure DevOps work item, Jira issue or GitHub issue / pull
 *   request read by a connector, lib/connectors.ts; source id = its `connector_items` id) and `page` (a
 *   Confluence page read by a connector: a document, so the "Documents" filter covers it; same source ids).
 * - **The answer pipeline** (`findSources`): search returns ~30 candidates (filtered by type and date when the
 *   person asked for that), the database adds each source's date, origin and outdated flags, and lib/rank.ts
 *   re-ranks them (fit to the whole question, freshness, firm-vs-group priority, summaries first), removes
 *   duplicates and keeps the best ~10.
 *
 * - **Two engines, one door**: passages always go into the local SQLite index (the source of truth). When
 *   Azure AI Search is configured (see azure-search.ts), a copy also goes to Azure, and questions are
 *   answered with Azure's hybrid keyword + meaning search. If Azure is not configured or a call fails,
 *   search falls back to local keyword search, so answers keep working.
 */
import "server-only";
import { all, DIALECT, get, now, run, type Param } from "./db";
import { chunk, isTranscript, unchunk } from "./extract";
import { span, spanAttrs } from "./trace";
import { azureCount, azureIndex, azureRemove, azureSearch, azureSearchConfigured, azureSetAudience } from "./azure-search";
import { rerank, versionKey, type Candidate, type Ranked } from "./rank";

/** The workspace id the firm library's passages are indexed under (one copy per org, shared by its groups). */
export const FIRM_SCOPE = "firm";

/** What a passage was cut from (see the file comment). */
export type SourceType = "document" | "meeting" | "notes" | "chat" | "firm" | "workitem" | "page";

/** One searchable piece of a document or transcript. `loc` is where it came from, like "Page 3" or "00:12:40". */
export type Passage = {
  rowid: number;
  text: string;
  title: string;
  loc: string;
  source_type: SourceType;
  source_id: string;
  audience: string;
  /** The group it belongs to, or `FIRM_SCOPE` for the firm library. */
  workspace_id?: string;
};

/** The filters a person can pick in Ask: what kind of source, and a date range. */
export type SourceFilter = "documents" | "meetings" | "chats" | "decisions" | "firm" | "work";
/** Which source types each filter covers. "decisions" = the meeting notes (summaries and decisions). */
export const FILTER_TYPES: Record<SourceFilter, SourceType[]> = {
  documents: ["document", "firm", "page"],
  meetings: ["meeting", "notes"],
  chats: ["chat"],
  decisions: ["notes"],
  firm: ["firm"],
  work: ["workitem"],
};

/**
 * Splits text into passages and adds them to the search index (local, plus Azure when configured).
 * Returns how many passages were stored. Call `removeIndexed` first when re-indexing the same source.
 * An Azure failure is logged, not thrown: the local copy is enough to keep answering.
 */
export async function indexText(opts: {
  orgId: string;
  workspaceId: string;
  sourceType: SourceType;
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

/**
 * Removes every passage of one document, meeting or chat message from the index (on delete or reprocess). For a
 * meeting this also removes its notes (`<id>:notes`).
 */
export async function removeIndexed(sourceId: string) {
  const notes = `${sourceId}:notes`;
  await run("DELETE FROM passages WHERE source_id = ? OR source_id = ?", sourceId, notes);
  if (azureSearchConfigured()) {
    for (const id of [sourceId, notes]) await azureRemove(id).catch((e) => console.error("Azure AI Search: delete failed", e));
  }
}

/**
 * Removes every passage of many sources of one org at once (local in pieces of 100, then Azure per source when
 * configured): used when a connector is disconnected or a project unlinked (lib/connectors.ts).
 */
export async function removeIndexedMany(orgId: string, sourceIds: string[]) {
  for (let i = 0; i < sourceIds.length; i += 100) {
    const part = sourceIds.slice(i, i + 100);
    await run(`DELETE FROM passages WHERE org_id = ? AND source_id IN (${part.map(() => "?").join(", ")})`, orgId, ...part);
  }
  if (azureSearchConfigured()) {
    for (const id of sourceIds) await azureRemove(id).catch((e) => console.error("Azure AI Search: delete failed", e));
  }
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

/**
 * Removes the whole firm library of one org from the index (local and Azure), when the organization is deleted
 * (lib/rolloff.ts). Single firm documents are removed with `removeIndexed`.
 */
export const removeFirmIndex = (orgId: string) => removeWorkspaceIndex(orgId, FIRM_SCOPE);

/**
 * Moves one source's passages to another scope (a group, or out of the firm library into a group): every local
 * passage is removed from the old scope and written again under the new workspace id and source type (and title,
 * when given), and on Azure the old entries are deleted and the passages indexed again. Used when a document is
 * moved between groups or from the firm library into a group (lib/upload-guard.ts). Scoped to the org. Returns how
 * many passages moved. Traced as its own step (counts only).
 */
export async function moveIndexed(orgId: string, sourceId: string, to: { workspaceId: string; sourceType: SourceType; title?: string }): Promise<number> {
  return span("index", "Move passages", async () => {
    const rows = await all<{ text: string; title: string; loc: string; audience: string }>(
      "SELECT text, title, loc, audience FROM passages WHERE org_id = ? AND source_id = ? ORDER BY rowid", orgId, sourceId,
    );
    await run("DELETE FROM passages WHERE org_id = ? AND source_id = ?", orgId, sourceId);
    if (azureSearchConfigured()) await azureRemove(sourceId).catch((e) => console.error("Azure AI Search: delete failed", e));
    const title = to.title ?? rows[0]?.title ?? "";
    const stmt = `INSERT INTO passages (text, title, loc, source_type, source_id, workspace_id, org_id, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    for (const p of rows) await run(stmt, p.text, title, p.loc, to.sourceType, sourceId, to.workspaceId, orgId, p.audience);
    if (rows.length && azureSearchConfigured()) {
      await azureIndex({ orgId, workspaceId: to.workspaceId, sourceType: to.sourceType, sourceId, title, audience: rows[0].audience, pieces: rows.map((p) => ({ text: p.text, loc: p.loc })) })
        .catch((e) => console.error("Azure AI Search: indexing failed (local index still updated)", e));
    }
    spanAttrs({ passages: rows.length, source: to.sourceType, azure: azureSearchConfigured() });
    return rows.length;
  });
}

/**
 * SQL (and its values) that leaves out firm documents limited to other groups: a firm passage stays only when its
 * document applies to all groups, or `workspaceId` is one of its chosen groups (`firm_doc_groups`).
 */
function limitedFirmClause(orgId: string, workspaceId: string): [string, Param[]] {
  return [
    `AND (workspace_id <> '${FIRM_SCOPE}' OR source_id NOT IN (SELECT id FROM firm_docs WHERE org_id = ? AND applies_to = 'some'
       AND id NOT IN (SELECT firm_doc_id FROM firm_doc_groups WHERE org_id = ? AND workspace_id = ?)))`,
    [orgId, orgId, workspaceId],
  ];
}

/** The firm documents limited to other groups (not `workspaceId`): left out of that group's Azure searches. */
async function limitedFirmIds(orgId: string, workspaceId: string): Promise<string[]> {
  return (await all<{ id: string }>(
    "SELECT id FROM firm_docs WHERE org_id = ? AND applies_to = 'some' AND id NOT IN (SELECT firm_doc_id FROM firm_doc_groups WHERE org_id = ? AND workspace_id = ?)",
    orgId, orgId, workspaceId,
  )).map((r) => r.id);
}

/** Changes whether a source's passages are internal or shareable (when a document is re-tagged). */
export async function setAudience(sourceId: string, audience: string) {
  await run("UPDATE passages SET audience = ? WHERE source_id = ?", audience, sourceId);
  if (azureSearchConfigured()) await azureSetAudience(sourceId, audience).catch((e) => console.error("Azure AI Search: audience update failed", e));
}

/**
 * Copies every local passage into Azure, grouped by source. Runs automatically the first time Azure is
 * used with an empty index (so switching Azure on, or moving to a new search service, just works), and can be
 * run again to rebuild it. Reads `REINDEX_PAGE` sources at a time (in source id order), so it works however big
 * the index is (10,000 groups is millions of passages; docs/SCALE.md). Returns how many sources were copied.
 */
export async function reindexAzure(): Promise<number> {
  type Row = { text: string; title: string; loc: string; source_type: string; source_id: string; workspace_id: string; org_id: string; audience: string };
  let after = "";
  let copied = 0;
  for (;;) {
    const ids = (await all<{ source_id: string }>(
      "SELECT DISTINCT source_id FROM passages WHERE source_id > ? ORDER BY source_id LIMIT ?", after, REINDEX_PAGE,
    )).map((r) => r.source_id);
    if (!ids.length) return copied;
    after = ids[ids.length - 1];
    const rows = await all<Row>(
      `SELECT text, title, loc, source_type, source_id, workspace_id, org_id, audience FROM passages WHERE source_id IN (${ids.map(() => "?").join(",")}) ORDER BY source_id, rowid`,
      ...ids,
    );
    const bySource = new Map<string, Row[]>();
    for (const r of rows) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r]);
    for (const [sourceId, ps] of bySource) {
      const f = ps[0];
      await azureIndex({ orgId: f.org_id, workspaceId: f.workspace_id, sourceType: f.source_type, sourceId, title: f.title, audience: f.audience, pieces: ps.map((p) => ({ text: p.text, loc: p.loc })) });
      copied++;
    }
  }
}
/** Sources read per round by `reindexAzure`. */
const REINDEX_PAGE = 200;

/** The current way transcripts are cut into passages (2 = overlapping speaker turns, `chunk` in extract.ts). */
export const TRANSCRIPT_CHUNKS_VERSION = 2;

/**
 * One-time upkeep for one organization: re-cuts the passages of transcripts indexed before transcript passages
 * overlapped (`chunk` in extract.ts), locally and on Azure when configured. Covers meetings (from the transcript
 * kept on the meeting) and transcripts uploaded as documents (their text rebuilt from their passages with
 * `unchunk`, since the file itself isn't kept). Sources whose passages already match are left alone, so it is
 * safe to run again. When everything is done the org is marked in `index_versions`, and later calls return at
 * once. Returns how many sources were re-cut.
 *
 * Who calls it: `ensureTranscriptsRechunked` (once per org per server start, from the first question), and tests.
 * Always scoped to `orgId`; never reads another org's passages.
 */
export async function rechunkTranscripts(orgId: string): Promise<number> {
  const done = await get<{ version: number }>("SELECT version FROM index_versions WHERE org_id = ? AND name = 'transcript_chunks'", orgId);
  if (done && done.version >= TRANSCRIPT_CHUNKS_VERSION) return 0;
  return span("index", "Re-cut transcript passages", async () => {
    type Row = { text: string; title: string; loc: string; source_type: string; source_id: string; workspace_id: string; audience: string };
    // Transcript passages start with a timestamped speaker turn; only sources with one can need re-cutting.
    const ids = await all<{ source_id: string; source_type: string }>(
      `SELECT DISTINCT source_id, source_type FROM passages WHERE org_id = ? AND source_type IN ('meeting', 'document') AND text LIKE '[%] %:%' ORDER BY source_id`,
      orgId,
    );
    let changed = 0;
    for (const { source_id, source_type } of ids) {
      const rows = await all<Row>(
        "SELECT text, title, loc, source_type, source_id, workspace_id, audience FROM passages WHERE org_id = ? AND source_id = ? ORDER BY rowid", orgId, source_id,
      );
      if (!rows.length) continue;
      const kept = source_type === "meeting"
        ? (await get<{ transcript: string }>("SELECT transcript FROM meetings WHERE id = ? AND org_id = ?", source_id, orgId))?.transcript
        : unchunk(rows.map((r) => r.text));
      if (!kept || !isTranscript(kept)) continue;
      const pieces = chunk(kept);
      if (pieces.length === rows.length && pieces.every((p, i) => p.text === rows[i].text && p.loc === rows[i].loc)) continue;
      const f = rows[0];
      await run("DELETE FROM passages WHERE org_id = ? AND source_id = ?", orgId, source_id);
      const stmt = `INSERT INTO passages (text, title, loc, source_type, source_id, workspace_id, org_id, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      for (const p of pieces) await run(stmt, p.text, f.title, p.loc, f.source_type, source_id, f.workspace_id, orgId, f.audience);
      if (azureSearchConfigured()) {
        await azureRemove(source_id).catch((e) => console.error("Azure AI Search: delete failed", e));
        await azureIndex({ orgId, workspaceId: f.workspace_id, sourceType: f.source_type, sourceId: source_id, title: f.title, audience: f.audience, pieces })
          .catch((e) => console.error("Azure AI Search: indexing failed (local index still updated)", e));
      }
      changed++;
    }
    await run(
      "INSERT INTO index_versions (org_id, name, version, done_at) VALUES (?, 'transcript_chunks', ?, ?) ON CONFLICT (org_id, name) DO UPDATE SET version = excluded.version, done_at = excluded.done_at",
      orgId, TRANSCRIPT_CHUNKS_VERSION, now(),
    );
    spanAttrs({ checked: ids.length, recut: changed, azure: azureSearchConfigured() });
    return changed;
  });
}

declare global {
  var __sidekickRechunk: Map<string, Promise<number>> | undefined;
}

/**
 * Starts `rechunkTranscripts` for one organization at most once per server start (in the background of its first
 * question; a failure is logged and retried on the next question). Returns the promise, so tests can wait for it.
 */
export function ensureTranscriptsRechunked(orgId: string): Promise<number> {
  const runs = (globalThis.__sidekickRechunk ??= new Map());
  let p = runs.get(orgId);
  if (!p) {
    p = rechunkTranscripts(orgId).catch((e) => {
      runs.delete(orgId);
      console.error("Search: re-cutting earlier transcripts failed (will retry)", e);
      return 0;
    });
    runs.set(orgId, p);
  }
  return p;
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

// Common words that say nothing about the topic ("what", "the", ...), and verbs of speech ("what did the client
// say about PCI?": the topic is PCI). Dropped from questions before searching.
const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about again also any just more most much not now only other over some such too very did done get got let make made need should say said says tell told mention mentioned".split(" "),
);

/** The meaningful words of a question (lower-case letters/digits, stop words removed, no duplicates). */
export function keywords(question: string): string[] {
  return [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)))];
}

/** Where and what to search: one group (and, unless left out, its org's firm library), with optional filters. */
export type SearchOpts = {
  /** when true, only `shareable` passages are returned (client guests are present) */
  guests?: boolean;
  /** maximum passages to return (default 12) */
  limit?: number;
  /** also search the org's firm library (default true) */
  firm?: boolean;
  /** only these source types (default: all) */
  types?: SourceType[];
  /** only sources dated on or after this day (YYYY-MM-DD) */
  since?: string | null;
  /** only sources dated on or before this day (YYYY-MM-DD) */
  until?: string | null;
};

/** The workspace ids one search covers: the group, plus the firm library unless left out or filtered away. */
function scopesFor(workspaceId: string, opts: SearchOpts): string[] {
  const firm = opts.firm !== false && (!opts.types || opts.types.includes("firm"));
  return firm ? [workspaceId, FIRM_SCOPE] : [workspaceId];
}

/**
 * Finds the passages that best match a question, scoped to one group in one org (plus the org's firm library):
 * the raw candidates, in the engine's order. Uses Azure hybrid search when configured, otherwise (or if Azure
 * fails) local keyword search. Most callers want `findSources`, which re-ranks these.
 *
 * @param orgId       always filtered on, so results never cross organizations
 * @param workspaceId always filtered on, so results never cross groups (callers check access first)
 */
export async function searchPassages(orgId: string, workspaceId: string, question: string, opts: SearchOpts = {}): Promise<Passage[]> {
  return span("search", "Search the workspace", async () => {
    const scopes = scopesFor(workspaceId, opts);
    const dated = Boolean(opts.since || opts.until);
    const limit = opts.limit ?? 12;
    if (azureSearchConfigured() && question.trim()) {
      try {
        await ensureBackfilled();
        // Azure has no dates on passages: take a bigger pool and keep the ones in the date range.
        const excludeSources = scopes.includes(FIRM_SCOPE) ? await limitedFirmIds(orgId, workspaceId) : [];
        const hits = await azureSearch(orgId, scopes, question, { guests: opts.guests, limit: dated ? Math.max(limit * 3, 50) : limit, types: opts.types, excludeSources });
        const kept = dated ? (await inDateRange(orgId, hits, opts)).slice(0, limit) : hits;
        spanAttrs({ engine: "Azure AI Search", results: kept.length, firm: scopes.length > 1 });
        return kept;
      } catch (e) {
        console.error("Azure AI Search failed; falling back to local keyword search", e);
        spanAttrs({ fallback: "Azure AI Search failed, used local keyword search" });
      }
    }
    const hits = await keywordSearch(orgId, scopes, question, { ...opts, limit });
    spanAttrs({ engine: "local keyword", results: hits.length, firm: scopes.length > 1 });
    return hits;
  }, { guests: Boolean(opts.guests), filtered: Boolean(opts.types || opts.since || opts.until) });
}

/** The day after a YYYY-MM-DD date, so "until" includes the whole day in string comparisons. */
const dayAfter = (d: string) => new Date(Date.parse(d.slice(0, 10)) + 86400_000).toISOString().slice(0, 10);

/**
 * SQL (and its values) that keeps only passages whose source is dated within the range: documents by the day
 * they were added, meetings and their notes by the day held, chat messages by when they were sent, firm
 * documents by their effective date (or upload day), work items by when the tool last changed them. Works on both engines (`||` joins text on both).
 */
function dateClause(orgId: string, opts: SearchOpts): [string, Param[]] {
  if (!opts.since && !opts.until) return ["", []];
  const from = opts.since?.slice(0, 10) ?? "0000-01-01";
  const to = opts.until ? dayAfter(opts.until) : "9999-12-31";
  const r = (col: string) => `${col} >= ? AND ${col} < ?`;
  return [
    `AND (source_id IN (SELECT id FROM documents WHERE org_id = ? AND ${r("created_at")})
       OR source_id IN (SELECT id FROM meetings WHERE org_id = ? AND ${r("held_at")})
       OR source_id IN (SELECT id || ':notes' FROM meetings WHERE org_id = ? AND ${r("held_at")})
       OR source_id IN (SELECT id FROM chat_messages WHERE org_id = ? AND ${r("sent_at")})
       OR source_id IN (SELECT id FROM firm_docs WHERE org_id = ? AND ${r("COALESCE(effective_on, created_at)")})
       OR source_id IN (SELECT id FROM connector_items WHERE org_id = ? AND ${r("COALESCE(changed_at, synced_at)")}))`,
    [orgId, from, to, orgId, from, to, orgId, from, to, orgId, from, to, orgId, from, to, orgId, from, to],
  ];
}

/** Keeps the passages whose source is dated within the range (for Azure results, which carry no dates). */
async function inDateRange(orgId: string, hits: Passage[], opts: SearchOpts): Promise<Passage[]> {
  const info = await sourceInfo(orgId, hits);
  const from = opts.since?.slice(0, 10) ?? "0000-01-01";
  const to = opts.until?.slice(0, 10) ?? "9999-12-31";
  return hits.filter((h) => {
    const d = info.get(h.source_id)?.date;
    return d != null && d >= from && d <= to;
  });
}

/**
 * Local keyword search: the fallback, and the only engine when Azure is not configured.
 * - SQLite: FTS5 with BM25 ranking (title weighted 2x), prefix matching on each word.
 * - Postgres: the generated `tsv` column (English stemming, title weighted higher) ranked with ts_rank,
 *   matching any of the question's meaningful words (and words starting with them).
 * Always filtered on the org and the given workspace ids (the group first, and maybe the firm library), the
 * audience when guests are present, the type and date filters, and firm documents limited to other groups.
 */
async function keywordSearch(orgId: string, scopes: string[], question: string, opts: SearchOpts & { limit: number }): Promise<Passage[]> {
  const words = keywords(question);
  if (!words.length) return [];
  const marks = (n: number) => Array(n).fill("?").join(", ");
  const audienceClause = opts.guests ? "AND audience = 'shareable'" : "";
  const typeClause = opts.types?.length ? `AND source_type IN (${marks(opts.types.length)})` : "";
  const [dates, dateParams] = dateClause(orgId, opts);
  // The firm library is searched for the group in scopes[0]: leave out firm documents limited to other groups.
  const [limited, limitedParams] = scopes.includes(FIRM_SCOPE) ? limitedFirmClause(orgId, scopes[0]) : ["", []];
  const filters: Param[] = [orgId, ...scopes, ...(opts.types ?? []), ...dateParams, ...limitedParams];
  const where = `org_id = ? AND workspace_id IN (${marks(scopes.length)}) ${audienceClause} ${typeClause} ${dates} ${limited}`;
  if (DIALECT === "postgres") {
    // to_tsquery syntax: word:* = prefix match, | = OR. Words are letters/digits only, so they're safe here,
    // and the whole query still goes in as a bound parameter.
    const q = words.map((w) => `${w}:*`).join(" | ");
    return await all<Passage>(
      `SELECT rowid, text, title, loc, source_type, source_id, audience, workspace_id
         FROM passages
        WHERE tsv @@ to_tsquery('english', ?) AND ${where}
        ORDER BY ts_rank(tsv, to_tsquery('english', ?)) DESC LIMIT ?`,
      q, ...filters, q, opts.limit,
    );
  }
  return await all<Passage>(
    `SELECT rowid, text, title, loc, source_type, source_id, audience, workspace_id
       FROM passages
      WHERE passages MATCH ? AND ${where}
      ORDER BY bm25(passages, 1.0, 2.0) LIMIT ?`,
    words.map((w) => `"${w}"*`).join(" OR "), ...filters, opts.limit,
  );
}

/**
 * Local keyword search only (never Azure, so no embedding cost): the passages of one group's own sources of the
 * given types that share words with `text`. For background checks (the stale-document watcher, lib/watchers.ts)
 * that must stay cheap; answers use `searchPassages`/`findSources`. Always scoped to the org and the group.
 */
export async function localMatches(orgId: string, workspaceId: string, text: string, opts: { types?: SourceType[]; limit?: number } = {}): Promise<Passage[]> {
  return keywordSearch(orgId, [workspaceId], text, { types: opts.types, limit: opts.limit ?? 8 });
}

/* ---------- The answer pipeline: candidates → source facts → re-rank ---------- */

/** What the database knows about one source, for ranking and for the answer prompt. */
type SourceFacts = { date: string | null; hash: string | null; outdated: string | null; name: string | null };

/** Splits a list into pieces of `n` (keeps `IN (...)` lists short). */
const pieces = <T>(list: T[], n = 100) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/**
 * Looks up each passage's source in the database, scoped to the org: its date, its document's text hash, and
 * whether it's outdated (a firm document with "superseded by", or a group document with a newer upload of the
 * same name apart from the version: see `versionKey` in rank.ts).
 */
export async function sourceInfo(orgId: string, passages: Pick<Passage, "source_id" | "source_type">[]): Promise<Map<string, SourceFacts>> {
  const out = new Map<string, SourceFacts>();
  const ids = (type: string) => [...new Set(passages.filter((p) => p.source_type === type).map((p) => p.source_id))];
  const q = (n: number) => Array(n).fill("?").join(", ");
  for (const part of pieces(ids("document"))) {
    const rows = await all<{ id: string; name: string; created_at: string; content_hash: string | null; workspace_id: string }>(
      `SELECT id, name, created_at, content_hash, workspace_id FROM documents WHERE org_id = ? AND id IN (${q(part.length)})`, orgId, ...part,
    );
    for (const d of rows) {
      // A newer upload with the same name apart from the version makes this one outdated.
      const key = versionKey(d.name);
      const first = key.split(" ")[0] ?? "";
      const newer = first
        ? (await all<{ name: string }>(
            "SELECT name FROM documents WHERE org_id = ? AND workspace_id = ? AND status = 'Ready' AND id != ? AND created_at > ? AND LOWER(name) LIKE ? ORDER BY created_at DESC LIMIT 50",
            orgId, d.workspace_id, d.id, d.created_at, `${first}%`,
          )).find((x) => versionKey(x.name) === key && x.name !== d.name)
        : undefined;
      out.set(d.id, { date: d.created_at.slice(0, 10), hash: d.content_hash, outdated: newer ? `a newer version exists: ${newer.name}` : null, name: d.name });
    }
  }
  const meetingIds = [...new Set([...ids("meeting"), ...ids("notes").map((x) => x.replace(/:notes$/, ""))])];
  for (const part of pieces(meetingIds)) {
    for (const m of await all<{ id: string; held_at: string }>(`SELECT id, held_at FROM meetings WHERE org_id = ? AND id IN (${q(part.length)})`, orgId, ...part)) {
      const facts = { date: m.held_at.slice(0, 10), hash: null, outdated: null, name: null };
      out.set(m.id, facts);
      out.set(`${m.id}:notes`, facts);
    }
  }
  // Items saved to knowledge (lib/saved-items.ts, source id "saved:<item id>"): dated by their meeting.
  const savedIds = ids("notes").filter((x) => x.startsWith("saved:")).map((x) => x.slice(6));
  for (const part of pieces(savedIds)) {
    for (const r of await all<{ id: string; held_at: string | null; saved_at: string | null }>(
      `SELECT i.id, m.held_at, i.saved_at FROM items i LEFT JOIN meetings m ON m.id = i.meeting_id AND m.org_id = i.org_id WHERE i.org_id = ? AND i.id IN (${q(part.length)})`, orgId, ...part,
    )) {
      const day = r.held_at ?? r.saved_at;
      if (day) out.set(`saved:${r.id}`, { date: day.slice(0, 10), hash: null, outdated: null, name: null });
    }
  }
  for (const part of pieces(ids("chat"))) {
    for (const c of await all<{ id: string; sent_at: string }>(`SELECT id, sent_at FROM chat_messages WHERE org_id = ? AND id IN (${q(part.length)})`, orgId, ...part)) {
      out.set(c.id, { date: c.sent_at.slice(0, 10), hash: null, outdated: null, name: null });
    }
  }
  // Work items and Confluence pages (both connector_items): dated by when the tool last changed them.
  for (const part of pieces([...ids("workitem"), ...ids("page")])) {
    for (const w of await all<{ id: string; changed_at: string | null; synced_at: string }>(`SELECT id, changed_at, synced_at FROM connector_items WHERE org_id = ? AND id IN (${q(part.length)})`, orgId, ...part)) {
      out.set(w.id, { date: (w.changed_at ?? w.synced_at).slice(0, 10), hash: null, outdated: null, name: null });
    }
  }
  for (const part of pieces(ids("firm"))) {
    const rows = await all<{ id: string; title: string; effective_on: string | null; created_at: string; content_hash: string | null; replaced_by: string | null }>(
      `SELECT f.id, f.title, f.effective_on, f.created_at, f.content_hash, n.title AS replaced_by
         FROM firm_docs f LEFT JOIN firm_docs n ON n.id = f.superseded_by AND n.org_id = f.org_id
        WHERE f.org_id = ? AND f.id IN (${q(part.length)})`,
      orgId, ...part,
    );
    for (const f of rows) {
      out.set(f.id, { date: (f.effective_on ?? f.created_at).slice(0, 10), hash: f.content_hash, outdated: f.replaced_by ? `superseded by ${f.replaced_by}` : null, name: f.title });
    }
  }
  return out;
}

/** A source ready for the answer prompt and citations: a ranked passage plus its date and outdated flag. */
export type FoundSource = Ranked;

/**
 * The answer pipeline for Ask (portal and Teams): searches the group and its firm library (~30 candidates,
 * with the person's type and date filters), adds each source's facts (`sourceInfo`), then re-ranks,
 * de-duplicates and keeps the best `limit` (lib/rank.ts). Traced as its own step with counts only.
 */
export async function findSources(orgId: string, workspaceId: string, question: string, opts: SearchOpts = {}): Promise<FoundSource[]> {
  const limit = opts.limit ?? 10;
  const candidates = await searchPassages(orgId, workspaceId, question, { ...opts, limit: Math.max(30, limit * 3) });
  return span("rank", "Re-rank the sources", async () => {
    const info = await sourceInfo(orgId, candidates);
    const list: Candidate[] = candidates.map((p) => {
      const f = info.get(p.source_id);
      return { ...p, origin: p.source_type === "firm" || p.workspace_id === FIRM_SCOPE ? "firm" : "group", date: f?.date ?? null, hash: f?.hash ?? null, outdated: f?.outdated ?? null };
    });
    const ranked = rerank(question, list, { limit });
    spanAttrs({ candidates: candidates.length, kept: ranked.length, firm: ranked.filter((r) => r.origin === "firm").length, outdated: ranked.filter((r) => r.outdated).length });
    return ranked;
  });
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
