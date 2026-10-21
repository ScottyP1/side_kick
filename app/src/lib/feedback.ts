/**
 * @file 👍/👎 feedback on answers, in the portal (Ask on the Knowledge page) and on Teams answer cards.
 *
 * Concepts
 * - **One vote per person per answer** (`answer_feedback`, unique on question + person): clicking again changes
 *   the vote. The answer is the `questions` row `ask()` saved (its id is the `questionId` it returned).
 * - **Walls**: a vote is only accepted for an answer in the voter's own organization and group (the portal route
 *   checks the group with `requireWorkspace`; Teams checks the chat is linked to the answer's group).
 * - **Counts only**: no question or answer text is stored with a vote or shown with the counts. Org Owners/Admins
 *   see their organization's counts per group and per week (Knowledge page); the Sidekick team sees the trend per
 *   client in the Owner Console (Performance), also counts only.
 *
 * Who calls it: /api/feedback (portal), the Teams bot's card buttons (lib/teams/bot.ts), /api/owner/performance.
 */
import "server-only";
import { all, get, newId, now, run } from "./db";
import { HttpError } from "./auth";
import { span } from "./trace";

/** A vote: 1 = 👍 helpful, -1 = 👎 not helpful. */
export type Vote = 1 | -1;

/** Reads "up"/"down" (or 1/-1) into a vote, or throws 400. */
export function parseVote(value: unknown): Vote {
  if (value === "up" || value === 1) return 1;
  if (value === "down" || value === -1) return -1;
  throw new HttpError(400, "Vote must be up or down.");
}

/**
 * Records (or changes) one person's vote on one answer. The answer must belong to `orgId` and `workspaceId`
 * (404 otherwise, so ids from another group or org can't be voted on or probed).
 */
export async function recordFeedback(orgId: string, workspaceId: string, questionId: string, userId: string, vote: Vote, channel: "portal" | "teams") {
  return span("feedback", "Record answer feedback", async () => {
    const q = await get<{ id: string }>("SELECT id FROM questions WHERE id = ? AND org_id = ? AND workspace_id = ?", questionId, orgId, workspaceId);
    if (!q) throw new HttpError(404, "That answer wasn't found in this group.");
    await run(
      `INSERT INTO answer_feedback (id, org_id, workspace_id, question_id, user_id, vote, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (question_id, user_id) DO UPDATE SET vote = excluded.vote, channel = excluded.channel, created_at = excluded.created_at`,
      newId(), orgId, workspaceId, questionId, userId, vote, channel, now(),
    );
  }, { vote, channel });
}

/** Monday (YYYY-MM-DD) of the week a timestamp falls in, for weekly trends. */
export function weekOf(at: string): string {
  const d = new Date(`${at.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Up and down counts with the share of 👍 (null when there are no votes). */
const tally = (up: number, down: number) => ({ up, down, helpful: up + down ? Math.round((up / (up + down)) * 100) : null });

/**
 * One organization's feedback since a day: totals, per group (with the group's name) and per week, plus how many
 * answers were given and how many were "I don't know" in the same period. Counts only; for Org Owners/Admins.
 */
export async function feedbackSummary(orgId: string, since: string) {
  const rows = await all<{ workspace_id: string; name: string | null; vote: number; channel: string; day: string; n: number }>(
    `SELECT f.workspace_id, w.name, f.vote, f.channel, SUBSTR(f.created_at, 1, 10) AS day, COUNT(*) AS n
       FROM answer_feedback f LEFT JOIN workspaces w ON w.id = f.workspace_id AND w.org_id = f.org_id
      WHERE f.org_id = ? AND f.created_at >= ?
      GROUP BY f.workspace_id, w.name, f.vote, f.channel, SUBSTR(f.created_at, 1, 10)`,
    orgId, since,
  );
  const answers = await get<{ total: number; found: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(found), 0) AS found FROM questions WHERE org_id = ? AND created_at >= ?", orgId, since);
  const groups = new Map<string, { id: string; name: string; up: number; down: number }>();
  const weeks = new Map<string, { up: number; down: number }>();
  let up = 0;
  let down = 0;
  let teams = 0;
  for (const r of rows) {
    const g = groups.get(r.workspace_id) ?? { id: r.workspace_id, name: r.name ?? "Deleted group", up: 0, down: 0 };
    const w = weeks.get(weekOf(r.day)) ?? { up: 0, down: 0 };
    if (r.vote > 0) {
      g.up += r.n;
      w.up += r.n;
      up += r.n;
    } else {
      g.down += r.n;
      w.down += r.n;
      down += r.n;
    }
    if (r.channel === "teams") teams += r.n;
    groups.set(r.workspace_id, g);
    weeks.set(weekOf(r.day), w);
  }
  return {
    since,
    total: tally(up, down),
    fromTeams: teams,
    answers: { total: answers?.total ?? 0, dontKnow: (answers?.total ?? 0) - (answers?.found ?? 0) },
    groups: [...groups.values()].map((g) => ({ ...g, ...tally(g.up, g.down) })).sort((a, b) => b.up + b.down - (a.up + a.down)),
    weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, w]) => ({ week, ...tally(w.up, w.down) })),
  };
}

/**
 * Answer quality per client for the Owner Console since a day: votes up/down, share helpful, answers given and
 * "I don't know" share, and a weekly trend across all clients. Counts only, never text.
 */
export async function qualityTrends(since: string) {
  const votes = await all<{ org_id: string; vote: number; day: string; n: number }>(
    "SELECT org_id, vote, SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS n FROM answer_feedback WHERE created_at >= ? GROUP BY org_id, vote, SUBSTR(created_at, 1, 10)",
    since,
  );
  const asked = await all<{ org_id: string; total: number; found: number }>(
    "SELECT org_id, COUNT(*) AS total, COALESCE(SUM(found), 0) AS found FROM questions WHERE created_at >= ? GROUP BY org_id",
    since,
  );
  const names = new Map((await all<{ id: string; name: string }>("SELECT id, name FROM orgs")).map((o) => [o.id, o.name]));
  const clients = new Map<string, { orgId: string; client: string; up: number; down: number; answers: number; dontKnow: number }>();
  const row = (orgId: string) => clients.get(orgId) ?? { orgId, client: names.get(orgId) ?? "Deleted client", up: 0, down: 0, answers: 0, dontKnow: 0 };
  const weeks = new Map<string, { up: number; down: number }>();
  for (const v of votes) {
    const c = row(v.org_id);
    const w = weeks.get(weekOf(v.day)) ?? { up: 0, down: 0 };
    if (v.vote > 0) {
      c.up += v.n;
      w.up += v.n;
    } else {
      c.down += v.n;
      w.down += v.n;
    }
    clients.set(v.org_id, c);
    weeks.set(weekOf(v.day), w);
  }
  for (const a of asked) {
    const c = row(a.org_id);
    c.answers = a.total;
    c.dontKnow = a.total - a.found;
    clients.set(a.org_id, c);
  }
  return {
    since,
    clients: [...clients.values()].map((c) => ({ ...c, ...tally(c.up, c.down), dontKnowShare: c.answers ? Math.round((c.dontKnow / c.answers) * 100) : null })).sort((a, b) => b.answers - a.answers),
    weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, w]) => ({ week, ...tally(w.up, w.down) })),
  };
}
