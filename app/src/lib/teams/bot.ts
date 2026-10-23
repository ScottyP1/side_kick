/**
 * @file Sidekick inside Microsoft Teams: the chat bot.
 *
 * How a Teams message reaches Sidekick
 *   Teams → Azure Bot Service → POST /api/messages (this app) → Teams SDK → the handlers below.
 * Each message is an **activity** (JSON describing who wrote what, where). The bot replies by calling back
 * the **service URL** that came with the activity. Messages Sidekick sends on its own, like meeting notes,
 * are **proactive** messages: they reuse the service URL saved when Sidekick first saw that conversation.
 *
 * Concepts
 * - **Conversation**: a Teams channel, group chat or 1:1 chat that Sidekick has been added to. Each one
 *   is a row in `teams_conversations`.
 * - **Linking**: a conversation must be linked to exactly one workspace before Sidekick answers there.
 *   If the chat's Microsoft tenant is tied to a Sidekick org (lib/tenants.ts), only a Team Lead or admin may
 *   add Sidekick (install.ts checks the installer and Sidekick leaves otherwise); the chat then waits ("Waiting
 *   to be assigned") until a Team Lead or admin assigns it to a group **in the portal only**. Until then
 *   Sidekick reads, saves and answers nothing there, and it leaves after 7 days. Once assigned it reads every
 *   message. In a tenant that isn't tied to an org (single-tenant mode, the live site today) Sidekick shows an
 *   8-character link code instead, entered on the group's page. Either way the link puts the chat inside one
 *   org's walls.
 * - **Tenants** (lib/tenants.ts): in multi-tenant mode Teams activities may come from any company. Sidekick
 *   only acts for tenants tied to a Sidekick org; anything else gets a "sign up first" card, and nothing about
 *   that chat is stored. In single-tenant mode (TENANT_ID set) every chat works as before.
 * - **Managing people from Teams** (members.ts): `@Sidekick add @name` / `remove @name` in a linked chat.
 * - **Client guests**: a linked conversation can be marked as having client guests. Answers there use only
 *   Shareable sources (the group's and the firm library's), and notes from internal-only meetings are never posted there.
 * - **Follow-ups**: a question builds on the asker's earlier questions in the same channel thread, or in the same
 *   group/1:1 chat within 30 minutes (lib/conversations.ts); "@Sidekick new question" starts afresh. The answer
 *   card shows "Following up on …" and has 👍/👎 buttons (lib/feedback.ts).
 * - **Chat settings** (see reminders.ts): per linked chat, an Org Admin chooses whether Sidekick tracks
 *   every message there (needs the app's resource-specific consent permissions, see teams/manifest),
 *   whether meeting notes go there, and whether reminders are posted there. (Chats assigned through the
 *   picker always track: assigned means full access.)
 * - **Adaptive Cards**: the formatted messages with buttons (see cards.ts). Button clicks come back as
 *   `card.action` activities and update the card in place.
 * - **Authentication**: in production every request carries a token signed by Microsoft for Sidekick's
 *   Azure Bot, and the Teams SDK rejects anything else (401). Local Playground mode is the only exception.
 *
 * Library: Microsoft Teams SDK for TypeScript (`@microsoft/teams.apps`), https://aka.ms/teams-sdk-ts
 */
import "server-only";
import crypto from "node:crypto";
import { after } from "next/server";
import { App, toThreadedConversationId, type HttpRouteHandler, type IHttpServerAdapter } from "@microsoft/teams.apps";
import { stripMentionsText, type IMessageActivityInput } from "@microsoft/teams.api";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import { all, get, now, run } from "../db";
import { audit, canEdit, HttpError, type User } from "../auth";
import { FeatureOffError } from "../owner";
import { ask, endAskConversation } from "../sidekick";
import { CHAT_FOLLOWUP_MINUTES } from "../conversations";
import { recordFeedback } from "../feedback";
import { failureReason, span, traceFailed, traceScope, withTrace } from "../trace";
import { actionItemCard, answerCard, helpCard, linkCard, meetingNotesCard, noticeCard, notSetUpCard, REMIND_PREFIX, unknownTenantCard, VERBS, type ActionItemInput } from "./cards";
import { leaveChat, mayAddSidekick, WAITING_DAYS } from "./install";
import { workspaceMemberCommand, type ChatPerson } from "./members";
import { homeTenantId, orgForTenant, portalUrl, tenantMode, type TenantOrg } from "../tenants";
import { getChatSettings, recordChatMessage, reminderAction } from "../reminders";
import { BRAND } from "../brand";

/* ------------------------------------------------------------------ */
/* Security mode                                                       */
/* ------------------------------------------------------------------ */

// Production: every request must carry a Microsoft-signed token for our Azure Bot (CLIENT_ID /
// CLIENT_SECRET / TENANT_ID, read by the Teams SDK). Local Agents Playground mode skips that check, so
// it only switches on outside production, when asked for explicitly, and only for localhost traffic.
export const PLAYGROUND_MODE = process.env.NODE_ENV !== "production" && process.env.TEAMS_LOCAL_PLAYGROUND === "true";

