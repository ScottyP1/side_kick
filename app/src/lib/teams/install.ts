/**
 * @file Who may add Sidekick to a Teams chat, and Sidekick leaving chats it shouldn't be in.
 *
 * Concepts (Cody's rules for chats in a Microsoft tenant tied to a Sidekick org, lib/tenants.ts)
 * - **Only Team Leads and admins add Sidekick.** Teams can't limit who adds an app to one chat from Sidekick's
 *   side, so the bot checks it: when Sidekick is added to a group chat or a team, the person who added it
 *   (`activity.from.aadObjectId`, signed by Microsoft) must be a Team Lead, Org Admin or Org Owner of the org
 *   tied to that tenant. Anyone else gets a short card and Sidekick removes itself.
 * - **Assigned only in the portal.** An unassigned chat waits ("Waiting to be assigned") until a Team Lead or
 *   admin assigns it to a group (workspace). Until then Sidekick reads, saves and answers nothing there.
 * - **Leaving after 7 days.** A chat still unassigned 7 days after Sidekick was added (or unassigned) is left
 *   automatically (`leaveStaleChats`, the job queue's `teams.leave` job).
 * - **Removing Sidekick from a chat** in the portal does the same on request.
 * - **How Sidekick leaves**: Microsoft Graph, `DELETE /chats/{id}/installedApps/{installation}` (or
 *   `/teams/{group id}/installedApps/...` for a channel's team), with the application permissions
 *   `TeamsAppInstallation.ReadWriteSelfForChat.All` / `ReadWriteSelfForTeam.All` ("self": Sidekick can only
 *   add or remove itself), approved by the customer's Microsoft admin with the rest (lib/directory.ts).
 *   If Graph refuses (approval missing), the chat is marked `leaving`: Sidekick ignores it from then on and the
 *   timer tries again every hour.
 *
 * Single-tenant mode with a tenant that isn't tied to an org (the live site today) keeps the old link-code
 * flow and never leaves on its own.
 */
import "server-only";
import { audit, HttpError, type User } from "../auth";
import { all, get, now, run } from "../db";
import { graphCall } from "../directory";
import { forgetChat } from "../reminders";
import { span } from "../trace";
import { noticeCard } from "./cards";
import { postCard, type TeamsConversation } from "./bot";
import { BRAND } from "../brand";

/** How long a chat may wait to be assigned before Sidekick leaves it. */
export const WAITING_DAYS = 7;

// Tests shorten the wait and the retry pause (both ignored in production).
const testMs = (name: string) => (process.env.NODE_ENV !== "production" && process.env[name] ? Number(process.env[name]) : NaN);
const waitingMs = () => (Number.isFinite(testMs("SIDEKICK_LEAVE_AFTER_MS")) ? testMs("SIDEKICK_LEAVE_AFTER_MS") : WAITING_DAYS * 86400_000);
const retryMs = () => (Number.isFinite(testMs("SIDEKICK_LEAVE_RETRY_MS")) ? testMs("SIDEKICK_LEAVE_RETRY_MS") : 3600_000);

/** Why Sidekick leaves a chat (stored in `teams_conversations.leaving` while it's pending). */
export type LeaveReason = "installer" | "stale" | "removed";

/** The Teams app id (the manifest's `id`, which is the bot's Microsoft App ID). */
const teamsAppId = () => (process.env.TEAMS_APP_ID || process.env.CLIENT_ID || "").toLowerCase();

/**
 * True if this Microsoft account belongs to a Team Lead, Org Admin or Org Owner of the org: the people who may
 * add Sidekick to a chat.
 */
export async function mayAddSidekick(orgId: string, objectId: string | undefined): Promise<boolean> {
  if (!objectId) return false;
  const u = await get<{ role: string }>("SELECT role FROM users WHERE org_id = ? AND entra_oid = ?", orgId, objectId);
  return !!u && ["Org Owner", "Org Admin", "Team Lead"].includes(u.role);
}

type Installation = { id: string; teamsApp?: { id?: string; externalId?: string }; teamsAppDefinition?: { teamsAppId?: string } };

/** Where Sidekick's installation lives in Graph: the chat, or the team a channel belongs to. */
function installBase(conv: TeamsConversation): string {
  if (!conv.tenant_id) throw new HttpError(400, "This chat has no Microsoft organization on record.");
  if (conv.kind !== "channel") return `/v1.0/chats/${encodeURIComponent(conv.id)}`;
  if (!conv.team_aad_id) throw new HttpError(400, `Teams didn't say which team this channel belongs to. Remove ${BRAND.name} in Teams: the team's ⋯ → Manage team → Apps.`);
  return `/v1.0/teams/${encodeURIComponent(conv.team_aad_id)}`;
}
const DENIED = `${BRAND.name} isn't allowed to remove itself from Teams chats in your organization yet. A Microsoft admin approves it once (Users & access → Approve ${BRAND.name} for your organization), or remove ${BRAND.name} in Teams yourself.`;

/**
 * Sidekick's own installation in the chat (or the channel's team), as Graph lists it, or null if it isn't
 * installed there any more. @throws ConsentNeededError when the Microsoft admin hasn't approved the permission
 */
