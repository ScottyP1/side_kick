/**
 * POST /api/connectors/links/<id>/sync: "Sync now" for one linked project (only what changed since the last sync).
 * Same people as linking. Returns the link's health; 409 while a sync of it is already running.
 * See lib/connectors.ts (`syncNow`).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { syncNow } from "@/lib/connectors";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return { link: await syncNow(user, (await ctx.params).id) };
});
