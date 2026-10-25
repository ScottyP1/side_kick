/**
 * GET/PUT /api/workspaces/:id/notes-chats: "Meeting notes go to", which of the group's linked Teams chats get its meeting
 * notes (lib/notes-chats.ts).
 * - GET: anyone in the group (the workspace wall: another group or organization is 404). Returns the plan (`mode`
 *   chosen/none/unset, the chats with client guests marked, the chats notes go to now, the default chat, whether a
 *   choice is still needed, the latest posted meeting and where it went) and `canManage` (the picker is read-only
 *   otherwise).
 * - PUT `{ chatIds: [...] }` or `{ none: true }`: the group's Team Lead or an Org Owner/Admin (`requireManage`: 403 for
 *   Members/Viewers, 404 for a group they can't see; 409 while the group is ending). Audited.
 */
import { handle, readJson } from "@/lib/api";
import { isAdmin, isLead, requireUser, requireWorkspace } from "@/lib/auth";
import { notesPlan, setNotesChats } from "@/lib/notes-chats";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const ws = await requireWorkspace(user, (await params).id);
  return { ...(await notesPlan(user.org_id, ws)), canManage: isAdmin(user) || isLead(user) };
});

export const PUT = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const plan = await setNotesChats(user, (await params).id, await readJson(req));
  return { ...plan, canManage: true };
});