async function findInstallation(conv: TeamsConversation): Promise<string | null> {
  const list = await graphCall<{ value: Installation[] }>(conv.tenant_id!, "GET", `${installBase(conv)}/installedApps?$expand=teamsApp,teamsAppDefinition`, { deniedMessage: DENIED });
  const appId = teamsAppId();
  return (list?.value ?? []).find((i) => [i.teamsApp?.externalId, i.teamsApp?.id, i.teamsAppDefinition?.teamsAppId].some((x) => x?.toLowerCase() === appId))?.id ?? null;
}

/** Removes that installation. Graph answers 404 if it's already gone, which counts as done. */
async function removeInstallation(conv: TeamsConversation, installationId: string) {
  await graphCall(conv.tenant_id!, "DELETE", `${installBase(conv)}/installedApps/${encodeURIComponent(installationId)}`, { deniedMessage: DENIED });
}

const FAREWELL: Record<LeaveReason, (by?: string) => [string, string]> = {
  installer: () => ["I'm leaving this chat", "Only a Team Lead or admin can add me to a chat, so I'm leaving."],
  stale: () => ["I'm leaving this chat", `Nobody assigned this chat to a group in the ${BRAND.name} portal within ${WAITING_DAYS} days, so I'm leaving. A Team Lead can add me again any time.`],
  removed: (by) => ["I've been removed from this chat", `${by ?? "Someone"} removed me from this chat in the ${BRAND.name} portal. I've forgotten the messages I saved here.`],
};

/**
 * Makes Sidekick leave a chat: posts a short goodbye (best effort), forgets what it saved there, marks the chat
 * as leaving (so it's ignored from now on), then removes itself through Graph. On success the chat's record is
 * deleted; if Graph refuses, the record stays marked and `leaveStaleChats` tries again later.
 *
 * @param by who asked (portal removal), for the goodbye and the audit log
 * @returns true if Sidekick is gone from the chat, false if removal is still pending
 * @throws only when `opts.strict` is set (portal removal), with Graph's reason
 */
export async function leaveChat(conv: TeamsConversation, reason: LeaveReason, opts: { by?: Pick<User, "org_id" | "name">; strict?: boolean } = {}): Promise<boolean> {
  return span("microsoft", `Remove ${BRAND.name} from a Teams chat`, async () => {
    // Portal removal: ask Graph first, so a refusal leaves everything as it was and the person sees why.
    const installation = opts.strict ? await findInstallation(conv) : undefined;
    if (!conv.leaving) {
      const [title, body] = FAREWELL[reason](opts.by?.name);
      await postCard(conv, noticeCard(title, body)).catch((e) => console.error("Couldn't post the goodbye in Teams", e));
    }
    await run("UPDATE teams_conversations SET leaving = ?, leave_tried_at = ?, workspace_id = NULL, linked_at = NULL WHERE id = ?", reason, now(), conv.id);
    const forgotten = await forgetChat(conv.id);
    if (opts.by) {
      const where = conv.kind === "channel" ? "channel" : "chat";
      await audit(opts.by, `Removed ${BRAND.name} from Teams ${where} “${conv.name ?? conv.id}”${forgotten ? ` (forgot ${forgotten} saved message${forgotten === 1 ? "" : "s"})` : ""}`, "Access", conv.workspace_id);
    }
    try {
      const id = installation !== undefined ? installation : await findInstallation(conv);
      if (id) await removeInstallation(conv, id);
    } catch (e) {
      if (opts.strict) throw e;
      console.error(`Couldn't remove ${BRAND.name} from Teams chat ${conv.id} yet`, e instanceof Error ? e.message : e);
      return false;
    }
    await run("DELETE FROM teams_conversations WHERE id = ?", conv.id);
    return true;
  }, { reason, kind: conv.kind });
}

/**
 * Run by the job queue (`teams.leave`, every 5 minutes): leaves chats in tied tenants that have waited more than 7 days without being
 * assigned, and retries removals Graph refused earlier (at most once an hour per chat). Returns how many chats
 * Sidekick left. Each chat is handled on its own, so one failure doesn't stop the others.
 */
export async function leaveStaleChats(): Promise<number> {
  const cutoff = new Date(Date.now() - waitingMs()).toISOString();
  const retry = new Date(Date.now() - retryMs()).toISOString();
  const due = await all<TeamsConversation>(
    `SELECT c.* FROM teams_conversations c JOIN orgs o ON o.entra_tenant_id = c.tenant_id
      WHERE c.workspace_id IS NULL AND c.kind <> 'personal'
        AND ((c.leaving IS NULL AND c.waiting_since IS NOT NULL AND c.waiting_since < ?) OR (c.leaving IS NOT NULL AND c.leave_tried_at <= ?))
      LIMIT 50`,
    cutoff, retry,
  );
  let left = 0;
  for (const conv of due) {
    try {
      if (await leaveChat(conv, (conv.leaving as LeaveReason | null) ?? "stale")) left++;
      else await run("UPDATE teams_conversations SET leave_tried_at = ? WHERE id = ?", now(), conv.id);
    } catch (e) {
      console.error(`Couldn't leave Teams chat ${conv.id}`, e);
    }
  }
  return left;
}
