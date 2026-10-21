/**
 * POST /api/teams-links/remove `{ id }`: "Remove Sidekick from this chat". Sidekick removes itself from the
 * Teams chat (or the channel's team) through Microsoft Graph, forgets the messages it saved there and the chat's
 * settings, and deletes the chat's record. Works for assigned chats and for chats waiting to be assigned.
 * Who: Org Owners and Org Admins; a Team Lead for chats assigned to a group they lead, or waiting chats they
 * added themselves. Answers 409 with `consent: "needed"` if the organization's Microsoft admin hasn't approved
 * Sidekick's "manage its own installation" permission; nothing changes then. Audited. See lib/teams/install.ts.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, isAdmin, isLead, managedWorkspaceIds, requireUser } from "@/lib/auth";
import { get } from "@/lib/db";
import type { TeamsConversation } from "@/lib/teams/bot";
import { leaveChat } from "@/lib/teams/install";
import { tenantOfOrg } from "@/lib/tenants";
import { BRAND } from "@/lib/brand";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, `Only Org Owners, Org Admins and the group's Team Lead can remove ${BRAND.name} from a chat.`);
  const { id } = await readJson<{ id?: unknown }>(req);
  const tenant = await tenantOfOrg(user.org_id);
  const conv = typeof id === "string" ? await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", id) : undefined;
  // In this org: linked to one of its groups, or waiting in its own Microsoft tenant.
  const inOrg = conv && (conv.workspace_id ? conv.org_id === user.org_id : !!tenant && conv.tenant_id === tenant && conv.kind !== "personal");
  if (!conv || !inOrg) throw new HttpError(404, "Teams chat not found.");
  if (isLead(user)) {
    const mine = conv.workspace_id
      ? (await managedWorkspaceIds(user)).includes(conv.workspace_id)
      : Boolean(conv.added_by_oid) && (await get<{ entra_oid: string | null }>("SELECT entra_oid FROM users WHERE id = ?", user.id))?.entra_oid === conv.added_by_oid;
    if (!mine) throw new HttpError(404, "Teams chat not found.");
  }
  if (conv.kind === "personal") throw new HttpError(400, `1:1 chats with ${BRAND.name} are removed in Teams by the person themselves.`);
  await leaveChat(conv, "removed", { by: user, strict: true });
  return { ok: true };
});
