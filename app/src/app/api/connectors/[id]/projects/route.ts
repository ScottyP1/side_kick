/**
 * GET /api/connectors/<id>/projects: the projects the connected account can read in that tool (all pages), to pick
 * one to link to a group. Org Owners, Org Admins and Team Leads. A tool problem (expired sign-in, tool down)
 * answers 409/502 with the reason. See lib/connectors.ts (`listProjects`).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listProjects } from "@/lib/connectors";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return { projects: await listProjects(user, (await ctx.params).id) };
});
