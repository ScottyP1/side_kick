/**
 * GET /api/workspaces/:id/usage: one group's last 30 days (lib/group-overview.ts `groupActivity`): questions asked
 * and answered, meetings captured, documents added, and this group's share of the organization's AI use as a
 * percent. No prices, plan or billing details.
 * Who: Org Owners/Admins, and a Team Lead for a group they lead (`requireManage`: other roles 403, a group they
 * can't see 404), so a Team Lead never sees another group's numbers.
 */
import { handle } from "@/lib/api";
import { requireManage, requireUser } from "@/lib/auth";
import { groupActivity } from "@/lib/group-overview";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const ws = await requireManage(user, (await params).id);
  return { activity: await groupActivity(user.org_id, ws) };
});