/** True if the URL points at this computer (localhost, 127.0.0.1 or ::1). */
const isLocalUrl = (url: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ */
/* Teams SDK app, plugged into the Next.js route at /api/messages      */
/* ------------------------------------------------------------------ */

// The Teams SDK normally runs its own Express server. This adapter hands its request handler to our
// Next.js route instead, so the bot lives inside the same app (and database) as the portal.
class NextRouteAdapter implements IHttpServerAdapter {
  /** The SDK's request handler (auth check + activity routing), captured when the app initializes. */
  handler?: HttpRouteHandler;
  registerRoute(_method: "POST", path: string, handler: HttpRouteHandler) {
    if (path === "/api/messages") this.handler = handler;
  }
}

declare global {
  var __sidekickTeams: Promise<{ app: App; adapter: NextRouteAdapter }> | undefined;
}

/**
 * The one Teams SDK app for this server process, created and initialized on first use. Kept on
 * `globalThis` so hot reloads in development don't register the handlers twice.
 */
export function teams() {
  globalThis.__sidekickTeams ??= (async () => {
    const adapter = new NextRouteAdapter();
    const app = new App({
      httpServerAdapter: adapter,
      messagingEndpoint: "/api/messages",
      // Always explicit, so the SDK's own environment variable can't turn auth off in production.
      dangerouslyAllowUnauthenticatedRequests: PLAYGROUND_MODE,
      // The bot's home tenant (a single-tenant Azure Bot, also when serving many companies), or empty for an
      // older multi-tenant bot, so the SDK uses Bot Framework's shared tenant even if TENANT_ID says "common".
      tenantId: homeTenantId() ?? "",
    });
    registerHandlers(app);
    await app.initialize();
    return { app, adapter };
  })();
  return globalThis.__sidekickTeams;
}

/**
 * Handles one POST to /api/messages: passes the activity to the Teams SDK (which checks the Microsoft
 * token and runs the matching handler) and returns its response. In Playground mode, anything that isn't
 * from this computer, or that asks Sidekick to reply to a non-local service URL, is refused with 401.
 */
export async function handleTeamsRequest(req: Request): Promise<Response> {
  let body: { serviceUrl?: string } & Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (PLAYGROUND_MODE && (!isLocalUrl(req.url) || !isLocalUrl(String(body.serviceUrl ?? "")))) {
    return Response.json({ error: "Playground mode only accepts local requests." }, { status: 401 });
  }
  const { adapter } = await teams();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const kind = String(body.type ?? "activity") === "invoke" ? "Teams card button" : String(body.type) === "message" ? "Teams message" : `Teams ${String(body.type ?? "event")}`;
  return withTrace({ name: kind, channel: "teams" }, async () => {
    const res = await adapter.handler!({ body, headers });
    if (res.status >= 400) traceFailed(res.status, `Teams request answered ${res.status}`);
    return res.body === undefined ? new Response(null, { status: res.status }) : Response.json(res.body, { status: res.status });
  });
}

/* ------------------------------------------------------------------ */
/* Linked conversations (Teams channel/chat <-> Sidekick workspace)    */
/* ------------------------------------------------------------------ */

/**
 * A Teams channel or chat Sidekick has been added to (a `teams_conversations` row).
 * `kind` is Teams' conversation type: "channel", "groupChat" or "personal" (1:1).
 * `workspace_id`/`org_id` are null until an admin links it; `link_code` is only set while waiting.
 */
export type TeamsConversation = {
  id: string;
  service_url: string;
  tenant_id: string | null;
  kind: string;
  name: string | null;
  link_code: string | null;
  code_expires_at: string | null;
  org_id: string | null;
  workspace_id: string | null;
  guests: number;
  /** Who added Sidekick here (Teams display name and Microsoft id), from the install activity. */
  added_by?: string | null;
  added_by_oid?: string | null;
  /** Since when the chat waits to be assigned (set when Sidekick is added or the chat is unlinked). */
  waiting_since?: string | null;
  /** The channel's team as a Microsoft 365 group id (Graph needs it to remove Sidekick from a team). */
  team_aad_id?: string | null;
  /** Set while Sidekick is leaving this chat ("installer", "stale", "removed"); it's ignored meanwhile. */
  leaving?: string | null;
  leave_tried_at?: string | null;
  /** Someone removed Sidekick from this chat in Teams (when, and their Teams name); cleared when it's added back. */
  removed_at?: string | null;
  removed_by?: string | null;
  /** The last time a post from Sidekick reached this chat (the failed-posts watcher compares failures with it). */
  last_post_ok_at?: string | null;
};

/** The parts of an incoming Teams activity Sidekick uses. */
type InboundActivity = {
  conversation: { id: string; conversationType?: string; tenantId?: string; name?: string };
  serviceUrl?: string;
  channelData?: { tenant?: { id?: string }; channel?: { id?: string; name?: string }; team?: { id?: string; name?: string; aadGroupId?: string } };
  recipient?: { id?: string };
  entities?: unknown[];
  from: { id: string; name?: string; aadObjectId?: string };
};

// Channel messages arrive as "<channel id>;messageid=<thread>"; the link is for the whole channel.
export const baseConversationId = (id: string) => id.split(";")[0];

// Shown until Teams tells us the real name. Never written over a real name (see touchConversation).
const PLACEHOLDER_NAMES: Record<string, string> = { personal: "1:1 chat", groupChat: "Group chat", channel: "Teams channel" };
const isPlaceholder = (name: string | null | undefined) => !name || Object.values(PLACEHOLDER_NAMES).includes(name);
// Before Oct 2026 the team's first channel was saved as "Team › General" without knowing its real name
// (it may have been renamed); such a name is looked up once more.
const isOldGeneralGuess = (name: string | null | undefined, conversationId: string, teamId?: string) => !!name && conversationId === teamId && name.endsWith(" › General");

/**
 * The conversation's display name from the activity itself, or null when the activity doesn't carry one.
 * Teams only includes team and channel names on some activities (e.g. when Sidekick is added), and a
 * group chat only has a name if someone gave it one.
 */
function activityName(a: InboundActivity): string | null {
  const team = a.channelData?.team?.name;
  const channel = a.channelData?.channel?.name;
  if (team && channel) return `${team} › ${channel}`;
  if (a.conversation.conversationType === "channel") return null;
  return a.conversation.name || null;
}

/**
 * Asks Teams for a channel's name ("Team › Channel") when the activity didn't include it. The team's first
 * channel has no name in Teams' API: it's "General" unless someone renamed it, so it shows as just the team
 * name rather than a guess (a later rename event fills in the real name). Best effort: returns null if Teams
 * can't be asked (e.g. local Playground against a remote service) and the placeholder stays.
 */
async function lookupChannelName(a: InboundActivity, conversationId: string): Promise<string | null> {
  const teamId = a.channelData?.team?.id;
  if (!teamId || !a.serviceUrl || (PLAYGROUND_MODE && !isLocalUrl(a.serviceUrl))) return null;
  try {
    return await span("teams", "Look up the channel name in Teams", async () => {
      const api = (await teams()).app.api.clone({ serviceUrl: a.serviceUrl! });
      const [team, channels] = await Promise.all([api.teams.getById(teamId), api.teams.getConversations(teamId)]);
      const channel = channels.find((c) => c.id === conversationId);
      const channelName = a.channelData?.channel?.name ?? channel?.name ?? null;
      const teamName = a.channelData?.team?.name ?? team.name;
      return teamName && channelName ? `${teamName} › ${channelName}` : (teamName ?? null);
    });
  } catch (e) {
    console.error("Couldn't look up the Teams channel name", e);
    return null;
  }
}

/**
 * Saves (or refreshes) the conversation an activity came from and returns its row. Keeps the latest
 * service URL, which proactive messages need, and the display name the portal shows. `addedBy` (from the
 * install activity) records who added Sidekick and restarts the 7-day wait.
 * Names: a real name from the activity always wins; a channel without one is looked up in Teams once
 * (while the saved name is still a placeholder); placeholders never overwrite a real name.
 */
async function touchConversation(a: InboundActivity, addedBy?: { name: string; oid: string | null }): Promise<TeamsConversation> {
  const id = baseConversationId(a.conversation.id);
  const kind = a.conversation.conversationType ?? "personal";
  let name = activityName(a);
  if (!name && kind === "channel") {
    const saved = await get<{ name: string | null }>("SELECT name FROM teams_conversations WHERE id = ?", id);
    if (isPlaceholder(saved?.name) || isOldGeneralGuess(saved?.name, id, a.channelData?.team?.id)) name = await lookupChannelName(a, id);
  }
  await run(
    `INSERT INTO teams_conversations (id, service_url, tenant_id, kind, name, created_at, last_seen_at, added_by, added_by_oid, waiting_since, team_aad_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET service_url = excluded.service_url, name = COALESCE(?, teams_conversations.name), last_seen_at = excluded.last_seen_at,
       added_by = COALESCE(excluded.added_by, teams_conversations.added_by), added_by_oid = COALESCE(excluded.added_by_oid, teams_conversations.added_by_oid),
       team_aad_id = COALESCE(excluded.team_aad_id, teams_conversations.team_aad_id)`,
    id, a.serviceUrl ?? "", tenantOf(a), kind, name ?? PLACEHOLDER_NAMES[kind] ?? "Teams chat", now(), now(), addedBy?.name ?? null, addedBy?.oid ?? null, now(), a.channelData?.team?.aadGroupId ?? null, name,
  );
  // Added again to a chat that still waits: the 7 days start over.
  if (addedBy) await run("UPDATE teams_conversations SET waiting_since = ? WHERE id = ? AND workspace_id IS NULL", now(), id);
  return (await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", id))!;
}

/** The Microsoft tenant an activity came from (Teams puts it on the conversation, and in channelData). */
const tenantOf = (a: InboundActivity) => a.conversation.tenantId ?? a.channelData?.tenant?.id ?? null;

/**
 * Whether Sidekick may act on this activity's tenant, and the org tied to it (if any).
 * - Multi-tenant mode: only tenants tied to a Sidekick org (`{ ok: false }` otherwise, and the caller stores nothing).
 * - Single-tenant mode: always ok (everything comes from the one tenant), so Teams behaves as before.
 */
async function tenantGate(a: InboundActivity): Promise<{ ok: true; org: TenantOrg | undefined } | { ok: false }> {
  const org = await orgForTenant(tenantOf(a));
  if (tenantMode() === "multi" && !org) return { ok: false };
  return { ok: true, org };
}

/**
 * True if this unlinked chat follows the "assigned only in the portal" rules (install.ts): a channel or group
 * chat in a tenant tied to an org. Everything else (1:1 chats, tenants not tied to an org) keeps the link code.
 */
const usesPicker = (conv: TeamsConversation, org: TenantOrg | undefined) => !!org && conv.kind !== "personal";

/**
 * The card for a chat that isn't linked yet: "I'm not set up for this chat yet" (no buttons, no code) where the
 * picker rules apply; otherwise the classic link-code card.
 */
async function unlinkedCard(conv: TeamsConversation, org: TenantOrg | undefined) {
  return usesPicker(conv, org) ? notSetUpCard(conv.kind, WAITING_DAYS) : linkCard(await freshLinkCode(conv), conv.kind);
}

/** The "sign up first" card for a tenant no Sidekick org is tied to (multi-tenant mode). */
const signupCard = () => unknownTenantCard(portalUrl("/signup"));

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I lookalikes
const CODE_HOURS = 24;

/**
 * Returns this conversation's link code, making a new one if there is none or it expired (24 hours).
 * Format "ABCD-2345": 8 random characters from an alphabet without lookalikes, about 40 bits of randomness.
 */
async function freshLinkCode(conv: TeamsConversation): Promise<string> {
  if (conv.link_code && conv.code_expires_at && new Date(conv.code_expires_at) > new Date()) return conv.link_code;
  const chars = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
  await run("UPDATE teams_conversations SET link_code = ?, code_expires_at = ? WHERE id = ?", code, new Date(Date.now() + CODE_HOURS * 3600_000).toISOString(), conv.id);
  return code;
}

/** Accepts a code typed any way ("abcd 2345", "ABCD2345") and returns "ABCD-2345", or null if it can't be one. */
export const normalizeCode = (code: string) => {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
};

/**
 * True if the message starts with "@Sidekick" typed as plain text: easy to do in Teams when the name isn't
 * picked from the mention list. Teams then delivers it only thanks to the chat-reading permission, without a mention.
 */
const PLAIN_MENTION = /^\s*@\s?sidekick\b[\s,:]*/i;
const startsWithPlainMention = (text: string | undefined) => PLAIN_MENTION.test(plainText(text ?? ""));
// Teams sends message text as HTML in channels; enough to read the start of it.
const plainText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/** True if the message @mentions Sidekick itself (the activity's recipient is the bot). */
const mentionsSidekick = (a: { recipient?: { id?: string }; entities?: unknown[] }) =>
  (a.entities ?? []).some((e) => {
    const m = e as { type?: string; mentioned?: { id?: string } };
    return m.type === "mention" && !!m.mentioned?.id && m.mentioned.id === a.recipient?.id;
  });

/** Name of the linked workspace (checked against the conversation's org), or null if not linked. */
const workspaceName = async (conv: TeamsConversation) =>
  conv.workspace_id ? (await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ? AND org_id = ?", conv.workspace_id, conv.org_id))?.name ?? null : null;

/** True if the owner paused this organization in the Owner Console; Sidekick then stops answering in Teams. */
const orgPaused = async (orgId: string) => (await get<{ status: string }>("SELECT status FROM orgs WHERE id = ?", orgId))?.status === "Suspended";

/**
 * Who sent a Teams activity, as Sidekick sees them.
 * - If their Microsoft account (`aadObjectId`) belongs to a Sidekick person in this organization, and the
 *   message comes from the Microsoft tenant the org connected (Settings → Microsoft sign-in), it's that
 *   person, with their own name and role (so a Viewer can ask but not change action items). The account
 *   id is saved the first time they sign in to the portal with Microsoft (lib/entra.ts).
 * - Otherwise they're a guest of the linked chat: they act as a Member of that one workspace (being in
 *   the linked Teams chat is what lets them ask), shown as "<name> (Teams)".
 * Teams requests are signed by Microsoft (checked in handleTeamsRequest), so the ids can be trusted.
 */
async function teamsActor(conv: TeamsConversation, a: InboundActivity): Promise<User> {
  const tenant = a.conversation.tenantId ?? a.channelData?.tenant?.id;
  if (a.from.aadObjectId && tenant && conv.org_id) {
    const person = await get<User>(
      `SELECT u.id, u.org_id, u.name, u.email, u.role, u.must_change_password FROM users u JOIN orgs o ON o.id = u.org_id
        WHERE u.org_id = ? AND u.entra_oid = ? AND o.entra_tenant_id = ?`,
      conv.org_id, a.from.aadObjectId, tenant,
    );
    if (person) {
      traceScope({ userId: person.id });
      return person;
    }
  }
  return {
    id: `teams:${a.from.aadObjectId ?? a.from.id}`,
    org_id: conv.org_id!,
    name: `${a.from.name ?? "Teams user"} (Teams)`,
    email: "",
    role: "Member",
    must_change_password: 0,
  };
}

/**
 * The people @mentioned in a message (other than Sidekick), looked up in the chat's roster so Sidekick knows
 * their Microsoft id, email and tenant. Someone Teams can't find is returned with just their name.
 */
async function mentionedPeople(a: InboundActivity, conv: TeamsConversation): Promise<ChatPerson[]> {
  const mentions = (a.entities ?? [])
    .map((e) => e as { type?: string; mentioned?: { id?: string; name?: string } })
    .filter((m) => m.type === "mention" && m.mentioned?.id && m.mentioned.id !== a.recipient?.id)
    .map((m) => m.mentioned!);
  const unique = [...new Map(mentions.map((m) => [m.id!, m])).values()];
  if (!unique.length || !a.serviceUrl || (PLAYGROUND_MODE && !isLocalUrl(a.serviceUrl))) return unique.map((m) => ({ name: m.name ?? "Someone", guest: false }));
  const api = (await teams()).app.api.clone({ serviceUrl: a.serviceUrl });
  // In a channel the roster belongs to the team.
  const rosterId = a.channelData?.team?.id ?? conv.id;
  return span("teams", "Look up mentioned people in the Teams chat", () =>
    Promise.all(
      unique.map(async (m): Promise<ChatPerson> => {
        try {
          const p = await api.conversations.getMemberById(rosterId, m.id!);
          return { name: p.name ?? m.name ?? "Someone", objectId: p.aadObjectId, email: (p.email ?? p.userPrincipalName ?? "").toLowerCase(), tenantId: p.tenantId, guest: p.userRole === "guest" || p.userRole === "anonymous" };
        } catch (e) {
          console.error("Couldn't look up a mentioned person in Teams", e);
          return { name: m.name ?? "Someone", guest: false };
        }
      }),
    ),
  { people: unique.length });
}

/* ------------------------------------------------------------------ */
/* Activity handlers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Wires up what Sidekick does for each kind of Teams activity:
 * - `install.add`: Sidekick was added to a channel/chat → the help card if it's already linked; otherwise, where
 *   the picker rules apply, the "not set up yet" notice if a Team Lead or admin added it (or Sidekick leaves),
 *   else the link code.
 * - `channelRenamed`: a channel's new name, so the portal shows it.
 * - `message`: someone mentioned Sidekick (or started with "@Sidekick" typed as plain text) → commands
 *   (`help`, `link`, `add @name`, `remove @name`) or a question to answer; other messages in tracked chats are only saved.
 * Every handler first checks the tenant (`tenantGate`): in multi-tenant mode an unknown company only gets
 * the sign-up card.
 * - `card.action`: someone clicked Assign / Mark done / Reopen on an action-item card.
 */
function registerHandlers(app: App) {
  app.on("install.add", async ({ activity, send }) => {
    const gate = await tenantGate(activity);
    if (!gate.ok) return void (await send(signupCard()));
    const conv = await touchConversation(activity, { name: activity.from.name ?? "Someone in Teams", oid: activity.from.aadObjectId ?? null });
    // Added back after someone removed it: the chat works again (and the watcher's finding resolves).
    if (conv.removed_at) await run("UPDATE teams_conversations SET removed_at = NULL, removed_by = NULL WHERE id = ?", conv.id);
    if (conv.workspace_id) return void (await send(helpCard(await workspaceName(conv))));
    // Only a Team Lead or admin of the tenant's org may add Sidekick to a chat; anyone else, Sidekick leaves.
    if (usesPicker(conv, gate.org) && !(await mayAddSidekick(gate.org!.id, activity.from.aadObjectId))) {
      traceScope({ orgId: gate.org!.id });
      after(() => leaveChat(conv, "installer").then(() => undefined, (e) => console.error("Couldn't leave the Teams chat", e)));
      return;
    }
    await send(await unlinkedCard(conv, gate.org));
  });

  // Someone removed Sidekick from a chat (or uninstalled it from a team) in Teams. A linked chat keeps its link, marked
  // removed, so the group's managers see it (watcher "removed from a chat") and can add Sidekick back or unlink it;
  // nothing is posted there meanwhile. A chat that wasn't assigned to a group is simply forgotten. When Sidekick
  // removed itself (`leaving`), leaveChat already handles the record.
  app.on("install.remove", async ({ activity }) => {
    const conv = await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", baseConversationId(activity.conversation.id));
    if (!conv || conv.leaving) return;
    if (!conv.workspace_id) return void (await run("DELETE FROM teams_conversations WHERE id = ?", conv.id));
    traceScope({ orgId: conv.org_id, workspaceId: conv.workspace_id, actor: activity.from.name ?? "Teams user" });
    await run("UPDATE teams_conversations SET removed_at = ?, removed_by = ? WHERE id = ?", now(), (activity.from.name ?? "Someone in Teams").slice(0, 120), conv.id);
    await audit({ org_id: conv.org_id!, name: activity.from.name ?? "Someone in Teams" }, `Removed ${BRAND.name} from Teams ${conv.kind === "channel" ? "channel" : "chat"} “${conv.name ?? conv.id}” in Teams`, "Access", conv.workspace_id);
  });

  // A channel was renamed: Teams says so to the team's bot, with the channel's id and new name.
  app.on("channelRenamed", async ({ activity }) => {
    const channel = activity.channelData?.channel;
    const team = activity.channelData?.team?.name;
    if (!channel?.id || !channel.name || !team) return;
    await run("UPDATE teams_conversations SET name = ? WHERE id = ?", `${team} › ${channel.name}`, channel.id);
  });

  // In channels and group chats Teams only delivers messages that @mention Sidekick; in 1:1 chats, every message.
  // With the chat-reading permission Teams also sends the others; one starting with "@Sidekick" typed as
  // plain text counts as a question.
  // stripMentionsText removes the "@Sidekick" part so only the question is left.
  // With the resource-specific consent permissions in the manifest, Teams also delivers channel and
  // group-chat messages that don't mention Sidekick: those are only saved (tracked chats) or ignored.
  app.on("message", async ({ activity, send, reply }) => {
    // Multi-tenant: a company that hasn't signed up gets one friendly card when it talks to Sidekick, and
    // nothing is saved (plain chat messages are ignored without a reply).
    const gate = await tenantGate(activity);
    if (!gate.ok) {
      const addressed = activity.conversation.conversationType === "personal" || mentionsSidekick(activity) || startsWithPlainMention(activity.text);
      if (addressed) await send(signupCard());
      return;
    }
    const conv = await touchConversation(activity);
    // Sidekick is on its way out of this chat (refused installer, never assigned, removed): ignore everything.
    if (conv.leaving) return;
    // A chat linked (by code, before multi-tenant) to another org than the one its tenant belongs to is left alone.
    if (tenantMode() === "multi" && conv.org_id && gate.org && conv.org_id !== gate.org.id) {
      if (conv.kind === "personal" || mentionsSidekick(activity)) await send(`This chat is linked to a different organization's ${BRAND.name}. An admin can unlink it on the group's page in the ${BRAND.name} portal.`);
      return;
    }
    traceScope({ orgId: conv.org_id, workspaceId: conv.workspace_id, actor: activity.from.name ?? "Teams user" });
    const plainMention = conv.kind !== "personal" && !mentionsSidekick(activity) && startsWithPlainMention(activity.text);
    if (conv.kind !== "personal" && !mentionsSidekick(activity) && !plainMention) {
      if (conv.workspace_id && !(await orgPaused(conv.org_id!))) await recordChatMessage(conv, activity);
      return;
    }
    // Not assigned yet where the picker rules apply: read, save and answer nothing; just say how to set it up.
    if (!conv.workspace_id && usesPicker(conv, gate.org)) return void (await send(notSetUpCard(conv.kind, WAITING_DAYS)));
    let question = (plainMention ? plainText(activity.text ?? "").replace(PLAIN_MENTION, "") : (stripMentionsText(activity) ?? "")).replace(/\s+/g, " ").trim();
    const command = question.toLowerCase().replace(/[^a-z]/g, "");

    if (!question || command === "help") return void (await send(helpCard(await workspaceName(conv))));
    if (!conv.workspace_id) return void (await send(await unlinkedCard(conv, gate.org)));
    if (command === "link") {
      return void (await send(`This ${conv.kind === "channel" ? "channel" : "chat"} is linked to **${await workspaceName(conv)}**. A Team Lead or admin can change that on the group's page in the ${BRAND.name} portal.`));
    }
    if (await orgPaused(conv.org_id!)) return void (await send(`${BRAND.name} is paused for this organization. Contact the ${BRAND.name} team.`));
    if (question.length > 1000) return void (await send("That question is too long for me (max 1,000 characters)."));
    const asker = await teamsActor(conv, activity);
    // "add"/"remove" followed by @mentions of people: a command. Without a mention it's an ordinary question
    // ("add a risk section?"), answered as usual.
    const othersMentioned = (activity.entities ?? []).some((e) => {
      const m = e as { type?: string; mentioned?: { id?: string } };
      return m.type === "mention" && !!m.mentioned?.id && m.mentioned.id !== activity.recipient?.id;
    });
    const memberCommand = othersMentioned ? (/^(add|remove)\b/i.exec(question)?.[1]?.toLowerCase() as "add" | "remove" | undefined) : undefined;
    if (memberCommand) {
      const people = await mentionedPeople(activity, conv);
      const out = await workspaceMemberCommand(memberCommand, asker, { org_id: conv.org_id!, workspace_id: conv.workspace_id, tenant_id: conv.tenant_id }, (await workspaceName(conv)) ?? "this workspace", people);
      return void (await send({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: noticeCard(out.title, out.lines.map((l) => `- ${l}`).join("\n")) }] } as IMessageActivityInput));
    }
    traceScope({ actor: asker.name });
    // Follow-ups: in a channel the reply thread is the conversation (its id carries ";messageid=<first post>"); in a
    // group or 1:1 chat it's the chat, for CHAT_FOLLOWUP_MINUTES after the last answer. "new question" starts afresh.
    const threadKey = conv.kind === "channel" ? activity.conversation.id : conv.id;
    const guests = conv.guests === 1;
    const fresh = /^new question\b[\s:,.!?-]*/i.exec(question);
    if (fresh) {
      question = question.slice(fresh[0].length).trim();
      if (!question) {
        await endAskConversation(asker, conv.workspace_id, guests, { teamsKey: threadKey });
        return void (await send("Okay, starting fresh. Mention me with your next question."));
      }
    }

    await send({ type: "typing" });
    // Teams expects a reply to its request within a few seconds; Claude can take longer, so the
    // answer is sent as a follow-up message after this request has already been acknowledged.
    after(() =>
      withTrace({ name: "Teams answer", channel: "teams", orgId: conv.org_id, workspaceId: conv.workspace_id, actor: asker.name, detached: true }, async () => {
        try {
          const result = await ask(asker, conv.workspace_id!, question, guests, "teams", {
            teamsScope: { key: threadKey, idleMinutes: conv.kind === "channel" ? undefined : CHAT_FOLLOWUP_MINUTES },
            newQuestion: Boolean(fresh),
          });
          const card = answerCard(question, result, (await workspaceName(conv)) ?? "Workspace");
          await span("teams", "Send the answer card to Teams", () => reply(card)).then(
            () => notePostOk(conv.id),
            async (e) => {
              await notePostFailed(conv.id, "an answer", e);
              throw e;
            },
          );
        } catch (e) {
          console.error("Teams ask failed", e);
          // A feature paused or turned off by the Sidekick team is a refusal, not a failure of Sidekick.
          traceFailed(e instanceof HttpError ? e.status : 500, e instanceof Error ? e.message : String(e), undefined, { refusal: e instanceof FeatureOffError });
          await send(e instanceof HttpError ? e.message : "Sorry, I couldn't answer that just now. Please try again in a minute.").catch(() => {});
        }
      }),
    );
  });

  // Returns the updated card, which Teams swaps in for the old one, so everyone sees the new owner/status.
  app.on("card.action", async ({ activity }) => {
    const { verb, data } = activity.value.action;
    // A message response shows the text to the person who clicked and leaves the card as it was.
    const fail = (message: string) => ({ statusCode: 200 as const, type: "application/vnd.microsoft.activity.message" as const, value: message });
    const gate = await tenantGate(activity);
    if (!gate.ok) return fail(`${BRAND.name} isn't set up for your organization yet.`);
    const conv = await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", baseConversationId(activity.conversation.id));
    if (!conv?.workspace_id || !conv.org_id) return fail(`This chat isn't linked to a ${BRAND.name} workspace anymore.`);
    if (tenantMode() === "multi" && gate.org && conv.org_id !== gate.org.id) return fail(`This chat is linked to a different organization's ${BRAND.name}.`);
    traceScope({ orgId: conv.org_id, workspaceId: conv.workspace_id, actor: activity.from.name ?? "Teams user" });
    if (await orgPaused(conv.org_id)) return fail(`${BRAND.name} is paused for this organization.`);
    // 👍/👎 on an answer card: only for answers given in this chat's own group (recordFeedback checks it).
    if (verb === VERBS.feedbackUp || verb === VERBS.feedbackDown) {
      const voter = await teamsActor(conv, activity);
      try {
        await recordFeedback(conv.org_id, conv.workspace_id, String(data?.questionId ?? ""), voter.id, verb === VERBS.feedbackUp ? 1 : -1, "teams");
      } catch (e) {
        if (e instanceof HttpError) return fail(e.message);
        throw e;
      }
      return fail(verb === VERBS.feedbackUp ? "Thanks, glad it helped." : "Thanks for telling us. Your admins can see which answers weren't helpful.");
    }
    if (typeof verb === "string" && verb.startsWith(REMIND_PREFIX)) {
      const out = await span("remind", "Reminder card button", async () => reminderAction(conv, await teamsActor(conv, activity), verb, { ...(data ?? {}) }));
      if ("error" in out) return fail(out.error);
      return { statusCode: 200 as const, type: "application/vnd.microsoft.card.adaptive" as const, value: out.card };
    }
    // Workspace wall: the card only works in a conversation linked to the item's own workspace. In a chat with
    // client guests, only items from meetings that had external guests (the only ones whose cards are posted
    // there), so a guest can't change internal action items by sending another item's id.
    const item = await get<ActionItemInput & { workspace_id: string; external_guests: number | null }>(
      `SELECT a.id, a.text, a.owner, a.due, a.status, a.workspace_id, m.external_guests
         FROM action_items a LEFT JOIN meetings m ON m.id = a.meeting_id
        WHERE a.id = ? AND a.org_id = ? AND a.workspace_id = ?`,
      String(data?.itemId ?? ""), conv.org_id, conv.workspace_id,
    );
    if (!item || (conv.guests === 1 && item.external_guests !== 1)) return fail("I couldn't find that action item in this workspace.");
    const actor = await teamsActor(conv, activity);
    if (!canEdit(actor)) return fail(`Your ${BRAND.name} role (${actor.role}) can't change action items. Ask a Member or an Org Admin.`);
    if (verb === VERBS.assign) {
      const owner = String(data?.owner ?? "").trim().slice(0, 120);
      if (!owner) return fail("Type a name to assign it to.");
      await run("UPDATE action_items SET owner = ?, status = CASE WHEN status = 'Open' THEN 'In progress' ELSE status END WHERE id = ?", owner, item.id);
      await audit(actor, `Assigned action item “${item.text.slice(0, 60)}” to ${owner} in Teams`, "Data", item.workspace_id);
    } else if (verb === VERBS.done || verb === VERBS.reopen) {
      const status = verb === VERBS.done ? "Done" : "Open";
      await run("UPDATE action_items SET status = ? WHERE id = ?", status, item.id);
      await audit(actor, `Marked action item “${item.text.slice(0, 60)}” ${status === "Done" ? "done" : "open again"} in Teams`, "Data", item.workspace_id);
    } else {
      return fail("Unknown action.");
    }
    const updated = (await get<ActionItemInput>("SELECT id, text, owner, due, status FROM action_items WHERE id = ?", item.id))!;
    return { statusCode: 200 as const, type: "application/vnd.microsoft.card.adaptive" as const, value: actionItemCard({ ...updated, updatedBy: activity.from.name }) };
  });
}

/* ------------------------------------------------------------------ */
/* Proactive: post meeting notes to the workspace's linked channels    */
/* ------------------------------------------------------------------ */

/** Wraps an Adaptive Card in a Teams message. */
const cardMessage = (c: IAdaptiveCard): IMessageActivityInput =>
  ({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: c }] }) as IMessageActivityInput;

