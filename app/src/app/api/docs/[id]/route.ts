/**
 * PATCH/DELETE /api/docs/:id: re-tag a document as internal or shareable, or delete it (and its search passages).
 * POST /api/docs/:id `{ action }`: the upload guard (lib/upload-guard.ts) for a held or flagged document:
 * - `keep`: index a held document in its group anyway (raises a "Needs attention" finding for the managers),
 * - `move` with `to` (a group id): move it to another group the person belongs to (admins: any group),
 * - `review`: the group's Team Lead or an Org Owner/Admin confirms a kept document belongs here (clears the finding).
 * Who: anyone who can edit content in the document's workspace (review: managers). Audited.
 */
import { handle, readJson } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { removeIndexed, setAudience } from "@/lib/search";
import { keepHeld, moveDoc, reviewHeld } from "@/lib/upload-guard";

type Ctx = { params: Promise<{ id: string }> };

async function load(id: string) {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't change documents.");
  const doc = await get<{ id: string; workspace_id: string; name: string }>("SELECT id, workspace_id, name FROM documents WHERE id = ? AND org_id = ?", id, user.org_id);
  if (!doc) throw new HttpError(404, "Document not found.");
  await requireWorkspace(user, doc.workspace_id);
  return { user, doc };
}

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { user, doc } = await load((await params).id);
  const { audience } = await readJson<{ audience?: string }>(req);
  if (audience !== "internal" && audience !== "shareable") throw new HttpError(400, "Audience must be internal or shareable.");
  await run("UPDATE documents SET audience = ? WHERE id = ?", audience, doc.id);
  await setAudience(doc.id, audience);
  await audit(user, `Marked “${doc.name}” as ${audience}`, "Data", doc.workspace_id);
  return { ok: true };
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { user, doc } = await load((await params).id);
  await removeIndexed(doc.id);
  await run("DELETE FROM documents WHERE id = ?", doc.id);
  await audit(user, `Deleted “${doc.name}” and removed it from search`, "Data", doc.workspace_id);
  return { ok: true };
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const id = (await params).id;
  const body = await readJson<{ action?: unknown; to?: unknown }>(req);
  if (body.action === "keep") await keepHeld(user, "document", id);
  else if (body.action === "review") await reviewHeld(user, "document", id);
  else if (body.action === "move") return { ok: true, ...(await moveDoc(user, "document", id, body.to)) };
  else throw new HttpError(400, "Unknown action.");
  return { ok: true };
});
