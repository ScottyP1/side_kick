/**
 * PATCH /api/teams-links/settings: change one linked Teams channel or chat's settings: message tracking,
 * meeting notes, reminders (on/off, time of day, time zone, quiet days, after meetings, kinds).
 * Body: `{ id, changes }` (only the fields to change). Who: Org Owners and Org Admins, or a Team Lead
 * of the chat's workspace. Every change is audited; switching tracking on or off is also announced in the chat.
 * Rules and defaults: lib/reminder-rules.ts.
 */
import { after } from "next/server";
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { managedLinkedChat, announceTracking, saveChatSettings } from "@/lib/reminders";

export const PATCH = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ id?: string; changes?: unknown }>(req);
  const conv = await managedLinkedChat(user, body.id);
  const { settings, trackChanged } = await saveChatSettings(user, conv, body.changes);
  if (trackChanged) {
    after(() => announceTracking(conv, settings.track, user.name).catch((e) => console.error("Couldn't announce the tracking change in Teams", e)));
  }
  return { settings };
});
