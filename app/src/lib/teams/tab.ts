/**
 * @file Sidekick as a Teams tab and personal app: the group's meetings, notes and action items inside Teams.
 *
 * Concepts
 * - **Where it shows**: as a personal app (Sidekick in the Teams app bar: "Meetings" tab), and as a tab people add
 *   to a group chat, channel or meeting (the meeting's chat, details page or side panel). Adding Sidekick to a
 *   meeting this way also puts the bot in the meeting chat, which can then be assigned to a group like any chat,
 *   and that group gets the meeting's automatic notes (lib/meetings-graph.ts `pickGroup`).
 * - **Teams single sign-on (SSO)**: the tab page asks Teams for a token (`authentication.getAuthToken()` in
 *   @microsoft/teams-js); Teams issues it silently for Sidekick's Entra app (`webApplicationInfo` in the manifest).
 *   The page sends it as `Authorization: Bearer …` with every call to /api/teams-tab, and `tabUser` verifies it each
 *   time (lib/entra.ts `verifyTeamsSsoToken`). No cookie is used, because browsers block cookies inside another
 *   site's frame (Teams on the web), so nothing here depends on the portal session.
 * - **Who**: the token's Microsoft tenant must be tied to a Sidekick organization (lib/tenants.ts) and the person
 *   must be a Sidekick user in it who has signed in with Microsoft once (their account id is on their user row) or
 *   was imported from Microsoft 365. There's no matching by email (security review L6). Anyone else gets a plain
 *   "ask your admin" message.
 * - **Walls**: the same as the portal: `requireWorkspace` decides which groups the person may open; in a chat tab
 *   the chat's linked group is the default, but only if the person may see it.
 * - **What it can change**: mark action items done / open again, and save items to knowledge, with the person's
 *   own role (Viewers can't). Everything else links to the portal.
 */
import "server-only";
import { all, get, run } from "../db";
import { audit, canEdit, HttpError, requireWorkspace, workspaceIdsFor, type User } from "../auth";
import { verifyTeamsSsoToken } from "../entra";
import { orgForTenant, portalUrl } from "../tenants";
import { orgAccess } from "../billing";
import { traceScope } from "../trace";
import { setItemSaved } from "../saved-items";
import { BRAND } from "../brand";

/**
 * The Sidekick user behind a tab request's Teams SSO token (`Authorization: Bearer …`).
 * @throws HttpError 401 (no or bad token), 403 (organization not signed up or paused, or not a Sidekick user yet)
 */
export async function tabUser(req: Request): Promise<User> {
  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer (.+)$/i.exec(auth)?.[1] ?? "";
  if (!token) throw new HttpError(401, `Open ${BRAND.name} inside Microsoft Teams to use this tab.`);
  const who = await verifyTeamsSsoToken(token);
  const org = await orgForTenant(who.tenantId);
  if (!org) throw new HttpError(403, `Your organization hasn't set up ${BRAND.name} yet. An admin can sign up at ${portalUrl("/signup")}.`);
  if (org.status === "Suspended") throw new HttpError(403, `Your organization's ${BRAND.name} access is paused. Contact the ${BRAND.name} team.`);
  const user = await get<User>("SELECT id, org_id, name, email, role, must_change_password FROM users WHERE org_id = ? AND entra_oid = ?", org.id, who.objectId);
  if (!user) throw new HttpError(403, `You don't have a ${BRAND.name} account yet, or haven't signed in with Microsoft once. Ask your ${BRAND.name} admin to add you, then sign in at ${portalUrl("/login")} with Microsoft.`);
  traceScope({ orgId: user.org_id, actor: user.name, userId: user.id });
  return user;
}

/** The group a tab opens on: the one asked for, else the chat's linked group (if the person may see it), else their first. */
async function pickTabGroup(user: User, ws: string | null, chatId: string | null): Promise<string | null> {
  const mine = await workspaceIdsFor(user);
  if (ws) return requireWorkspace(user, ws);
  if (chatId) {
    const linked = await get<{ workspace_id: string | null }>("SELECT workspace_id FROM teams_conversations WHERE id = ? AND org_id = ?", chatId.split(";")[0], user.org_id);
    if (linked?.workspace_id && mine.includes(linked.workspace_id)) return requireWorkspace(user, linked.workspace_id);
  }
  return mine.length ? requireWorkspace(user, mine[0]) : null;
}

