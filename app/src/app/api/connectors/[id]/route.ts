/**
 * DELETE /api/connectors/<id>: disconnects one group's connection (that group's Team Lead, or an Org Owner/Admin):
 * its sign-in (tokens), every linked project and every imported work item with its search entries are removed.
 * Returns the counts. Audited.
 * Another organization's or another group's id answers 404; Members and Viewers get 403. See lib/connectors.ts (`disconnect`).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { disconnect } from "@/lib/connectors";

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return disconnect(user, (await ctx.params).id);
});
