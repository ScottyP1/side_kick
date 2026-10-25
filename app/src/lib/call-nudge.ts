/**
 * @file The "turn on transcription" nudge for calls in a group's Teams chats (Meet now, or the call button in a group
 * chat). Automatic notes (lib/meetings-graph.ts) need a transcript, and Teams only makes one when someone clicks
 * **Start transcription**; Teams has no admin setting that starts it for these calls. So when a call starts in a chat
 * linked to a group and nothing shows transcription after about two minutes, Sidekick posts one short card there
 * saying where the button is and how to stop these nudges.
 *
 * Concepts
 * - **How Sidekick sees calls**: Teams posts a system message in the chat when a call starts, ends, or gets a
 *   transcript or recording (call events, lib/call-nudge-rules.ts). Every minute the recurring job `calls.watch`
 *   reads the latest messages of each watched chat from Microsoft Graph (`GET /chats/{id}/messages`, app-only, with
 *   the chat-scoped permission `ChatMessage.Read.Chat` that the Teams app package has asked for since 1.1.0 and Teams
 *   grants when Sidekick is added to a chat). Bots aren't told about calls in group chats (Teams' meeting start/end
 *   events are only for scheduled and channel meetings), hence the read.
 * - **Which chats are watched**: group chats linked to a group that isn't ending, in organizations with automatic notes
 *   on (the same switch and Microsoft connection), unless the group switched the nudge off. Channels and 1:1 chats are
 *   not watched.
 * - **Once per call** (`call_nudges`, one row per chat and call id): `watching` → `nudged` (claimed with a
 *   compare-and-set before posting, so several app copies post once), or `transcribing` / `ended` / `quiet` /
 *   `skipped` / `failed`. A chat gets at most one nudge per `CHAT_GAP_MS` even if calls are restarted.
 * - **Quiet days**: a chat with reminders on (its chat settings, lib/reminders.ts) gets no nudge on its quiet days.
 * - **Per-group switch** (`workspaces.call_nudge`: NULL or 1 = on, the default; 0 = off): on the group's Teams chats
 *   tab next to "Meeting notes go to", or "@Sidekick stop/start transcription reminders" in a linked chat. Only the
 *   group's Team Lead or an Org Owner/Admin (`requireManage`); audited.
 * - **Can't read a chat**: Graph refusing a chat (403: the permission wasn't granted there, e.g. Sidekick was added
 *   with an old package) is remembered per chat (`call_watch.error`) and shown on the Teams chats tab; never silent.
 * - **Walls**: everything is per organization and group; the card is fixed text (no Claude, no group content), so it's
 *   safe in a chat with client guests.
 *
 * Who may call: `watchCalls` from the job queue only; `callNudgeStatus` for anyone who can see the group (the route
 * checks `requireWorkspace`); `setCallNudge` and `callNudgeFromTeams` check `requireManage` themselves.
 */
import "server-only";
import { all, get, now, run } from "./db";
import { audit, auditAsSidekick, HttpError, requireManage, type User } from "./auth";
import { ConsentNeededError, graphCall, GraphThrottledError } from "./directory";
import { autoNotesOrgs } from "./meetings-graph";
import { tenantOfOrg } from "./tenants";
import { NOT_ENDING } from "./billing";
import { span, withTrace } from "./trace";
import { getChatSettings } from "./reminders";
import { localTime } from "./reminder-rules";
import { callsFromMessages, nudgeDue, recentCall, type GraphChatMessage } from "./call-nudge-rules";
import { BRAND } from "./brand";

export { parseNudgeCommand } from "./call-nudge-rules";

/** At most one nudge per chat in this window (a call dropped and restarted isn't nudged twice). */
const CHAT_GAP_MS = 30 * 60_000;
/** How many of a chat's latest messages are read each time (Graph allows up to 50). */
const MESSAGES_PER_READ = 25;
/** At most this many chats per organization per run (oldest-checked first; the rest next minute). */
const MAX_CHATS_PER_ORG = 300;

/** Shown on the Teams chats tab for a chat Graph won't let Sidekick read. */
export const CHAT_DENIED = `${BRAND.name} can't see calls in this chat yet: Microsoft hasn't granted it the chat-reading permission there. Your Microsoft admin checks the Teams chat consent setting (${BRAND.name}'s help explains how), then remove ${BRAND.name} from the chat and add it again.`;

