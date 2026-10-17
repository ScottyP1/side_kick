/**
 * GET/POST/DELETE /api/meetings/:id: a meeting's notes; reprocess it (after a failure); or delete it with its notes and transcript.
 * Who: workspace members (reprocess and delete need edit rights).
 */
import { after } from "next/server";
import { handle } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { all, get, run } from "@/lib/db";
import { removeIndexed } from "@/lib/search";
import { processMeeting } from "@/lib/sidekick";
import { postMeetingNotes } from "@/lib/teams/bot";
import { remindAfterMeeting } from "@/lib/reminders";

type Ctx = { params: Promise<{ id: string }> };

async function load(id: string) {
  const user = await requireUser();
  const m = await get<{ id: string; workspace_id: string; title: string }>("SELECT * FROM meetings WHERE id = ? AND org_id = ?", id, user.org_id);
  if (!m) throw new HttpError(404, "Meeting not found.");
  await requireWorkspace(user, m.workspace_id);
  return { user, m };
}

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { m } = await load((await params).id);
  const items = await all("SELECT id, kind, text, who, answered FROM items WHERE meeting_id = ? ORDER BY rowid", m.id);
  const actions = await all("SELECT id, text, owner, due, status, ticket FROM action_items WHERE meeting_id = ? ORDER BY rowid", m.id);
  return { meeting: m, items, actions };
});

// Retry processing after a failure (for example, before the API key was added).
export const POST = handle(async (_req: Request, { params }: Ctx) => {
  const { user, m } = await load((await params).id);
  if (!canEdit(user)) throw new HttpError(403, "Your role can't reprocess meetings.");
  await run("DELETE FROM items WHERE meeting_id = ?", m.id);
  await run("DELETE FROM action_items WHERE meeting_id = ?", m.id);
  await removeIndexed(m.id);
  await run("UPDATE meetings SET status = 'Processing', error = NULL WHERE id = ?", m.id);
  await processMeeting(user, m.id);
  after(async () => {
    await postMeetingNotes(user.org_id, m.id).catch((e) => console.error("Teams notes post failed", e));
    // Then a reminder in the chats that want one after meetings (what's still open from earlier).
    await remindAfterMeeting(user.org_id, m.id).catch((e) => console.error("Teams reminders after the meeting failed", e));
  });
  return { ok: true };
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { user, m } = await load((await params).id);
  if (!canEdit(user)) throw new HttpError(403, "Your role can't delete meetings.");
  await removeIndexed(m.id);
  await run("DELETE FROM meetings WHERE id = ?", m.id);
  await audit(user, `Deleted meeting “${m.title}”, its notes and transcript`, "Data", m.workspace_id);
  return { ok: true };
});
