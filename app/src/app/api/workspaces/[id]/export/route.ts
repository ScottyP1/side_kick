/**
 * GET /api/workspaces/:id/export: download everything in one group as a zip (lib/export.ts): documents'
 * text, meetings with notes, decisions and action items, questions and gaps, a Teams chat summary, people
 * and an index.html. Works while the group is ending and while the organization is read-only.
 * Who: Org Owners and Org Admins only (role first, then the workspace wall: other orgs get 404). Audited.
 */
import { handle } from "@/lib/api";
import { audit, HttpError, isAdmin, requireUser, requireWorkspace } from "@/lib/auth";
import { exportGroup, zipResponse } from "@/lib/export";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  if (!isAdmin(user)) throw new HttpError(403, "Only Org Owners and Org Admins can export a group.");
  const ws = await requireWorkspace(user, (await params).id);
  const { filename, zip } = await exportGroup(user.org_id, ws);
  await audit(user, `Exported group data (${filename})`, "Data", ws);
  return zipResponse(filename, zip);
});