/**
 * Sends a card into a Teams conversation outside of a reply (a proactive message). Returns the new message
 * id. Pass `conversationId` to post into a channel thread instead of starting a new post.
 */
export async function postCard(conv: Pick<TeamsConversation, "id" | "service_url">, c: IAdaptiveCard, conversationId = conv.id, what = "a card"): Promise<string | undefined> {
  if (PLAYGROUND_MODE && !isLocalUrl(conv.service_url)) throw new Error("Playground mode only posts to local conversations.");
  const { app } = await teams();
  try {
    const id = await span("teams", "Post a card to Teams", async () => (await app.api.clone({ serviceUrl: conv.service_url }).conversations.createActivity(conversationId, cardMessage(c))).id);
    await notePostOk(conv.id);
    return id;
  } catch (e) {
    await notePostFailed(conv.id, what, e);
    throw e;
  }
}

/** Records that a post reached this chat (clears the failed-posts watcher's finding on its next run). Never throws. */
async function notePostOk(conversationId: string) {
  await run("UPDATE teams_conversations SET last_post_ok_at = ? WHERE id = ?", now(), baseConversationId(conversationId)).catch((e) => console.error("Couldn't record the Teams post", e));
}

/**
 * Records a Teams post that failed (`teams_post_failures`: which chat, what, Microsoft's error without any message
 * text), for the failed-posts watcher (lib/watchers.ts). Only chats that belong to an organization. Never throws.
 */
