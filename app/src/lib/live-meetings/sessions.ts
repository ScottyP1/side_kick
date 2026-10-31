/**
 * @file Sidekick live in Teams meetings (Enterprise, docs/LIVE-MEETINGS.md): sending the meeting bot, what it does while
 * the meeting runs, when it leaves, and handing over to the notes pipeline afterwards. The provider (Recall.ai, or the
 * tests' fake) sits behind lib/live-meetings/provider.ts; this file never names one.
 *
 * Concepts
 * - **A session** (`live_sessions`): one time the bot joined (or tried to join) one meeting for one group. Status
 *   `joining` (sent; maybe waiting in the lobby) → `live` (admitted: its first chat message says it's listening and how
 *   to remove it) → `ended` (with a reason) or `failed` (never got in, or the provider failed). Once per meeting
 *   occurrence (`join_key` = hash of the join link, `starts_at`), and never two running at once for one meeting.
 * - **The group's switch** (`workspaces.live_mode`): `off` (default), `ask` (only on `@Sidekick join`), `auto` (also
 *   every clearly-one-group scheduled meeting, found by the transcription reminder's calendar read, lib/meeting-nudge.ts).
 *   Turning it on needs the plan's `liveMeetings` feature (Enterprise); Team Lead of the group or Org Owner/Admin; audited.
 * - **Live**: lines said or typed (`live_lines`) arrive by signed webhook. "Sidekick, …" → the normal Ask pipeline
 *   (`ask`, so `screenTurn` before, `checkGrounding` + `cleanOutput` after); "Sidekick, recap" reads the running list
 *   back; "Sidekick, leave" leaves. Answers go to the meeting chat through Sidekick's own Teams bot when it's in that
 *   chat (an answer card; `chat_via = 'teams'`), else through the provider's chat message (plain text). Every few
 *   minutes of talk, `live.extract` updates the running list of decisions and action items (Claude feature `live`).
 * - **Guest wall**: `guests = 1` when the meeting chat is marked as having client guests, Graph lists invitees from
 *   another organization, or a participant joins as a guest or from another tenant. Then answers use Shareable sources
 *   only (Ask's guest mode) and Sidekick says so once in the chat. It never goes back to 0 during a session.
 * - **Limits**: the plan's `liveMeetingHours` (joined → ended; running ones count up to now, lib/limits.ts) is checked
 *   before joining and every minute while live (`live.watch`), which also leaves after 4 hours, gives up after 15
 *   minutes in the lobby, and leaves when the feature is paused or no longer in the plan. At most 60 answers a meeting.
 * - **Afterwards** (`handoffLive`, 30 minutes after the end): the Teams transcript, if one arrived, already claimed
 *   the session (lib/live-meetings/claims.ts) and writes the notes; otherwise the live lines become the meeting
 *   (`meetings.source = 'teams-live'`) and the usual `meetings.notes` job writes and posts the notes. Either way, one
 *   set of notes, and the live lines are deleted.
 * - **Never silent**: a failed join, a failed chat post or a provider failure is saved on the session (`error`) and
 *   shown on the group page and the Owner Console's Live meetings page; every join and leave is audited; every step
 *   is a trace span (kind `live`, counts and times only).
 *
 * Who may call: the Teams bot (`joinFromTeams`, `leaveFromTeams`), the routes under /api/workspaces/:id/live,
 * /api/live/events and /api/owner/live, and the job kinds `live.*` (lib/job-kinds.ts). Every query names the org.
 */
import "server-only";
import { z } from "zod";
import { all, asSystem, get, newId, now, run, withOrg } from "../db";
import { audit, auditAsSidekick, HttpError, requireManage, requireWorkspace, isAdmin, type User } from "../auth";
import { graphCall } from "../directory";
import { enqueue } from "../jobs";
import { span, spanAttrs, traceFailed, withTrace } from "../trace";
import { tenantOfOrg, portalUrl } from "../tenants";
import { NOT_ENDING, orgAccess } from "../billing";
import { assertCanAdd, assertFeature, hasFeature, orgPlan, usageCounts } from "../limits";
import { creditGate } from "../credit";
import { assertEnabled, FeatureOffError } from "../owner";
import { structured } from "../claude";
import { ask } from "../sidekick";
import { cleanOutput, getGuardSettings } from "../guardrails";
import { tagSafe } from "../security";
import { notificationBase } from "../meetings-graph";
import { joinKey } from "../auto-record";
import { answerCard, noticeCard } from "../teams/cards";
import { BRAND } from "../brand";
import { configuredProviders, PROVIDER_IDS, PROVIDER_INFO, providerById, type LiveEvent, type LiveProvider, type ProviderId } from "./provider";
import { speechConfigured, synthesize } from "./speech";
import { capReached, capState, checkCapAlerts, LIVE_PAUSED, monthSpend } from "./spend";
import { reapBot } from "./attendee";
import { botKey } from "./launcher";
import { sameKey } from "./signature";
import {
  answerText, BOT_NAME, confident, GUEST_NOTICE, HAND_NOTE, introText, isNonAnswer, isRoomQuestion, isTeamsMeetingUrl, liveMinutes, LIVE_MODES,
  LOBBY_TIMEOUT_MS, looksExternal, MAX_ANSWERS, MAX_SESSION_MS, meetingThreadFromUrl, ownQuestion, parseSettings, parseTrigger, recapText, spokenText,
  hearingNext, minuteOf, type ListItem, type LiveMode, type LiveSettings, type Trigger,
} from "./rules";

/** A row of `live_sessions` (see db/schema.postgres.sql). */
export type LiveSession = {
  id: string; org_id: string; workspace_id: string; provider: string; bot_id: string | null; join_key: string; starts_at: string;
  thread_id: string | null; title: string | null; status: "joining" | "live" | "ended" | "failed"; invited_by: string; guests: number;
  chat_via: "teams" | "provider" | null; joined_at: string | null; ended_at: string | null; end_reason: string | null; error: string | null;
  decisions: string | null; action_items: string | null; line_count: number; extracted_lines: number; extracted_at: string | null;
  answers: number; last_question: string | null; last_question_at: string | null; intro_posted_at: string | null; handoff: string | null;
  notes_meeting_id: string | null; created_at: string; updated_at: string;
  /** 1 = quiet mode for this meeting ("Sidekick, quiet"): only questions to it, in the chat, nothing volunteered. */
  quiet: number;
  /** JSON list of who is speaking right now (speech start/stop events), and when anyone was last heard. */
  speaking: string | null; last_heard_at: string | null;
  /** JSON `Pending`: what Sidekick has its hand up for (an answer for the room, or its own question). */
  hand: string | null;
  /** Someone said only "Sidekick": their next line until then is a question to it. */
  addressed_until: string | null; addressed_by: string | null;
  /** JSON list of action items Sidekick already asked about (never twice). */
  asked: string | null;
  /** Sidekick's own bot: its Container Apps job execution, when it started and exited (cost meter). */
  execution: string | null; launched_at: string | null; exited_at: string | null;
  /** How it hears now ('captions' | 'stt') and since when; when a caption and someone talking were last seen. */
  hearing: string | null; hearing_since: string | null; captions_at: string | null; speech_at: string | null; captions_unavailable: number;
  /** Characters spoken (Azure AI Speech text-to-speech, cost meter). */
  tts_chars: number;
};

/** What Sidekick has its hand up for: the chat text (full answer with sources), the short spoken version, the card. */
type Pending = { kind: "answer" | "own"; question: string; chat: string; spoken: string; card?: unknown; raisedAt: string };

/** Said when this copy of Sidekick has no meeting-bot provider configured. */
export const NOT_SET_UP = `Live meetings aren't set up on this ${BRAND.name} yet (the meeting-bot service). The ${BRAND.name} team turns them on.`;
/** New lines since the last update of the running list that trigger the next one. */
const EXTRACT_EVERY = 12;
/** How long after a session ends the live transcript waits for a Teams transcript before writing the notes itself. */
const handoffDelayMs = () => Math.max(0, Number(process.env.SIDEKICK_LIVE_HANDOFF_MIN ?? 30)) * 60_000;
/** How long before (and after) a group meeting's start Sidekick joins it automatically. */
const AUTO_BEFORE_MS = 2 * 60_000;
const AUTO_AFTER_MS = 15 * 60_000;

const sessionById = (orgId: string, id: string) => get<LiveSession>("SELECT * FROM live_sessions WHERE id = ? AND org_id = ?", id, orgId);
const parseList = (json: string | null): ListItem[] => {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.text === "string").slice(0, 40) : [];
  } catch {
    return [];
  }
};
const groupName = async (orgId: string, workspaceId: string) => (await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId))?.name ?? "this group";

/** Whether this copy of Sidekick can send a meeting bot at all (a provider and a public address). */
export const liveConfigured = () => configuredProviders().length > 0 && Boolean(notificationBase());

/**
 * Test speed-up only: every wait (room question, pause before speaking, silence) is multiplied by
 * `SIDEKICK_LIVE_TIME_SCALE` outside production (the tests use 0.05). Always 1 in production.
 */
const scale = () => (process.env.NODE_ENV === "production" ? 1 : Math.min(1, Math.max(0.001, Number(process.env.SIDEKICK_LIVE_TIME_SCALE) || 1)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * scale()));
/** How long a question to the room waits for someone in the meeting to answer it first. */
const ROOM_WAIT_MS = 5000;
/** How long Sidekick keeps its hand up before it lowers it and puts the answer in the chat instead. */
const HAND_MS = 60_000;
/** How long after a session ends its bot's container may still be running before Sidekick stops it in Azure. */
const REAP_AFTER_MS = 3 * 60_000;
/** How long a lone "Sidekick" makes the speaker's next line a question to it. */
const ADDRESSED_MS = 20_000;

/**
 * The organization's meeting bot: the self-hosted one (`attendee`) unless its Org Owner opted in to a hosted one
 * (`orgs.live_provider`). Never falls back to a hosted provider by itself.
 */
