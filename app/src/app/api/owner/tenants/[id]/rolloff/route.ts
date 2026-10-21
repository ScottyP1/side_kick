/**
 * POST /api/owner/tenants/:id/rolloff `{ days? }`: the Sidekick team **ends a client**: the organization
 * turns read-only now (with a banner and export for its admins) and all its data is deleted in `days` days
 * (default 30, at least 7). Stop it with PATCH /api/owner/rolloffs/:id `{ action: "cancel" }`; paying again
 * stops it too. Who: platform operators only. Audited in the client's log and the operator log.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { get, now } from "@/lib/db";
import { requireOwner } from "@/lib/owner";
import { TEAM_NAME } from "@/lib/brand";
import { ORG_GRACE_DAYS, requireDays, scheduleOrgRolloff } from "@/lib/rolloff";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string }>("SELECT id FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const { days } = await readJson<{ days?: unknown }>(req);
  const n = days === undefined ? ORG_GRACE_DAYS : requireDays(days);
  await scheduleOrgRolloff(org.id, { readOnlyFrom: now(), deleteOn: new Date(Date.now() + n * 86400_000).toISOString(), reason: `the ${TEAM_NAME} ended the service`, by: owner.name });
  return { ok: true };
});