export async function notePostFailed(conversationId: string, what: string, e: unknown) {
  try {
    const conv = await get<{ id: string; org_id: string | null; workspace_id: string | null }>("SELECT id, org_id, workspace_id FROM teams_conversations WHERE id = ?", baseConversationId(conversationId));
    if (!conv?.org_id) return;
    await run(
      "INSERT INTO teams_post_failures (id, org_id, workspace_id, conversation_id, what, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), conv.org_id, conv.workspace_id, conv.id, what.slice(0, 60), failureReason(e), now(),
    );
  } catch (err) {
    console.error("Couldn't record the failed Teams post", err);
  }
}

// Cap so one long meeting can't flood a channel; the full list is always in the portal.
const MAX_ACTION_CARDS = 15;

/**
 * Posts a processed meeting's notes card, then one card per action item, to every Teams conversation
 * linked to the meeting's workspace that has meeting notes switched on in its chat settings (the default).
 * Skips conversations with client guests if the meeting was internal.
 * A failure in one conversation is logged and doesn't stop the others. Returns how many got the notes.
 * Called from the meeting import/reprocess routes after the response is sent, so imports never wait on Teams.
 */
export async function postMeetingNotes(orgId: string, meetingId: string): Promise<number> {
  // Nothing to post to (Teams not set up, or no chat linked to this workspace): no trace at all, so
  // Activity and the home orb don't count Teams work that never happened.
  if (!(await meetingHasLinkedChat(orgId, meetingId))) return 0;
  return withTrace({ name: "Post meeting notes to Teams", channel: "teams", orgId, detached: true }, () => postMeetingNotesInner(orgId, meetingId));
}

