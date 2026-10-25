/**
 * /api/meetings/auto: automatic notes after Teams meetings (lib/meetings-graph.ts).
 *
 * - GET: the status for the Meetings page: whether it's on, Microsoft connected, instant notifications live, the
 *   last check and its problem, and recent Teams meetings Sidekick heard about. Everyone signed in sees the
 *   meetings captured into their own groups; Org Owners/Admins and Team Leads also see skipped ones and the ones
 *   waiting for a group they can pick.
 *   `autoRecord` is the "record and transcribe group meetings by themselves" part (lib/auto-record.ts).
 * - PUT `{ enabled }`: turn it on or off for the organization. Org Owners and Org Admins only.
 *   PUT `{ autoRecord }`: turn automatic recording of groups' scheduled meetings on or off (needs automatic notes on;
 *   Teams also saves a video, so it's a separate, audited choice). Org Owners and Org Admins only.
 * - POST `{ action: "check" }` (Org Owners/Admins): look for new meetings now (and, when automatic recording is on,
 *   for upcoming meetings to set).
 *   POST `{ action: "assign", id, ws }`: pick the group for a waiting meeting (an Org Owner/Admin, or the Team Lead
 *   of that group; `ws` must be one of the meeting's candidate groups, or for a meeting where fewer than two of one
 *   group's people were recognised, any group when an Org Owner/Admin picks).
 *   POST `{ action: "add-person", id, oid }`: **Add to group** for one of a picked meeting's people who isn't in its
 *   group yet (an Org Owner/Admin, or the group's Team Lead; within the plan's seats).
 *   POST `{ action: "retry", id }` (Org Owners/Admins): try a skipped or failed meeting again.
 */
// Registers the job kinds this route enqueues (meetings.fetch, meetings.poll.org, meetings.subscription, meetings.record.org).
import "@/lib/job-kinds";
import { handle, readJson } from "@/lib/api";
import { HttpError, isAdmin, isLead, requireManage, requireUser, workspaceIdsFor } from "@/lib/auth";
import { addMeetingPerson, autoNotesStatus, requestCheck, retryCapture, setAutoNotes } from "@/lib/meetings-graph";
import { autoRecordOn, autoRecordStatus, requestRecordScan, setAutoRecord } from "@/lib/auto-record";

const ADMINS = ["Org Owner", "Org Admin"] as const;

export const GET = handle(async () => {
  const user = await requireUser();
  const opts = { workspaceIds: await workspaceIdsFor(user), manager: isAdmin(user) || isLead(user) };
  return { ...(await autoNotesStatus(user.org_id, { ...opts, admin: isAdmin(user) })), autoRecord: await autoRecordStatus(user.org_id, opts) };
});

export const PUT = handle(async (req: Request) => {
  const user = await requireUser(ADMINS);
  const body = await readJson<{ enabled?: unknown; autoRecord?: unknown }>(req);
  if (body.autoRecord !== undefined) {
    if (typeof body.autoRecord !== "boolean") throw new HttpError(400, "Say whether group meetings should record by themselves (autoRecord: true or false).");
    await setAutoRecord(user, body.autoRecord);
    return { ok: true, autoRecord: body.autoRecord };
  }
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "Say whether automatic notes should be on (enabled: true or false).");
  await setAutoNotes(user, body.enabled);
  return { ok: true, enabled: body.enabled };
});

export const POST = handle(async (req: Request) => {
  const body = await readJson<{ action?: unknown; id?: unknown; ws?: unknown; oid?: unknown }>(req);
  if (body.action === "check") {
    const user = await requireUser(ADMINS);
    await requestCheck(user.org_id);
    if (await autoRecordOn(user.org_id)) await requestRecordScan(user.org_id);
    return { ok: true };
  }
  if (body.action === "assign") {
    const user = await requireUser();
    const ws = await requireManage(user, typeof body.ws === "string" ? body.ws : null);
    await retryCapture(user, body.id, ws);
    return { ok: true };
  }
  if (body.action === "add-person") {
    const user = await requireUser();
    return { ok: true, ...(await addMeetingPerson(user, body.id, body.oid)) };
  }
  if (body.action === "retry") {
    const user = await requireUser(ADMINS);
    await retryCapture(user, body.id, null);
    return { ok: true };
  }
  throw new HttpError(400, "Unknown action.");
});
