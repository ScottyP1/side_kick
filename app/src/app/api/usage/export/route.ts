/**
 * GET /api/usage/export: a CSV of activity per group (workspace) per month, with each group's engagement code and
 * client, for charging work back to engagements (WBS chargeback). Counts only: no AI cost, tokens or model
 * columns (those are in the Owner Console's copy, GET /api/owner/tenants/:id/usage-export).
 * Who: Org Owners and Org Admins (`BILLING_VIEW_ROLES`); only their own organization's groups.
 *
 * Query: `month=YYYY-MM` for one month, or `months=N` for the last N months including this one (default 12,
 * at most 36). Months are calendar months in UTC, like the AI allowance.
 * Columns and rules: `usageCsv` in lib/firm-usage.ts.
 */
import { handle } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { BILLING_VIEW_ROLES } from "@/lib/billing";
import { exportRange, usageCsv } from "@/lib/firm-usage";

export const GET = handle(async (req: Request) => {
  const user = await requireUser(BILLING_VIEW_ROLES);
  const range = exportRange(new URL(req.url).searchParams);
  if ("error" in range) throw new HttpError(400, range.error);
  return new Response(await usageCsv(user.org_id, range.from, range.to), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="sidekick-usage-${range.label}.csv"`, "cache-control": "no-store" },
  });
});
