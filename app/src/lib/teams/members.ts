/**
 * @file `@Sidekick add @Maria` and `@Sidekick remove @Maria`: managing a workspace's people from its Teams chat.
 *
 * Concepts
 * - **Who may do it**: only someone Sidekick recognises (their Teams account's Microsoft id, `aadObjectId`, is
 *   saved on their Sidekick user, from a Microsoft sign-in or a directory import, in the org tied to this chat's
 *   tenant) who is an Org Owner/Admin, or a Team Lead of the chat's workspace. Everyone else gets a polite no.
 *   The same rules as on Users & access: a Team Lead only adds or removes Members and Viewers.
 * - **Who can be added**: people in the chat who belong to the organization's own Microsoft tenant (not guests
 *   from other companies). Teams tells Sidekick their Microsoft id, name and email (the chat roster), so no extra
 *   permission is needed. Someone not in Sidekick yet is created as a **Member who signs in with Microsoft**
 *   (no password; lib/directory.ts).
 * - **Removing** only takes the person off this workspace; it never deletes their account (that stays on
 *   Users & access, for Org Admins).
 * Every change is audited with "from Teams". Replies are fixed text built here (no Claude), so no guardrail
 * check is needed; names come from Microsoft.
 */
import "server-only";
import { audit, HttpError, isAdmin, isLead, LEAD_ASSIGNABLE_ROLES, type Role, type User } from "../auth";
import { get, run } from "../db";
import { findOrCreateMicrosoftUser } from "../directory";
import { span } from "../trace";
import { BRAND } from "../brand";

/** A person mentioned in the command, as the Teams chat roster describes them. */
export type ChatPerson = { name: string; objectId?: string; email?: string; tenantId?: string; guest: boolean };

/** What the bot posts back: a title and one line per person (or a single refusal line). */
export type CommandReply = { title: string; lines: string[] };

/** True if `actor` may add or remove people in this workspace: an Org Owner/Admin, or a Team Lead who belongs to it. */
async function mayManage(actor: User, workspaceId: string): Promise<boolean> {
  if (isAdmin(actor)) return true;
  if (!isLead(actor)) return false;
  return Boolean(await get("SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?", workspaceId, actor.id));
}

/**
 * Runs `add` or `remove` for the people mentioned, in the workspace this chat is linked to.
 *
 * @param actor  who typed the command (`teamsActor` in bot.ts: a real Sidekick user, or a `teams:` guest)
 * @param conv   the linked conversation (its org, workspace and Microsoft tenant)
 * @param people the mentioned people, already looked up in the chat roster
 */
export async function workspaceMemberCommand(
  action: "add" | "remove",
  actor: User,
  conv: { org_id: string; workspace_id: string; tenant_id: string | null },
  workspaceName: string,
  people: ChatPerson[],
): Promise<CommandReply> {
  const verb = action === "add" ? "add people to" : "take people off";
  if (actor.id.startsWith("teams:")) {
    return { title: `I don't know you in ${BRAND.name} yet`, lines: [`Only this workspace's Team Lead or an Org Admin can ${verb} ${workspaceName}. If that's you, sign in to the ${BRAND.name} portal with Microsoft once so I recognise you here.`] };
  }
  if (!(await mayManage(actor, conv.workspace_id))) {
    return { title: "Sorry, I can't do that for you", lines: [`Only this workspace's Team Lead or an Org Admin can ${verb} ${workspaceName}. Your ${BRAND.name} role is ${actor.role}.`] };
  }
  if (!people.length) return { title: "Who should I " + action + "?", lines: [`Mention them, for example “@${BRAND.name} ${action} @Maria”.`] };

  return span("teams", action === "add" ? "Add people to the workspace from Teams" : "Take people off the workspace from Teams", async () => {
    const lines: string[] = [];
    for (const p of people.slice(0, 10)) {
      try {
        lines.push(action === "add" ? await addOne(actor, conv, workspaceName, p) : await removeOne(actor, conv, workspaceName, p));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        lines.push(`${p.name}: ${e.message}`);
      }
    }
    return { title: action === "add" ? `People for ${workspaceName}` : `Taken off ${workspaceName}`, lines };
  }, { people: people.length });
}

const leadMayTouch = (actor: User, role: Role) => !isLead(actor) || LEAD_ASSIGNABLE_ROLES.includes(role);

async function addOne(actor: User, conv: { org_id: string; workspace_id: string; tenant_id: string | null }, ws: string, p: ChatPerson): Promise<string> {
  if (!p.objectId) return `${p.name}: I couldn't find their Microsoft account in this chat.`;
  if (p.guest || !conv.tenant_id || (p.tenantId && p.tenantId.toLowerCase() !== conv.tenant_id.toLowerCase())) {
    return `${p.name} is a guest from another organization, so I can't add them. They can still ask me questions in this chat.`;
  }
  const { user, created } = await findOrCreateMicrosoftUser(actor.org_id, { objectId: p.objectId, name: p.name, email: p.email ?? "" }, "Member");
  if (!created && (user.role === "Org Owner" || user.role === "Org Admin")) return `${user.name} is an ${user.role} and already sees every workspace.`;
  if (!created && !leadMayTouch(actor, user.role)) return `${user.name} is a ${user.role}; ask an Org Admin to add them.`;
  const already = await get("SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?", conv.workspace_id, user.id);
  if (already) return `${user.name} is already in ${ws}.`;
  await run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", conv.workspace_id, user.id);
  if (created) await audit(actor, `Added ${user.name} (${user.email}) as Member (Microsoft sign-in) from Teams`, "Access");
  await audit(actor, `Added ${user.name} (${user.email}) to workspace “${ws}” from Teams`, "Access", conv.workspace_id);
  return created ? `Added ${user.name} to ${ws}. They're new to ${BRAND.name}: they sign in with their Microsoft work account.` : `Added ${user.name} to ${ws}.`;
}

async function removeOne(actor: User, conv: { org_id: string; workspace_id: string }, ws: string, p: ChatPerson): Promise<string> {
  const user = p.objectId
    ? await get<{ id: string; name: string; email: string; role: Role }>("SELECT id, name, email, role FROM users WHERE org_id = ? AND entra_oid = ?", actor.org_id, p.objectId)
    : undefined;
  if (!user) return `${p.name} isn't in ${BRAND.name}, so there's nothing to take away.`;
  if (user.id === actor.id) return "You can't take yourself off here. Ask another Team Lead or an Org Admin.";
  if (user.role === "Org Owner" || user.role === "Org Admin") return `${user.name} is an ${user.role} and sees every workspace; their role is changed on Users & access.`;
  if (!leadMayTouch(actor, user.role)) return `${user.name} is a ${user.role}; ask an Org Admin.`;
  const n = await run("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?", conv.workspace_id, user.id);
  if (!n.changes) return `${user.name} wasn't in ${ws}.`;
  await audit(actor, `Took ${user.name} (${user.email}) off workspace “${ws}” from Teams`, "Access", conv.workspace_id);
  return `Took ${user.name} off ${ws}. Their ${BRAND.name} account stays; an Org Admin can remove it on Users & access.`;
}
