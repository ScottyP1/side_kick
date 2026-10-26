/**
 * @file Azure AI Search capacity: an hourly look at how full the search service is, so the operator upgrades the tier
 * before uploads start failing. Shown on the Owner Console only; customers never see it.
 *
 * Concepts
 * - **Tier**: the Azure AI Search pricing level. The live site runs **Free**: 50 MB of storage (Azure's portal says
 *   52 MB), 3 indexes, no uptime guarantee. **Basic** (about $75/month) has 15 GB and 15 indexes. Azure's service
 *   stats don't name the tier, so it is worked out from the index limit (`tierFromLimits`: 3 = Free, 15 = Basic…).
 * - **Service stats**: `GET {endpoint}/servicestats` (lib/azure-search.ts `azureServiceStats`, read through
 *   lib/search.ts `searchServiceStats`): storage and indexes used, with the tier's limits. Counts and sizes only.
 * - **Level** (`capacityLevel`): `warn` at 70% of storage or when all indexes but one are used; `full` at 90% of
 *   storage or when every index is used; else `ok`.
 * - **Alert**: when the level rises since the last check (ok → warn, warn → full) the operator log (`platform_log`, Owner Console →
 *   Releases) gets one entry and the server log a warning, so each step is raised once: at 70% and again at 90%. While
 *   the level is warn or full, the Owner Console home and Business pages show "Search is almost full: upgrade to
 *   Basic (about $75/month) before uploads fail". When it drops again (after an upgrade or clean-up), a later rise
 *   is raised again.
 * - **Schedule**: the job queue's `search.capacity` job, every hour (lib/job-kinds.ts). A no-op when Azure AI Search
 *   isn't configured (local keyword index: nothing to fill up). Upgrading the tier: docs/RUNBOOKS.md.
 *
 * Storage: one row in `search_capacity` (id 'azure': the latest counters, level, check time and error); no
 * organization's data.
 */
import "server-only";
import { get, now, run } from "./db";
import { searchServiceStats } from "./search";
import { span, spanAttrs } from "./trace";
import { azureSearchConfigured, type ServiceCounter } from "./azure-search";

/** How full the search service is: `warn` from 70% (or one index left), `full` from 90% (or no index left). */
export type CapacityLevel = "ok" | "warn" | "full";
const RANK: Record<CapacityLevel, number> = { ok: 0, warn: 1, full: 2 };
/** Storage share (percent) at which the operator is warned, and warned again. */
export const WARN_PCT = 70;
export const FULL_PCT = 90;
const ROW = "azure";

/** What the hourly check saves: the service's counters (bytes for storage). */
export type CapacityStats = { storage: ServiceCounter; indexes: ServiceCounter; documents: ServiceCounter | null; vectorStorage: ServiceCounter | null };

/** Percent of `c`'s quota in use (0–100+, one decimal), or null when the tier sets no limit. */
export const pctOf = (c: ServiceCounter | null | undefined): number | null => (c && c.quota ? Math.round((c.usage / c.quota) * 1000) / 10 : null);

/**
 * The level for these counters (see the file comment). Pure, so tests call it directly: storage at or above 90% or
 * every index used is `full`; storage at or above 70% or all indexes but one used is `warn`.
 */
export function capacityLevel(s: Pick<CapacityStats, "storage" | "indexes">): CapacityLevel {
  const storage = pctOf(s.storage) ?? 0;
  const left = s.indexes.quota === null ? Infinity : s.indexes.quota - s.indexes.usage;
  if (storage >= FULL_PCT || left <= 0) return "full";
  if (storage >= WARN_PCT || left <= 1) return "warn";
  return "ok";
}

/** The tier, worked out from the index limit (Azure doesn't say it): Free 3, Basic 15, Standard S1 50, S2/S3 200. */
export function tierFromLimits(indexQuota: number | null): string | null {
  return ({ 3: "Free", 15: "Basic", 50: "Standard S1", 200: "Standard S2 or S3", 1000: "Standard S3 (high density)" } as Record<number, string>)[indexQuota ?? -1] ?? null;
}

/** The alert sentence for a tier at this level (null when `ok`). From Free the next step is Basic; above it, a bigger tier. */
export function capacityMessage(level: CapacityLevel, tier: string | null): string | null {
  if (level === "ok") return null;
  return tier === "Free"
    ? "Search is almost full: upgrade to Basic (about $75/month) before uploads fail"
    : "Search is almost full: move to a bigger tier or add a partition before uploads fail";
}