/** The nudge card's wording (fixed text, the same in every chat). */
export const NUDGE_TITLE = "Turn on transcription?";
export const NUDGE_TEXT = "This call isn't being transcribed yet. So I can write the meeting notes afterwards, turn it on: **More (…) → Record and transcribe → Start transcription**. If someone already started it, ignore this.";
export const NUDGE_FOOTNOTE = `Don't want these? The Team Lead can say “@${BRAND.name} stop transcription reminders” here, or switch them off on the group's Teams chats tab in the ${BRAND.name} portal.`;

/* ------------------------------------------------------------------ */
/* The per-group switch                                                */
/* ------------------------------------------------------------------ */

/** What the Teams chats tab shows about the nudge for one group (see `callNudgeStatus`). */
export type CallNudgeStatus = {
  /** The group's switch (on unless someone turned it off). */
  enabled: boolean;
  changedBy: string | null;
  changedAt: string | null;
  /** Automatic notes are on for the organization (the nudge only runs then). */
  autoNotes: boolean;
  /** Names of the group's chats Graph won't let Sidekick read (so no nudges there). */
  unreadable: string[];
  /** The latest nudge in one of the group's chats. */
  last: { chat: string; at: string } | null;
};

/**
 * The nudge's state for one group. Read-only; the caller has checked the person may see the group
 * (`requireWorkspace`).
 */
export async function callNudgeStatus(orgId: string, workspaceId: string): Promise<CallNudgeStatus> {
  const ws = await get<{ call_nudge: number | null; call_nudge_by: string | null; call_nudge_at: string | null }>(
    "SELECT call_nudge, call_nudge_by, call_nudge_at FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId,
  );
  const autoNotes = Boolean((await get<{ enabled: number }>("SELECT enabled FROM auto_meetings WHERE org_id = ?", orgId))?.enabled);
  const unreadable = (await all<{ name: string | null }>(
    `SELECT c.name FROM call_watch s JOIN teams_conversations c ON c.id = s.conversation_id
      WHERE s.org_id = ? AND c.org_id = ? AND c.workspace_id = ? AND s.error IS NOT NULL AND c.removed_at IS NULL ORDER BY c.name`,
    orgId, orgId, workspaceId,
  )).map((r) => r.name ?? "Teams chat");
  const lastRow = await get<{ name: string | null; nudged_at: string }>(
    `SELECT c.name, n.nudged_at FROM call_nudges n JOIN teams_conversations c ON c.id = n.conversation_id
      WHERE n.org_id = ? AND n.workspace_id = ? AND n.status = 'nudged' ORDER BY n.nudged_at DESC LIMIT 1`,
    orgId, workspaceId,
  );
  return {
    enabled: ws?.call_nudge !== 0,
    changedBy: ws?.call_nudge_by ?? null,
    changedAt: ws?.call_nudge_at ?? null,
    autoNotes,
    unreadable,
    last: lastRow ? { chat: lastRow.name ?? "Teams chat", at: lastRow.nudged_at } : null,
  };
}

/** Writes the switch and audits it (" from Teams" appended for the chat command). The caller checked `requireManage`. */
async function saveSwitch(user: User, workspaceId: string, enabled: boolean, via: string) {
  await run("UPDATE workspaces SET call_nudge = ?, call_nudge_by = ?, call_nudge_at = ? WHERE id = ? AND org_id = ?", enabled ? 1 : 0, user.name, now(), workspaceId, user.org_id);
  await audit(user, `${enabled ? "Turned on" : "Turned off"} “Turn on transcription” reminders in this group's Teams calls${via}`, "Policy change", workspaceId);
}

/**
 * Turns the nudge on or off for a group (PUT /api/workspaces/:id/call-nudge). Only the group's Team Lead or an Org
 * Owner/Admin (`requireManage`: 403 for other roles, 404 for a group they can't see). `enabled` must be a boolean
 * (400 otherwise). Audited ("Policy change"). Returns the new status.
 */
export async function setCallNudge(user: User, workspaceId: string, enabled: unknown): Promise<CallNudgeStatus> {
  const ws = await requireManage(user, workspaceId);
  if (typeof enabled !== "boolean") throw new HttpError(400, "Say whether transcription reminders should be on (true) or off (false).");
  await saveSwitch(user, ws, enabled, "");
  return callNudgeStatus(user.org_id, ws);
}

/**
 * Runs "@Sidekick stop transcription reminders" (`off`) or "start transcription reminders" (`on`) in a chat linked to
 * group `workspaceId`, as `actor` (lib/teams/bot.ts `teamsActor`). Same rule as the portal: only the group's Team Lead
 * or an Org Owner/Admin; `teams:` guests and other roles get a polite refusal. Audited "(from Teams)". Returns the
 * fixed reply text (no Claude involved).
 */
