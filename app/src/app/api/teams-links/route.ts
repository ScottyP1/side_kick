/**
 * GET/POST/PATCH/DELETE /api/teams-links: which Teams channels and chats are linked to which workspace.
 * Listing: workspace members; changes: Org Owners and Org Admins, or a Team Lead for the workspaces they lead.
 * Two ways to link (see lib/teams/bot.ts, lib/teams/install.ts and lib/tenants.ts):
 * - **Assign a waiting chat** (`{ id, ws, guests? }`): chats and channels a Team Lead or admin added Sidekick
 *   to in the org's own Microsoft tenant, not assigned yet. GET returns them as `waiting` (id, name, kind, who
 *   added Sidekick and when, `leaves_at` = when Sidekick leaves if nobody assigns it): Org Owners/Admins see
 *   all of them, a Team Lead only the ones they added, and assigns those to the groups they lead. Assigning
 *   turns on reading every message (assigned means full access) and Sidekick says so in the chat.
 *   `?members=1` adds each waiting chat's `members` (names from Teams' roster, null if Teams can't be asked),
 *   for the group page's "Assign a chat" dialog. `picker` says whether this org is tied to a Microsoft tenant
 *   (then chats are assigned from the waiting list and Sidekick hands out no codes in group chats).
 * - **Link code** (`{ code, ws }`): for chats where the picker doesn't apply (a tenant not tied to the org,
 *   1:1 chats). In multi-tenant mode the chat must belong to the org's own Microsoft tenant.
 * Removing Sidekick from a chat altogether: POST /api/teams-links/remove.
 * The list includes each chat's settings (tracking, notes, reminders; see lib/reminders.ts) and its last
 * reminder. Unlinking also forgets the messages Sidekick saved from that chat and its settings.
 */
import { after } from "next/server";
import { assertCanAdd } from "@/lib/limits";
import { handle, readJson, requireText } from "@/lib/api";
import { audit, HttpError, isAdmin, isLead, requireManage, requireUser, workspaceIdsFor, type User } from "@/lib/auth";
import { all, asSystem, get, now, run } from "@/lib/db";
import { assignedCard, helpCard } from "@/lib/teams/cards";
import { chatMemberNames, normalizeCode, postCard, type TeamsConversation } from "@/lib/teams/bot";
import { WAITING_DAYS } from "@/lib/teams/install";
import { CHAT_RETENTION_DAYS, forgetChat, getChatSettings, lastRuns, saveChatSettings } from "@/lib/reminders";
import { tenantMode, tenantOfOrg } from "@/lib/tenants";
import { BRAND } from "@/lib/brand";

// Teams channels and chats linked to the workspaces this user can see.
export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const waiting = await waitingChats(user, new URL(req.url).searchParams.get("members") === "1");
  const picker = !!(await tenantOfOrg(user.org_id));
  const ids = await workspaceIdsFor(user);
  if (!ids.length) return { links: [], waiting, picker };
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
    waiting,
    picker,
    links: await Promise.all(
      links.map(async (l) => ({ ...l, settings: await getChatSettings(l), lastReminder: runs.get(l.id) ?? null, savedMessages: tracked.find((t) => t.conversation_id === l.id)?.n ?? 0 })),
    ),
  };
});

/** One chat waiting to be assigned, as GET returns it. */
type Waiting = { id: string; kind: string; name: string | null; added_by: string | null; created_at: string; waiting_since: string | null; last_seen_at: string; service_url: string };

/**
 * The SQL condition for "waits to be assigned in this tenant": unlinked, not 1:1, Sidekick not leaving. A Team
 * Lead additionally only gets the chats they added themselves (`added_by_oid` = their Microsoft account).
 */
async function waitingScope(user: User): Promise<{ sql: string; params: string[] } | null> {
  if (!isAdmin(user) && !isLead(user)) return null;
  const tenant = await tenantOfOrg(user.org_id);
  if (!tenant) return null;
  const base = "tenant_id = ? AND workspace_id IS NULL AND kind <> 'personal' AND leaving IS NULL";
  if (isAdmin(user)) return { sql: base, params: [tenant] };
  const oid = (await get<{ entra_oid: string | null }>("SELECT entra_oid FROM users WHERE id = ?", user.id))?.entra_oid;
  return oid ? { sql: `${base} AND added_by_oid = ?`, params: [tenant, oid] } : null;
}

/**
 * The chats and channels this person may assign: all waiting ones for Org Owners/Admins, the ones they added
 * for a Team Lead, none for anyone else. `leaves_at` is when Sidekick leaves if nobody assigns the chat. With
 * `withMembers`, the names of the people in each chat (asked from Teams, at most 20 chats, null when unavailable).
 */
