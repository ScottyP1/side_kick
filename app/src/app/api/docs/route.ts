/**
 * GET/POST /api/docs: list a workspace's documents, or upload new ones.
 * Uploads are extracted to text and indexed for search straight away. Files of an unsupported type, empty
 * or over 25 MB are refused before anything is saved (listed in `results`; 415 if every file was refused).
 * A file whose text is already in this group (same SHA-256 of its text, lib/rank.ts `contentHash`) is refused too,
 * so the same document isn't searched and cited twice.
 * At most 20 files per upload; a file whose text is over 2 million characters, or a Word file that unpacks
 * to far more than it should (a "zip bomb"), is saved as Failed with the reason (see lib/extract.ts).
 * **Upload guard** (lib/upload-guard.ts): after the text is read it is checked against the organization's other
 * groups (client names, group names, engagement codes; no AI). A file that looks like it's about another client is
 * saved **Held**: not indexed, so no answer can use it, until the uploader keeps or moves it (/api/docs/[id]). Its
 * result says `held: true` with the `question` to ask and the `match` (group name, what matched).
 * GET also returns `targets`: the groups this person may move a document to.
 * Who: workspace members (upload needs edit rights).
 */
import { assertCanAdd } from "@/lib/limits";
import { handle } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { all, get, newId, now, run } from "@/lib/db";
import { fileToText, MAX_DOCUMENT_CHARS, MAX_FILES_PER_UPLOAD, uploadProblem } from "@/lib/extract";
import { indexText } from "@/lib/search";
import { contentHash } from "@/lib/rank";
import { assertEnabled } from "@/lib/owner";
import { checkWrongClient, heldQuestion, moveTargets, parseMatch, type GuardMatch } from "@/lib/upload-guard";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const ws = await requireWorkspace(user, new URL(req.url).searchParams.get("ws"));
  const rows = await all<{ guard_json: string | null; guard_status: string | null; status: string }>(
    `SELECT d.id, d.name, d.size, d.audience, d.status, d.error, d.chunk_count, d.created_at, u.name AS uploaded_by, d.guard_status, d.guard_json
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.workspace_id = ? AND d.org_id = ? ORDER BY d.created_at DESC`,
    ws, user.org_id,
  );
  // Held and flagged documents carry what matched (names only) and the question to ask.
  const docs = rows.map(({ guard_json, ...d }) => {
    const match = d.guard_status === "kept" || d.status === "Held" ? parseMatch(guard_json) : null;
    return { ...d, match, question: match && d.status === "Held" ? heldQuestion(match, false) : null };
  });
  const stats = (await all<{ n: number }>("SELECT COUNT(*) n FROM passages WHERE workspace_id = ? AND org_id = ?", ws, user.org_id))[0];
  const asked = (await all<{ total: number; found: number }>("SELECT COUNT(*) total, COALESCE(SUM(found),0) found FROM questions WHERE workspace_id = ?", ws))[0];
  return { docs, index: { passages: stats.n, questions: asked.total, answered: asked.found }, targets: await moveTargets(user) };
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
  if (files.length > MAX_FILES_PER_UPLOAD) throw new HttpError(413, `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`);
  const results: { name: string; ok: boolean; error?: string; id?: string; held?: boolean; question?: string; match?: GuardMatch }[] = [];
  const readable = [];
  for (const file of files) {
    const problem = uploadProblem(file.name, file.size);
    if (problem) results.push({ name: file.name, ok: false, error: problem });
    else readable.push(file);
  }
  if (!readable.length) throw new HttpError(415, results.length === 1 ? results[0].error! : `None of these files can be uploaded: ${results[0].error}`);
  await assertCanAdd(user.org_id, "documents", readable.length);
  for (const file of readable) {
    const id = newId();
    await run(
      "INSERT INTO documents (id, org_id, workspace_id, name, mime, size, audience, status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Indexing', ?, ?)",
      id, user.org_id, ws, file.name, file.type, file.size, audience, user.id, now(),
    );
    try {
      const text = await fileToText(file.name, Buffer.from(await file.arrayBuffer()));
      if (!text.trim()) throw new HttpError(422, "No readable text found. If it's a scan, export it with text (OCR) first.");
      if (text.length > MAX_DOCUMENT_CHARS) {
        throw new HttpError(413, `This file holds ${text.length.toLocaleString("en-US")} characters of text; the limit is ${MAX_DOCUMENT_CHARS.toLocaleString("en-US")} per document. Split it into smaller files.`);
      }
      const hash = contentHash(text);
      const same = await get<{ name: string }>("SELECT name FROM documents WHERE org_id = ? AND workspace_id = ? AND content_hash = ? AND id != ?", user.org_id, ws, hash, id);
      if (same) {
        await run("DELETE FROM documents WHERE id = ? AND org_id = ?", id, user.org_id);
        results.push({ name: file.name, ok: false, error: `The same text is already in this group as “${same.name}”.` });
        continue;
      }
      // Looks like another client's? Hold it (not indexed) until the uploader keeps or moves it.
      const match = await checkWrongClient(user.org_id, text, { workspaceId: ws });
      if (match) {
        await run("UPDATE documents SET status = 'Held', content_hash = ?, held_text = ?, guard_json = ? WHERE id = ?", hash, text, JSON.stringify(match), id);
        results.push({ name: file.name, ok: true, id, held: true, question: heldQuestion(match, false), match });
        continue;
      }
      const n = await indexText({ orgId: user.org_id, workspaceId: ws, sourceType: "document", sourceId: id, title: file.name, audience, text });
      await run("UPDATE documents SET status = 'Ready', chunk_count = ?, content_hash = ? WHERE id = ?", n, hash, id);
      results.push({ name: file.name, ok: true, id });
    } catch (e) {
      // Our own refusals explain themselves; a library's error (a broken PDF, a damaged zip) is logged and
      // replaced by a plain sentence, so its internal wording never reaches people.
      if (!(e instanceof HttpError)) console.error(`Couldn't read uploaded file "${file.name}"`, e);
      const message = e instanceof HttpError ? e.message : "Couldn't read this file. It may be damaged or password-protected; open it, save it again and re-upload.";
      await run("UPDATE documents SET status = 'Failed', error = ? WHERE id = ?", message, id);
      results.push({ name: file.name, ok: false, error: message });
    }
  }
  const held = results.filter((r) => r.held);
  await audit(user, `Uploaded ${readable.length} document${readable.length > 1 ? "s" : ""}${held.length ? ` (${held.length} held: may belong to another client)` : ""}`, "Data", ws);
  return { results };
});
