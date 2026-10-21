/**
 * GET/POST /api/meetings: list a workspace's meetings, or import a transcript and have Sidekick write the notes.
 * After a successful import the notes are posted to the workspace's linked Teams chats that take meeting notes,
 * followed by a reminder in the chats that want one after meetings (lib/reminders.ts).
 */
import { after } from "next/server";
import { handle, withErrorDetails } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { all, newId, now, run } from "@/lib/db";
import { fileToText, MAX_TRANSCRIPT_CHARS, MAX_UPLOAD_BYTES } from "@/lib/extract";
import { processMeeting } from "@/lib/sidekick";
import { assertEnabled } from "@/lib/owner";
import { postMeetingNotes } from "@/lib/teams/bot";
import { remindAfterMeeting } from "@/lib/reminders";

/** A real calendar day written as YYYY-MM-DD (2026-02-30 and "notadate" are not). */
function isDay(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

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

/**
 * Import a meeting transcript (Teams .vtt or .docx, or pasted text) and let Sidekick write the notes.
 * Who: people who can edit content in the workspace. Limits: files up to 25 MB, and the transcript text
 * (pasted or from the file) up to `MAX_TRANSCRIPT_CHARS`; the date must be YYYY-MM-DD.
 * If writing the notes fails, the meeting is still saved (status Failed) and the error body carries its
 * `meeting_id`, so the page can open it with **Try again** instead of the person importing it twice.
 */
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't import meetings.");
  await assertEnabled("extract", user.org_id);
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
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    throw new HttpError(413, `This transcript is too long: ${transcript.length.toLocaleString("en-US")} characters, and the limit is ${MAX_TRANSCRIPT_CHARS.toLocaleString("en-US")} (about five hours of talk). Split it into parts and import each one.`);
  }
  if (!title) throw new HttpError(400, "Give the meeting a title.");
  const heldAt = String(form.get("held_at") ?? "").trim() || now().slice(0, 10);
  // Dates sort as text, so anything but a real YYYY-MM-DD date would jump above real meetings.
  if (!isDay(heldAt)) throw new HttpError(400, "Meeting date must be a date like 2026-10-20.");
  const id = newId();
  await run(
    "INSERT INTO meetings (id, org_id, workspace_id, title, held_at, external_guests, status, transcript, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Processing', ?, ?, ?)",
    id, user.org_id, ws, title, heldAt, form.get("external") === "true" ? 1 : 0, transcript, user.id, now(),
  );
  await audit(user, `Imported meeting “${title}”`, "Data", ws);
  try {
    await processMeeting(user, id);
  } catch (e) {
    // The meeting is saved as Failed: tell the page which one, so it opens it with Try again.
    throw withErrorDetails(e, { meeting_id: id });
  }
  // Post the notes to the workspace's linked Teams channels without making the portal wait.
  after(async () => {
    await postMeetingNotes(user.org_id, id).catch((e) => console.error("Teams notes post failed", e));
    // Then a reminder in the chats that want one after meetings (what's still open from earlier).
    await remindAfterMeeting(user.org_id, id).catch((e) => console.error("Teams reminders after the meeting failed", e));
  });
  return { id };
});
