/**
 * POST /api/owner/tenants/:id/credit: the Sidekick team grants a one-off AI credit top-up for this month
 * (lib/credit.ts `grantTopUp`), e.g. when a client hit its credit before a big delivery week.
 * Who: platform operators only. Recorded in the operator log and the client's audit log.
 *
 * Body: { amountUsd: number, note?: string }. Returns the client's credit status after the top-up.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { get } from "@/lib/db";
import { grantTopUp } from "@/lib/credit";
import { platformLog, requireOwner } from "@/lib/owner";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const body = await readJson<{ amountUsd?: unknown; note?: unknown }>(req);
  const credit = await grantTopUp(org.id, body.amountUsd, body.note, owner.name);
  await platformLog(owner.name, `Added $${Number(body.amountUsd).toFixed(2)} of AI credit for ${org.name} (${credit.month})`);
  return { credit };
});
