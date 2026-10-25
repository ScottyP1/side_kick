/**
 * GET/PUT /api/workspaces/:id/call-nudge: the group's "Turn on transcription" reminder for calls in its Teams chats
 * (lib/call-nudge.ts).
 * - GET: anyone in the group (the workspace wall: another group or organization is 404). Returns whether it's on, who
 *   changed it and when, whether automatic notes are on for the organization (it only runs then), the group's chats
 *   Microsoft won't let Sidekick read (no reminders there), the latest reminder, and `canManage`.
 * - PUT `{ enabled: true | false }`: the group's Team Lead or an Org Owner/Admin (`requireManage`: 403 for
 *   Members/Viewers, 404 for a group they can't see; 400 when `enabled` isn't a boolean). Audited ("Policy change").
 */
import { handle, readJson } from "@/lib/api";
import { isAdmin, isLead, requireUser, requireWorkspace } from "@/lib/auth";
import { callNudgeStatus, setCallNudge } from "@/lib/call-nudge";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const ws = await requireWorkspace(user, (await params).id);
  return { ...(await callNudgeStatus(user.org_id, ws)), canManage: isAdmin(user) || isLead(user) };
});

export const PUT = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const body = await readJson<{ enabled?: unknown } | null>(req);
  return { ...(await setCallNudge(user, (await params).id, body?.enabled)), canManage: true };
});
