/**
 * GET/POST/PATCH/DELETE /api/teams-links: which Teams channels and chats are linked to which workspace.
 * Linking uses the code Sidekick shows in Teams (see lib/teams/bot.ts). Listing: workspace members; changes:
 * Org Owners and Org Admins, or a Team Lead for the workspaces they lead.
 * The list includes each chat's settings (tracking, notes, reminders; see lib/reminders.ts) and its last
 * reminder. Unlinking also forgets the messages Sidekick saved from that chat and its settings.
 */
import { after } from "next/server";
import { assertCanAdd } from "@/lib/limits";
import { handle, readJson, requireText } from "@/lib/api";
import { audit, HttpError, isAdmin, isLead, requireManage, requireUser, workspaceIdsFor, type User } from "@/lib/auth";
import { all, get, now, run } from "@/lib/db";
import { helpCard } from "@/lib/teams/cards";
import { normalizeCode, postCard, type TeamsConversation } from "@/lib/teams/bot";
import { forgetChat, getChatSettings, lastRuns } from "@/lib/reminders";

// Teams channels and chats linked to the workspaces this user can see.
export const GET = handle(async () => {
  const user = await requireUser();
  const ids = await workspaceIdsFor(user);
  if (!ids.length) return { links: [] };
  const links = await all<{ id: string; workspace_id: string }>(
    `SELECT t.id, t.kind, t.name, t.guests, t.linked_at, t.last_seen_at, t.workspace_id, w.name AS workspace
       FROM teams_conversations t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.org_id = ? AND t.workspace_id IN (${ids.map(() => "?").join(",")}) ORDER BY w.name, t.name`,
    user.org_id, ...ids,
  );
  const runs = await lastRuns(links.map((l) => l.id));
  const tracked = await all<{ conversation_id: string; n: number }>(
    `SELECT conversation_id, COUNT(*) AS n FROM chat_messages WHERE org_id = ? AND conversation_id IN (${links.map(() => "?").join(",") || "''"}) GROUP BY conversation_id`,
    user.org_id, ...links.map((l) => l.id),
  );
  return {
    links: await Promise.all(
      links.map(async (l) => ({ ...l, settings: await getChatSettings(l), lastReminder: runs.get(l.id) ?? null, savedMessages: tracked.find((t) => t.conversation_id === l.id)?.n ?? 0 })),
    ),
  };
});

// Link a Teams channel/chat to a workspace using the code Sidekick showed in Teams.
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ code?: string; ws?: string; guests?: boolean }>(req);
  const ws = await requireManage(user, body.ws);
  await assertCanAdd(user.org_id, "chats"); // tracked chats are a plan limit (lib/limits.ts)
  const code = normalizeCode(requireText(body.code, "Link code", 20));
  const conv = code
    ? await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE link_code = ? AND code_expires_at > ? AND workspace_id IS NULL", code, now())
    : undefined;
  if (!conv) throw new HttpError(404, "That code doesn't match a Teams channel or chat. Codes expire after 24 hours: mention @Sidekick with “link” in Teams to get a new one.");
  await run(
    "UPDATE teams_conversations SET org_id = ?, workspace_id = ?, guests = ?, linked_by = ?, linked_at = ?, link_code = NULL, code_expires_at = NULL WHERE id = ?",
    user.org_id, ws, body.guests ? 1 : 0, user.id, now(), conv.id,
  );
  const wsName = (await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", ws))!.name;
  await audit(user, `Linked Teams ${conv.kind === "channel" ? "channel" : "chat"} “${conv.name ?? conv.id}” to workspace “${wsName}”`, "Access", ws);
  // Let the people in Teams know it worked.
  after(async () => {
    try {
      await postCard(conv, helpCard(wsName));
    } catch (e) {
      console.error("Couldn't confirm the link in Teams", e);
    }
  });
  return { ok: true, name: conv.name };
});

// Change whether client guests are in the conversation (guests only get Shareable sources).
export const PATCH = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ id?: string; guests?: boolean }>(req);
  const conv = await ownLink(user, body.id);
  await run("UPDATE teams_conversations SET guests = ? WHERE id = ?", body.guests ? 1 : 0, conv.id);
  await audit(user, `Marked Teams ${conv.kind === "channel" ? "channel" : "chat"} “${conv.name ?? conv.id}” as ${body.guests ? "having client guests" : "internal only"}`, "Access", conv.workspace_id);
  return { ok: true };
});

export const DELETE = handle(async (req: Request) => {
  const user = await requireUser();
  const conv = await ownLink(user, new URL(req.url).searchParams.get("id"));
  await run("UPDATE teams_conversations SET org_id = NULL, workspace_id = NULL, linked_by = NULL, linked_at = NULL WHERE id = ?", conv.id);
  const forgotten = await forgetChat(conv.id);
  if (forgotten) await audit(user, `Deleted ${forgotten} saved message${forgotten === 1 ? "" : "s"} from Teams ${conv.kind === "channel" ? "channel" : "chat"} “${conv.name ?? conv.id}”`, "Data", conv.workspace_id);
  await audit(user, `Unlinked Teams ${conv.kind === "channel" ? "channel" : "chat"} “${conv.name ?? conv.id}”`, "Access", conv.workspace_id);
  return { ok: true };
});

/** A linked conversation in a workspace this user may manage (403 for roles that can't manage links, checked first; 404 otherwise). */
async function ownLink(user: User, id: string | null | undefined): Promise<TeamsConversation> {
  // Role first, so other roles always get a plain 403 whichever chat they name.
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and the workspace's Team Lead can do this.");
  const conv = id ? await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ? AND org_id = ?", id, user.org_id) : undefined;
  if (!conv) throw new HttpError(404, "Linked Teams channel not found.");
  await requireManage(user, conv.workspace_id);
  return conv;
}
