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
 *   Sidekick shows an 8-character code in Teams; an Org Admin enters it on the portal's Workspaces page.
 *   The code proves the admin can see that chat, and the link puts the chat inside one org's walls.
 * - **Client guests**: a linked conversation can be marked as having client guests. Answers there use only
 *   Shareable sources, and notes from internal-only meetings are never posted there.
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
import { ask } from "../sidekick";
import { span, traceFailed, traceScope, withTrace } from "../trace";
import { actionItemCard, answerCard, helpCard, linkCard, meetingNotesCard, VERBS, type ActionItemInput } from "./cards";

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
};

/** The parts of an incoming Teams activity Sidekick uses. */
type InboundActivity = {
  conversation: { id: string; conversationType?: string; tenantId?: string; name?: string };
  serviceUrl?: string;
  channelData?: { tenant?: { id?: string }; channel?: { name?: string }; team?: { name?: string } };
  from: { id: string; name?: string; aadObjectId?: string };
};

// Channel messages arrive as "<channel id>;messageid=<thread>"; the link is for the whole channel.
export const baseConversationId = (id: string) => id.split(";")[0];

/**
 * Saves (or refreshes) the conversation an activity came from and returns its row. Keeps the latest
 * service URL and display name, which proactive messages and the Workspaces page need.
 */
