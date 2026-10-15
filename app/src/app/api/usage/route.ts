import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { MODELS } from "@/lib/claude";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin", "Billing Admin"]);
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const s = start.toISOString();
  const totals = get("SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(AVG(latency_ms),0) latency, COALESCE(SUM(1 - ok),0) errors FROM usage_events WHERE org_id = ? AND created_at >= ?", user.org_id, s);
  const byFeature = all("SELECT feature, COUNT(*) calls, SUM(cost_usd) cost, AVG(latency_ms) latency FROM usage_events WHERE org_id = ? AND created_at >= ? GROUP BY feature ORDER BY cost DESC", user.org_id, s);
  const byModel = all("SELECT model, COUNT(*) calls, SUM(cost_usd) cost, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cache_read_tokens) cached FROM usage_events WHERE org_id = ? AND created_at >= ? GROUP BY model ORDER BY cost DESC", user.org_id, s);
  const byWorkspace = all("SELECT w.name, w.color, COUNT(*) calls, SUM(u.cost_usd) cost FROM usage_events u JOIN workspaces w ON w.id = u.workspace_id WHERE u.org_id = ? AND u.created_at >= ? GROUP BY w.id ORDER BY cost DESC", user.org_id, s);
  const daily = all("SELECT substr(created_at, 1, 10) day, SUM(cost_usd) cost, COUNT(*) calls FROM usage_events WHERE org_id = ? AND created_at >= ? GROUP BY day ORDER BY day", user.org_id, s);
  return { period: { start: s, end: end.toISOString(), day: d.getDate(), days: Math.round((end.getTime() - start.getTime()) / 86400000) }, totals, byFeature, byModel, byWorkspace, daily, models: MODELS };
});