export async function callNudgeFromTeams(actor: User, workspaceId: string, groupName: string, action: "on" | "off"): Promise<string> {
  const noRight = "Only the Team Lead or an admin can switch transcription reminders on or off.";
  if (actor.id.startsWith("teams:")) return `${noRight} If that's you, sign in to the ${BRAND.name} portal with Microsoft once so I recognise you here.`;
  try {
    await requireManage(actor, workspaceId);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return noRight;
    throw e;
  }
  const on = (await callNudgeStatus(actor.org_id, workspaceId)).enabled;
  if (action === "off") {
    if (!on) return `Transcription reminders are already off for ${groupName}.`;
    await saveSwitch(actor, workspaceId, false, " (from Teams)");
    return `Done ✓ I won't remind ${groupName}'s chats to start transcription any more. Remember to click Start transcription yourselves, or there won't be notes. Say “@${BRAND.name} start transcription reminders” to turn them back on.`;
  }
  if (on) return `Transcription reminders are already on for ${groupName}.`;
  await saveSwitch(actor, workspaceId, true, " (from Teams)");
  return `Done ✓ When a call starts in ${groupName}'s chats and nobody has started transcription after about two minutes, I'll post a short reminder.`;
}

/* ------------------------------------------------------------------ */
/* Watching calls (the recurring job)                                  */
/* ------------------------------------------------------------------ */

/** A chat the job watches. */
type WatchedChat = { id: string; service_url: string; org_id: string; workspace_id: string; name: string | null };

/** Remembers whether Graph let Sidekick read a chat this time (`error` null = it did). Never throws. */
async function noteRead(chat: WatchedChat, error: string | null) {
  await run(
    `INSERT INTO call_watch (conversation_id, org_id, workspace_id, checked_at, error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET org_id = excluded.org_id, workspace_id = excluded.workspace_id, checked_at = excluded.checked_at, error = excluded.error`,
    chat.id, chat.org_id, chat.workspace_id, now(), error,
  ).catch((e) => console.error("Couldn't record the call check", e));
}

/** Moves a call's row from `watching` to `to`; true if this caller made the change (the compare-and-set). */
async function moveCall(chatId: string, callId: string, to: string, fields: { nudged_at?: string } = {}): Promise<boolean> {
  const r = await run(
    "UPDATE call_nudges SET status = ?, nudged_at = COALESCE(?, nudged_at), updated_at = ? WHERE conversation_id = ? AND call_id = ? AND status = 'watching'",
    to, fields.nudged_at ?? null, now(), chatId, callId,
  );
  return r.changes === 1;
}

/** True when this chat has reminders on and `at` falls on one of its quiet days (in the chat's time zone). */
async function quietNow(chat: WatchedChat, at: Date): Promise<boolean> {
  const s = await getChatSettings(chat);
  return s.reminders && s.quietDays.includes(localTime(at, s.timeZone).weekday);
}

/**
 * Posts the nudge card in one chat, as its own trace under the organization (Activity shows "Transcription reminder"
 * only when one is posted, not every minute's check) and audits it ("Agent action"). Returns false if Teams refused
 * the post (recorded for the failed-posts watcher by `postCard`; not retried, a late reminder is no use).
 */
async function postNudge(chat: WatchedChat, afterSeconds: number): Promise<boolean> {
  const { postCard } = await import("./teams/bot");
  const { noticeCard } = await import("./teams/cards");
  try {
    await withTrace({ name: "Transcription reminder", channel: "teams", kind: "teams", orgId: chat.org_id, workspaceId: chat.workspace_id, actor: BRAND.name, detached: true }, () =>
      span("teams", "Post the transcription reminder", () => postCard(chat, noticeCard(NUDGE_TITLE, NUDGE_TEXT, NUDGE_FOOTNOTE), chat.id, "a transcription reminder"), { after_seconds: afterSeconds }),
    );
  } catch (e) {
    console.error("Couldn't post the transcription reminder", e);
    return false;
  }
  await auditAsSidekick(chat.org_id, `Reminded “${chat.name ?? "Teams chat"}” to start transcription in a call (none had started after 2 minutes)`, "Agent action", chat.workspace_id);
  return true;
}

/**
 * Checks one organization's watched chats (see the file comment) and posts the nudges that are due. Graph refusing a
 * chat is noted on that chat and the run goes on; throttling stops this organization's run (the next minute retries).
 */
