/**
 * @file Azure AI Search backend for Sidekick's search: keyword + meaning ("hybrid") search.
 *
 * Concepts
 * - **Azure AI Search**: Microsoft's hosted search engine. Sidekick keeps one index (`sidekick-passages`
 *   by default) holding a copy of every passage from the local SQLite index, with the same org,
 *   workspace and audience fields so every query is still walled to one org and one workspace.
 * - **Embedding / vector**: a list of ~1,500 numbers that captures what a passage *means*. Passages with
 *   similar meaning have similar vectors, so "go-live" can find a passage that only says "cutover".
 *   Vectors come from an Azure OpenAI embedding model (`text-embedding-3-small` by default) deployed in
 *   Microsoft Foundry.
 * - **Hybrid search**: Azure runs a keyword (BM25) search and a vector search together and merges the
 *   two rankings (reciprocal rank fusion). Exact terms like "CR-02" still match; paraphrases match too.
 * - **Mirror, not master**: SQLite stays the source of truth and the fallback. If Azure is not configured
 *   or a call fails, search.ts quietly uses the local keyword index instead. `npm run search:reindex`
 *   rebuilds the Azure copy from SQLite at any time.
 *
 * Configuration (app/.env.local; keys are secrets, never paste them in chat):
 *   AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_API_KEY, AZURE_SEARCH_INDEX (optional)
 *   AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_EMBEDDING_DEPLOYMENT (optional)
 * Without the AZURE_OPENAI_* settings, the Azure index works keyword-only.
 */
import "server-only";
import { AzureKeyCredential, SearchClient, SearchIndexClient, type SearchIndex } from "@azure/search-documents";
import { now, run } from "./db";
import type { Passage } from "./search";
import { span, spanAttrs, traceUserId } from "./trace";

const INDEX = process.env.AZURE_SEARCH_INDEX || "sidekick-passages";
const EMBED_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-3-small";
const DIMENSIONS = 1536; // text-embedding-3-small's native size
const EMBED_PRICE_PER_M = 0.02; // USD per million input tokens (text-embedding-3-small list price)

/** One passage as stored in Azure. `id` is `<sourceId>_<n>`; `vector` is absent when embeddings are off. */
export type AzurePassage = Omit<Passage, "rowid"> & { id: string; workspace_id: string; org_id: string; vector?: number[] };

/** True when the Azure AI Search endpoint and key are set. */
export const azureSearchConfigured = () => Boolean(process.env.AZURE_SEARCH_ENDPOINT && process.env.AZURE_SEARCH_API_KEY);
/** True when an Azure OpenAI embedding model is configured, so meaning-based (vector) search is on. */
export const embeddingsConfigured = () => Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY);

declare global {
  var __sidekickAzureSearch: { client: SearchClient<AzurePassage>; ready: Promise<void> } | undefined;
}

/** The shared search client. The index is created (or updated) the first time it's needed. */
function azure() {
  if (!globalThis.__sidekickAzureSearch) {
    const endpoint = process.env.AZURE_SEARCH_ENDPOINT!;
    const credential = new AzureKeyCredential(process.env.AZURE_SEARCH_API_KEY!);
    const ready = new SearchIndexClient(endpoint, credential).createOrUpdateIndex(indexDefinition()).then(() => undefined);
    // If creating the index fails, forget the client so the next call retries instead of failing forever.
    ready.catch(() => (globalThis.__sidekickAzureSearch = undefined));
    globalThis.__sidekickAzureSearch = { client: new SearchClient<AzurePassage>(endpoint, INDEX, credential), ready };
  }
  return globalThis.__sidekickAzureSearch;
}

/**
 * The index layout. org_id, workspace_id, audience and source_id are filterable so every query can be
 * walled; text and title are searchable (English analyzer); vector uses HNSW, the standard fast
 * nearest-neighbour method.
 */
function indexDefinition(): SearchIndex {
  return {
    name: INDEX,
    fields: [
      { name: "id", type: "Edm.String", key: true, filterable: true },
      { name: "text", type: "Edm.String", searchable: true, analyzerName: "en.microsoft" },
      { name: "title", type: "Edm.String", searchable: true, analyzerName: "en.microsoft" },
      { name: "loc", type: "Edm.String" },
      { name: "source_type", type: "Edm.String", filterable: true },
      { name: "source_id", type: "Edm.String", filterable: true },
      { name: "workspace_id", type: "Edm.String", filterable: true },
      { name: "org_id", type: "Edm.String", filterable: true },
      { name: "audience", type: "Edm.String", filterable: true },
      { name: "vector", type: "Collection(Edm.Single)", searchable: true, vectorSearchDimensions: DIMENSIONS, vectorSearchProfileName: "default" },
    ],
    vectorSearch: {
      algorithms: [{ name: "hnsw", kind: "hnsw" }],
      profiles: [{ name: "default", algorithmConfigurationName: "hnsw" }],
    },
  } as SearchIndex;
}

/**
 * Turns texts into vectors with the Azure OpenAI embedding model, in batches. Each call is metered in
 * usage_events as feature "embed" so its (tiny) cost shows up on the Usage page and Owner Console.
 */
async function embed(texts: string[], ctx: { orgId: string | null; workspaceId: string | null }): Promise<number[][]> {
  return span("embed", "Embeddings (meaning vectors)", () => embedInner(texts, ctx), { model: EMBED_DEPLOYMENT, texts: texts.length });
}

