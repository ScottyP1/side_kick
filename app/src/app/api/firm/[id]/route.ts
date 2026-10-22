/**
 * PATCH/DELETE /api/firm/:id: change a firm document ({ title?, audience?, effective_on?, superseded_by? }) or delete
 * it (and its search passages). Who: Org Owner / Org Admin of the document's organization. Audited (lib/firm.ts).
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { deleteFirmDoc, updateFirmDoc } from "@/lib/firm";

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
