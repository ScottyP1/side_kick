/**
 * PATCH /api/owner/rolloffs/:id: the Sidekick team changes a pending roll-off.
 * Body: `{ action: "extend", days }` moves the deletion date to `days` days from today (1 to 365);
 * `{ action: "cancel" }` stops it (a group becomes a normal group again; an organization keeps its data and
 * goes back to what its plan allows). Who: platform operators only. Audited on both sides.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { get } from "@/lib/db";
import { platformLog, requireOwner } from "@/lib/owner";
import { cancelGroupRolloff, cancelOrgRolloff, rescheduleRolloff, rolloffView, type Rolloff } from "@/lib/rolloff";
import { TEAM_NAME } from "@/lib/brand";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const id = (await params).id;
  const body = await readJson<{ action?: unknown; days?: unknown }>(req);
  const r = await get<Rolloff>("SELECT * FROM rolloffs WHERE id = ?", id);
  if (!r || r.status !== "scheduled") throw new HttpError(404, "No scheduled roll-off with that id.");
  if (body.action === "extend") return { rolloff: rolloffView(await rescheduleRolloff(id, body.days, owner.name)) };
  if (body.action !== "cancel") throw new HttpError(400, "Action must be extend or cancel.");
  if (r.scope === "group") {
    await cancelGroupRolloff({ org_id: r.org_id, name: TEAM_NAME }, r.workspace_id!);
    await platformLog(owner.name, `${r.org_name}: cancelled the ending of group “${r.workspace_name}”`);
  } else {
    await cancelOrgRolloff(r.org_id, TEAM_NAME, `kept by ${owner.name}`);
  }
  return { ok: true };
});
