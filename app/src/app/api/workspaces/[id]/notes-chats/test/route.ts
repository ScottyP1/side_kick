/**
 * POST /api/workspaces/:id/notes-chats/test `{ chatId }`: "Send test message" next to a chat in the group's "Meeting
 * notes go to" picker. Posts a small card in that Teams chat ("👋 This is where <group>'s meeting notes will go (sent
 * from the Sidekick portal by <name>)") so people can see where notes will land.
 * - Who: the group's Team Lead or an Org Owner/Admin (`requireManage`: 403 for Members/Viewers, 404 for a group they
 *   can't see; 409 while the group is ending). The chat must be one of this group's linked chats (404 otherwise), so
 *   nobody can post into another group's or another organization's chat.
 * - Rate limit: one test message per chat per minute, whoever sends it (429 with a friendly message), so the button
 *   can't be used to spam a chat.
 * - 409 with Teams' reason when the post fails (not Sidekick's fault, so the portal shows it inline; the failed-posts
 *   watcher sees it too). Audited ("Agent action").
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, requireManage, requireUser } from "@/lib/auth";
import { get } from "@/lib/db";
import { linkedChat } from "@/lib/notes-chats";
import { takeHit } from "@/lib/rate-limit";
import { sendNotesTestMessage } from "@/lib/teams/bot";
import { failureReason } from "@/lib/trace";
import { BRAND } from "@/lib/brand";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const ws = await requireManage(user, (await params).id);
  const chat = await linkedChat(user.org_id, ws, (await readJson<{ chatId?: unknown }>(req)).chatId);
  const label = `“${chat.name ?? "Teams chat"}”`;
  await takeHit(`notes-test:${chat.id}`, 1, 1, `A test message was just sent to ${label}. Wait a minute before sending another.`);
  const group = (await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ? AND org_id = ?", ws, user.org_id))?.name ?? "this group";
  try {
    await sendNotesTestMessage(chat, group, user.name);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, `Couldn't post in ${label} (Teams said ${failureReason(e)}). Check that ${BRAND.name} is still in that chat in Teams.`);
  }
  await audit(user, `Sent a test message to Teams chat ${label} (where meeting notes go)`, "Agent action", ws);
  return { ok: true, chat: chat.name };
});
