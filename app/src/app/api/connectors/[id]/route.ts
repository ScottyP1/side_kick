/**
 * PUT /api/connectors/<id> { accessMode: "shared" | "personal" }: who sees what from one group's connection (that
 * group's Team Lead, or an Org Owner/Admin). "personal" = each person signs in, answers use only what their own sign-in
 * can open (Jira and Azure DevOps; 409 for the others); back to "shared" removes everyone's own sign-ins. Audited. See
 * lib/connectors.ts (`setAccessMode`) and docs/ARCHITECTURE.md → Connectors.
 *
 * DELETE /api/connectors/<id>: disconnects one group's connection (that group's Team Lead, or an Org Owner/Admin):
 * its sign-in (tokens), every linked project and every imported work item with its search entries are removed.
 * Returns the counts. Audited.
 * Another organization's or another group's id answers 404; Members and Viewers get 403. See lib/connectors.ts (`disconnect`).
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { disconnect, setAccessMode } from "@/lib/connectors";

export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const body = await readJson<{ accessMode?: unknown }>(req);
  return setAccessMode(user, (await ctx.params).id, body.accessMode);
});

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return disconnect(user, (await ctx.params).id);
});
