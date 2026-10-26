/**
 * @file What a customer firm may see of its own AI use, and the shared usage export. The rule (Oct 25, 2026):
 * a firm sees **what Sidekick did** for it (activity counts) and **how much of its plan's included AI it has
 * used** (a percentage), never what that AI cost us, how many tokens it took, how long each call ran or which
 * models did the work. Those are Sidekick's own internals and live only in the Owner Console (/owner).
 *
 * Concepts
 * - **Activity counts** (`activityCounts`): questions asked and answered, meetings written up, documents added,
 *   reminder cards posted in Teams and in-app assistant replies, for a period, in total, per group and per day.
 *   Counted from the work itself (questions, meetings, documents, reminder_runs), plus the assistant's metered
 *   calls (usage_events, count only).
 * - **AI allowance** (`allowanceOf`): the monthly AI credit (lib/credit.ts) turned into a percent and a level
 *   (ok / warn at 80% / essentials at 100% / unlimited), with no dollar amounts. The credit itself still runs
 *   in dollars underneath; only what the firm is shown changes.
 * - **Firm limit lines** (`firmLimits`): the plan limits report (lib/limits.ts) without the AI credit line, which
 *   is in dollars. The allowance shows that limit instead.
 * - **Firm trace attributes** (`firmAttrs`): a trace step's attributes without model names, token counts or
 *   costs (`OPERATOR_ONLY_KEY`). Timings, result counts and the like stay.
 * - **Usage export** (`usageCsv`): the per-group, per-month CSV. Firms get counts only; the Owner Console's copy
 *   (`withCost`) adds AI requests and AI cost for chargeback and margin checks.
 *
 * Who may import it: server code only (API routes for the portal and the Owner Console). Every function takes an
 * org id the caller has already checked (`requireUser` / `requireOwner`) and filters on it.
 */
import "server-only";
import { all } from "./db";
import type { CreditStatus } from "./credit";
import type { LimitLine } from "./limits";

/**
 * Attribute keys that are operator-only: model names, token counts and costs (e.g. `model`, `input_tokens`,
 * `cost_usd`). Used to clean trace steps for the portal, and by the tests to prove no firm API returns them.
 */
export const OPERATOR_ONLY_KEY = /^models?$|token|cost|usd/i;

/** A trace step's attributes as a firm may see them: everything except `OPERATOR_ONLY_KEY` keys. */
export function firmAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([k]) => !OPERATOR_ONLY_KEY.test(k)));
}

/** This month's AI allowance as a firm sees it: percent used and level, no dollars. */
export type Allowance = {
  /** The calendar month (UTC), e.g. "2026-10". */
  month: string;
  /** Percent of the included AI used (may pass 100 slightly; 0 when unlimited). One decimal. */
  pct: number;
  /** ok, warn (80%+), essentials (used up: answers keep working, extras pause) or unlimited (no cap). */
  level: CreditStatus["level"];
  /** True when the Sidekick team added extra AI for this month (a top-up). */
  toppedUp: boolean;
};

/** Turns the AI credit status (lib/credit.ts) into the firm's view of it: percent and level only. */
export function allowanceOf(c: CreditStatus): Allowance {
  return { month: c.month, pct: c.level === "unlimited" ? 0 : Math.round(c.pct * 10) / 10, level: c.level, toppedUp: c.topUpUsd > 0 };
}

/** The plan limit lines a firm sees: every limit except the AI credit (which is in dollars; see `Allowance`). */
export function firmLimits(lines: LimitLine[]): LimitLine[] {
  return lines.filter((l) => l.key !== "aiCreditUsd");
}

/**
 * A copy of a plan-shaped object (a plan, or the extra-group add-on's `adds`) without its AI credit amount, which
 * is in dollars. Firms are told a bigger plan includes more AI, not how many dollars of AI.
 */
export function withoutAiDollars<T extends object>(o: T): Omit<T, "aiCreditUsd"> {
  const rest = { ...o } as Record<string, unknown>;
  delete rest.aiCreditUsd;
  return rest as Omit<T, "aiCreditUsd">;
}

/** The activity counts for a period: what Sidekick did for the firm. */
export type Activity = { questions: number; answered: number; meetings: number; documents: number; reminders: number; assistant: number };

/** One group's activity counts (or the organization-wide row, `id` null, for work not tied to a group). */
export type GroupActivityRow = Activity & { id: string | null; name: string; color: string };

