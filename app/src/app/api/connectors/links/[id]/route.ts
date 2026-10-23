/**
 * DELETE /api/connectors/links/<id>: unlinks a project from its group; its imported work items and their search
 * entries are removed. Same people as linking (Org Owners/Admins, the group's Team Lead). Audited. Another
 * organization's or group's link answers 404. See lib/connectors.ts (`unlinkProject`).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { unlinkProject } from "@/lib/connectors";

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return unlinkProject(user, (await ctx.params).id);
});
