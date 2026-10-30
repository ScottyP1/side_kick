/**
 * @file Who writes a meeting's notes when Sidekick was in it live (docs/LIVE-MEETINGS.md → "Notes afterwards: no
 * duplicates"). Two paths could write them: the Teams transcript (lib/meetings-graph.ts `fetchTranscript`) and the
 * live session's own transcript (lib/live-meetings/sessions.ts `handoffLive`). Each claims the session row with a
 * compare-and-set on `live_sessions.handoff`, so exactly one wins:
 * - `claimForGraph` (the Teams transcript arrived): sessions in the same meeting chat around that time that nobody
 *   claimed yet become `graph`; if the live path already wrote notes (`live`), the Teams transcript is skipped.
 * - `handoffLive` sets `live` only where it's still unclaimed.
 * Kept apart from sessions.ts (no Teams or provider imports) so lib/meetings-graph.ts can use it without a cycle.
 * Who may call: lib/meetings-graph.ts. Org-scoped (every query names the org).
 */
import "server-only";
import { all, now, run } from "../db";

/** How far around a transcript's start a live session of the same meeting chat counts as the same meeting. */
const WINDOW_MS = 6 * 3600_000;

/**
 * The Teams transcript of a meeting in chat `threadId` that started at `startedAt` is about to be captured. Returns
 * `"live"` when Sidekick already wrote that meeting's notes from its live session (skip the transcript), `"graph"`
 * when there were live sessions and the transcript now writes the notes (they won't), or null when Sidekick wasn't
 * there live.
 */
export async function claimForGraph(orgId: string, threadId: string | null, startedAt: string | null): Promise<"live" | "graph" | null> {
  if (!threadId) return null;
  const at = Date.parse(startedAt ?? "") || Date.now();
  const window = [new Date(at - WINDOW_MS).toISOString(), new Date(at + WINDOW_MS).toISOString()];
  const rows = await all<{ id: string; handoff: string | null }>(
    "SELECT id, handoff FROM live_sessions WHERE org_id = ? AND thread_id = ? AND joined_at IS NOT NULL AND created_at >= ? AND created_at <= ?",
    orgId, threadId, ...window,
  );
  if (!rows.length) return null;
  if (rows.some((r) => r.handoff === "live")) return "live";
  let lost = false;
  for (const r of rows.filter((x) => !x.handoff)) {
    const claim = await run("UPDATE live_sessions SET handoff = 'graph', updated_at = ? WHERE id = ? AND org_id = ? AND handoff IS NULL", now(), r.id, orgId);
    // Someone else set it between the read and here: only the live path can have (it's the only other writer).
    if (!claim.changes) lost = true;
  }
  if (lost) {
    const again = await all<{ handoff: string | null }>("SELECT handoff FROM live_sessions WHERE org_id = ? AND thread_id = ? AND handoff = 'live' AND created_at >= ? AND created_at <= ?", orgId, threadId, ...window);
    if (again.length) return "live";
  }
  return "graph";
}
