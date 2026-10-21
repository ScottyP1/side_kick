/**
 * PATCH /api/teams-links/settings: change one linked Teams channel or chat's settings: message tracking,
 * meeting notes, reminders (on/off, time of day, time zone, quiet days, after meetings, kinds).
 * Body: `{ id, changes }` (only the fields to change). Who: Org Owners and Org Admins, or a Team Lead
 * of the chat's workspace. Every change is audited; switching tracking on or off is also announced in the chat.
 * Tracking can't be switched off in chats assigned through the picker (the org's own Microsoft tenant).
 * Rules and defaults: lib/reminder-rules.ts.
 */
import { after } from "next/server";
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { tenantOfOrg } from "@/lib/tenants";
import { managedLinkedChat, announceTracking, saveChatSettings } from "@/lib/reminders";
import { BRAND } from "@/lib/brand";

export const PATCH = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ id?: string; changes?: unknown }>(req);
  const conv = await managedLinkedChat(user, body.id);
  // Chats assigned in the org's own Microsoft tenant always track (assigned means full access): to stop,
  // remove Sidekick from the chat (POST /api/teams-links/remove).
  const changes = body.changes as { track?: unknown } | undefined;
  if (changes?.track === false && conv.kind !== "personal" && conv.tenant_id && conv.tenant_id === (await tenantOfOrg(user.org_id))) {
    throw new HttpError(400, `In chats assigned to a group, ${BRAND.name} reads every message. To stop that, remove ${BRAND.name} from the chat.`);
  }
  const { settings, trackChanged } = await saveChatSettings(user, conv, body.changes);
  if (trackChanged) {
    after(() => announceTracking(conv, settings.track, user.name).catch((e) => console.error("Couldn't announce the tracking change in Teams", e)));
  }
  return { settings };
});
