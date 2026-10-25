/**
 * PATCH/DELETE /api/firm/:id: change a firm document ({ title?, audience?, effective_on?, superseded_by?, applies_to? })
 * or delete it (and its search passages). `applies_to` is "all" or a list of the org's group ids.
 * POST /api/firm/:id `{ action }`, the upload guard (lib/upload-guard.ts) for a held or flagged firm document:
 * `keep` (index it for every group it applies to; raises a "Needs attention" finding), `limit` with `groups?` (keep
 * it only for those groups, default the group it seems to be about), `move` with `to` (into that group, out of the
 * firm library), `review` (confirm a kept one belongs in the firm library).
 * Who: Org Owner / Org Admin of the document's organization. Audited (lib/firm.ts).
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { deleteFirmDoc, limitHeldFirmDoc, updateFirmDoc } from "@/lib/firm";
import { keepHeld, moveDoc, reviewHeld } from "@/lib/upload-guard";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  await updateFirmDoc(user, (await params).id, await readJson(req));
  return { ok: true };
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  await deleteFirmDoc(user, (await params).id);
  return { ok: true };
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const id = (await params).id;
  const body = await readJson<{ action?: unknown; to?: unknown; groups?: unknown }>(req);
  if (body.action === "keep") await keepHeld(user, "firm", id);
  else if (body.action === "limit") await limitHeldFirmDoc(user, id, body.groups);
  else if (body.action === "review") await reviewHeld(user, "firm", id);
  else if (body.action === "move") return { ok: true, ...(await moveDoc(user, "firm", id, body.to)) };
  else throw new HttpError(400, "Unknown action.");
  return { ok: true };
});