async function waitingChats(user: User, withMembers = false) {
  const scope = await waitingScope(user);
  if (!scope) return [];
  // Waiting, unlinked or just-unlinked chats belong to no org yet (org_id NULL), which row-level security hides from
  // any org; the tenant / org condition in the query is the wall here (system work, lib/db.ts asSystem).
  const rows = await asSystem("Teams chats without an org", () => all<Waiting>(
    // No name saved (Teams left it out): the Sidekick person whose Microsoft account added it, if there is one.
    `SELECT id, kind, name, COALESCE(added_by, (SELECT u.name FROM users u WHERE u.org_id = ? AND u.entra_oid = teams_conversations.added_by_oid)) AS added_by,
            created_at, waiting_since, last_seen_at, service_url FROM teams_conversations WHERE ${scope.sql} ORDER BY created_at DESC LIMIT 100`,
    user.org_id, ...scope.params,
  ));
  return Promise.all(rows.map(async ({ service_url, ...r }, i) => ({
    ...r,
    leaves_at: new Date(new Date(r.waiting_since ?? r.created_at).getTime() + WAITING_DAYS * 86400_000).toISOString(),
    ...(withMembers ? { members: i < 20 ? await chatMemberNames({ id: r.id, service_url }) : null } : {}),
  })));
}

// Link a Teams channel/chat to a workspace: assign a waiting chat by id, or use the code Sidekick showed in Teams.
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ id?: string; code?: string; ws?: string; guests?: boolean }>(req);
  const ws = await requireManage(user, body.ws);
  await assertCanAdd(user.org_id, "chats"); // tracked chats are a plan limit (lib/limits.ts)
  const tenant = await tenantOfOrg(user.org_id);
  let conv: TeamsConversation | undefined;
  if (body.id !== undefined) {
    // Assigning from "Waiting to be assigned": only chats this person may see there (own tenant; a lead's own).
    const scope = await waitingScope(user);
    const id = body.id;
    conv = typeof id === "string" && scope
      ? await asSystem("Teams chats without an org", () => get<TeamsConversation>(`SELECT * FROM teams_conversations WHERE id = ? AND ${scope.sql}`, id, ...scope.params))
      : undefined;
    if (!conv) throw new HttpError(404, "That chat isn't waiting to be assigned any more (someone may have just assigned it). Reload the page.");
  } else {
    const code = normalizeCode(requireText(body.code, "Link code", 20));
    conv = code
      ? await asSystem("Teams chats without an org", () => get<TeamsConversation>("SELECT * FROM teams_conversations WHERE link_code = ? AND code_expires_at > ? AND workspace_id IS NULL", code, now()))
      : undefined;
    // Multi-tenant: a code from another company's Teams never links into this org.
    if (conv && tenantMode() === "multi" && (!tenant || conv.tenant_id !== tenant)) conv = undefined;
    if (!conv) throw new HttpError(404, `That code doesn't match a Teams channel or chat. Codes expire after 24 hours: mention @${BRAND.name} with “link” in Teams to get a new one.`);
  }
  // "AND workspace_id IS NULL": if two people assign the same chat at once, only the first one wins. The chat has
  // no org until this statement gives it this one: system work (lib/db.ts asSystem).
  const linked = await asSystem("Teams chats without an org", () => run(
    "UPDATE teams_conversations SET org_id = ?, workspace_id = ?, guests = ?, linked_by = ?, linked_at = ?, link_code = NULL, code_expires_at = NULL, waiting_since = NULL WHERE id = ? AND workspace_id IS NULL",
    user.org_id, ws, body.guests ? 1 : 0, user.id, now(), conv.id,
  ));
  if (!linked.changes) throw new HttpError(409, "Someone just linked that chat. Reload the page.");
  const wsName = (await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", ws))!.name;
  await audit(user, `Linked Teams ${conv.kind === "channel" ? "channel" : "chat"} “${conv.name ?? conv.id}” to workspace “${wsName}”`, "Access", ws);
  // A chat in the org's own tenant (the picker rules): assigned means Sidekick reads every message there.
  const fullAccess = conv.kind !== "personal" && !!tenant && conv.tenant_id === tenant;
  if (fullAccess) {
    const linkedConv = (await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", conv.id))!;
    await saveChatSettings(user, linkedConv, { track: true });
  }
  // Let the people in Teams know it worked.
  after(async () => {
    try {
      await postCard(conv, fullAccess ? assignedCard(wsName, user.name, CHAT_RETENTION_DAYS) : helpCard(wsName));
    } catch (e) {
      console.error("Couldn't confirm the link in Teams", e);
    }
  });
  return { ok: true, id: conv.id, name: conv.name, tracking: fullAccess };
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
  // Back to waiting (in the org's own tenant): the 7 days before Sidekick leaves start now. The chat leaves the org,
  // which row-level security only allows as system work (`ownLink` checked it's this org's).
  await asSystem("Teams chats without an org", () => run("UPDATE teams_conversations SET org_id = NULL, workspace_id = NULL, linked_by = NULL, linked_at = NULL, waiting_since = ? WHERE id = ?", now(), conv.id));
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
