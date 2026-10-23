/**
 * /api/meetings/auto: automatic notes after Teams meetings (lib/meetings-graph.ts).
 *
 * - GET: the status for the Meetings page: whether it's on, Microsoft connected, instant notifications live, the
 *   last check and its problem, and recent Teams meetings Sidekick heard about. Everyone signed in sees the
 *   meetings captured into their own groups; Org Owners/Admins and Team Leads also see skipped ones and the ones
 *   waiting for a group they can pick.
 * - PUT `{ enabled }`: turn it on or off for the organization. Org Owners and Org Admins only.
 * - POST `{ action: "check" }` (Org Owners/Admins): look for new meetings now.
 *   POST `{ action: "assign", id, ws }`: pick the group for a waiting meeting (an Org Owner/Admin, or the Team Lead
 *   of that group; `ws` must be one of the meeting's candidate groups).
 *   POST `{ action: "retry", id }` (Org Owners/Admins): try a skipped or failed meeting again.
 */
// Registers the job kinds this route enqueues (meetings.fetch, meetings.poll.org, meetings.subscription).
import "@/lib/job-kinds";
import { handle, readJson } from "@/lib/api";
import { HttpError, isAdmin, isLead, requireManage, requireUser, workspaceIdsFor } from "@/lib/auth";
import { autoNotesStatus, requestCheck, retryCapture, setAutoNotes } from "@/lib/meetings-graph";

const ADMINS = ["Org Owner", "Org Admin"] as const;

export const GET = handle(async () => {
  const user = await requireUser();
  return autoNotesStatus(user.org_id, { workspaceIds: await workspaceIdsFor(user), manager: isAdmin(user) || isLead(user) });
});

export const PUT = handle(async (req: Request) => {
  const user = await requireUser(ADMINS);
  const body = await readJson<{ enabled?: unknown }>(req);
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "Say whether automatic notes should be on (enabled: true or false).");
  await setAutoNotes(user, body.enabled);
  return { ok: true, enabled: body.enabled };
});

export const POST = handle(async (req: Request) => {
  const body = await readJson<{ action?: unknown; id?: unknown; ws?: unknown }>(req);
  if (body.action === "check") {
    const user = await requireUser(ADMINS);
    await requestCheck(user.org_id);
    return { ok: true };
  }
  if (body.action === "assign") {
    const user = await requireUser();
    const ws = await requireManage(user, typeof body.ws === "string" ? body.ws : null);
    await retryCapture(user, body.id, ws);
    return { ok: true };
  }
  if (body.action === "retry") {
    const user = await requireUser(ADMINS);
    await retryCapture(user, body.id, null);
    return { ok: true };
  }
  throw new HttpError(400, "Unknown action.");
});
