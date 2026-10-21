/**
 * POST/DELETE /api/workspaces/:id/rolloff: end a group (engagement over) or cancel its ending.
 * - POST `{ days? }`: the group becomes **Ending**: read-only, its Teams chats are told and unlinked, it
 *   stops counting toward the group limit, and everything in it is deleted in `days` days (default 30,
 *   at least 7, at most 365). Answers the roll-off.
 * - DELETE: cancel the ending (until the date): a normal group again, chats relinked where possible.
 * Who: Org Owners and Org Admins only (role checked first, then the workspace wall: other orgs get 404).
 * Audited. See lib/rolloff.ts for the whole roll-off.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, isAdmin, requireUser, requireWorkspace } from "@/lib/auth";
import { cancelGroupRolloff, requireDays, rolloffView, scheduleGroupRolloff } from "@/lib/rolloff";

type Ctx = { params: Promise<{ id: string }> };

/** The signed-in admin and the group id, after the role check and the workspace wall. */
async function load(id: string) {
  const user = await requireUser();
  if (!isAdmin(user)) throw new HttpError(403, "Only Org Owners and Org Admins can end a group.");
  return { user, ws: await requireWorkspace(user, id, { allowEnding: true }) };
}

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { user, ws } = await load((await params).id);
  const { days } = await readJson<{ days?: unknown }>(req);
  return { rolloff: rolloffView(await scheduleGroupRolloff(user, ws, requireDays(days))) };
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { user, ws } = await load((await params).id);
  return cancelGroupRolloff(user, ws);
});