const ZERO = (): Activity => ({ questions: 0, answered: 0, meetings: 0, documents: 0, reminders: 0, assistant: 0 });

type Bucket = { ws: string | null; d: string; n: number; found?: number };

/**
 * Counts the organization's activity from `from` (inclusive) to `to` (exclusive): totals, per group (largest
 * first; work not in a group, or in a deleted group, is one "Organization-wide" row) and per day (only days with
 * activity). Each kind is one grouped query, so this stays cheap for big organizations.
 */
export async function activityCounts(orgId: string, from: string, to: string): Promise<{ totals: Activity; byWorkspace: GroupActivityRow[]; daily: (Activity & { day: string })[] }> {
  const per = (sql: string) => all<Bucket>(sql, orgId, from, to);
  const day = "substr(created_at, 1, 10)";
  const [groups, questions, meetings, documents, reminders, assistant] = await Promise.all([
    all<{ id: string; name: string; color: string | null }>("SELECT id, name, color FROM workspaces WHERE org_id = ?", orgId),
    per(`SELECT workspace_id AS ws, ${day} AS d, COUNT(*) AS n, COALESCE(SUM(found), 0) AS found FROM questions WHERE org_id = ? AND created_at >= ? AND created_at < ? GROUP BY workspace_id, ${day}`),
    per(`SELECT workspace_id AS ws, ${day} AS d, COUNT(*) AS n FROM meetings WHERE org_id = ? AND created_at >= ? AND created_at < ? AND status = 'Ready' GROUP BY workspace_id, ${day}`),
    per(`SELECT workspace_id AS ws, ${day} AS d, COUNT(*) AS n FROM documents WHERE org_id = ? AND created_at >= ? AND created_at < ? GROUP BY workspace_id, ${day}`),
    per(`SELECT workspace_id AS ws, ${day} AS d, COUNT(*) AS n FROM reminder_runs WHERE org_id = ? AND created_at >= ? AND created_at < ? AND status = 'posted' GROUP BY workspace_id, ${day}`),
    // Only the firm's own assistant use (work Sidekick pays for itself has `payer` set). A count, nothing else.
    per(`SELECT workspace_id AS ws, ${day} AS d, COUNT(*) AS n FROM usage_events WHERE org_id = ? AND created_at >= ? AND created_at < ? AND feature = 'assist' AND ok = 1 AND payer IS NULL GROUP BY workspace_id, ${day}`),
  ]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const totals = ZERO();
  const ws = new Map<string, GroupActivityRow>();
  const days = new Map<string, Activity & { day: string }>();
  const add = (rows: Bucket[], key: keyof Activity) => {
    for (const r of rows) {
      const n = Number(r.n);
      const id = r.ws && byId.has(r.ws) ? r.ws : null;
      const g = byId.get(id ?? "");
      if (!ws.has(id ?? "")) ws.set(id ?? "", { id, name: g?.name ?? "Organization-wide (no group)", color: g?.color ?? "#8a8f98", ...ZERO() });
      if (!days.has(r.d)) days.set(r.d, { day: r.d, ...ZERO() });
      for (const target of [totals, ws.get(id ?? "")!, days.get(r.d)!]) {
        target[key] += n;
        if (key === "questions") target.answered += Number(r.found ?? 0);
      }
    }
  };
  add(questions, "questions");
  add(meetings, "meetings");
  add(documents, "documents");
  add(reminders, "reminders");
  add(assistant, "assistant");
  const size = (a: Activity) => a.questions + a.meetings + a.documents + a.reminders + a.assistant;
  return {
    totals,
    byWorkspace: [...ws.values()].sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name)),
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

type Count = { ws: string | null; month: string; n: number; cost?: number; minutes?: number };

/** One CSV cell: quoted when needed, formula-looking text defused (prefixed with '). */
function cell(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The usage CSV: one row per group (with its engagement code and client) per calendar month (UTC) from `from`
 * to `to`, for charging work back to engagements. Columns: Month, Group, Engagement code, Client, Questions
 * asked, Questions answered, Meetings imported, Meeting hours, Documents added, Reminders sent, Assistant replies;
 * with `withCost` (Owner Console only) also AI requests and AI cost (USD). Work not in a group is one
 * "Organization-wide" row a month; rows with no activity are left out.
 */
export async function usageCsv(orgId: string, from: string, to: string, opts: { withCost?: boolean } = {}): Promise<string> {
  const per = (table: string, extra = "", where = "") =>
    all<Count>(`SELECT workspace_id AS ws, substr(created_at, 1, 7) AS month, COUNT(*) AS n${extra} FROM ${table} WHERE org_id = ? AND created_at >= ? AND created_at < ?${where} GROUP BY workspace_id, substr(created_at, 1, 7)`, orgId, from, to);
  const [groups, ai, questions, answered, meetings, documents, reminders, assistant] = await Promise.all([
    all<{ id: string; name: string; code: string | null; client: string | null }>("SELECT id, name, code, client FROM workspaces WHERE org_id = ?", orgId),
    opts.withCost ? per("usage_events", ", COALESCE(SUM(cost_usd), 0) AS cost") : Promise.resolve([] as Count[]),
    per("questions"),
    per("questions", "", " AND found = 1"),
    per("meetings", ", COALESCE(SUM(duration_min), 0) AS minutes"),
    per("documents"),
    per("reminder_runs", "", " AND status = 'posted'"),
    per("usage_events", "", " AND feature = 'assist' AND ok = 1 AND payer IS NULL"),
  ]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  type Row = { month: string; ws: string | null; calls: number; cost: number; questions: number; answered: number; meetings: number; minutes: number; documents: number; reminders: number; assistant: number };
  const rows = new Map<string, Row>();
  const row = (c: Count) => {
    // Work in a group that was since deleted, or not in a group, lands on the organization-wide row.
    const ws = c.ws && byId.has(c.ws) ? c.ws : null;
    const key = `${c.month}|${ws ?? ""}`;
    if (!rows.has(key)) rows.set(key, { month: c.month, ws, calls: 0, cost: 0, questions: 0, answered: 0, meetings: 0, minutes: 0, documents: 0, reminders: 0, assistant: 0 });
    return rows.get(key)!;
  };
  for (const c of ai) {
    const r = row(c);
    r.calls += Number(c.n);
    r.cost += Number(c.cost ?? 0);
  }
  for (const c of questions) row(c).questions += Number(c.n);
  for (const c of answered) row(c).answered += Number(c.n);
  for (const c of meetings) {
    const r = row(c);
    r.meetings += Number(c.n);
    r.minutes += Number(c.minutes ?? 0);
  }
  for (const c of documents) row(c).documents += Number(c.n);
  for (const c of reminders) row(c).reminders += Number(c.n);
  for (const c of assistant) row(c).assistant += Number(c.n);

  const header = ["Month", "Group", "Engagement code", "Client", "Questions asked", "Questions answered", "Meetings imported", "Meeting hours", "Documents added", "Reminders sent", "Assistant replies", ...(opts.withCost ? ["AI requests", "AI cost (USD)"] : [])];
  const lines = [...rows.values()]
    .sort((a, b) => a.month.localeCompare(b.month) || (a.ws ? byId.get(a.ws)!.name : "~").localeCompare(b.ws ? byId.get(b.ws)!.name : "~"))
    .map((r) => {
      const g = r.ws ? byId.get(r.ws)! : null;
      return [
        r.month, g?.name ?? "Organization-wide (no group)", g?.code ?? null, g?.client ?? null,
        r.questions, r.answered, r.meetings, Math.round((r.minutes / 60) * 10) / 10, r.documents, r.reminders, r.assistant,
        ...(opts.withCost ? [r.calls, Number(r.cost.toFixed(4))] : []),
      ].map(cell).join(",");
    });
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

/**
 * Reads the export period from the query string: `month=YYYY-MM` for one month, or `months=N` for the last N
 * months including this one (default 12, at most 36). Returns the range and a file-name part, or a message for a
 * bad value (the route answers 400 with it).
 */
export function exportRange(q: URLSearchParams, at = new Date()): { from: string; to: string; label: string } | { error: string } {
  const month = q.get("month");
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { error: "Month must look like 2026-10." };
    const [y, m] = month.split("-").map(Number);
    return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString(), label: month };
  }
  const n = q.get("months") === null ? 12 : Number(q.get("months"));
  if (!Number.isInteger(n) || n < 1 || n > 36) return { error: "Months must be a whole number from 1 to 36." };
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - (n - 1), 1)).toISOString();
  const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
  return { from, to, label: `${from.slice(0, 7)}-to-${new Date(Date.parse(to) - 1).toISOString().slice(0, 7)}` };
}
