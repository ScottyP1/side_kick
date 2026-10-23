/**
 * GET /api/activity?view=…: the client's observability data (Activity page and the live home orb).
 * Who: Org Owners and Org Admins; `live` (the home orb) is open to everyone signed in, but only admins
 * see names of active people (others get a count). Everything is filtered to the caller's own organization.
 *
 * Views
 * - overview (&days=1|7|30): request volume, failures, response times (p50/p95), AI calls and cost,
 *   portal vs Teams, the busiest operations, requests per day, and guardrail counts per rule
 *   (`guardrails`, from guard_events: counts only).
 * - traces (&channel=portal|teams|system&status=error|refused|ok&q=text&limit=…): the most recent traces.
 * - trace (&id=…): one trace with all its steps (spans), for the waterfall.
 * - messages (&limit=…): questions asked in the portal and in Teams, and whether they were answered.
 * - live: the last few minutes, for the home page orb: active people, each connection's health
 *   (Teams, Claude, search, database), and recent work (used to tell whether Sidekick is busy).
 *
 * Traces hold timings, counts, model names and costs only; no document text (see lib/trace.ts). Model names
 * are left out of what the portal gets (they're for the Owner Console).
 */
import { guardSummary } from "@/lib/guardrails";
import { handle } from "@/lib/api";
import { HttpError, isAdmin, requireUser } from "@/lib/auth";
import { all, DIALECT, get } from "@/lib/db";
import { claudeConfigured } from "@/lib/claude";
import { azureSearchConfigured, embeddingsConfigured } from "@/lib/azure-search";

type TraceRow = { id: string; channel: string; name: string; actor: string | null; status: string; http_status: number | null; error: string | null; ref: string | null; duration_ms: number; span_count: number; db_queries: number; db_ms: number; started_at: string; workspace: string | null };

