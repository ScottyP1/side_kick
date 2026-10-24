/**
 * GET /api/usage/export: a CSV of AI cost and activity per group (workspace) per month, with each group's
 * engagement code and client, for charging the cost back to engagements (WBS chargeback).
 * Who: Org Owners and Org Admins (`BILLING_VIEW_ROLES`); only their own organization's groups.
 *
 * Query: `month=YYYY-MM` for one month, or `months=N` for the last N months including this one (default 12,
 * at most 36). Months are calendar months in UTC, like the AI credit.
 * Columns: Month, Group, Engagement code, Client, AI requests, AI cost (USD), Questions asked, Meetings
 * imported, Meeting hours, Documents added. AI work not tied to a group (the home assistant, org-wide
 * checks) is one "Organization-wide" row per month. Rows with no activity are left out. Text cells that
 * could be read as a spreadsheet formula are prefixed with ' so opening the file is safe.
 */
import { handle } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { all } from "@/lib/db";
import { BILLING_VIEW_ROLES } from "@/lib/billing";

type Count = { ws: string | null; month: string; n: number; cost?: number; minutes?: number };

/** One CSV cell: quoted when needed, formula-looking text defused. */
function cell(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const GET = handle(async (req: Request) => {
  const user = await requireUser(BILLING_VIEW_ROLES);
  const q = new URL(req.url).searchParams;
  const now = new Date();
  let from: string;
  let to: string;
  const month = q.get("month");
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Month must look like 2026-10.");
    const [y, m] = month.split("-").map(Number);
    from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    to = new Date(Date.UTC(y, m, 1)).toISOString();
  } else {
    const n = q.get("months") === null ? 12 : Number(q.get("months"));
    if (!Number.isInteger(n) || n < 1 || n > 36) throw new HttpError(400, "Months must be a whole number from 1 to 36.");
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1)).toISOString();
    to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  const org = user.org_id;
  const per = (table: string, extra = "") =>
    all<Count>(`SELECT workspace_id AS ws, substr(created_at, 1, 7) AS month, COUNT(*) AS n${extra} FROM ${table} WHERE org_id = ? AND created_at >= ? AND created_at < ? GROUP BY workspace_id, substr(created_at, 1, 7)`, org, from, to);
  const [groups, ai, questions, meetings, documents] = await Promise.all([
    all<{ id: string; name: string; code: string | null; client: string | null }>("SELECT id, name, code, client FROM workspaces WHERE org_id = ?", org),
    per("usage_events", ", COALESCE(SUM(cost_usd), 0) AS cost"),
    per("questions"),
    per("meetings", ", COALESCE(SUM(duration_min), 0) AS minutes"),
    per("documents"),
  ]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const rows = new Map<string, { month: string; ws: string | null; calls: number; cost: number; questions: number; meetings: number; minutes: number; documents: number }>();
  const row = (c: Count) => {
    // Work in a group that was since deleted, or not in a group, lands on the organization-wide row.
    const ws = c.ws && byId.has(c.ws) ? c.ws : null;
    const key = `${c.month}|${ws ?? ""}`;
    if (!rows.has(key)) rows.set(key, { month: c.month, ws, calls: 0, cost: 0, questions: 0, meetings: 0, minutes: 0, documents: 0 });
    return rows.get(key)!;
  };
  for (const c of ai) {
    const r = row(c);
    r.calls += Number(c.n);
    r.cost += Number(c.cost ?? 0);
  }
  for (const c of questions) row(c).questions += Number(c.n);
  for (const c of meetings) {
    const r = row(c);
    r.meetings += Number(c.n);
    r.minutes += Number(c.minutes ?? 0);
  }
  for (const c of documents) row(c).documents += Number(c.n);

  const header = ["Month", "Group", "Engagement code", "Client", "AI requests", "AI cost (USD)", "Questions asked", "Meetings imported", "Meeting hours", "Documents added"];
  const lines = [...rows.values()]
    .sort((a, b) => a.month.localeCompare(b.month) || (a.ws ? byId.get(a.ws)!.name : "~").localeCompare(b.ws ? byId.get(b.ws)!.name : "~"))
    .map((r) => {
      const g = r.ws ? byId.get(r.ws)! : null;
      return [r.month, g?.name ?? "Organization-wide (no group)", g?.code ?? null, g?.client ?? null, r.calls, Number(r.cost.toFixed(4)), r.questions, r.meetings, Math.round((r.minutes / 60) * 10) / 10, r.documents].map(cell).join(",");
    });
  const name = `sidekick-usage-${month ?? `${from.slice(0, 7)}-to-${new Date(Date.parse(to) - 1).toISOString().slice(0, 7)}`}.csv`;
  return new Response([header.join(","), ...lines].join("\r\n") + "\r\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
});
