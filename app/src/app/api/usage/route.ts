/**
 * GET /api/usage: what Sidekick did for this organization this month (activity counts in total, per group and
 * per day), how much of the plan's included AI it has used (a percentage, `allowance`), and every plan limit with
 * its use (lib/limits.ts, without the AI credit line, which is in dollars).
 * Who: Org Owners and Org Admins (`BILLING_VIEW_ROLES`).
 * No AI cost, tokens, response times or model names: those are Sidekick's internals and are only in the Owner
 * Console (lib/firm-usage.ts explains the rule; tests/api.test.mjs proves this response has none of them).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { BILLING_VIEW_ROLES } from "@/lib/billing";
import { creditStatus } from "@/lib/credit";
import { activityCounts, allowanceOf, firmLimits } from "@/lib/firm-usage";
import { limitReport, monthStart } from "@/lib/limits";

export const GET = handle(async () => {
  const user = await requireUser(BILLING_VIEW_ROLES);
  const d = new Date();
  const s = monthStart(d);
  const start = new Date(s);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const [activity, credit] = await Promise.all([activityCounts(user.org_id, s, end.toISOString()), creditStatus(user.org_id, { fresh: true })]);
  const { lines } = await limitReport(user.org_id, credit.usedUsd);
  return {
    period: { start: s, end: end.toISOString(), day: d.getUTCDate(), days: Math.round((end.getTime() - start.getTime()) / 86400000) },
    totals: activity.totals,
    byWorkspace: activity.byWorkspace,
    daily: activity.daily,
    allowance: allowanceOf(credit),
    limits: firmLimits(lines),
  };
});
