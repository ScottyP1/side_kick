/**
 * GET /api/owner/tenants/:id/usage-export: one client's usage CSV with cost, for the Sidekick team (margin
 * checks, or sending a client a chargeback file on request). The same rows as the client's own export
 * (GET /api/usage/export) plus "AI requests" and "AI cost (USD)" columns (`usageCsv` with `withCost`).
 * Who: platform operators only. Logged in the operator log.
 * Query: `month=YYYY-MM` or `months=N` (1-36, default 12), as for the client's export.
 */
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { get } from "@/lib/db";
import { exportRange, usageCsv } from "@/lib/firm-usage";
import { platformLog, requireOwner } from "@/lib/owner";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const range = exportRange(new URL(req.url).searchParams);
  if ("error" in range) throw new HttpError(400, range.error);
  await platformLog(owner.name, `Exported usage with cost for ${org.name} (${range.label})`);
  return new Response(await usageCsv(org.id, range.from, range.to, { withCost: true }), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="sidekick-usage-${org.id}-${range.label}.csv"`, "cache-control": "no-store" },
  });
});
