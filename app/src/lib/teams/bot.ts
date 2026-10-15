import "server-only";
import crypto from "node:crypto";
import { after } from "next/server";
import { App, toThreadedConversationId, type HttpRouteHandler, type IHttpServerAdapter } from "@microsoft/teams.apps";
import { stripMentionsText, type IMessageActivityInput } from "@microsoft/teams.api";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import { all, get, now, run } from "../db";
import { audit, HttpError, type User } from "../auth";
import { ask } from "../sidekick";
import { actionItemCard, answerCard, helpCard, linkCard, meetingNotesCard, VERBS, type ActionItemInput } from "./cards";

/* ------------------------------------------------------------------ */
/* Security mode                                                       */
/* ------------------------------------------------------------------ */

// Production: every request must carry a Microsoft-signed token for our Azure Bot (CLIENT_ID /
// CLIENT_SECRET / TENANT_ID, read by the Teams SDK). Local Agents Playground mode skips that check, so
// it only switches on outside production, when asked for explicitly, and only for localhost traffic.
export const PLAYGROUND_MODE = process.env.NODE_ENV !== "production" && process.env.TEAMS_LOCAL_PLAYGROUND === "true";

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
  handler?: HttpRouteHandler;
  registerRoute(_method: "POST", path: string, handler: HttpRouteHandler) {
    if (path === "/api/messages") this.handler = handler;
  }
}

declare global {
  var __sidekickTeams: Promise<{ app: App; adapter: NextRouteAdapter }> | undefined;
}

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
  const res = await adapter.handler!({ body, headers });
  return res.body === undefined ? new Response(null, { status: res.status }) : Response.json(res.body, { status: res.status });
}

/* ------------------------------------------------------------------ */
/* Linked conversations (Teams channel/chat <-> Sidekick workspace)    */
/* ------------------------------------------------------------------ */

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

type InboundActivity = {
  conversation: { id: string; conversationType?: string; tenantId?: string; name?: string };
  serviceUrl?: string;
  channelData?: { tenant?: { id?: string }; channel?: { name?: string }; team?: { name?: string } };
  from: { id: string; name?: string; aadObjectId?: string };
};

// Channel messages arrive as "<channel id>;messageid=<thread>"; the link is for the whole channel.
export const baseConversationId = (id: string) => id.split(";")[0];

