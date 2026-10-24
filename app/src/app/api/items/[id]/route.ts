/**
 * PATCH /api/items/:id `{ saved: true | false }`: save a meeting's decision, requirement, risk, fact or term to the
 * group's knowledge, or remove it again (lib/saved-items.ts). The same as the "Save to knowledge" button on the
 * notes card in Teams.
 *
 * Who: anyone who can edit content in the item's group (not Viewers or Billing Admins). The item must belong to the
 * person's organization and a group they're in (404 otherwise, so other groups' items can't be probed).
 */
import { handle, readJson } from "@/lib/api";
import { canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { get } from "@/lib/db";
import { setItemSaved } from "@/lib/saved-items";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't save things to knowledge.");
  const { id } = await params;
  const body = await readJson<{ saved?: unknown }>(req);
  if (typeof body.saved !== "boolean") throw new HttpError(400, "Say whether to save it (saved: true or false).");
  const item = await get<{ workspace_id: string }>("SELECT workspace_id FROM items WHERE id = ? AND org_id = ?", id, user.org_id);
  if (!item) throw new HttpError(404, "Item not found.");
  const ws = await requireWorkspace(user, item.workspace_id);
  return setItemSaved(user, ws, id, body.saved, { where: "the portal" });
});
