/**
 * /api/findings: what the watchers found that needs a person (lib/watchers.ts), for Home and a group's page.
 * - GET (`?ws=<group id>` for one group, `&snoozed=1` to include snoozed ones): the findings this person may see in
 *   their organization (workspace walls and the finding's audience apply), worst first.
 * - POST `{ id, action: "snooze" | "reopen" }`: snooze a finding for 7 days or bring it back. Org Owners/Admins, or
 *   the group's Team Lead for its group's findings (other roles 403; a finding they can't see 404). Audited.
 * - POST `{ action: "check" }`: run the watchers again soon (next heartbeat, within about 30 seconds).
 *   Org Owners/Admins and Team Leads.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, isAdmin, isLead, requireUser, requireWorkspace } from "@/lib/auth";
import { actOnFinding, findingsFor } from "@/lib/watchers";
import { requestWatch } from "@/lib/job-kinds";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const q = new URL(req.url).searchParams;
  const ws = q.get("ws");
  const workspaceId = ws ? await requireWorkspace(user, ws) : undefined;
  return { findings: await findingsFor(user, { workspaceId, includeSnoozed: q.get("snoozed") === "1" }) };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ id?: unknown; action?: unknown }>(req);
  // The role is checked first, so other roles always get a plain 403 whatever they name.
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and the group's Team Lead can do this.");
  if (body.action === "check") {
    await requestWatch(user.org_id);
    return { ok: true };
  }
  if (body.action !== "snooze" && body.action !== "reopen") throw new HttpError(400, "Unknown action.");
  if (typeof body.id !== "string" || !body.id) throw new HttpError(400, "Which item?");
  await actOnFinding(user, body.id, body.action);
  return { ok: true };
});
