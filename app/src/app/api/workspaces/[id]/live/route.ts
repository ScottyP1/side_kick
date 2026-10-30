/**
 * GET/PUT/POST /api/workspaces/:id/live: the group's "Live in meetings" panel (lib/live-meetings/sessions.ts).
 * - GET: anyone in the group (the workspace wall: another group or organization is 404). The mode (off / when someone
 *   asks / every group meeting), who changed it, whether the plan includes it and it's set up, this month's live hours
 *   against the plan, the latest sessions (with the running list while one is live), and `canManage`.
 * - PUT `{ mode: "off" | "ask" | "auto" }`: the group's Team Lead or an Org Owner/Admin (`requireManage`: 403 for
 *   Members/Viewers). Turning it on needs the Enterprise plan (402) and a configured meeting-bot service (503).
 *   Audited ("Policy change").
 * - POST `{ action: "stop", session }`: the same people make Sidekick leave a running meeting now. Audited.
 */
// Registers the job kinds stopping enqueues (live.handoff).
import "@/lib/job-kinds";
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { liveStatus, setLiveMode, stopFromPortal } from "@/lib/live-meetings/sessions";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  return liveStatus(user, (await params).id);
});

export const PUT = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const body = await readJson<{ mode?: unknown } | null>(req);
  return setLiveMode(user, (await params).id, body?.mode);
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const body = await readJson<{ action?: unknown; session?: unknown } | null>(req);
  if (body?.action !== "stop") throw new HttpError(400, "Say what to do (stop).");
  return stopFromPortal(user, (await params).id, body.session);
});
