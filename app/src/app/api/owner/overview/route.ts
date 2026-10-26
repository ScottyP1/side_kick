/**
 * GET /api/owner/overview: platform-wide AI spend, clients, error rate and response times for the Owner Console home,
 * plus `alerts`: things the operator must act on (today: "Search is almost full" from lib/search-capacity.ts, while
 * the Azure AI Search service is 70%+ full). Who: platform operators only.
 */
import { handle } from "@/lib/api";
import { all, get } from "@/lib/db";
import { requireOwner } from "@/lib/owner";
import { searchCapacity } from "@/lib/search-capacity";

export const GET = handle(async () => {
  await requireOwner();
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const day = new Date(Date.now() - 86400_000).toISOString();
  const n = async (sql: string, ...p: string[]) => (await get<{ n: number }>(sql, ...p))?.n ?? 0;
  const month = (await get<{ cost: number; calls: number; errors: number; latency: number }>(
    "SELECT COALESCE(SUM(cost_usd),0) cost, COUNT(*) calls, COALESCE(SUM(1-ok),0) errors, COALESCE(AVG(latency_ms),0) latency FROM usage_events WHERE created_at >= ?",
    monthStart,
  ))!;
  const today = (await get<{ cost: number; calls: number; errors: number }>(
    "SELECT COALESCE(SUM(cost_usd),0) cost, COUNT(*) calls, COALESCE(SUM(1-ok),0) errors FROM usage_events WHERE created_at >= ?",
    day,
  ))!;
  const search = await searchCapacity();
  return {
    alerts: search?.message ? [{ kind: search.level === "full" ? "bad" : "warn", text: search.message, href: "/owner/business#search-capacity" }] : [],
    kpis: {
      tenants: await n("SELECT COUNT(*) n FROM orgs"),
      activeTenants: await n("SELECT COUNT(DISTINCT org_id) n FROM usage_events WHERE created_at >= ?", since7),
      users: await n("SELECT COUNT(*) n FROM users"),
      activeUsers: await n("SELECT COUNT(*) n FROM users WHERE last_active >= ?", since7),
      meetings: await n("SELECT COUNT(*) n FROM meetings WHERE created_at >= ?", monthStart),
      questions: await n("SELECT COUNT(*) n FROM questions WHERE created_at >= ?", monthStart),
      documents: await n("SELECT COUNT(*) n FROM documents"),
      monthCost: month.cost,
      monthCalls: month.calls,
      errorRate: month.calls ? month.errors / month.calls : 0,
      avgLatency: month.latency,
      todayCost: today.cost,
      todayCalls: today.calls,
      projected: (month.cost / d.getDate()) * new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(),
    },
    // Last 30 days, including days with no usage.
    daily: await (async () => {
      const rows = await all<{ day: string; cost: number; calls: number; errors: number }>(
        "SELECT substr(created_at,1,10) AS day, SUM(cost_usd) cost, COUNT(*) calls, SUM(1-ok) errors FROM usage_events WHERE created_at >= ? GROUP BY day",
        since30,
      );
      return Array.from({ length: 30 }, (_, i) => {
        const day = new Date(Date.now() - (29 - i) * 86400_000).toISOString().slice(0, 10);
        return rows.find((r) => r.day === day) ?? { day, cost: 0, calls: 0, errors: 0 };
      });
    })(),
    topTenants: await all(
      `SELECT o.id, o.name, o.status, COALESCE(SUM(u.cost_usd),0) cost, COUNT(u.id) calls
         FROM orgs o LEFT JOIN usage_events u ON u.org_id = o.id AND u.created_at >= ?
        GROUP BY o.id ORDER BY cost DESC LIMIT 6`,
      monthStart,
    ),
    recentErrors: await all(
      `SELECT u.created_at, u.feature, u.model, u.error, o.name AS tenant FROM usage_events u LEFT JOIN orgs o ON o.id = u.org_id
        WHERE u.ok = 0 ORDER BY u.id DESC LIMIT 5`,
    ),
  };
});