/** The p-th percentile (0-100) of a list of numbers, or 0 for an empty list. */
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const view = q.get("view") ?? "overview";
  const user = await requireUser(view === "live" ? undefined : ["Org Owner", "Org Admin"]);
  const org = user.org_id;

  if (view === "overview") {
    const days = [1, 7, 30].includes(Number(q.get("days"))) ? Number(q.get("days")) : 7;
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = await all<{ name: string; channel: string; status: string; http_status: number | null; duration_ms: number; started_at: string; actor: string | null }>(
      "SELECT name, channel, status, http_status, duration_ms, started_at, actor FROM traces WHERE org_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 20000",
      org, since,
    );
    const durations = rows.map((r) => r.duration_ms);
    const failed = rows.filter((r) => r.status === "error").length;
    const refused = rows.filter((r) => r.status !== "error" && (r.http_status ?? 0) >= 400).length;
    const ops = new Map<string, { count: number; errors: number; d: number[] }>();
    for (const r of rows) {
      const o = ops.get(r.name) ?? { count: 0, errors: 0, d: [] };
      o.count++;
      if (r.status === "error") o.errors++;
      o.d.push(r.duration_ms);
      ops.set(r.name, o);
    }
    const dayCount = days === 1 ? 24 : days;
    const bucket = (iso: string) => (days === 1 ? iso.slice(0, 13) : iso.slice(0, 10)); // hours for "today", days otherwise
    const series = Array.from({ length: dayCount }, (_, i) => {
      const t = new Date(Date.now() - (dayCount - 1 - i) * (days === 1 ? 3600_000 : 86400_000)).toISOString();
      return { key: bucket(t), requests: 0, errors: 0 };
    });
    const byKey = new Map(series.map((s) => [s.key, s]));
    for (const r of rows) {
      const s = byKey.get(bucket(r.started_at));
      if (s) {
        s.requests++;
        if (r.status === "error") s.errors++;
      }
    }
    const ai = await get<{ calls: number; cost: number; failed: number }>(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(1 - ok), 0) AS failed FROM usage_events WHERE org_id = ? AND created_at >= ?",
      org, since,
    );
    const asked = await get<{ total: number; found: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(found), 0) AS found FROM questions WHERE org_id = ? AND created_at >= ?",
      org, since,
    );
    const guard = await guardSummary(org, since);
    return {
      days,
      guardrails: guard,
      kpis: {
        requests: rows.length,
        failed,
        refused,
        errorRate: rows.length ? failed / rows.length : 0,
        p50: pct(durations, 50),
        p95: pct(durations, 95),
        teams: rows.filter((r) => r.channel === "teams").length,
        portal: rows.filter((r) => r.channel === "portal").length,
        background: rows.filter((r) => r.channel === "system").length,
        people: new Set(rows.map((r) => r.actor).filter(Boolean)).size,
        aiCalls: ai?.calls ?? 0,
        aiCost: ai?.cost ?? 0,
        aiFailed: ai?.failed ?? 0,
        questions: asked?.total ?? 0,
        answered: asked?.found ?? 0,
      },
      series,
      operations: [...ops.entries()]
        .map(([name, o]) => ({ name, count: o.count, errors: o.errors, p50: pct(o.d, 50), p95: pct(o.d, 95) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12),
    };
  }

  if (view === "traces") {
    const where = ["t.org_id = ?"];
    const params: (string | number)[] = [org];
    const channel = q.get("channel");
    if (channel === "portal" || channel === "teams" || channel === "system") {
      where.push("t.channel = ?");
      params.push(channel);
    }
    const status = q.get("status");
    if (status === "error") where.push("t.status = 'error'");
    if (status === "refused") where.push("t.status <> 'error' AND t.http_status >= 400");
    if (status === "ok") where.push("t.status <> 'error' AND (t.http_status IS NULL OR t.http_status < 400)");
    const text = (q.get("q") ?? "").trim().slice(0, 80);
    if (text) {
      where.push("(lower(t.name) LIKE ? OR lower(coalesce(t.actor, '')) LIKE ? OR coalesce(t.ref, '') = ?)");
      params.push(`%${text.toLowerCase()}%`, `%${text.toLowerCase()}%`, text.toUpperCase());
    }
    const limit = Math.min(500, Math.max(10, Number(q.get("limit")) || 200));
    const traces = await all<TraceRow>(
      `SELECT t.id, t.channel, t.name, t.actor, t.status, t.http_status, t.error, t.ref, t.duration_ms, t.span_count, t.db_queries, t.db_ms, t.started_at, w.name AS workspace
         FROM traces t LEFT JOIN workspaces w ON w.id = t.workspace_id
        WHERE ${where.join(" AND ")} ORDER BY t.started_at DESC LIMIT ?`,
      ...params, limit,
    );
    return { traces };
  }

  if (view === "trace") {
    const trace = await get<TraceRow>(
      `SELECT t.id, t.channel, t.name, t.actor, t.status, t.http_status, t.error, t.ref, t.duration_ms, t.span_count, t.db_queries, t.db_ms, t.started_at, w.name AS workspace
         FROM traces t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ? AND t.org_id = ?`,
      q.get("id") ?? "", org,
    );
    if (!trace) throw new HttpError(404, "Trace not found.");
    const spans = (
      await all<{ span_id: string; parent_id: string | null; kind: string; name: string; start_ms: number; duration_ms: number; status: string; error: string | null; attrs: string }>(
        "SELECT span_id, parent_id, kind, name, start_ms, duration_ms, status, error, attrs FROM trace_spans WHERE trace_id = ? ORDER BY start_ms, span_id",
        trace.id,
      )
    ).map((s) => {
      // Model names stay in the Owner Console: the portal shows plain "AI" steps.
      const { model: _model, ...attrs } = JSON.parse(s.attrs || "{}") as Record<string, unknown>;
      return { ...s, attrs };
    });
    return { trace, spans };
  }

  if (view === "messages") {
    const limit = Math.min(500, Math.max(10, Number(q.get("limit")) || 200));
    const messages = await all(
      `SELECT q.id, q.question, q.found, q.created_at, coalesce(q.asked_by, u.name) AS asked_by,
              coalesce(q.channel, CASE WHEN q.user_id LIKE 'teams:%' THEN 'teams' ELSE 'portal' END) AS channel, w.name AS workspace
         FROM questions q LEFT JOIN users u ON u.id = q.user_id LEFT JOIN workspaces w ON w.id = q.workspace_id
        WHERE q.org_id = ? ORDER BY q.created_at DESC LIMIT ?`,
      org, limit,
    );
    return { messages };
  }

  if (view === "live") {
    const since15 = new Date(Date.now() - 15 * 60_000).toISOString();
    const since60 = new Date(Date.now() - 60 * 60_000).toISOString();
    const people = await all<{ actor: string; channel: string; last: string }>(
      "SELECT actor, channel, MAX(started_at) AS last FROM traces WHERE org_id = ? AND started_at >= ? AND actor IS NOT NULL GROUP BY actor, channel ORDER BY MAX(started_at) DESC LIMIT 12",
      org, since15,
    );
    // Health per connection over the last hour, from the steps that used it.
    const kindStats = await all<{ kind: string; n: number; errors: number; avg: number; last: string }>(
      `SELECT s.kind, COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END), 0) AS errors, COALESCE(AVG(s.duration_ms), 0) AS avg, MAX(t.started_at) AS last
         FROM trace_spans s JOIN traces t ON t.id = s.trace_id
        WHERE t.org_id = ? AND t.started_at >= ? GROUP BY s.kind`,
      org, since60,
    );
    const k = (kind: string) => kindStats.find((x) => x.kind === kind);
    const health = (kind: string, configured: boolean) => {
      const s = k(kind);
      if (!configured) return { state: "off" as const, calls: 0, errors: 0, avgMs: 0, last: null };
      if (!s) return { state: "idle" as const, calls: 0, errors: 0, avgMs: 0, last: null };
      const state = s.errors / s.n > 0.2 ? "failing" : s.errors > 0 || s.avg > 8000 ? "degraded" : "ok";
      return { state, calls: s.n, errors: s.errors, avgMs: Math.round(s.avg), last: s.last };
    };
    const teamsLinks = await get<{ n: number; last: string | null }>(
      "SELECT COUNT(*) AS n, MAX(last_seen_at) AS last FROM teams_conversations WHERE org_id = ? AND workspace_id IS NOT NULL",
      org,
    );
    const recent = await all<{ id: string; channel: string; name: string; status: string; started_at: string; duration_ms: number; kinds: string }>(
      `SELECT t.id, t.channel, t.name, t.status, t.started_at, t.duration_ms,
              (SELECT ${DIALECT === "postgres" ? "string_agg(DISTINCT s.kind, ',')" : "group_concat(DISTINCT s.kind)"} FROM trace_spans s WHERE s.trace_id = t.id) AS kinds
         FROM traces t WHERE t.org_id = ? AND t.name NOT LIKE 'GET %' ORDER BY t.started_at DESC LIMIT 12`,
      org,
    );
    return {
      now: new Date().toISOString(),
      peopleCount: new Set(people.map((p) => p.actor)).size,
      people: isAdmin(user) ? people : [],
      connections: {
        teams: { ...health("teams", Boolean(teamsLinks?.n)), linked: teamsLinks?.n ?? 0, lastSeen: teamsLinks?.last ?? null },
        claude: health("ai", claudeConfigured() || process.env.SIDEKICK_FAKE_CLAUDE === "1"),
        search: { ...health("search", true), engine: azureSearchConfigured() ? (embeddingsConfigured() ? "Azure AI Search (hybrid)" : "Azure AI Search") : "Local keyword search" },
        database: { state: "ok" as const, engine: DIALECT === "postgres" ? "PostgreSQL" : "SQLite" },
      },
      recent: recent.map((r) => ({ ...r, kinds: (r.kinds ?? "").split(",").filter(Boolean) })),
      busy: recent.some((r) => Date.now() - new Date(r.started_at).getTime() < 20_000),
    };
  }

  throw new HttpError(400, "Unknown activity view.");
});
