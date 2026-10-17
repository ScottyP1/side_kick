/**
 * GET/POST /api/meetings: list a workspace's meetings, or import a transcript and have Sidekick write the notes.
 * After a successful import the notes are posted to the workspace's linked Teams chats that take meeting notes,
 * followed by a reminder in the chats that want one after meetings (lib/reminders.ts).
 */
import { after } from "next/server";
import { handle } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { all, newId, now, run } from "@/lib/db";
import { fileToText, MAX_UPLOAD_BYTES } from "@/lib/extract";
import { processMeeting } from "@/lib/sidekick";
import { assertEnabled } from "@/lib/owner";
import { postMeetingNotes } from "@/lib/teams/bot";
import { remindAfterMeeting } from "@/lib/reminders";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const ws = await requireWorkspace(user, new URL(req.url).searchParams.get("ws"));
  const meetings = await all(
    `SELECT m.id, m.title, m.held_at, m.external_guests, m.status, m.error, m.created_at,
       (SELECT COUNT(*) FROM items i WHERE i.meeting_id = m.id AND i.kind = 'decision') AS decisions,
       (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id) AS actions,
       (SELECT COUNT(*) FROM items i WHERE i.meeting_id = m.id AND i.kind = 'question' AND i.answered = 0) AS open_questions
     FROM meetings m WHERE m.workspace_id = ? ORDER BY m.held_at DESC, m.created_at DESC`,
    ws,
  );
  return { meetings };
});

// Import a meeting transcript (Teams .vtt or .docx, or text) and let Sidekick write the notes.
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't import meetings.");
  await assertEnabled("extract");
  const form = await req.formData();
  const ws = await requireWorkspace(user, String(form.get("ws") ?? ""));
  const file = form.get("file");
  const pasted = String(form.get("text") ?? "");
  let transcript = pasted.trim();
  let title = String(form.get("title") ?? "").trim();
  if (file instanceof File && file.size) {
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Transcript file is larger than 25 MB.");
    transcript = (await fileToText(file.name, Buffer.from(await file.arrayBuffer()))).trim();
    title ||= file.name.replace(/\.[^.]+$/, "");
  }
  if (!transcript) throw new HttpError(400, "Add a transcript file or paste the transcript text.");
  if (!title) throw new HttpError(400, "Give the meeting a title.");
  const heldAt = String(form.get("held_at") ?? "").trim() || now().slice(0, 10);
  const id = newId();
  await run(
    "INSERT INTO meetings (id, org_id, workspace_id, title, held_at, external_guests, status, transcript, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Processing', ?, ?, ?)",
    id, user.org_id, ws, title, heldAt, form.get("external") === "true" ? 1 : 0, transcript, user.id, now(),
  );
  await audit(user, `Imported meeting “${title}”`, "Data", ws);
  await processMeeting(user, id);
  // Post the notes to the workspace's linked Teams channels without making the portal wait.
  after(async () => {
    await postMeetingNotes(user.org_id, id).catch((e) => console.error("Teams notes post failed", e));
    // Then a reminder in the chats that want one after meetings (what's still open from earlier).
    await remindAfterMeeting(user.org_id, id).catch((e) => console.error("Teams reminders after the meeting failed", e));
  });
  return { id };
});