/**
 * Everything the tab shows for one group: the person, the groups they may switch to, the group's recent meetings
 * (with counts and whether they came from Teams), its open action items, and one meeting's notes when `meeting` is
 * given (summary, decisions and things to keep with their saved state, open questions, action items).
 */
export async function tabView(user: User, q: { ws: string | null; chat: string | null; meeting: string | null }) {
  const ids = await workspaceIdsFor(user);
  const groups = ids.length ? await all<{ id: string; name: string }>(`SELECT id, name FROM workspaces WHERE org_id = ? AND id IN (${ids.map(() => "?").join(", ")}) ORDER BY name`, user.org_id, ...ids) : [];
  const ws = await pickTabGroup(user, q.ws, q.chat);
  const base = { user: { name: user.name, role: user.role, canEdit: canEdit(user) }, groups, portal: portalUrl("/meetings") };
  if (!ws) return { ...base, ws: null, meetings: [], actions: [], meeting: null };
  const meetings = await all(
    `SELECT m.id, m.title, m.held_at, m.status, m.source,
       (SELECT COUNT(*) FROM items i WHERE i.meeting_id = m.id AND i.kind = 'decision') AS decisions,
       (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id AND a.status <> 'Done') AS open_actions
     FROM meetings m WHERE m.workspace_id = ? AND m.org_id = ? ORDER BY m.held_at DESC, m.created_at DESC LIMIT 25`,
    ws, user.org_id,
  );
  const actions = await all(
    `SELECT a.id, a.text, a.owner, a.due, a.status, m.title AS meeting FROM action_items a LEFT JOIN meetings m ON m.id = a.meeting_id
      WHERE a.workspace_id = ? AND a.org_id = ? AND a.status <> 'Done' ORDER BY a.due_on IS NULL, a.due_on, a.created_at LIMIT 50`,
    ws, user.org_id,
  );
  let meeting = null;
  if (q.meeting) {
    const m = await get<{ id: string; title: string; held_at: string; summary: string | null; status: string; source: string | null }>(
      "SELECT id, title, held_at, summary, status, source FROM meetings WHERE id = ? AND org_id = ? AND workspace_id = ?", q.meeting, user.org_id, ws,
    );
    if (!m) throw new HttpError(404, "Meeting not found in this group.");
    const items = await all("SELECT id, kind, text, who, answered, pinned, saved_by FROM items WHERE meeting_id = ? AND org_id = ? ORDER BY rowid", m.id, user.org_id);
    const acts = await all("SELECT id, text, owner, due, status FROM action_items WHERE meeting_id = ? AND org_id = ? ORDER BY rowid", m.id, user.org_id);
    meeting = { ...m, items, actions: acts };
  }
  return { ...base, ws, meetings, actions, meeting };
}

/**
 * A change from the tab: `done` / `reopen` an action item, or `save` / `unsave` a meeting item to knowledge, in a
 * group the person may use and with their own role. Refused on a read-only plan. Audited ("in Teams").
 */
export async function tabAction(user: User, body: { action?: unknown; id?: unknown; ws?: unknown }) {
  const ws = await requireWorkspace(user, typeof body.ws === "string" ? body.ws : null);
  const access = await orgAccess(user.org_id);
  if (access.mode === "read_only") throw new HttpError(402, access.reason ?? "Your plan is read-only.");
  if (body.action === "save" || body.action === "unsave") return setItemSaved(user, ws, body.id, body.action === "save", { where: "Teams" });
  if (body.action !== "done" && body.action !== "reopen") throw new HttpError(400, "Unknown action.");
  if (!canEdit(user)) throw new HttpError(403, `Your ${BRAND.name} role (${user.role}) can't change action items.`);
  const a = typeof body.id === "string" ? await get<{ id: string; text: string }>("SELECT id, text FROM action_items WHERE id = ? AND org_id = ? AND workspace_id = ?", body.id, user.org_id, ws) : undefined;
  if (!a) throw new HttpError(404, "Action item not found in this group.");
  const status = body.action === "done" ? "Done" : "Open";
  await run("UPDATE action_items SET status = ? WHERE id = ? AND org_id = ?", status, a.id, user.org_id);
  await audit(user, `Marked action item “${a.text.slice(0, 60)}” ${status === "Done" ? "done" : "open again"} in Teams`, "Data", ws);
  return { ok: true, status };
}