export async function orgProviderId(orgId: string): Promise<ProviderId> {
  const v = (await get<{ live_provider: string | null }>("SELECT live_provider FROM orgs WHERE id = ?", orgId))?.live_provider;
  return (PROVIDER_IDS as readonly string[]).includes(v ?? "") ? (v as ProviderId) : "attendee";
}
const providerFor = async (orgId: string) => providerById(await orgProviderId(orgId));
const sessionProvider = (s: Pick<LiveSession, "provider">) => providerById(s.provider);

/**
 * The Org Owner chooses where the organization's meeting bot runs: Sidekick's own (`attendee`, the default) or the
 * hosted Recall.ai (`recall`, then listed as a sub-processor). Org Owner only (403); the provider must be set up on
 * this copy (503). Audited ("Policy change"). Running meetings keep the bot they joined with.
 */
export async function setOrgProvider(user: User, id: unknown) {
  if (user.role !== "Org Owner") throw new HttpError(403, "Only the Org Owner chooses where the meeting bot runs.");
  if (typeof id !== "string" || !(PROVIDER_IDS as readonly string[]).includes(id)) throw new HttpError(400, "Choose Sidekick's own meeting bot or Recall.ai.");
  if (!providerById(id)) throw new HttpError(503, `${PROVIDER_INFO[id as ProviderId].label} isn't set up on this ${BRAND.name}.`);
  if ((await orgProviderId(user.org_id)) !== id) {
    await run("UPDATE orgs SET live_provider = ? WHERE id = ?", id, user.org_id);
    await audit(user, `Chose ${PROVIDER_INFO[id as ProviderId].label} for ${BRAND.name} live in meetings`, "Policy change");
  }
  return { provider: id };
}

