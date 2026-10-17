/**
 * GET/POST /api/docs: list a workspace's documents, or upload new ones.
 * Uploads are extracted to text and indexed for search straight away. Who: workspace members (upload needs edit rights).
 */
import { handle } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { all, newId, now, run } from "@/lib/db";
import { fileToText, MAX_UPLOAD_BYTES } from "@/lib/extract";
import { indexText } from "@/lib/search";
import { assertEnabled } from "@/lib/owner";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const ws = await requireWorkspace(user, new URL(req.url).searchParams.get("ws"));
  const docs = await all(
    `SELECT d.id, d.name, d.size, d.audience, d.status, d.error, d.chunk_count, d.created_at, u.name AS uploaded_by
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.workspace_id = ? ORDER BY d.created_at DESC`,
    ws,
  );
  const stats = (await all<{ n: number }>("SELECT COUNT(*) n FROM passages WHERE workspace_id = ? AND org_id = ?", ws, user.org_id))[0];
  const asked = (await all<{ total: number; found: number }>("SELECT COUNT(*) total, COALESCE(SUM(found),0) found FROM questions WHERE workspace_id = ?", ws))[0];
  return { docs, index: { passages: stats.n, questions: asked.total, answered: asked.found } };
});

// Upload one or more files (multipart form: ws, audience, files[]). Text is extracted and indexed immediately.
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't upload documents.");
  await assertEnabled("uploads", user.org_id);
  const form = await req.formData();
  const ws = await requireWorkspace(user, String(form.get("ws") ?? ""));
  const audience = form.get("audience") === "shareable" ? "shareable" : "internal";
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) throw new HttpError(400, "Choose at least one file to upload.");
  const results = [];
  for (const file of files) {
    const id = newId();
    await run(
      "INSERT INTO documents (id, org_id, workspace_id, name, mime, size, audience, status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Indexing', ?, ?)",
      id, user.org_id, ws, file.name, file.type, file.size, audience, user.id, now(),
    );
    try {
      if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "File is larger than 25 MB.");
      const text = await fileToText(file.name, Buffer.from(await file.arrayBuffer()));
      if (!text.trim()) throw new HttpError(422, "No readable text found. If it's a scan, export it with text (OCR) first.");
      const n = await indexText({ orgId: user.org_id, workspaceId: ws, sourceType: "document", sourceId: id, title: file.name, audience, text });
      await run("UPDATE documents SET status = 'Ready', chunk_count = ? WHERE id = ?", n, id);
      results.push({ name: file.name, ok: true });
    } catch (e) {
      await run("UPDATE documents SET status = 'Failed', error = ? WHERE id = ?", e instanceof Error ? e.message : "Couldn't read this file.", id);
      results.push({ name: file.name, ok: false, error: e instanceof Error ? e.message : "Failed" });
    }
  }
  await audit(user, `Uploaded ${files.length} document${files.length > 1 ? "s" : ""}`, "Data", ws);
  return { results };
});
