/**
 * POST /api/connectors/requests/<id> { action: "approve" | "decline" | "cancel", note? }: decides a request to allow
 * a tool type.
 * - approve (Org Owner only): allows the tool type for the organization (and so approves every pending request for
 *   it); the group then connects it with its own account. 402 past the plan's connectors limit.
 * - decline (Org Owner only): with an optional `note` the person who asked sees.
 * - cancel: the person who asked, or the Org Owner.
 * Another organization's id answers 404; a request already decided answers 409. Audited.
 * See lib/connector-requests.ts.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { approveRequest, cancelRequest, declineRequest } from "@/lib/connector-requests";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const id = (await ctx.params).id;
  const body = await readJson<{ action?: unknown; note?: unknown }>(req);
  if (body.action === "approve") return approveRequest(user, id);
  if (body.action === "decline") return { request: await declineRequest(user, id, body.note) };
  if (body.action === "cancel") return { request: await cancelRequest(user, id) };
  throw new HttpError(400, "Pick approve, decline or cancel.");
});
