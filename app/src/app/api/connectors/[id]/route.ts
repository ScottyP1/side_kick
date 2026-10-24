/**
 * DELETE /api/connectors/<id>: turns a tool off for the organization (disconnects it; the Org Owner only, the
 * toggle on Connectors): its sign-in (tokens), every linked project and every imported work item with its search
 * entries are removed. Returns the counts. Audited.
 * Another organization's id answers 404. See lib/connectors.ts (`disconnect`).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { disconnect } from "@/lib/connectors";

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(["Org Owner"]);
  return disconnect(user, (await ctx.params).id);
});