/**
 * The hourly check (job `search.capacity`): reads the service's usage, saves it, and raises the operator alert when
 * the level rose since the last check (so once per step: 70%, then 90%). Traced as a "search" step (counts only). Does nothing at all when Azure AI Search isn't
 * configured. A failed read is saved on the row (shown on the Owner Console with the last good numbers) and logged,
 * not thrown, so the job doesn't retry a wrong key every few minutes. Returns counts for the job report.
 */
export async function checkSearchCapacity(): Promise<{ searchChecked: number; searchAlerts: number; searchCheckFailed: number }> {
  if (!azureSearchConfigured()) return { searchChecked: 0, searchAlerts: 0, searchCheckFailed: 0 }; // local keyword index: nothing to watch
  return span("search", "Check search capacity", checkInner);
}

async function checkInner() {
  const none = { searchChecked: 0, searchAlerts: 0, searchCheckFailed: 0 };
  let stats: CapacityStats | null;
  try {
    stats = await searchServiceStats();
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    console.error("Search capacity check failed", e);
    await run(
      `INSERT INTO search_capacity (id, json, level, checked_at, error) VALUES (?, NULL, 'ok', ?, ?)
       ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
      ROW, now(), error,
    );
    return { ...none, searchCheckFailed: 1 };
  }
  if (!stats) return none;
  const level = capacityLevel(stats);
  const before = (await get<{ level: CapacityLevel }>("SELECT level FROM search_capacity WHERE id = ?", ROW))?.level ?? "ok";
  let alerts = 0;
  if (RANK[level] > RANK[before]) {
    const tier = tierFromLimits(stats.indexes.quota);
    const line = `${capacityMessage(level, tier)} (storage ${pctOf(stats.storage) ?? "?"}% used, indexes ${stats.indexes.usage} of ${stats.indexes.quota ?? "no limit"}, tier ${tier ?? "unknown"})`;
    await run("INSERT INTO platform_log (actor, action, created_at) VALUES (?, ?, ?)", "Search capacity check", line, now());
    console.warn(`[search] ${line}`);
    alerts = 1;
  }
  // The saved level is what the next check compares with: falling back (after an upgrade) lets a later rise alert again.
  await run(
    `INSERT INTO search_capacity (id, json, level, checked_at, error) VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (id) DO UPDATE SET json = excluded.json, level = excluded.level, checked_at = excluded.checked_at, error = NULL`,
    ROW, JSON.stringify(stats), level, now(),
  );
  spanAttrs({ level, storagePct: pctOf(stats.storage), alerts });
  return { searchChecked: 1, searchAlerts: alerts, searchCheckFailed: 0 };
}

/** What the Owner Console shows (`searchCapacity`). Percentages are of the tier's limits. */
export type CapacityView = {
  tier: string | null;
  storage: { usedBytes: number; quotaBytes: number | null; pct: number | null } | null;
  indexes: { used: number; quota: number | null; pct: number | null } | null;
  documents: number | null;
  level: CapacityLevel;
  message: string | null;
  checkedAt: string | null;
  error: string | null;
};

/**
 * The latest saved capacity for the Owner Console (operators only; the routes check `requireOwner`). Null when Azure
 * AI Search isn't configured. Before the first check it says so (`checkedAt` null).
 */
export async function searchCapacity(): Promise<CapacityView | null> {
  if (!azureSearchConfigured()) return null;
  const row = await get<{ json: string | null; level: CapacityLevel; checked_at: string; error: string | null }>("SELECT json, level, checked_at, error FROM search_capacity WHERE id = ?", ROW);
  if (!row) return { tier: null, storage: null, indexes: null, documents: null, level: "ok", message: null, checkedAt: null, error: null };
  const s = row.json ? (JSON.parse(row.json) as CapacityStats) : null;
  const tier = s ? tierFromLimits(s.indexes.quota) : null;
  const level = s ? row.level : "ok";
  return {
    tier,
    storage: s ? { usedBytes: s.storage.usage, quotaBytes: s.storage.quota, pct: pctOf(s.storage) } : null,
    indexes: s ? { used: s.indexes.usage, quota: s.indexes.quota, pct: pctOf(s.indexes) } : null,
    documents: s?.documents?.usage ?? null,
    level,
    message: capacityMessage(level, tier),
    checkedAt: row.checked_at,
    error: row.error,
  };
}