async function watchOrg(orgId: string, at: Date): Promise<{ callsSeen: number; nudged: number; chatsUnreadable: number }> {
  const out = { callsSeen: 0, nudged: 0, chatsUnreadable: 0 };
  const tenant = await tenantOfOrg(orgId);
  if (!tenant) return out;
  const chats = await all<WatchedChat>(
    `SELECT c.id, c.service_url, c.org_id, c.workspace_id, c.name
       FROM teams_conversations c JOIN workspaces w ON w.id = c.workspace_id AND w.org_id = c.org_id
       LEFT JOIN call_watch s ON s.conversation_id = c.id
      WHERE c.org_id = ? AND c.kind = 'groupChat' AND c.removed_at IS NULL AND c.leaving IS NULL
        AND (w.call_nudge IS NULL OR w.call_nudge <> 0) AND ${NOT_ENDING}
      ORDER BY s.checked_at, c.id`,
    orgId,
  );
  for (const chat of chats.slice(0, MAX_CHATS_PER_ORG)) {
    let res: { value?: GraphChatMessage[] } | null;
    try {
      res = await span("microsoft", "Read call events in a Teams chat", () =>
        graphCall<{ value?: GraphChatMessage[] }>(tenant, "GET", `/v1.0/chats/${encodeURIComponent(chat.id)}/messages?$top=${MESSAGES_PER_READ}&$orderby=createdDateTime desc`, {
          headers: { Prefer: "include-unknown-enum-members" },
          deniedMessage: CHAT_DENIED,
        }),
      );
    } catch (e) {
      if (e instanceof ConsentNeededError) {
        out.chatsUnreadable++;
        await noteRead(chat, e.message);
        continue;
      }
      throw e;
    }
    await noteRead(chat, null);
    for (const c of callsFromMessages(res?.value ?? []).filter((x) => recentCall(x, at))) {
      out.callsSeen++;
      await run(
        `INSERT INTO call_nudges (conversation_id, call_id, org_id, workspace_id, started_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'watching', ?, ?)
         ON CONFLICT (conversation_id, call_id) DO NOTHING`,
        chat.id, c.callId, orgId, chat.workspace_id, c.startedAt, now(), now(),
      );
      if (c.transcribing || c.ended) {
        await moveCall(chat.id, c.callId, c.transcribing ? "transcribing" : "ended");
        continue;
      }
      if (!nudgeDue(c, at)) continue;
      if (await quietNow(chat, at)) {
        await moveCall(chat.id, c.callId, "quiet");
        continue;
      }
      const recent = await get<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM call_nudges WHERE conversation_id = ? AND status = 'nudged' AND nudged_at > ?",
        chat.id, new Date(at.getTime() - CHAT_GAP_MS).toISOString(),
      );
      if (Number(recent?.n ?? 0) > 0) {
        await moveCall(chat.id, c.callId, "skipped");
        continue;
      }
      if (!(await moveCall(chat.id, c.callId, "nudged", { nudged_at: now() }))) continue;
      if (await postNudge(chat, Math.round((at.getTime() - Date.parse(c.startedAt!)) / 1000))) out.nudged++;
      else await run("UPDATE call_nudges SET status = 'failed', updated_at = ? WHERE conversation_id = ? AND call_id = ?", now(), chat.id, c.callId);
    }
  }
  return out;
}

/**
 * The `calls.watch` job (every minute): checks every organization with automatic notes on (lib/meetings-graph.ts
 * `autoNotesOrgs`; none on a server without a Microsoft app) and posts the nudges that are due. One organization's
 * Graph trouble (throttling, an outage) never stops the others; it's logged and that organization is retried next
 * minute. Returns counts for the job report: calls seen, nudges posted, chats Graph wouldn't let Sidekick read.
 */
export async function watchCalls(at = new Date()): Promise<{ callsSeen: number; nudged: number; chatsUnreadable: number }> {
  const total = { callsSeen: 0, nudged: 0, chatsUnreadable: 0 };
  for (const orgId of await autoNotesOrgs()) {
    try {
      const r = await span("job", "Watch calls in a company's Teams chats", () => watchOrg(orgId, at), { org: orgId });
      total.callsSeen += r.callsSeen;
      total.nudged += r.nudged;
      total.chatsUnreadable += r.chatsUnreadable;
    } catch (e) {
      console.error(e instanceof GraphThrottledError ? "Microsoft Graph asked to wait; calls are checked again next minute" : "Couldn't check calls for an organization", e);
    }
  }
  return total;
}
