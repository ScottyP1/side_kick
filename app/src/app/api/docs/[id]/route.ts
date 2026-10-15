/**
 * PATCH/DELETE /api/docs/:id: re-tag a document as internal or shareable, or delete it (and its search passages).
 * Who: anyone who can edit content in the document's workspace. Audited.
 */
import { handle, readJson } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { removeIndexed, setAudience } from "@/lib/search";

type Ctx = { params: Promise<{ id: string }> };

async function load(id: string) {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't change documents.");
  const doc = get<{ id: string; workspace_id: string; name: string }>("SELECT id, workspace_id, name FROM documents WHERE id = ? AND org_id = ?", id, user.org_id);
  if (!doc) throw new HttpError(404, "Document not found.");
  requireWorkspace(user, doc.workspace_id);
  return { user, doc };
}

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { user, doc } = await load((await params).id);
  const { audience } = await readJson<{ audience?: string }>(req);
  if (audience !== "internal" && audience !== "shareable") throw new HttpError(400, "Audience must be internal or shareable.");
  run("UPDATE documents SET audience = ? WHERE id = ?", audience, doc.id);
  setAudience(doc.id, audience);
  audit(user, `Marked “${doc.name}” as ${audience}`, "Data", doc.workspace_id);
  return { ok: true };
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { user, doc } = await load((await params).id);
  removeIndexed(doc.id);
  run("DELETE FROM documents WHERE id = ?", doc.id);
  audit(user, `Deleted “${doc.name}” and removed it from search`, "Data", doc.workspace_id);
  return { ok: true };
});