async function embedInner(texts: string[], ctx: { orgId: string | null; workspaceId: string | null }): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 8000));
    const started = Date.now();
    const res = await fetch(`${process.env.AZURE_OPENAI_ENDPOINT!.replace(/\/+$/, "")}/openai/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": process.env.AZURE_OPENAI_API_KEY! },
      body: JSON.stringify({ model: EMBED_DEPLOYMENT, input: batch }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number }; error?: { message?: string } };
    const tokens = json.usage?.prompt_tokens ?? 0;
    await run(
      `INSERT INTO usage_events (org_id, workspace_id, user_id, feature, model, input_tokens, output_tokens, cost_usd, latency_ms, ok, error, created_at)
       VALUES (?, ?, ?, 'embed', ?, ?, 0, ?, ?, ?, ?, ?)`,
      ctx.orgId, ctx.workspaceId, traceUserId(), EMBED_DEPLOYMENT, tokens, (tokens * EMBED_PRICE_PER_M) / 1_000_000, Date.now() - started,
      res.ok ? 1 : 0, res.ok ? null : (json.error?.message ?? `HTTP ${res.status}`).slice(0, 500), now(),
    );
    spanAttrs({ tokens: tokens });
    if (!res.ok || !json.data) throw new Error(`Embedding request failed: ${json.error?.message ?? res.status}`);
    for (const d of json.data.sort((a, b) => a.index - b.index)) out.push(d.embedding);
  }
  return out;
}

// OData string literal: single quotes are escaped by doubling them.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
// Azure document keys allow letters, digits, _ - and =.
const keyOf = (sourceId: string, n: number) => `${sourceId.replace(/[^A-Za-z0-9_\-=]/g, "_")}_${n}`;

/** Adds (or replaces) the passages of one document or meeting in the Azure index, with vectors if enabled. */
export async function azureIndex(p: { orgId: string; workspaceId: string; sourceType: string; sourceId: string; title: string; audience: string; pieces: { text: string; loc: string }[] }) {
  const { client, ready } = azure();
  await ready;
  const vectors = embeddingsConfigured() ? await embed(p.pieces.map((x) => `${p.title}\n${x.text}`), { orgId: p.orgId, workspaceId: p.workspaceId }) : null;
  const docs: AzurePassage[] = p.pieces.map((x, i) => ({
    id: keyOf(p.sourceId, i), text: x.text, title: p.title, loc: x.loc, source_type: p.sourceType as Passage["source_type"],
    source_id: p.sourceId, workspace_id: p.workspaceId, org_id: p.orgId, audience: p.audience,
    ...(vectors ? { vector: vectors[i] } : {}),
  }));
  for (let i = 0; i < docs.length; i += 500) await client.mergeOrUploadDocuments(docs.slice(i, i + 500));
}

/** How many passages the Azure index holds (0 for a brand-new index). */
export async function azureCount(): Promise<number> {
  const { client, ready } = azure();
  await ready;
  return client.getDocumentsCount();
}

/** Lists the Azure keys of every passage that belongs to one source. */
async function keysOf(client: SearchClient<AzurePassage>, sourceId: string) {
  const res = await client.search("*", { filter: `source_id eq ${lit(sourceId)}`, select: ["id"], top: 1000 });
  const ids: string[] = [];
  for await (const r of res.results) ids.push(r.document.id);
  return ids;
}

/** Removes every passage of one document or meeting from the Azure index. */
export async function azureRemove(sourceId: string) {
  const { client, ready } = azure();
  await ready;
  const ids = await keysOf(client, sourceId);
  if (ids.length) await client.deleteDocuments("id", ids);
}

/** Changes the audience (internal/shareable) of every passage of one source in the Azure index. */
export async function azureSetAudience(sourceId: string, audience: string) {
  const { client, ready } = azure();
  await ready;
  const ids = await keysOf(client, sourceId);
  if (ids.length) await client.mergeDocuments(ids.map((id) => ({ id, audience }) as AzurePassage));
}

/**
 * Hybrid search in one org's workspace. The filter is applied inside Azure before ranking, so results
 * can never come from another org or workspace (or from internal passages when guests are present).
 */
export async function azureSearch(orgId: string, workspaceId: string, question: string, opts: { guests?: boolean; limit: number }): Promise<Passage[]> {
  const { client, ready } = azure();
  await ready;
  const filter = [`org_id eq ${lit(orgId)}`, `workspace_id eq ${lit(workspaceId)}`, opts.guests ? `audience eq 'shareable'` : ""].filter(Boolean).join(" and ");
  const vector = embeddingsConfigured() ? (await embed([question], { orgId, workspaceId }))[0] : null;
  const res = await client.search(question, {
    filter,
    top: opts.limit,
    select: ["id", "text", "title", "loc", "source_type", "source_id", "audience"],
    ...(vector ? { vectorSearchOptions: { queries: [{ kind: "vector", vector, fields: ["vector"], kNearestNeighborsCount: 50 }] } } : {}),
  });
  const out: Passage[] = [];
  let n = 0;
  for await (const r of res.results) {
    const d = r.document;
    out.push({ rowid: n++, text: d.text, title: d.title, loc: d.loc, source_type: d.source_type, source_id: d.source_id, audience: d.audience });
  }
  return out;
}
