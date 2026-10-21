/**
 * GET /api/usage: what Sidekick's AI work cost this organization this month, by feature, group and day,
 * plus the monthly AI credit (lib/credit.ts) and every plan limit with its use (lib/limits.ts).
 * Who: Org Owners, Org Admins and Billing Admins. No model or provider names: customers see plain wording
 * ("AI requests"); models are in the Owner Console.
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { creditStatus } from "@/lib/credit";
import { limitReport, monthStart } from "@/lib/limits";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin", "Billing Admin"]);
  const d = new Date();
  const s = monthStart(d);
  const start = new Date(s);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const totals = await get("SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(AVG(latency_ms),0) latency, COALESCE(SUM(1 - ok),0) errors FROM usage_events WHERE org_id = ? AND created_at >= ?", user.org_id, s);
  const byFeature = await all("SELECT feature, COUNT(*) calls, SUM(cost_usd) cost, AVG(latency_ms) latency FROM usage_events WHERE org_id = ? AND created_at >= ? GROUP BY feature ORDER BY cost DESC", user.org_id, s);
  // Work that isn't tied to one workspace (the home assistant, org-wide guardrail checks) is its own row,
  // so the list never says "No usage yet" while the totals above show requests.
  const byWorkspace = await all(
    `SELECT COALESCE(w.name, 'Organization-wide (no workspace)') AS name, COALESCE(w.color, '#8a8f98') AS color, COUNT(*) calls, SUM(u.cost_usd) cost
       FROM usage_events u LEFT JOIN workspaces w ON w.id = u.workspace_id
      WHERE u.org_id = ? AND u.created_at >= ? GROUP BY w.id, w.name, w.color ORDER BY cost DESC`,
    user.org_id, s,
  );
  const daily = await all("SELECT substr(created_at, 1, 10) AS day, SUM(cost_usd) cost, COUNT(*) calls FROM usage_events WHERE org_id = ? AND created_at >= ? GROUP BY day ORDER BY day", user.org_id, s);
  const credit = await creditStatus(user.org_id, { fresh: true });
  const { lines } = await limitReport(user.org_id, credit.usedUsd);
  return {
    period: { start: s, end: end.toISOString(), day: d.getUTCDate(), days: Math.round((end.getTime() - start.getTime()) / 86400000) },
    totals, byFeature, byWorkspace, daily, credit, limits: lines,
  };
});
