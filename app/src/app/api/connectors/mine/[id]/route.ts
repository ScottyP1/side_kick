/**
 * DELETE /api/connectors/mine/<connector id>: removes the person's **own** sign-in to that connection (their tokens);
 * the group's connection and everyone else's sign-ins stay. Anyone in the group, for themselves only (another
 * organization's or group's id: 404). Audited. See lib/connector-access.ts (`disconnectMine`).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { disconnectMine } from "@/lib/connector-access";

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return disconnectMine(user, (await ctx.params).id);
});