/**
 * Whether any Teams chat or channel is linked to the workspace of this meeting (in this org). Checked before
 * starting Teams work after an import, so nothing is recorded when there's nowhere to post.
 */
export async function meetingHasLinkedChat(orgId: string, meetingId: string): Promise<boolean> {
  return Boolean(await get(
    "SELECT c.id FROM teams_conversations c JOIN meetings m ON m.workspace_id = c.workspace_id WHERE m.id = ? AND m.org_id = ? AND c.org_id = ? AND c.removed_at IS NULL LIMIT 1",
    meetingId, orgId, orgId,
  ));
}

async function postMeetingNotesInner(orgId: string, meetingId: string): Promise<number> {
  const m = await get<{ id: string; workspace_id: string; title: string; held_at: string; summary: string | null; status: string; external_guests: number; ws: string }>(
    "SELECT m.id, m.workspace_id, m.title, m.held_at, m.summary, m.status, m.external_guests, w.name AS ws FROM meetings m JOIN workspaces w ON w.id = m.workspace_id WHERE m.id = ? AND m.org_id = ?",
    meetingId, orgId,
  );
  if (!m || m.status !== "Ready") return 0;
  traceScope({ workspaceId: m.workspace_id });
  // Notes from an internal-only meeting never go to a conversation that has client guests in it.
  const convs = await all<TeamsConversation>(
    "SELECT * FROM teams_conversations WHERE org_id = ? AND workspace_id = ? AND removed_at IS NULL AND (guests = 0 OR ? = 1)",
    orgId, m.workspace_id, m.external_guests,
  );
  // Only chats an admin left (or set) to receive meeting notes: a workspace can keep them to one notes chat.
  const settings = await Promise.all(convs.map((c) => getChatSettings(c)));
  const targets = convs.filter((_, i) => settings[i].notes);
  if (!targets.length) return 0;
  const items = await all<{ kind: string; text: string; answered: number | null }>("SELECT kind, text, answered FROM items WHERE meeting_id = ? ORDER BY rowid", m.id);
  const actions = await all<ActionItemInput>("SELECT id, text, owner, due, status FROM action_items WHERE meeting_id = ? ORDER BY rowid", m.id);
  const notes = meetingNotesCard({
    workspace: m.ws,
    title: m.title,
    heldAt: m.held_at,
    summary: m.summary ?? "",
    decisions: items.filter((i) => i.kind === "decision").map((i) => i.text),
    openQuestions: items.filter((i) => i.kind === "question" && !i.answered).map((i) => i.text),
    actionCount: actions.length,
    portalUrl: portalUrl("/meetings"),
  });

  let posted = 0;
  for (const conv of targets) {
    try {
      const postId = await postCard(conv, notes, conv.id, "meeting notes");
      // In a channel the action items go in the notes post's thread; in chats they follow it.
      const target = conv.kind === "channel" && postId ? toThreadedConversationId(conv.id, postId) : conv.id;
      for (const a of actions.slice(0, MAX_ACTION_CARDS)) await postCard(conv, actionItemCard(a), target, "an action item");
      posted++;
    } catch (e) {
      console.error(`Couldn't post meeting notes to Teams conversation ${conv.id}`, e);
    }
  }
  if (posted) await audit({ org_id: orgId, name: BRAND.name }, `Posted notes for “${m.title}” to ${posted} Teams ${posted === 1 ? "conversation" : "conversations"}`, "Agent action", m.workspace_id);
  return posted;
}
