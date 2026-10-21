/**
 * PATCH /api/owner/tenants/:id/billing: the Sidekick team sets a client's plan and/or subscription status
 * (lib/billing.ts `setByOwner`), e.g. to extend a trial, mark an invoice paid, or end access.
 * Who: platform operators only. Recorded in the operator log and in the client's own audit log.
 *
 * Body: { plan?: "starter" | "team" | "business" | "enterprise", status?: "trialing" | "active" | "past_due" | "canceled",
 *         extraGroups?: 0-50 }. Setting canceled starts the client's roll-off (deleted after 30 days, lib/rolloff.ts);
 *         any other status stops a pending one.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { requireExtras, requirePlan, setByOwner } from "@/lib/billing";
import { get } from "@/lib/db";
import { platformLog, requireOwner } from "@/lib/owner";
import { SUB_STATUSES, type SubStatus } from "@/lib/plans";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const body = await readJson<{ plan?: unknown; status?: unknown; extraGroups?: unknown }>(req);
  if (body.plan === undefined && body.status === undefined && body.extraGroups === undefined) throw new HttpError(400, "Say which plan, status or extra groups to set.");
  const extras = body.extraGroups === undefined ? undefined : requireExtras(body.extraGroups);
  const plan = body.plan === undefined ? undefined : requirePlan(body.plan, { operator: true });
  if (body.status !== undefined && !SUB_STATUSES.includes(body.status as SubStatus)) throw new HttpError(400, "Status must be trialing, active, past_due or canceled.");
  const summary = await setByOwner(org.id, { plan, status: body.status as SubStatus | undefined, extras }, owner.name);
  await platformLog(owner.name, `Set ${org.name} to the ${summary}`);
  return { ok: true };
});