async function touchConversation(a: InboundActivity): Promise<TeamsConversation> {
  const id = baseConversationId(a.conversation.id);
  const kind = a.conversation.conversationType ?? "personal";
  const team = a.channelData?.team?.name;
  const channel = a.channelData?.channel?.name;
  const name = channel ? `${team ? `${team} › ` : ""}${channel}` : (a.conversation.name ?? (kind === "personal" ? "1:1 chat" : "Group chat"));
  await run(
    `INSERT INTO teams_conversations (id, service_url, tenant_id, kind, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET service_url = excluded.service_url, name = COALESCE(excluded.name, teams_conversations.name), last_seen_at = excluded.last_seen_at`,
    id, a.serviceUrl ?? "", a.conversation.tenantId ?? a.channelData?.tenant?.id ?? null, kind, name, now(), now(),
  );
  return (await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", id))!;
}

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

/* ------------------------------------------------------------------ */
/* Activity handlers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Wires up what Sidekick does for each kind of Teams activity:
 * - `install.add`: Sidekick was added to a channel/chat → greet with the help card, or the link code.
 * - `message`: someone mentioned Sidekick → commands (`help`, `link`) or a question to answer.
 * - `card.action`: someone clicked Assign / Mark done / Reopen on an action-item card.
 */
function registerHandlers(app: App) {
  app.on("install.add", async ({ activity, send }) => {
    const conv = await touchConversation(activity);
    await send(conv.workspace_id ? helpCard(await workspaceName(conv)) : linkCard(await freshLinkCode(conv), conv.kind));
  });

  // In channels and group chats Teams only delivers messages that @mention Sidekick; in 1:1 chats, every message.
  // stripMentionsText removes the "@Sidekick" part so only the question is left.
  app.on("message", async ({ activity, send, reply }) => {
    const conv = await touchConversation(activity);
    traceScope({ orgId: conv.org_id, workspaceId: conv.workspace_id, actor: activity.from.name ?? "Teams user" });
    const question = (stripMentionsText(activity) ?? "").replace(/\s+/g, " ").trim();
    const command = question.toLowerCase().replace(/[^a-z]/g, "");

    if (!question || command === "help") return void (await send(helpCard(await workspaceName(conv))));
    if (!conv.workspace_id) return void (await send(linkCard(await freshLinkCode(conv), conv.kind)));
    if (command === "link") {
      return void (await send(`This ${conv.kind === "channel" ? "channel" : "chat"} is linked to **${await workspaceName(conv)}**. An Org Admin can change that on the Workspaces page in the Sidekick portal.`));
    }
    if (await orgPaused(conv.org_id!)) return void (await send("Sidekick is paused for this organization. Contact the Sidekick team."));
    if (question.length > 1000) return void (await send("That question is too long for me (max 1,000 characters)."));
    const asker = await teamsActor(conv, activity);
    traceScope({ actor: asker.name });

    await send({ type: "typing" });
    // Teams expects a reply to its request within a few seconds; Claude can take longer, so the
    // answer is sent as a follow-up message after this request has already been acknowledged.
    after(() =>
      withTrace({ name: "Teams answer", channel: "teams", orgId: conv.org_id, workspaceId: conv.workspace_id, actor: asker.name, detached: true }, async () => {
        try {
          const result = await ask(asker, conv.workspace_id!, question, conv.guests === 1, "teams");
          const card = answerCard(question, result, (await workspaceName(conv)) ?? "Workspace");
          await span("teams", "Send the answer card to Teams", () => reply(card));
        } catch (e) {
          console.error("Teams ask failed", e);
          traceFailed(e instanceof HttpError ? e.status : 500, e instanceof Error ? e.message : String(e));
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
    const conv = await get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", baseConversationId(activity.conversation.id));
    if (!conv?.workspace_id || !conv.org_id) return fail("This chat isn't linked to a Sidekick workspace anymore.");
    traceScope({ orgId: conv.org_id, workspaceId: conv.workspace_id, actor: activity.from.name ?? "Teams user" });
    if (await orgPaused(conv.org_id)) return fail("Sidekick is paused for this organization.");
    // Workspace wall: the card only works in a conversation linked to the item's own workspace.
    const item = await get<ActionItemInput & { workspace_id: string }>(
      "SELECT id, text, owner, due, status, workspace_id FROM action_items WHERE id = ? AND org_id = ? AND workspace_id = ?",
      String(data?.itemId ?? ""), conv.org_id, conv.workspace_id,
    );
    if (!item) return fail("I couldn't find that action item in this workspace.");
    const actor = await teamsActor(conv, activity);
    if (!canEdit(actor)) return fail(`Your Sidekick role (${actor.role}) can't change action items. Ask a Member or an Org Admin.`);
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
export async function postCard(conv: Pick<TeamsConversation, "id" | "service_url">, c: IAdaptiveCard, conversationId = conv.id): Promise<string | undefined> {
  if (PLAYGROUND_MODE && !isLocalUrl(conv.service_url)) throw new Error("Playground mode only posts to local conversations.");
  const { app } = await teams();
  return span("teams", "Post a card to Teams", async () => (await app.api.clone({ serviceUrl: conv.service_url }).conversations.createActivity(conversationId, cardMessage(c))).id);
}

// Cap so one long meeting can't flood a channel; the full list is always in the portal.
const MAX_ACTION_CARDS = 15;

/**
 * Posts a processed meeting's notes card, then one card per action item, to every Teams conversation
 * linked to the meeting's workspace. Skips conversations with client guests if the meeting was internal.
 * A failure in one conversation is logged and doesn't stop the others. Returns how many got the notes.
 * Called from the meeting import/reprocess routes after the response is sent, so imports never wait on Teams.
 */
export async function postMeetingNotes(orgId: string, meetingId: string): Promise<number> {
  return withTrace({ name: "Post meeting notes to Teams", channel: "teams", orgId, detached: true }, () => postMeetingNotesInner(orgId, meetingId));
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
    "SELECT * FROM teams_conversations WHERE org_id = ? AND workspace_id = ? AND (guests = 0 OR ? = 1)",
    orgId, m.workspace_id, m.external_guests,
  );
  if (!convs.length) return 0;
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
    portalUrl: `${process.env.SIDEKICK_PUBLIC_URL || "http://localhost:3000"}/meetings`,
  });

  let posted = 0;
  for (const conv of convs) {
    try {
      const postId = await postCard(conv, notes);
      // In a channel the action items go in the notes post's thread; in chats they follow it.
      const target = conv.kind === "channel" && postId ? toThreadedConversationId(conv.id, postId) : conv.id;
      for (const a of actions.slice(0, MAX_ACTION_CARDS)) await postCard(conv, actionItemCard(a), target);
      posted++;
    } catch (e) {
      console.error(`Couldn't post meeting notes to Teams conversation ${conv.id}`, e);
    }
  }
  if (posted) await audit({ org_id: orgId, name: "Sidekick" }, `Posted notes for “${m.title}” to ${posted} Teams ${posted === 1 ? "conversation" : "conversations"}`, "Agent action", m.workspace_id);
  return posted;
}
