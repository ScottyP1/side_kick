/**
 * GET/POST/PATCH/DELETE /api/teams-links: which Teams channels and chats are linked to which workspace.
 * Linking uses the code Sidekick shows in Teams (see lib/teams/bot.ts). Listing: workspace members; changes:
 * Org Owners and Org Admins, or a Team Lead for the workspaces they lead.
 */
import { after } from "next/server";
import { handle, readJson, requireText } from "@/lib/api";
import { audit, HttpError, requireManage, requireUser, workspaceIdsFor, type User } from "@/lib/auth";
import { all, get, now, run } from "@/lib/db";
import { helpCard } from "@/lib/teams/cards";
import { normalizeCode, postCard, type TeamsConversation } from "@/lib/teams/bot";

// Teams channels and chats linked to the workspaces this user can see.
export const GET = handle(async () => {
  const user = await requireUser();
  const ids = await workspaceIdsFor(user);
  if (!ids.length) return { links: [] };
  const links = await all(
    `SELECT t.id, t.kind, t.name, t.guests, t.linked_at, t.last_seen_at, t.workspace_id, w.name AS workspace
       FROM teams_conversations t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.org_id = ? AND t.workspace_id IN (${ids.map(() => "?").join(",")}) ORDER BY w.name, t.name`,
    user.org_id, ...ids,
  );
  return { links };
});

// Link a Teams channel/chat to a workspace using the code Sidekick showed in Teams.
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ code?: string; ws?: string; guests?: boolean }>(req);
  const ws = await requireManage(user, body.ws);
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
  await audit(user, `Unlinked Teams ${conv.kind === "channel" ? "channel" : "chat"} “${conv.name ?? conv.id}”`, "Access", conv.workspace_id);
  return { ok: true };
});

/** A linked conversation in a workspace this user may manage (404 / 403 otherwise). */
async function ownLink(user: User, id: string | null | undefined): Promise<TeamsConversation> {
  const conv = id ? await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ? AND org_id = ?", id, user.org_id) : undefined;
  if (!conv) throw new HttpError(404, "Linked Teams channel not found.");
  await requireManage(user, conv.workspace_id);
  return conv;
}
