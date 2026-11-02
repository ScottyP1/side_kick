/**
 * @file Who writes a meeting's notes when Sidekick was in it live (docs/LIVE-MEETINGS.md → "Notes afterwards: no
 * duplicates"). Two paths could write them: the Teams transcript (lib/meetings-graph.ts `fetchTranscript`) and the
 * live session's own transcript (lib/live-meetings/sessions.ts `handoffLive`). Each claims the session row with a
 * compare-and-set on `live_sessions.handoff`, so exactly one wins:
 * - `claimForGraph` (the Teams transcript arrived): sessions in the same meeting chat around that time that nobody
 *   claimed yet become `graph`; if the live path already wrote notes (`live`), the Teams transcript is skipped.
 * - `handoffLive` sets `live` only where it's still unclaimed.
 * Kept apart from sessions.ts (no Teams or provider imports) so lib/meetings-graph.ts can use it without a cycle.
 *
 * Whichever path writes the notes also gets what Sidekick heard and said live (`liveContext`): the sessions' running
 * lists (owners and dates, including replies to Sidekick's own "by when…?") and Sidekick's own answers in the meeting
 * (`live_lines` with source `sidekick`, written by sessions.ts `noteOwnAnswer`). It's saved on the meeting
 * (`meetings.live_context`) and read by the notes (lib/sidekick.ts processMeeting, lib/meeting-notes-rules.ts).
 * Who may call: lib/meetings-graph.ts, lib/live-meetings/sessions.ts. Org-scoped (every query names the org).
 */
import "server-only";
import { all, get, now, run } from "../db";
import type { LiveContext } from "../meeting-notes-rules";

/** How far around a transcript's start a live session of the same meeting chat counts as the same meeting. */
const WINDOW_MS = 6 * 3600_000;
const windowAround = (startedAt: string | null) => {
  const at = Date.parse(startedAt ?? "") || Date.now();
  return [new Date(at - WINDOW_MS).toISOString(), new Date(at + WINDOW_MS).toISOString()];
};

/**
 * The Teams transcript of a meeting in chat `threadId` that started at `startedAt` is about to be captured. Returns
 * `"live"` when Sidekick already wrote that meeting's notes from its live session (skip the transcript), `"graph"`
 * when there were live sessions and the transcript now writes the notes (they won't), or null when Sidekick wasn't
 * there live.
 */
export async function claimForGraph(orgId: string, threadId: string | null, startedAt: string | null): Promise<"live" | "graph" | null> {
  if (!threadId) return null;
  const window = windowAround(startedAt);
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

/** A JSON list column of `live_sessions` (decisions, action_items), or [] when unreadable. */
function listOf<T>(json: string | null): T[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * What Sidekick heard and said live in sessions `ids` (see the file comment): their running lists and Sidekick's own
 * answers, in order. Null when there's nothing. Read before the live lines are deleted.
 */
export async function liveContext(orgId: string, ids: string[]): Promise<LiveContext | null> {
  const ctx: LiveContext = { decisions: [], actions: [], answers: [] };
  for (const id of ids) {
    const s = await get<{ decisions: string | null; action_items: string | null }>("SELECT decisions, action_items FROM live_sessions WHERE id = ? AND org_id = ?", id, orgId);
    if (!s) continue;
    ctx.decisions.push(...listOf<LiveContext["decisions"][number]>(s.decisions).map((d) => ({ text: d.text, who: d.who ?? null })));
    ctx.actions.push(...listOf<LiveContext["actions"][number]>(s.action_items).map((a) => ({ text: a.text, who: a.who ?? null, due: a.due ?? null })));
    const said = await all<{ text: string }>("SELECT text FROM live_lines WHERE org_id = ? AND session_id = ? AND source = 'sidekick' ORDER BY said_at, id", orgId, id);
    for (const l of said) {
      try {
        const a = JSON.parse(l.text) as { question?: unknown; answer?: unknown };
        if (typeof a.question === "string" && typeof a.answer === "string") ctx.answers.push({ question: a.question, answer: a.answer });
      } catch {
        // Not one of ours: skip it.
      }
    }
  }
  return ctx.decisions.length || ctx.actions.length || ctx.answers.length ? ctx : null;
}

/**
 * The Teams transcript writes the notes (`claimForGraph` said `graph`): what Sidekick heard and said live in that
 * meeting's sessions, as JSON for `meetings.live_context`, or null.
 */
export async function graphLiveContext(orgId: string, threadId: string | null, startedAt: string | null): Promise<string | null> {
  if (!threadId) return null;
  const rows = await all<{ id: string }>(
    "SELECT id FROM live_sessions WHERE org_id = ? AND thread_id = ? AND handoff = 'graph' AND created_at >= ? AND created_at <= ? ORDER BY created_at",
    orgId, threadId, ...windowAround(startedAt),
  );
  const ctx = await liveContext(orgId, rows.map((r) => r.id));
  return ctx ? JSON.stringify(ctx) : null;
}
