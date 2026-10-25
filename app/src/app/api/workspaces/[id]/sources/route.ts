/**
 * GET /api/workspaces/:id/sources: the connected tools that feed this group (lib/group-overview.ts `groupSources`):
 * tool, linked project/space/library name, last successful sync and whether it's working. Names and dates only.
 * Who: anyone in the group (the workspace wall: a group they're not in, or another organization's, is 404).
 */
import { handle } from "@/lib/api";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { groupSources } from "@/lib/group-overview";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const ws = await requireWorkspace(user, (await params).id);
  return { sources: await groupSources(user.org_id, ws) };
});