/** The group's live-meeting settings (answer mode, spoken answers, pause, its own questions), over the defaults. */
export async function groupSettings(orgId: string, workspaceId: string): Promise<LiveSettings> {
  return parseSettings((await get<{ live_settings: string | null }>("SELECT live_settings FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId))?.live_settings);
}

/* ------------------------------------------------------------------ */
/* The group's switch                                                  */
/* ------------------------------------------------------------------ */

/** The group's live-meeting mode (`off` when never set). */
export async function groupMode(orgId: string, workspaceId: string): Promise<LiveMode> {
  const v = (await get<{ live_mode: string | null }>("SELECT live_mode FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId))?.live_mode;
  return (LIVE_MODES as readonly string[]).includes(v ?? "") ? (v as LiveMode) : "off";
}

/**
 * Changes the group's live-meeting switch and settings. `body.mode` (off / ask / auto) and any of `answer`, `voice`,
 * `pauseS`, `ask` (lib/live-meetings/rules.ts `LiveSettings`). Only the group's Team Lead or an Org Owner/Admin
 * (`requireManage`); turning it on needs the plan's `liveMeetings` feature (Enterprise, 402 otherwise) and a
 * configured provider (503); a bad value is 400. Audited ("Policy change"). Returns the new status for the group page.
 */
export async function setLiveMode(user: User, workspaceId: unknown, body: Record<string, unknown> | null) {
  const ws = await requireManage(user, typeof workspaceId === "string" ? workspaceId : null);
  const { mode, ...rest } = body ?? {};
  const settingKeys = ["answer", "voice", "pauseS", "ask"].filter((k) => k in rest);
  if (mode === undefined && !settingKeys.length) throw new HttpError(400, "Choose off, when someone asks, or every group meeting.");
  if (settingKeys.length) {
    const cur = await groupSettings(user.org_id, ws);
    const next = parseSettings(JSON.stringify({ ...cur, ...Object.fromEntries(settingKeys.map((k) => [k, rest[k]])) }));
    if (settingKeys.some((k) => JSON.stringify(next[k as keyof LiveSettings]) !== JSON.stringify(rest[k]))) throw new HttpError(400, "One of the live meeting settings isn't valid.");
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      await run("UPDATE workspaces SET live_settings = ? WHERE id = ? AND org_id = ?", JSON.stringify(next), ws, user.org_id);
      await audit(user, `Changed ${BRAND.name}'s live meeting settings: ${settingKeys.map((k) => `${k} ${JSON.stringify(next[k as keyof LiveSettings])}`).join(", ")}`, "Policy change", ws);
    }
  }
  if (mode === undefined) return liveStatus(user, ws);
  if (typeof mode !== "string" || !(LIVE_MODES as readonly string[]).includes(mode)) throw new HttpError(400, "Choose off, when someone asks, or every group meeting.");
  if (mode !== "off") {
    await assertFeature(user.org_id, "liveMeetings");
    if (!(await providerFor(user.org_id)) || !notificationBase()) throw new HttpError(503, NOT_SET_UP);
  }
  const before = await groupMode(user.org_id, ws);
  if (before !== mode) {
    await run("UPDATE workspaces SET live_mode = ?, live_mode_by = ?, live_mode_at = ? WHERE id = ? AND org_id = ?", mode, user.name, now(), ws, user.org_id);
    const label = mode === "off" ? "off" : mode === "ask" ? "on when someone asks" : "on for every group meeting";
    await audit(user, `Turned ${BRAND.name} live in meetings ${label}`, "Policy change", ws);
  }
  return liveStatus(user, ws);
}

/**
 * The group page's "Live in meetings" panel: the mode (and who set it), whether the plan includes it and the provider
 * is set up, this month's live hours against the plan, and the group's latest sessions (title, status, minutes, who
 * invited, why it ended, any error, and the running list while it's live). Anyone in the group may read it
 * (`requireWorkspace`); `canManage` says who may change it.
 */
export async function liveStatus(user: User, workspaceId: unknown) {
  const ws = await requireWorkspace(user, typeof workspaceId === "string" ? workspaceId : null);
  const row = await get<{ live_mode: string | null; live_mode_by: string | null; live_mode_at: string | null }>("SELECT live_mode, live_mode_by, live_mode_at FROM workspaces WHERE id = ? AND org_id = ?", ws, user.org_id);
  const [included, { limits }, used] = await Promise.all([hasFeature(user.org_id, "liveMeetings"), orgPlan(user.org_id), usageCounts(user.org_id)]);
  const sessions = await all<LiveSession>("SELECT * FROM live_sessions WHERE org_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 10", user.org_id, ws);
  const lead = await get("SELECT 1 AS ok FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND wm.user_id = ? AND u.role = 'Team Lead'", ws, user.id);
  const providerId = await orgProviderId(user.org_id);
  const provider = providerById(providerId);
  return {
    mode: await groupMode(user.org_id, ws),
    settings: await groupSettings(user.org_id, ws),
    provider: { id: providerId, ...PROVIDER_INFO[providerId], ready: Boolean(provider), canChoose: user.role === "Org Owner", choices: configuredProviders().map((id) => ({ id, label: PROVIDER_INFO[id].label, hosted: PROVIDER_INFO[id].hosted })) },
    can: { raiseHand: Boolean(provider?.can.raiseHand), speak: Boolean(provider?.can.speak && speechConfigured()) },
    changedBy: row?.live_mode_by ?? null,
    changedAt: row?.live_mode_at ?? null,
    included,
    configured: Boolean(provider && notificationBase()),
    hours: { used: Math.round(used.liveMeetingHours * 10) / 10, limit: limits.liveMeetingHours },
    canManage: isAdmin(user) || Boolean(lead),
    sessions: sessions.map((s) => ({
      id: s.id, title: s.title ?? "Teams meeting", status: s.status, invitedBy: s.invited_by, guests: s.guests === 1,
      createdAt: s.created_at, joinedAt: s.joined_at, endedAt: s.ended_at, minutes: Math.round(liveMinutes(s.joined_at, s.ended_at)),
      endReason: s.end_reason, error: s.error, answers: s.answers, quiet: s.quiet === 1,
      hearing: s.provider === "attendee" && s.launched_at ? (s.hearing === "stt" ? "Azure speech-to-text" : "Teams captions") : null,
      notes: s.handoff === "graph" ? "From the Teams transcript" : s.handoff === "live" ? "From the live transcript" : null,
      decisions: s.status === "live" ? parseList(s.decisions) : [], actions: s.status === "live" ? parseList(s.action_items) : [],
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Joining                                                             */
/* ------------------------------------------------------------------ */

/** The Teams chat a session talks through when Sidekick's own bot is in the meeting chat (linked to the same group). */
async function meetingConversation(orgId: string, workspaceId: string, threadId: string | null) {
  if (!threadId) return undefined;
  return get<{ id: string; service_url: string; guests: number }>(
    "SELECT id, service_url, guests FROM teams_conversations WHERE id = ? AND org_id = ? AND workspace_id = ? AND leaving IS NULL", threadId, orgId, workspaceId,
  );
}

/**
 * Sends the meeting bot to a Teams meeting for a group and records the session. Refuses (HttpError) when: no provider
 * (503), the plan lacks live meetings (402), the feature is paused or restricted (503), the organization is suspended
 * or read-only, the group's switch is off (409), the link isn't a Teams meeting link (400), Sidekick is already in that
 * meeting (409), or this month's live hours are used up (402). Returns the session id, or null when this occurrence was
 * already handled (automatic joins race safely). A provider failure marks the session failed (shown, audited) and
 * throws a plain 502.
 */
export async function startLive(o: {
  orgId: string; workspaceId: string; meetingUrl: string; threadId: string | null; title: string | null; invitedBy: string;
  guests: boolean; startsAt?: string; joinKey?: string;
}): Promise<string | null> {
  const { orgId, workspaceId } = o;
  const provider = await providerFor(orgId);
  const base = notificationBase();
  if (!provider || !base) throw new HttpError(503, NOT_SET_UP);
  await assertFeature(orgId, "liveMeetings");
  await assertEnabled("live", orgId);
  if ((await get<{ status: string }>("SELECT status FROM orgs WHERE id = ?", orgId))?.status === "Suspended") throw new HttpError(403, `${BRAND.name} is paused for this organization.`);
  if ((await groupMode(orgId, workspaceId)) === "off") throw new HttpError(409, `Live meetings are off for this group. Its Team Lead turns them on on the group's page in the ${BRAND.name} portal.`);
  if (!isTeamsMeetingUrl(o.meetingUrl)) throw new HttpError(400, "That isn't a Microsoft Teams meeting link.");
  const key = o.joinKey ?? joinKey(o.meetingUrl);
  if (await get("SELECT 1 AS ok FROM live_sessions WHERE org_id = ? AND join_key = ? AND status IN ('joining', 'live')", orgId, key)) {
    throw new HttpError(409, `${BOT_NAME} is already in this meeting.`);
  }
  await assertCanAdd(orgId, "liveMeetingHours", 1 / 60);
  // The Sidekick team's monthly cap on what meeting bots cost (lib/live-meetings/spend.ts): new meetings pause.
  if (await capReached()) throw new HttpError(503, LIVE_PAUSED);
  const conv = await meetingConversation(orgId, workspaceId, o.threadId);
  const guests = o.guests || conv?.guests === 1 || Boolean(o.threadId && (await get("SELECT 1 AS ok FROM teams_conversations WHERE id = ? AND org_id = ? AND guests = 1", o.threadId, orgId)));
  const id = newId();
  const t = now();
  const title = (o.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "Teams meeting";
  const inserted = await run(
    `INSERT INTO live_sessions (id, org_id, workspace_id, provider, join_key, starts_at, thread_id, title, status, invited_by, guests, chat_via, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'joining', ?, ?, ?, ?, ?) ON CONFLICT (org_id, join_key, starts_at) DO NOTHING`,
    id, orgId, workspaceId, provider.id, key, o.startsAt ?? t, o.threadId, title, o.invitedBy.slice(0, 120), guests ? 1 : 0, conv ? "teams" : "provider", t, t,
  );
  if (!inserted.changes) return null;
  try {
    const { botId } = await span("live", "Send Sidekick to a Teams meeting", () => provider.join({ meetingUrl: o.meetingUrl, botName: BOT_NAME, webhookUrl: `${base}/api/live/events/${provider.id}`, sessionId: id }), { provider: provider.id, via: conv ? "teams" : "provider" });
    await run("UPDATE live_sessions SET bot_id = ?, updated_at = ? WHERE id = ? AND org_id = ?", botId, now(), id, orgId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await run("UPDATE live_sessions SET status = 'failed', error = ?, end_reason = ?, ended_at = ?, updated_at = ? WHERE id = ? AND org_id = ?", msg.slice(0, 400), "The meeting-bot service couldn't join.", now(), now(), id, orgId);
    await auditAsSidekick(orgId, `${BOT_NAME} couldn't join the Teams meeting “${title}”: ${msg.slice(0, 200)}`, "Agent action", workspaceId);
    throw new HttpError(502, `I couldn't join the meeting: ${msg.slice(0, 200)}`);
  }
  await auditAsSidekick(orgId, `${BOT_NAME} was sent to the Teams meeting “${title}” (invited by ${o.invitedBy.slice(0, 120)})`, "Agent action", workspaceId);
  return id;
}

/** The join link of a Teams meeting chat (Graph `GET /chats/{id}` → `onlineMeetingInfo.joinWebUrl`), or null. */
async function meetingChatJoinUrl(orgId: string, chatId: string): Promise<string | null> {
  const tenant = await tenantOfOrg(orgId);
  if (!tenant) return null;
  try {
    const chat = await span("microsoft", "Read the meeting chat's join link", () =>
      graphCall<{ onlineMeetingInfo?: { joinWebUrl?: string | null } | null }>(tenant, "GET", `/v1.0/chats/${encodeURIComponent(chatId)}?$select=onlineMeetingInfo`),
    );
    return chat?.onlineMeetingInfo?.joinWebUrl ?? null;
  } catch (e) {
    console.error("Couldn't read the meeting chat's join link", e instanceof Error ? e.message : e);
    return null;
  }
}

/** A Teams chat Sidekick's bot is in and that is linked to a group (what the bot passes in). */
export type LiveChat = { id: string; org_id: string; workspace_id: string; name: string | null; guests: number };

/**
 * `@Sidekick join [link]` in a Teams chat linked to a group: in a meeting chat, its own meeting (the join link from
 * Graph); elsewhere, the pasted Teams meeting link. Returns the reply for the chat (never throws for a refusal).
 */
export async function joinFromTeams(chat: LiveChat, asker: User, url: string | null): Promise<string> {
  const isMeetingChat = /^19:meeting_/i.test(chat.id);
  const link = url ?? (isMeetingChat ? await meetingChatJoinUrl(chat.org_id, chat.id) : null);
  if (!link) {
    return isMeetingChat
      ? `I couldn't find this meeting's link. Paste it: @${BRAND.name} join <Teams meeting link>.`
      : `Which meeting? Paste its link: @${BRAND.name} join <Teams meeting link>, or mention me in the meeting's own chat.`;
  }
  try {
    const id = await startLive({
      orgId: chat.org_id, workspaceId: chat.workspace_id, meetingUrl: link,
      threadId: meetingThreadFromUrl(link) ?? (isMeetingChat ? chat.id : null),
      // A meeting chat is named after its meeting; another chat's name says nothing about the pasted meeting.
      title: isMeetingChat ? chat.name : null, invitedBy: asker.name, guests: chat.guests === 1 && isMeetingChat,
    });
    if (!id) return `${BOT_NAME} is already on its way.`;
    return `Joining now as “${BOT_NAME}”. If the meeting has a lobby, someone needs to let me in. Say “${BRAND.name}, leave” or type @${BRAND.name} leave to remove me.`;
  } catch (e) {
    if (e instanceof HttpError) return e.message;
    throw e;
  }
}

/** `@Sidekick leave` in a Teams chat: stops the group's running session for this meeting chat (or its only one). */
export async function leaveFromTeams(chat: LiveChat, asker: User): Promise<string> {
  const running = await all<{ id: string; thread_id: string | null }>(
    "SELECT id, thread_id FROM live_sessions WHERE org_id = ? AND workspace_id = ? AND status IN ('joining', 'live') ORDER BY created_at DESC", chat.org_id, chat.workspace_id,
  );
  const target = running.find((r) => r.thread_id === chat.id) ?? (running.length === 1 ? running[0] : undefined);
  if (!target) return running.length ? `I'm in more than one of this group's meetings. Say “${BRAND.name}, leave” in the meeting, or stop it on the group's page in the portal.` : "I'm not in a meeting for this group right now.";
  await stopSession(chat.org_id, target.id, `${asker.name} asked ${BRAND.name} to leave.`, { say: "Okay, leaving now. The notes will follow in the group's chat." });
  return "Okay, I've left the meeting. The notes will follow in the group's notes chat.";
}

/* ------------------------------------------------------------------ */
/* Leaving                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ends a running session (compare-and-set: only `joining`/`live` ones, once): records why, optionally says goodbye in
 * the chat, makes the bot leave (unless the meeting already ended), audits it and queues the notes handoff. Returns
 * whether this call ended it. Never throws for a provider failure (saved on the session instead).
 */
export async function stopSession(orgId: string, id: string, reason: string, opts: { callProvider?: boolean; failed?: boolean; say?: string } = {}): Promise<boolean> {
  const s = await sessionById(orgId, id);
  if (!s) return false;
  const t = now();
  const claim = await run(
    "UPDATE live_sessions SET status = ?, ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status IN ('joining', 'live')",
    opts.failed ? "failed" : "ended", t, reason.slice(0, 300), t, id, orgId,
  );
  if (!claim.changes) return false;
  if (opts.say && s.status === "live") await postToMeeting(s, opts.say).catch((e) => noteError(orgId, id, e));
  const provider = sessionProvider(s);
  if (s.hand && provider?.can.raiseHand && s.bot_id) await provider.raiseHand(s.bot_id, false).catch(() => {});
  await run("UPDATE live_sessions SET hand = NULL WHERE id = ? AND org_id = ?", id, orgId);
  if (opts.callProvider !== false && s.bot_id && provider) {
    await span("live", "Make Sidekick leave a Teams meeting", () => provider.stop(s.bot_id!)).catch((e) => noteError(orgId, id, e));
  }
  const minutes = Math.round(liveMinutes(s.joined_at, t));
  await auditAsSidekick(orgId, `${BOT_NAME} left the Teams meeting “${s.title ?? "Teams meeting"}” after ${minutes} min: ${reason.slice(0, 200)}`, "Agent action", s.workspace_id);
  await enqueue("live.handoff", { orgId, workspaceId: s.workspace_id, payload: { sessionId: id }, key: `live-handoff:${id}`, runAt: new Date(Date.now() + handoffDelayMs()) });
  return true;
}

/**
 * Someone presses Stop on the group page: the group's Team Lead or an Org Owner/Admin (`requireManage`). 404 for a
 * session that isn't the group's; 409 when it already ended.
 */
export async function stopFromPortal(user: User, workspaceId: unknown, sessionId: unknown) {
  const ws = await requireManage(user, typeof workspaceId === "string" ? workspaceId : null);
  const s = typeof sessionId === "string" ? await sessionById(user.org_id, sessionId) : undefined;
  if (!s || s.workspace_id !== ws) throw new HttpError(404, "That live session isn't in this group.");
  if (!(await stopSession(user.org_id, s.id, `${user.name} stopped it from the portal.`, { say: "Leaving now (stopped from the portal). The notes will follow in the group's chat." }))) {
    throw new HttpError(409, "That session already ended.");
  }
  return liveStatus(user, ws);
}

/** Saves a problem on the session (shown on the group page and the Owner Console). Never throws. */
async function noteError(orgId: string, id: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("Live meeting problem", msg);
  await run("UPDATE live_sessions SET error = ?, updated_at = ? WHERE id = ? AND org_id = ?", msg.slice(0, 400), now(), id, orgId).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Posting in the meeting chat                                         */
/* ------------------------------------------------------------------ */

/**
 * Posts in the meeting chat: through Sidekick's Teams bot (a card) when it's in that chat, else through the provider's
 * chat message (plain `text`). Throws on failure (callers record it).
 */
async function postToMeeting(s: LiveSession, text: string, card?: ReturnType<typeof noticeCard>) {
  const conv = s.chat_via === "teams" ? await meetingConversation(s.org_id, s.workspace_id, s.thread_id) : undefined;
  if (conv) {
    const { postCard } = await import("../teams/bot");
    await postCard(conv, card ?? noticeCard(BOT_NAME, text), conv.id, "a live meeting message");
    return;
  }
  const provider = sessionProvider(s);
  if (!provider || !s.bot_id) throw new Error("The meeting-bot service isn't available to post in the chat.");
  await span("live", "Post in the meeting chat", () => provider.sendChatMessage(s.bot_id!, text));
}

/* ------------------------------------------------------------------ */
/* Webhooks from the provider                                          */
/* ------------------------------------------------------------------ */

/** Work to do after the webhook has been answered (answers, chat posts), each in its session's org. */
export type LiveWork = () => Promise<void>;

/**
 * Handles one webhook from the provider: refuses an unsigned or wrongly signed one (401) before reading it, then
 * applies each event to its session (found by the provider's bot id; unknown bots are ignored). Quick database work
 * happens here; answers and chat posts are returned as `work` for the route to run after replying (providers want a
 * quick 2xx). Returns counts for the trace.
 */
export async function handleLiveWebhook(providerId: string, headers: Headers, raw: string): Promise<{ accepted: number; ignored: number; work: LiveWork[] }> {
  const provider = providerById(providerId);
  if (!provider) throw new HttpError(404, "Live meetings aren't set up.");
  if (!provider.verify(headers, raw)) throw new HttpError(401, "Signature check failed.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Not JSON.");
  }
  const events = provider.parse(body);
  const work: LiveWork[] = [];
  let accepted = 0;
  let ignored = 0;
  for (const e of events) {
    const found = await asSystem("live meeting webhook: find the session by its bot", () => get<{ id: string; org_id: string }>("SELECT id, org_id FROM live_sessions WHERE bot_id = ? AND provider = ?", e.botId, provider.id));
    if (!found) {
      ignored++;
      continue;
    }
    const used = await withOrg(found.org_id, () => onEvent(found.org_id, found.id, e, work));
    if (used) accepted++;
    else ignored++;
  }
  return { accepted, ignored, work };
}

/** Applies one provider event to a session (see `handleLiveWebhook`); true when it changed something. */
async function onEvent(orgId: string, id: string, e: LiveEvent, work: LiveWork[]): Promise<boolean> {
  const s = await sessionById(orgId, id);
  if (!s) return false;
  const running = s.status === "joining" || s.status === "live";
  const later = (name: string, fn: () => Promise<void>) =>
    work.push(() => withOrg(orgId, () => withTrace({ name, channel: "teams", orgId, workspaceId: s.workspace_id, actor: BOT_NAME, detached: true }, fn)));
  if (e.kind === "status") {
    if (!running) return false;
    if (e.status === "in_call") {
      const t = now();
      await run("UPDATE live_sessions SET status = 'live', joined_at = COALESCE(joined_at, ?), updated_at = ? WHERE id = ? AND org_id = ? AND status IN ('joining', 'live')", t, t, id, orgId);
      const intro = await run("UPDATE live_sessions SET intro_posted_at = ? WHERE id = ? AND org_id = ? AND intro_posted_at IS NULL", t, id, orgId);
      if (intro.changes) {
        later("Live meeting: say hello", async () => {
          const fresh = (await sessionById(orgId, id))!;
          const group = await groupName(orgId, s.workspace_id);
          await span("live", "Say Sidekick is listening", () => postToMeeting(fresh, introText(group, fresh.guests === 1))).catch((err) => noteError(orgId, id, err));
        });
      }
      return true;
    }
    if (e.status === "ended") return stopSession(orgId, id, s.status === "live" ? "The meeting ended." : "Removed before it got in.", { callProvider: false });
    if (e.status === "failed") {
      return stopSession(orgId, id, s.status === "live" ? `The meeting-bot service stopped${e.detail ? ` (${e.detail})` : ""}.` : `The meeting-bot service couldn't get in${e.detail ? ` (${e.detail})` : ""}.`, { callProvider: false, failed: s.status !== "live" });
    }
    await run("UPDATE live_sessions SET updated_at = ? WHERE id = ? AND org_id = ?", now(), id, orgId);
    return true;
  }
  // The bot's container exiting: its time stops counting; a session still running is over.
  if (e.kind === "exit") {
    await run("UPDATE live_sessions SET exited_at = COALESCE(exited_at, ?) WHERE id = ? AND org_id = ?", now(), id, orgId);
    if (running) await stopSession(orgId, id, `${BOT_NAME}'s container stopped${e.detail ? ` (${e.detail})` : ""}.`, { callProvider: false });
    return true;
  }
  if (!running) return false;
  if (e.kind === "hearing") {
    await run("UPDATE live_sessions SET hearing = ?, hearing_since = ? WHERE id = ? AND org_id = ? AND (hearing IS NULL OR hearing <> ?)", e.source, now(), id, orgId, e.source);
    return true;
  }
  if (e.kind === "captions_unavailable") {
    await run("UPDATE live_sessions SET captions_unavailable = 1 WHERE id = ? AND org_id = ?", id, orgId);
    await maybeSwitchHearing(orgId, id);
    return true;
  }
  if (e.kind === "participant") {
    const tenant = e.tenantId ? (await tenantOfOrg(orgId))?.toLowerCase() : null;
    const external = e.guest || looksExternal(e.name) || Boolean(e.tenantId && tenant && e.tenantId.toLowerCase() !== tenant);
    if (!external || s.guests === 1 || e.name === BOT_NAME) return false;
    const flip = await run("UPDATE live_sessions SET guests = 1, updated_at = ? WHERE id = ? AND org_id = ? AND guests = 0", now(), id, orgId);
    if (flip.changes) {
      await auditAsSidekick(orgId, `A guest joined the Teams meeting “${s.title ?? "Teams meeting"}”: ${BRAND.name} now answers from Shareable sources only`, "Agent action", s.workspace_id);
      later("Live meeting: guest wall", async () => {
        const fresh = (await sessionById(orgId, id))!;
        await postToMeeting(fresh, GUEST_NOTICE).catch((err) => noteError(orgId, id, err));
      });
    }
    return true;
  }
  // Who is speaking right now: Sidekick never starts talking over anyone.
  if (e.kind === "speech") {
    const speaking = new Set(parseNames(s.speaking));
    if (e.speaking) speaking.add(e.name ?? "Someone");
    else speaking.delete(e.name ?? "Someone");
    await run("UPDATE live_sessions SET speaking = ?, last_heard_at = ?, speech_at = ? WHERE id = ? AND org_id = ?", JSON.stringify([...speaking].slice(0, 50)), now(), e.speaking ? now() : s.speech_at, id, orgId);
    await maybeSwitchHearing(orgId, id);
    return true;
  }
  // A line said or typed in the meeting. Sidekick's own chat messages (the meeting bot's, or its Teams bot's answer
  // cards) come back as chat lines: skip them.
  if (e.source === "chat" && (e.speaker === BOT_NAME || e.speaker === BRAND.name)) return false;
  // Spoken lines: Teams captions or Azure speech-to-text, whichever Sidekick hears by now. A caption while on
  // speech-to-text only says captions work again (no line twice).
  if (e.source === "speech" && e.heardBy) {
    if (e.heardBy === "captions") await run("UPDATE live_sessions SET captions_at = ? WHERE id = ? AND org_id = ?", now(), id, orgId);
    const by = s.hearing === "stt" ? "stt" : "captions";
    if (e.heardBy !== by) {
      await maybeSwitchHearing(orgId, id);
      return true;
    }
    await noteHearing(orgId, id, by);
  }
  const t = now();
  const heardAt = Date.now();
  await run("INSERT INTO live_lines (id, org_id, session_id, speaker, text, said_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)", newId(), orgId, id, e.speaker, e.text, t, e.source);
  await run("UPDATE live_sessions SET line_count = line_count + 1, status = 'live', joined_at = COALESCE(joined_at, ?), last_heard_at = ?, updated_at = ? WHERE id = ? AND org_id = ?", t, t, t, id, orgId);
  const lines = s.line_count + 1;
  // Typed "Sidekick, …" in a meeting chat where Sidekick's Teams bot is: the bot answers it already (lib/teams/bot.ts).
  let trigger: Trigger | null = e.source === "chat" && s.chat_via === "teams" ? null : parseTrigger(e.text);
  // Only its name ("Sidekick?"): being called on when its hand is up, else the speaker's next line is a question to it.
  if (trigger?.kind === "name") {
    if (s.hand) trigger = { kind: "called" };
    else {
      await run("UPDATE live_sessions SET addressed_until = ?, addressed_by = ? WHERE id = ? AND org_id = ?", new Date(heardAt + ADDRESSED_MS).toISOString(), e.speaker, id, orgId);
      trigger = null;
    }
  } else if (!trigger && s.addressed_until && s.addressed_until > t && (!s.addressed_by || s.addressed_by === e.speaker)) {
    trigger = { kind: "question", question: e.text.slice(0, 1000) };
    await run("UPDATE live_sessions SET addressed_until = NULL, addressed_by = NULL WHERE id = ? AND org_id = ?", id, orgId);
  }
  const say = (name: string, text: string) => later(name, async () => {
    const fresh = (await sessionById(orgId, id))!;
    await postToMeeting(fresh, text).catch((err) => noteError(orgId, id, err));
  });
  if (trigger?.kind === "leave") {
    later("Live meeting: leave", async () => {
      await stopSession(orgId, id, `${e.speaker ?? "Someone"} asked ${BRAND.name} to leave.`, { say: "Okay, leaving now. The notes will follow in the group's chat." });
    });
  } else if (trigger?.kind === "recap") {
    later("Live meeting: recap", async () => {
      const fresh = (await sessionById(orgId, id))!;
      const settings = await getGuardSettings(orgId);
      await span("live", "Read back the decisions so far", () => postToMeeting(fresh, cleanOutput(recapText(parseList(fresh.decisions), parseList(fresh.action_items)), settings).text)).catch((err) => noteError(orgId, id, err));
    });
  } else if (trigger?.kind === "quiet") {
    await run("UPDATE live_sessions SET quiet = 1, updated_at = ? WHERE id = ? AND org_id = ?", t, id, orgId);
    if (s.hand) later("Live meeting: lower hand", () => dropHand(orgId, id));
    say("Live meeting: quiet mode", `Okay, I'll stay quiet: I'll only answer when you ask me, in the chat. Say “${BRAND.name}, you can speak up” to change that.`);
  } else if (trigger?.kind === "unquiet") {
    await run("UPDATE live_sessions SET quiet = 0, updated_at = ? WHERE id = ? AND org_id = ?", t, id, orgId);
    say("Live meeting: speak up", "Okay, I'll raise my hand when I can help.");
  } else if (trigger?.kind === "called") {
    if (s.hand) later("Live meeting: called on", () => deliverPending(orgId, id, "called"));
  } else if (trigger?.kind === "question") {
    const question = trigger.question;
    later("Live meeting answer", () => answerLive(orgId, id, e.speaker, question, heardAt));
  } else if (!s.quiet && !s.hand) {
    // A question to the room: Sidekick waits to see whether someone answers it first (`roomQuestion`).
    const settings = await groupSettings(orgId, s.workspace_id);
    if (settings.answer === "room" && isRoomQuestion(e.text, await meetingPeople(orgId, id))) {
      later("Live meeting: question to the room", () => roomQuestion(orgId, id, e.speaker, e.text.slice(0, 1000), t));
    }
  }
  if (lines - s.extracted_lines >= EXTRACT_EVERY) {
    await enqueue("live.extract", { orgId, workspaceId: s.workspace_id, payload: { sessionId: id }, key: `live-extract:${id}:${s.extracted_lines}` });
  }
  return true;
}

/** Names in a JSON list column (who is speaking, items already asked about). */
const parseNames = (json: string | null): string[] => {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** The people heard so far in this meeting (to tell a question to the room from one to a person by name). */
async function meetingPeople(orgId: string, id: string): Promise<string[]> {
  return (await all<{ speaker: string }>("SELECT DISTINCT speaker FROM live_lines WHERE org_id = ? AND session_id = ? AND speaker IS NOT NULL LIMIT 50", orgId, id)).map((r) => r.speaker);
}

/** Records how this minute of the meeting was heard (cost meter): 'both' when it switched within the minute. */
async function noteHearing(orgId: string, id: string, source: "captions" | "stt", at = Date.now()) {
  await run(
    `INSERT INTO live_hearing (org_id, session_id, minute, source) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, minute) DO UPDATE SET source = CASE WHEN live_hearing.source = excluded.source THEN live_hearing.source ELSE 'both' END`,
    orgId, id, minuteOf(at), source,
  );
}

/**
 * Switches how Sidekick's own bot hears when the rule says so (lib/live-meetings/rules.ts `hearingNext`: captions
 * first; Azure speech-to-text when captions are off or stalled; back when they work again). Compare-and-set, so one
 * switch per change; the bot gets a `hearing` command. Traced, audited only in the trace (it's routine).
 */
async function maybeSwitchHearing(orgId: string, id: string, at = Date.now()) {
  const s = await sessionById(orgId, id);
  if (!s || s.status !== "live") return;
  const provider = sessionProvider(s);
  if (!provider?.setHearing) return;
  const source = s.hearing === "stt" ? "stt" : "captions";
  const ms = (v: string | null) => (v ? Date.parse(v) : null);
  const next = hearingNext({ source, since: ms(s.hearing_since) ?? ms(s.joined_at) ?? at, captionsAt: ms(s.captions_at), speechAt: ms(s.speech_at), captionsUnavailable: s.captions_unavailable === 1 }, at, scale());
  if (!next) return;
  const claim = await run("UPDATE live_sessions SET hearing = ?, hearing_since = ? WHERE id = ? AND org_id = ? AND COALESCE(hearing, 'captions') = ?", next.source, new Date(at).toISOString(), id, orgId, source);
  if (!claim.changes) return;
  await noteHearing(orgId, id, next.source, at);
  await span("live", next.source === "stt" ? "Hear with Azure speech-to-text" : "Hear with Teams captions again", () => provider.setHearing!(s.bot_id ?? id, next.source), { reason: next.reason }).catch((e) => noteError(orgId, id, e));
}

/**
 * The bot's commands (GET /api/live/bot/commands): checks the session's key, then waits up to `waitMs` for commands not
 * yet given and hands them over once each (claimed with a compare-and-set). `stop` once the session is over. Null when
 * the key or session is wrong (the route answers 401 without saying which).
 */
export async function takeCommands(sessionId: string, token: string, waitMs: number): Promise<{ commands: { id: string; kind: string; data: unknown }[]; stop: boolean } | null> {
  if (!/^[\w-]{1,80}$/.test(sessionId) || !process.env.SIDEKICK_MEETBOT_SECRET || !sameKey(token, botKey(sessionId))) return null;
  const found = await asSystem("live meeting bot: find its session", () => get<{ org_id: string }>("SELECT org_id FROM live_sessions WHERE id = ? AND provider = 'attendee'", sessionId));
  if (!found) return null;
  return withOrg(found.org_id, async () => {
    const start = Date.now();
    for (;;) {
      const s = await sessionById(found.org_id, sessionId);
      if (!s) return null;
      const pending = await all<{ id: string; kind: string; data: string | null }>(
        "SELECT id, kind, data FROM live_commands WHERE org_id = ? AND session_id = ? AND taken_at IS NULL ORDER BY id LIMIT 20", found.org_id, sessionId,
      );
      const commands: { id: string; kind: string; data: unknown }[] = [];
      for (const c of pending) {
        const claim = await run("UPDATE live_commands SET taken_at = ? WHERE id = ? AND org_id = ? AND taken_at IS NULL", now(), c.id, found.org_id);
        if (claim.changes) commands.push({ id: c.id, kind: c.kind, data: JSON.parse(c.data ?? "{}") });
      }
      const over = s.status === "ended" || s.status === "failed";
      if (commands.length || over || Date.now() - start >= waitMs) return { commands, stop: over && !commands.length };
      await new Promise((r) => setTimeout(r, 300));
    }
  });
}

/* ------------------------------------------------------------------ */
/* Answering in the meeting                                            */
/* ------------------------------------------------------------------ */

/** This meeting so far (its latest lines) as a source for answers, so "what did Ana just say?" works. */
async function meetingSoFar(orgId: string, s: LiveSession) {
  const lines = await all<{ speaker: string | null; text: string; said_at: string; source: string }>(
    "SELECT speaker, text, said_at, source FROM live_lines WHERE org_id = ? AND session_id = ? ORDER BY said_at DESC, id DESC LIMIT 80", orgId, s.id,
  );
  if (!lines.length) return [];
  const text = lines.reverse().map((l) => `[${l.said_at.slice(11, 19)}] ${l.speaker ?? "Someone"}${l.source === "chat" ? " (chat)" : ""}: ${l.text}`).join("\n");
  return [{ title: `This meeting so far (${s.title ?? "Teams meeting"})`, loc: "live", text: text.slice(-12_000), sourceType: "meeting", sourceId: `live:${s.id}`, date: (s.joined_at ?? s.created_at).slice(0, 10) }];
}

/** Asks the group's knowledge (the normal Ask pipeline: guardrails before and after, guest wall, never judging people). */
async function askInMeeting(s: LiveSession, speaker: string | null, question: string) {
  const asker: User = { id: `live:${s.id}`, org_id: s.org_id, name: `${(speaker ?? "Someone").slice(0, 80)} (Teams meeting)`, email: "", role: "Member", must_change_password: 0 };
  return ask(asker, s.workspace_id, question, s.guests === 1, "teams", {
    teamsScope: { key: `live:${s.id}`, idleMinutes: 10 },
    // Everyone in the meeting reads the answer, and Sidekick can't check who they are: no personal connector items.
    readers: { kind: "chat", userIds: [], unmatched: 1 },
    extraSources: await meetingSoFar(s.org_id, s),
    forceSwitches: ["judging_people"],
  });
}

/** Claims one more answer for this meeting: the same question within a minute once (speech can arrive twice), at most MAX_ANSWERS. */
async function claimAnswer(orgId: string, id: string, question: string): Promise<boolean> {
  const t = now();
  const claim = await run(
    `UPDATE live_sessions SET last_question = ?, last_question_at = ?, answers = answers + 1, updated_at = ?
      WHERE id = ? AND org_id = ? AND answers < ? AND (last_question IS NULL OR last_question <> ? OR last_question_at < ?)`,
    question, t, t, id, orgId, MAX_ANSWERS, question, new Date(Date.now() - 60_000).toISOString(),
  );
  return claim.changes > 0;
}

/** Whether Sidekick may speak in this meeting now: the group allows it, not in quiet mode, the bot can, speech is set up. */
const canSpeak = (s: LiveSession, settings: LiveSettings, provider: LiveProvider | null) =>
  settings.voice !== "off" && s.quiet !== 1 && Boolean(provider?.can.speak) && speechConfigured();

/** Raises (or lowers) the bot's hand in Teams when it can. Never throws (saved on the session). */
async function hand(s: LiveSession, up: boolean) {
  const provider = sessionProvider(s);
  if (!provider?.can.raiseHand || !s.bot_id) return false;
  await span("live", up ? "Raise Sidekick's hand" : "Lower Sidekick's hand", () => provider.raiseHand(s.bot_id!, up)).catch((e) => noteError(s.org_id, s.id, e));
  return true;
}

/**
 * Waits until nobody is speaking and nothing was heard for `quietMs`, at most `maxMs` (both scaled in tests). True when
 * it's quiet; false when the time ran out or the session ended. Sidekick never starts talking over anyone.
 */
async function waitForSilence(orgId: string, id: string, quietMs: number, maxMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const s = await sessionById(orgId, id);
    if (!s || s.status !== "live") return false;
    const heard = s.last_heard_at ? Date.parse(s.last_heard_at) : 0;
    if (!parseNames(s.speaking).length && Date.now() - heard >= quietMs * scale()) return true;
    if (Date.now() - start >= maxMs * scale()) return false;
    await sleep(200);
  }
}

/** Says `text` aloud in the meeting (Azure AI Speech → the bot's microphone) once it's quiet. False when it didn't. */
async function speakNow(s: LiveSession, text: string): Promise<boolean> {
  const provider = sessionProvider(s);
  if (!provider || !s.bot_id || !text) return false;
  if (!(await waitForSilence(s.org_id, s.id, 800, 8000))) return false;
  try {
    const mp3 = await synthesize(text);
    await run("UPDATE live_sessions SET tts_chars = tts_chars + ? WHERE id = ? AND org_id = ?", text.length, s.id, s.org_id);
    await span("live", "Speak in the meeting", () => provider.speak(s.bot_id!, mp3), { words: text.split(" ").length });
    return true;
  } catch (e) {
    await noteError(s.org_id, s.id, e);
    return false;
  }
}

/** The answer as the meeting chat gets it: an answer card through our Teams bot, plain text with sources otherwise. */
function chatAnswer(s: LiveSession, question: string, result: Awaited<ReturnType<typeof ask>>, group: string, intro = "") {
  const text = `${intro}${answerText(question, result.answer, result.sources)}`;
  const card = answerCard(question, { ...result, signInUrl: portalUrl(`/knowledge?ws=${encodeURIComponent(s.workspace_id)}#signins`) }, group);
  return { text, card };
}

/**
 * Answers a question addressed to Sidekick ("Sidekick, …", typed or said, or a line right after its name), the
 * normal Ask pipeline with the meeting so far as a source. Order (docs/LIVE-MEETINGS.md → "The live flow"): hand up at
 * once (when the bot can), then a short spoken answer when the group allows speaking and nobody is talking, then the
 * full answer with sources in the chat, then the hand down. A refusal goes to the chat only. Failures are posted as a
 * short apology, traced and saved on the session. Timings (heard → hand, → spoken, → chat) are trace attributes.
 */
export async function answerLive(orgId: string, id: string, speaker: string | null, question: string, heardAt = Date.now()): Promise<void> {
  const s = await sessionById(orgId, id);
  if (!s || s.status !== "live") return;
  if (!(await claimAnswer(orgId, id, question))) return;
  const provider = sessionProvider(s);
  const settings = await groupSettings(orgId, s.workspace_id);
  const group = await groupName(orgId, s.workspace_id);
  const timing: Record<string, number> = {};
  try {
    // Quiet mode ("Sidekick, quiet"): it still answers when asked, in the chat, without raising its hand or speaking.
    if (s.quiet !== 1 && (await hand(s, true))) timing.handMs = Date.now() - heardAt;
    const result = await askInMeeting(s, speaker, question);
    if (!result.blocked && result.found && canSpeak(s, settings, provider) && (await speakNow(s, spokenText(result.answer)))) timing.spokenMs = Date.now() - heardAt;
    const { text, card } = chatAnswer(s, question, result, group);
    await span("live", "Post the answer in the meeting", () => postToMeeting(s, text, card), { sources: result.sources.length, found: result.found });
    timing.chatMs = Date.now() - heardAt;
  } catch (e) {
    console.error("Live meeting answer failed", e);
    traceFailed(e instanceof HttpError ? e.status : 500, e instanceof Error ? e.message : String(e), undefined, { refusal: e instanceof FeatureOffError });
    await noteError(orgId, id, e);
    await postToMeeting(s, e instanceof HttpError ? e.message : "Sorry, I couldn't answer that just now. Please ask again in a minute.").catch(() => {});
  } finally {
    if (timing.handMs !== undefined) await hand(s, false);
    spanAttrs({ addressed: true, ...timing });
  }
}

/**
 * A question put to the room ("when's the cutover again?"): Sidekick waits a few seconds; if someone answers it, it
 * stays out of it. If nobody does (silence, "not sure", "good question"), it asks the group's knowledge, and only when
 * the answer is confident (found, cited, no conflict, not refused) does it volunteer: with spoken answers off it puts
 * the answer in the chat (that interrupts nobody); otherwise it raises its hand and waits to be called on ("go ahead,
 * Sidekick"), or, when the group allows it, speaks after a pause of silence. Hands left up for a minute are lowered by
 * `live.watch` and the answer goes to the chat instead. Low confidence: it stays quiet.
 */
export async function roomQuestion(orgId: string, id: string, speaker: string | null, question: string, saidAt: string): Promise<void> {
  await sleep(ROOM_WAIT_MS);
  const s = await sessionById(orgId, id);
  if (!s || s.status !== "live" || s.quiet === 1 || s.hand) return;
  const after = await all<{ speaker: string | null; text: string }>("SELECT speaker, text FROM live_lines WHERE org_id = ? AND session_id = ? AND said_at > ? ORDER BY said_at", orgId, id, saidAt);
  // Someone else answered (a statement of a few words that isn't "not sure" or another question): stay out of it.
  if (after.some((l) => l.speaker !== speaker && !isNonAnswer(l.text) && !parseTrigger(l.text) && !isRoomQuestion(l.text) && l.text.split(" ").length >= 3)) {
    spanAttrs({ room: "answered by someone" });
    return;
  }
  if (!(await claimAnswer(orgId, id, question))) return;
  const result = await askInMeeting(s, speaker, question);
  // Volunteering needs the group's own knowledge: an answer that only repeats this meeting back isn't worth a hand.
  if (!confident(result) || !result.sources.some((x) => !x.sourceId.startsWith("live:"))) {
    spanAttrs({ room: "not confident, stayed quiet" });
    return;
  }
  const settings = await groupSettings(orgId, s.workspace_id);
  const group = await groupName(orgId, s.workspace_id);
  const { text, card } = chatAnswer(s, question, result, group);
  if (settings.voice === "off") {
    await postToMeeting(s, text, card).catch((e) => noteError(orgId, id, e));
    spanAttrs({ room: "answered in the chat" });
    return;
  }
  const pending: Pending = { kind: "answer", question, chat: text, spoken: spokenText(result.answer), card, raisedAt: now() };
  if (!(await putHandUp(s, pending))) return;
  spanAttrs({ room: "hand raised" });
  if (settings.voice === "auto" && (await waitForSilence(orgId, id, settings.pauseS * 1000, HAND_MS))) await deliverPending(orgId, id, "pause");
}

/** Puts Sidekick's hand up for `pending` (compare-and-set: one thing at a time), in Teams or as "✋" in the chat. */
async function putHandUp(s: LiveSession, pending: Pending): Promise<boolean> {
  const claim = await run("UPDATE live_sessions SET hand = ?, updated_at = ? WHERE id = ? AND org_id = ? AND hand IS NULL AND status = 'live'", JSON.stringify(pending), now(), s.id, s.org_id);
  if (!claim.changes) return false;
  if (!(await hand(s, true))) await postToMeeting(s, HAND_NOTE).catch((e) => noteError(s.org_id, s.id, e));
  return true;
}

/**
 * Gives what Sidekick had its hand up for: called on or after the pause, the short spoken version (when allowed) and
 * then the full text in the chat; when the hand was up too long (`expired`), only the chat, saying so. Claimed with a
 * compare-and-set, so it's given once. The hand goes down.
 */
export async function deliverPending(orgId: string, id: string, how: "called" | "pause" | "expired"): Promise<void> {
  const s = await sessionById(orgId, id);
  if (!s?.hand) return;
  const claim = await run("UPDATE live_sessions SET hand = NULL, updated_at = ? WHERE id = ? AND org_id = ? AND hand = ?", now(), id, orgId, s.hand);
  if (!claim.changes) return;
  let p: Pending;
  try {
    p = JSON.parse(s.hand);
  } catch {
    return;
  }
  await hand(s, false);
  if (s.status !== "live") return;
  const settings = await groupSettings(orgId, s.workspace_id);
  if (how !== "expired" && canSpeak(s, settings, sessionProvider(s))) await speakNow(s, p.spoken);
  const intro = how === "expired" ? (p.kind === "own" ? "" : "In case it helps (I had my hand up):\n") : "";
  const card = p.kind === "answer" && how !== "expired" ? (p.card as ReturnType<typeof noticeCard>) : undefined;
  await span("live", p.kind === "own" ? "Ask in the meeting" : "Post the answer in the meeting", () => postToMeeting(s, `${intro}${p.chat}`, card)).catch((e) => noteError(orgId, id, e));
  spanAttrs({ delivered: how, kind: p.kind });
}

/** Takes Sidekick's hand down without giving anything (quiet mode, leaving). */
async function dropHand(orgId: string, id: string) {
  const s = await sessionById(orgId, id);
  if (!s?.hand) return;
  await run("UPDATE live_sessions SET hand = NULL WHERE id = ? AND org_id = ?", id, orgId);
  await hand(s, false);
}

/* ------------------------------------------------------------------ */
/* The running list of decisions and action items (job live.extract)   */
/* ------------------------------------------------------------------ */

const LIVE_SYSTEM = `You keep the running list of decisions and action items for a Teams meeting that is still going on.
You get the current list and the transcript so far (lines "[time] Speaker: what they said"; "(chat)" marks typed messages).
Return the updated list:
- A decision is something the people in the meeting clearly agreed or settled. An action item is something a person committed to do ("I'll…", "let me…", agreeing when asked). Ideas only floated are neither.
- Keep earlier items unless the meeting changed or dropped them; merge duplicates. At most 20 of each, in the order they happened.
- Short plain sentences, no quotes. made_by / owner: the speaker's name as written, or null. due: as said ("Friday"), or null.
- Lines that address "Sidekick" are questions to an assistant, not part of the meeting's decisions.
- Never invent anything that isn't in the transcript.`;

const LiveListSchema = z.object({
  decisions: z.array(z.object({ text: z.string(), made_by: z.string().nullable() })),
  action_items: z.array(z.object({ text: z.string(), owner: z.string().nullable(), due: z.string().nullable() })),
});

/**
 * Updates a session's running list from everything said so far (the last 40,000 characters), with Claude feature
 * `live` (AI credit applies; paused at 100%). Only while the session is live. Called by the `live.extract` job.
 */
export async function extractLive(orgId: string, id: string): Promise<{ decisions: number; actions: number }> {
  const s = await sessionById(orgId, id);
  if (!s || s.status !== "live") return { decisions: 0, actions: 0 };
  const lines = await all<{ speaker: string | null; text: string; said_at: string; source: string }>(
    "SELECT speaker, text, said_at, source FROM live_lines WHERE org_id = ? AND session_id = ? ORDER BY said_at, id", orgId, id,
  );
  let transcript = lines.map((l) => `[${l.said_at.slice(11, 16)}] ${tagSafe(l.speaker ?? "Someone")}${l.source === "chat" ? " (chat)" : ""}: ${tagSafe(l.text)}`).join("\n");
  if (transcript.length > 40_000) transcript = transcript.slice(transcript.length - 40_000).replace(/^[^\n]*\n/, "");
  const current = { decisions: parseList(s.decisions), action_items: parseList(s.action_items) };
  const out = await structured("live", { orgId, workspaceId: s.workspace_id }, {
    system: LIVE_SYSTEM,
    content: `<current_list>\n${tagSafe(JSON.stringify(current))}\n</current_list>\n\n<transcript>\n${transcript}\n</transcript>`,
    schema: LiveListSchema, effort: "low", maxTokens: 3000,
  });
  const decisions: ListItem[] = out.decisions.slice(0, 20).map((d) => ({ text: d.text.slice(0, 300), who: d.made_by?.slice(0, 80) ?? null }));
  const actions: ListItem[] = out.action_items.slice(0, 20).map((a) => ({ text: a.text.slice(0, 300), who: a.owner?.slice(0, 80) ?? null, due: a.due?.slice(0, 60) ?? null }));
  await run(
    "UPDATE live_sessions SET decisions = ?, action_items = ?, extracted_lines = ?, extracted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?",
    JSON.stringify(decisions), JSON.stringify(actions), lines.length, now(), now(), id, orgId,
  );
  await askOwnQuestion(orgId, id, actions);
  return { decisions: decisions.length, actions: actions.length };
}

/**
 * Sidekick as a participant, not only a note-taker: when an action item on the running list has no owner or no date,
 * it asks (once per item, the first such item each update), with the same etiquette as answers: hand up, spoken when
 * called on (or after the pause when the group allows it, `live.watch`), else in the chat after a minute. Not in quiet
 * mode, not when the group switched its own questions off, and not while its hand is already up.
 */
async function askOwnQuestion(orgId: string, id: string, actions: ListItem[]) {
  const s = await sessionById(orgId, id);
  if (!s || s.status !== "live" || s.quiet === 1 || s.hand) return;
  const settings = await groupSettings(orgId, s.workspace_id);
  if (!settings.ask) return;
  const asked = new Set(parseNames(s.asked));
  const item = actions.find((a) => !asked.has(a.text) && ownQuestion(a));
  if (!item) return;
  const question = ownQuestion(item)!;
  await run("UPDATE live_sessions SET asked = ? WHERE id = ? AND org_id = ?", JSON.stringify([...asked, item.text].slice(-100)), id, orgId);
  if (settings.voice === "off") {
    await postToMeeting(s, question).catch((e) => noteError(orgId, id, e));
    return;
  }
  await putHandUp(s, { kind: "own", question, chat: question, spoken: question, raisedAt: now() });
}

/* ------------------------------------------------------------------ */
/* Afterwards: the notes (job live.handoff)                            */
/* ------------------------------------------------------------------ */

/**
 * After a session ends: when no Teams transcript claimed it (lib/live-meetings/claims.ts), its live transcript becomes
 * the meeting (`source = 'teams-live'`, the same checks as a Teams transcript: read-only plan, meeting hours, AI credit)
 * and `meetings.notes` writes and posts the notes. The live lines are deleted either way. Safe to run twice (the claim
 * is a compare-and-set). Called by the `live.handoff` job, 30 minutes after the end.
 */
export async function handoffLive(orgId: string, id: string): Promise<{ captured: number }> {
  const s = await sessionById(orgId, id);
  if (!s || s.status === "joining" || s.status === "live") return { captured: 0 };
  const dropLines = () => run("DELETE FROM live_lines WHERE org_id = ? AND session_id = ?", orgId, id);
  if (s.handoff) {
    await dropLines();
    return { captured: 0 };
  }
  const lines = await all<{ speaker: string | null; text: string; source: string }>("SELECT speaker, text, source FROM live_lines WHERE org_id = ? AND session_id = ? ORDER BY said_at, id", orgId, id);
  const claim = await run("UPDATE live_sessions SET handoff = ?, updated_at = ? WHERE id = ? AND org_id = ? AND handoff IS NULL", lines.length ? "live" : "none", now(), id, orgId);
  if (!claim.changes || !lines.length) {
    await dropLines();
    return { captured: 0 };
  }
  const title = s.title ?? "Teams meeting";
  const transcript = lines.map((l) => `${l.speaker ?? "Someone"}${l.source === "chat" ? " (chat)" : ""}: ${l.text}`).join("\n");
  const minutes = Math.max(1, Math.round(liveMinutes(s.joined_at, s.ended_at)));
  const refuse = async (reason: string) => {
    await run("UPDATE live_sessions SET error = ?, updated_at = ? WHERE id = ? AND org_id = ?", reason, now(), id, orgId);
    await auditAsSidekick(orgId, `Didn't write notes for the live Teams meeting “${title}”: ${reason}`, "Agent action", s.workspace_id);
    await dropLines();
    return { captured: 0 };
  };
  if ((await orgAccess(orgId)).mode === "read_only") return refuse("Your plan is read-only, so no new notes are written.");
  try {
    await assertCanAdd(orgId, "meetingHours", minutes / 60);
    await creditGate("extract", orgId, { size: transcript.length });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 402 || e instanceof FeatureOffError)) {
      return refuse(e.status === 402 ? "This month's meeting hours on your plan are used up." : "This month's included AI is used up, so long meetings get no notes.");
    }
    throw e;
  }
  const meetingId = newId();
  await run(
    `INSERT INTO meetings (id, org_id, workspace_id, title, held_at, external_guests, status, transcript, imported_by, created_at, duration_min, source)
     VALUES (?, ?, ?, ?, ?, ?, 'Processing', ?, ?, ?, ?, 'teams-live')`,
    meetingId, orgId, s.workspace_id, title, (s.joined_at ?? s.created_at).slice(0, 10), s.guests, transcript, BOT_NAME, now(), minutes,
  );
  await run("UPDATE live_sessions SET notes_meeting_id = ?, updated_at = ? WHERE id = ? AND org_id = ?", meetingId, now(), id, orgId);
  await auditAsSidekick(orgId, `Captured the live Teams meeting “${title}” (${minutes} min)`, "Data", s.workspace_id);
  await enqueue("meetings.notes", { orgId, workspaceId: s.workspace_id, payload: { meetingId }, key: `meeting-notes:${meetingId}` });
  await dropLines();
  return { captured: 1 };
}

/* ------------------------------------------------------------------ */
/* Every minute: watching running sessions (job live.watch)            */
/* ------------------------------------------------------------------ */

/**
 * Checks every running session (all organizations, each in its own org scope) and ends the ones that must stop: the
 * feature paused or restricted by the Sidekick team, the plan no longer includes it, the month's live hours used up,
 * longer than 4 hours, or still in the lobby after 15 minutes. Returns how many it checked and stopped.
 */
export async function watchLive(at = Date.now()): Promise<{ liveChecked: number; liveStopped: number; liveReaped: number; liveCapLevel: number }> {
  const running = await asSystem("live meetings watch: every running session", () =>
    all<{ id: string; org_id: string }>("SELECT id, org_id FROM live_sessions WHERE status IN ('joining', 'live') ORDER BY created_at LIMIT 500"),
  );
  let stopped = 0;
  for (const r of running) {
    const done = await withOrg(r.org_id, async () => {
      const s = await sessionById(r.org_id, r.id);
      if (!s || (s.status !== "joining" && s.status !== "live")) return false;
      try {
        await assertEnabled("live", r.org_id);
      } catch (e) {
        return stopSession(r.org_id, r.id, e instanceof Error ? e.message : "Live meetings were paused.", { say: "I have to leave: live meetings were paused. The notes will follow in the group's chat." });
      }
      if (!(await hasFeature(r.org_id, "liveMeetings"))) return stopSession(r.org_id, r.id, "The plan no longer includes live meetings.");
      if (s.status === "joining" && at - Date.parse(s.created_at) > LOBBY_TIMEOUT_MS) {
        return stopSession(r.org_id, r.id, `Nobody let ${BOT_NAME} in from the lobby within 15 minutes.`, { failed: true });
      }
      if (s.status === "live" && s.joined_at && at - Date.parse(s.joined_at) > MAX_SESSION_MS) {
        return stopSession(r.org_id, r.id, "It was in the meeting for 4 hours, the most for one meeting.", { say: "I've been here 4 hours, the most I stay in one meeting, so I'm leaving. The notes will follow in the group's chat." });
      }
      // A hand that's up: given after the pause of silence (when the group allows speaking by itself), or put in the
      // chat after a minute.
      if (s.hand) {
        const raisedAt = Date.parse((JSON.parse(s.hand) as Pending).raisedAt ?? "") || 0;
        const settings = await groupSettings(r.org_id, s.workspace_id);
        const quietFor = Date.now() - (s.last_heard_at ? Date.parse(s.last_heard_at) : 0);
        if (at - raisedAt >= HAND_MS * scale()) await deliverPending(r.org_id, r.id, "expired");
        else if (settings.voice === "auto" && !parseNames(s.speaking).length && quietFor >= settings.pauseS * 1000 * scale()) await deliverPending(r.org_id, r.id, "pause");
      }
      // How it hears: a stall with nobody's events arriving is noticed here; a minute on speech-to-text is counted.
      if (s.status === "live") {
        await maybeSwitchHearing(r.org_id, r.id, at);
        const fresh = await sessionById(r.org_id, r.id);
        if (fresh?.hearing === "stt") await noteHearing(r.org_id, r.id, "stt", at);
      }
      const { limits } = await orgPlan(r.org_id);
      if (s.status === "live" && limits.liveMeetingHours !== null && (await usageCounts(r.org_id)).liveMeetingHours >= limits.liveMeetingHours) {
        return stopSession(r.org_id, r.id, "This month's live meeting hours are used up.", { say: "This month's live meeting hours are used up, so I'm leaving. The notes will follow in the group's chat." });
      }
      return false;
    });
    if (done) stopped++;
  }
  // Containers of sessions that ended a few minutes ago but never said they exited: stop them in Azure, so a stuck
  // bot never runs (and bills) on.
  const stuck = await asSystem("live meetings watch: bot containers left running", () =>
    all<{ id: string; org_id: string; execution: string }>(
      "SELECT id, org_id, execution FROM live_sessions WHERE execution IS NOT NULL AND exited_at IS NULL AND status IN ('ended', 'failed') AND ended_at < ? LIMIT 100",
      new Date(at - REAP_AFTER_MS * scale()).toISOString(),
    ),
  );
  for (const x of stuck) {
    await reapBot(x.execution);
    await withOrg(x.org_id, () => run("UPDATE live_sessions SET exited_at = ? WHERE id = ? AND org_id = ? AND exited_at IS NULL", new Date(at).toISOString(), x.id, x.org_id));
  }
  const cap = await checkCapAlerts(at);
  // Job counts are numbers: 0 ok, 1 warning (80%), 2 reached.
  return { liveChecked: running.length, liveStopped: stopped, liveReaped: stuck.length, liveCapLevel: cap === "reached" ? 2 : cap === "warn" ? 1 : 0 };
}

/* ------------------------------------------------------------------ */
/* Every minute: joining group meetings automatically (job live.auto)  */
/* ------------------------------------------------------------------ */

type DueMeeting = { join_key: string; starts_at: string; organizer_oid: string; online_meeting_id: string; workspace_id: string; title: string | null; chat_id: string | null };
type GraphMeeting = { joinWebUrl?: string | null; chatInfo?: { threadId?: string | null } | null; participants?: { attendees?: { identity?: { user?: { tenantId?: string | null } | null; guest?: unknown; phone?: unknown } | null }[] } | null };

/**
 * Sends the bot to group meetings starting now (from 2 minutes before to 15 after the start) for groups whose switch
 * is "Every group meeting": the meetings the transcription reminder's calendar read already found to be clearly one
 * group's (`meeting_nudges`, lib/meeting-nudge.ts; needs automatic notes and the calendar permission). The join link
 * and guests come from Graph's meeting. Once per occurrence; refusals (plan, hours, switch) and failures are saved as
 * a failed session so they show. Returns counts.
 */
export async function autoJoinDue(at = Date.now()): Promise<{ liveAutoJoined: number; liveAutoFailed: number }> {
  const out = { liveAutoJoined: 0, liveAutoFailed: 0 };
  if (!liveConfigured()) return out;
  const orgs = await asSystem("live meetings: organizations with a group joining every meeting", () =>
    all<{ org_id: string }>("SELECT DISTINCT org_id FROM workspaces WHERE live_mode = 'auto'"),
  );
  for (const { org_id: orgId } of orgs) {
    await withOrg(orgId, async () => {
      if (!(await hasFeature(orgId, "liveMeetings"))) return;
      const due = await all<DueMeeting>(
        `SELECT n.join_key, n.starts_at, n.organizer_oid, n.online_meeting_id, n.workspace_id, n.title, n.chat_id FROM meeting_nudges n
           JOIN workspaces w ON w.id = n.workspace_id AND w.org_id = n.org_id
          WHERE n.org_id = ? AND w.live_mode = 'auto' AND n.status NOT IN ('gone', 'skipped') AND n.online_meeting_id IS NOT NULL
            AND n.starts_at >= ? AND n.starts_at <= ? AND ${NOT_ENDING}
            AND NOT EXISTS (SELECT 1 FROM live_sessions s WHERE s.org_id = n.org_id AND s.join_key = n.join_key AND s.starts_at = n.starts_at)
          ORDER BY n.starts_at LIMIT 20`,
        orgId, new Date(at - AUTO_AFTER_MS).toISOString(), new Date(at + AUTO_BEFORE_MS).toISOString(),
      );
      if (!due.length) return;
      const tenant = await tenantOfOrg(orgId);
      for (const m of due) {
        try {
          const meeting = tenant
            ? await span("microsoft", "Read the meeting's join link", () => graphCall<GraphMeeting>(tenant, "GET", `/v1.0/users/${m.organizer_oid}/onlineMeetings/${encodeURIComponent(m.online_meeting_id)}`))
            : null;
          if (!meeting?.joinWebUrl) throw new HttpError(404, "Microsoft Teams didn't give the meeting's join link.");
          const guests = (meeting.participants?.attendees ?? []).some((a) => {
            const tid = a.identity?.user?.tenantId;
            return Boolean(a.identity?.guest || a.identity?.phone || (tid && tenant && tid.toLowerCase() !== tenant.toLowerCase()));
          });
          const id = await startLive({
            orgId, workspaceId: m.workspace_id, meetingUrl: meeting.joinWebUrl, threadId: meeting.chatInfo?.threadId ?? m.chat_id,
            title: m.title, invitedBy: "auto", guests, startsAt: m.starts_at, joinKey: m.join_key,
          });
          if (id) out.liveAutoJoined++;
        } catch (e) {
          out.liveAutoFailed++;
          // Paused by the monthly cap: say so once in the meeting's chat when Sidekick's Teams app is there.
          if (e instanceof HttpError && e.message === LIVE_PAUSED && m.chat_id) {
            const conv = await meetingConversation(orgId, m.workspace_id, m.chat_id);
            if (conv) await import("../teams/bot").then(({ postCard }) => postCard(conv, noticeCard(BOT_NAME, LIVE_PAUSED), conv.id, "a live meeting message")).catch(() => {});
          }
          // Saved once as a failed session for this occurrence (startLive already did for a provider failure).
          const t = now();
          await run(
            `INSERT INTO live_sessions (id, org_id, workspace_id, provider, join_key, starts_at, title, status, invited_by, error, end_reason, ended_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', 'auto', ?, ?, ?, ?, ?) ON CONFLICT (org_id, join_key, starts_at) DO NOTHING`,
            newId(), orgId, m.workspace_id, await orgProviderId(orgId), m.join_key, m.starts_at, m.title ?? "Teams meeting",
            (e instanceof Error ? e.message : String(e)).slice(0, 400), "Couldn't join automatically.", t, t, t,
          );
        }
      }
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Owner Console                                                       */
/* ------------------------------------------------------------------ */

/**
 * The Owner Console's Live meetings page: whether a provider is set up, every organization's live use this month
 * (sessions, hours against the plan's limit, failures), the sessions running now and the latest failures. Titles are
 * shown (operators see client names already); never anything said in a meeting. Platform operators only (the route
 * checks `requireOwner`).
 */
export async function ownerLiveReport() {
  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  return asSystem("Owner Console: live meetings across clients", async () => {
    const rows = await all<{ id: string; org_id: string; org: string; workspace: string | null; title: string | null; status: string; invited_by: string; joined_at: string | null; ended_at: string | null; end_reason: string | null; error: string | null; created_at: string; answers: number }>(
      `SELECT s.id, s.org_id, o.name AS org, w.name AS workspace, s.title, s.status, s.invited_by, s.joined_at, s.ended_at, s.end_reason, s.error, s.created_at, s.answers
         FROM live_sessions s JOIN orgs o ON o.id = s.org_id LEFT JOIN workspaces w ON w.id = s.workspace_id AND w.org_id = s.org_id
        WHERE s.created_at >= ? OR s.status IN ('joining', 'live') ORDER BY s.created_at DESC LIMIT 2000`,
      month,
    );
    const byOrg = new Map<string, { orgId: string; org: string; sessions: number; minutes: number; failures: number; answers: number; running: number }>();
    for (const r of rows) {
      const o = byOrg.get(r.org_id) ?? { orgId: r.org_id, org: r.org, sessions: 0, minutes: 0, failures: 0, answers: 0, running: 0 };
      o.sessions++;
      o.minutes += liveMinutes(r.joined_at, r.ended_at);
      o.answers += Number(r.answers) || 0;
      if (r.status === "failed") o.failures++;
      if (r.status === "joining" || r.status === "live") o.running++;
      byOrg.set(r.org_id, o);
    }
    const orgs = [];
    for (const o of byOrg.values()) {
      const limit = await withOrg(o.orgId, async () => (await orgPlan(o.orgId)).limits.liveMeetingHours);
      orgs.push({ ...o, hours: Math.round((o.minutes / 60) * 10) / 10, limit });
    }
    const pick = (r: (typeof rows)[number]) => ({
      id: r.id, orgId: r.org_id, org: r.org, group: r.workspace ?? "(deleted group)", title: r.title ?? "Teams meeting", status: r.status, invitedBy: r.invited_by,
      createdAt: r.created_at, minutes: Math.round(liveMinutes(r.joined_at, r.ended_at)), endReason: r.end_reason, error: r.error,
    });
    return {
      configured: liveConfigured(),
      provider: configuredProviders().join(", ") || null,
      spend: await monthSpend(),
      cap: await capState(),
      orgs: orgs.sort((a, b) => b.minutes - a.minutes),
      running: rows.filter((r) => r.status === "joining" || r.status === "live").map(pick),
      failures: rows.filter((r) => r.status === "failed" || r.error).slice(0, 50).map(pick),
    };
  });
}

/** Stops every running session of a group that is being deleted (lib/workspaces.ts). Never throws. */
export async function stopGroupSessions(orgId: string, workspaceId: string): Promise<void> {
  const running = await all<{ id: string }>("SELECT id FROM live_sessions WHERE org_id = ? AND workspace_id = ? AND status IN ('joining', 'live')", orgId, workspaceId);
  for (const r of running) await stopSession(orgId, r.id, "The group was deleted.").catch((e) => console.error("Couldn't stop a live session", e));
}