function touchConversation(a: InboundActivity): TeamsConversation {
  const id = baseConversationId(a.conversation.id);
  const kind = a.conversation.conversationType ?? "personal";
  const team = a.channelData?.team?.name;
  const channel = a.channelData?.channel?.name;
  const name = channel ? `${team ? `${team} › ` : ""}${channel}` : (a.conversation.name ?? (kind === "personal" ? "1:1 chat" : "Group chat"));
  run(
    `INSERT INTO teams_conversations (id, service_url, tenant_id, kind, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET service_url = excluded.service_url, name = COALESCE(excluded.name, name), last_seen_at = excluded.last_seen_at`,
    id, a.serviceUrl ?? "", a.conversation.tenantId ?? a.channelData?.tenant?.id ?? null, kind, name, now(), now(),
  );
  return get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", id)!;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I lookalikes
const CODE_HOURS = 24;

function freshLinkCode(conv: TeamsConversation): string {
  if (conv.link_code && conv.code_expires_at && new Date(conv.code_expires_at) > new Date()) return conv.link_code;
  const chars = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
  run("UPDATE teams_conversations SET link_code = ?, code_expires_at = ? WHERE id = ?", code, new Date(Date.now() + CODE_HOURS * 3600_000).toISOString(), conv.id);
  return code;
}

export const normalizeCode = (code: string) => {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
};

const workspaceName = (conv: TeamsConversation) =>
  conv.workspace_id ? get<{ name: string }>("SELECT name FROM workspaces WHERE id = ? AND org_id = ?", conv.workspace_id, conv.org_id)?.name ?? null : null;

const orgPaused = (orgId: string) => get<{ status: string }>("SELECT status FROM orgs WHERE id = ?", orgId)?.status === "Suspended";

// Teams users aren't portal users yet (Entra ID sign-in comes later in step 2). Inside a linked
// channel they act as a Member of that one workspace, which is all ask() and the card actions need.
const teamsMember = (conv: TeamsConversation, from: InboundActivity["from"]): User => ({
  id: `teams:${from.aadObjectId ?? from.id}`,
  org_id: conv.org_id!,
  name: `${from.name ?? "Teams user"} (Teams)`,
  email: "",
  role: "Member",
  must_change_password: 0,
});

/* ------------------------------------------------------------------ */
/* Activity handlers                                                   */
/* ------------------------------------------------------------------ */

function registerHandlers(app: App) {
  app.on("install.add", async ({ activity, send }) => {
    const conv = touchConversation(activity);
    await send(conv.workspace_id ? helpCard(workspaceName(conv)) : linkCard(freshLinkCode(conv), conv.kind));
  });

  app.on("message", async ({ activity, send, reply }) => {
    const conv = touchConversation(activity);
    const question = (stripMentionsText(activity) ?? "").replace(/\s+/g, " ").trim();
    const command = question.toLowerCase().replace(/[^a-z]/g, "");

    if (!question || command === "help") return void (await send(helpCard(workspaceName(conv))));
    if (!conv.workspace_id) return void (await send(linkCard(freshLinkCode(conv), conv.kind)));
    if (command === "link") {
      return void (await send(`This ${conv.kind === "channel" ? "channel" : "chat"} is linked to **${workspaceName(conv)}**. An Org Admin can change that on the Workspaces page in the Sidekick portal.`));
    }
    if (orgPaused(conv.org_id!)) return void (await send("Sidekick is paused for this organization. Contact the Sidekick team."));
    if (question.length > 1000) return void (await send("That question is too long for me (max 1,000 characters)."));

    await send({ type: "typing" });
    // Teams expects a reply to its request within a few seconds; Claude can take longer, so the
    // answer is sent as a follow-up message after this request has already been acknowledged.
    after(async () => {
      try {
        const result = await ask(teamsMember(conv, activity.from), conv.workspace_id!, question, conv.guests === 1);
        await reply(answerCard(question, result, workspaceName(conv) ?? "Workspace"));
      } catch (e) {
        console.error("Teams ask failed", e);
        await send(e instanceof HttpError ? e.message : "Sorry, I couldn't answer that just now. Please try again in a minute.").catch(() => {});
      }
    });
  });

  app.on("card.action", async ({ activity }) => {
    const { verb, data } = activity.value.action;
    // A message response shows the text to the person who clicked and leaves the card as it was.
    const fail = (message: string) => ({ statusCode: 200 as const, type: "application/vnd.microsoft.activity.message" as const, value: message });
    const conv = get<TeamsConversation>("SELECT * FROM teams_conversations WHERE id = ?", baseConversationId(activity.conversation.id));
    if (!conv?.workspace_id || !conv.org_id) return fail("This chat isn't linked to a Sidekick workspace anymore.");
    if (orgPaused(conv.org_id)) return fail("Sidekick is paused for this organization.");
    // Workspace wall: the card only works in a conversation linked to the item's own workspace.
    const item = get<ActionItemInput & { workspace_id: string }>(
      "SELECT id, text, owner, due, status, workspace_id FROM action_items WHERE id = ? AND org_id = ? AND workspace_id = ?",
      String(data?.itemId ?? ""), conv.org_id, conv.workspace_id,
    );
    if (!item) return fail("I couldn't find that action item in this workspace.");
    const actor = teamsMember(conv, activity.from);
    if (verb === VERBS.assign) {
      const owner = String(data?.owner ?? "").trim().slice(0, 120);
      if (!owner) return fail("Type a name to assign it to.");
      run("UPDATE action_items SET owner = ?, status = CASE WHEN status = 'Open' THEN 'In progress' ELSE status END WHERE id = ?", owner, item.id);
      audit(actor, `Assigned action item “${item.text.slice(0, 60)}” to ${owner} in Teams`, "Data", item.workspace_id);
    } else if (verb === VERBS.done || verb === VERBS.reopen) {
      const status = verb === VERBS.done ? "Done" : "Open";
      run("UPDATE action_items SET status = ? WHERE id = ?", status, item.id);
      audit(actor, `Marked action item “${item.text.slice(0, 60)}” ${status === "Done" ? "done" : "open again"} in Teams`, "Data", item.workspace_id);
    } else {
      return fail("Unknown action.");
    }
    const updated = get<ActionItemInput>("SELECT id, text, owner, due, status FROM action_items WHERE id = ?", item.id)!;
    return { statusCode: 200 as const, type: "application/vnd.microsoft.card.adaptive" as const, value: actionItemCard({ ...updated, updatedBy: activity.from.name }) };
  });
}

/* ------------------------------------------------------------------ */
/* Proactive: post meeting notes to the workspace's linked channels    */
/* ------------------------------------------------------------------ */

const cardMessage = (c: IAdaptiveCard): IMessageActivityInput =>
  ({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: c }] }) as IMessageActivityInput;

// Sends a card into a Teams conversation outside of a reply (proactive message). Returns the new message id.
export async function postCard(conv: Pick<TeamsConversation, "id" | "service_url">, c: IAdaptiveCard, conversationId = conv.id): Promise<string | undefined> {
  if (PLAYGROUND_MODE && !isLocalUrl(conv.service_url)) throw new Error("Playground mode only posts to local conversations.");
  const { app } = await teams();
  const res = await app.api.clone({ serviceUrl: conv.service_url }).conversations.createActivity(conversationId, cardMessage(c));
  return res.id;
}

const MAX_ACTION_CARDS = 15;

export async function postMeetingNotes(orgId: string, meetingId: string): Promise<number> {
  const m = get<{ id: string; workspace_id: string; title: string; held_at: string; summary: string | null; status: string; external_guests: number; ws: string }>(
    "SELECT m.id, m.workspace_id, m.title, m.held_at, m.summary, m.status, m.external_guests, w.name AS ws FROM meetings m JOIN workspaces w ON w.id = m.workspace_id WHERE m.id = ? AND m.org_id = ?",
    meetingId, orgId,
  );
  if (!m || m.status !== "Ready") return 0;
  // Notes from an internal-only meeting never go to a conversation that has client guests in it.
  const convs = all<TeamsConversation>(
    "SELECT * FROM teams_conversations WHERE org_id = ? AND workspace_id = ? AND (guests = 0 OR ? = 1)",
    orgId, m.workspace_id, m.external_guests,
  );
  if (!convs.length) return 0;
  const items = all<{ kind: string; text: string; answered: number | null }>("SELECT kind, text, answered FROM items WHERE meeting_id = ? ORDER BY rowid", m.id);
  const actions = all<ActionItemInput>("SELECT id, text, owner, due, status FROM action_items WHERE meeting_id = ? ORDER BY rowid", m.id);
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
  if (posted) audit({ org_id: orgId, name: "Sidekick" }, `Posted notes for “${m.title}” to ${posted} Teams ${posted === 1 ? "conversation" : "conversations"}`, "Agent action", m.workspace_id);
  return posted;
}
