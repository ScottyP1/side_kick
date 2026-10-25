/**
 * @file "Is this meeting being transcribed?" for **scheduled** Teams meetings of a group. Automatic notes need a
 * transcript, and Teams only makes one when someone clicks **Start transcription** (or the meeting records by itself,
 * lib/auto-record.ts). The reminder for Meet now and chat calls (lib/call-nudge.ts) only sees calls in a group's
 * linked chats, so a scheduled meeting with its own meeting chat got no warning and the team found out afterwards
 * that nothing was captured. This file closes that gap: about two minutes after a group's scheduled meeting starts,
 * if nothing shows transcription, Sidekick posts one short card.
 *
 * Concepts
 * - **Which meetings** (`planOrg`, every 10 minutes per organization): Sidekick reads the calendars of the group's
 *   people who signed in with Microsoft (`GET /users/{id}/calendarView`, the next 2 hours plus the last 30 minutes,
 *   the meetings they organize), looks each Teams meeting up by its join link (as lib/auto-record.ts does) and keeps
 *   only meetings that are **clearly one group's** by the shared rule (lib/meeting-group.ts `pickGroup`: its meeting
 *   chat is linked to the group, or most of the meeting is one group's people, at least two). Ties and unclear
 *   meetings are left alone (never a guess). Unlike automatic recording there's no "outsiders" rule: the reminder is
 *   fixed text and records nothing. One row per meeting occurrence (`meeting_nudges`); a meeting moved or cancelled
 *   before it starts is marked `gone` at the next read.
 * - **When and where** (`checkOrg`, every minute): from 2 to 30 minutes after a planned meeting's start, while its
 *   calendar end hasn't passed:
 *   1. the group switched reminders off (`workspaces.call_nudge = 0`, the same switch as for calls) or is ending:
 *      nothing (`off`);
 *   2. the meeting records by itself (Sidekick set it, `meeting_autorecord` set/already, or Teams says
 *      `recordAutomatically`): nothing (`records`);
 *   3. Sidekick is in the meeting chat and it is one of a group's linked chats that lib/call-nudge.ts already watches:
 *      that reminder covers it (`chat`), so the chat is never read or nudged twice;
 *   4. Sidekick is in the meeting chat otherwise (e.g. added but not assigned): Sidekick reads the chat's call events
 *      (`GET /chats/{id}/messages`, same rules as lib/call-nudge-rules.ts). A transcript or recording event →
 *      `transcribing`; no "call started" yet → wait; a call running 2+ minutes with neither → the card **in the
 *      meeting chat**;
 *   5. Sidekick isn't in the meeting chat: it can't see the call, so it checks what it can (Teams already lists a
 *      transcript for the meeting → `transcribing`) and otherwise posts the card in the **group's notes chat**
 *      (lib/notes-chats.ts, internal chats only, since the card names the meeting), saying it can't tell whether the
 *      meeting is being transcribed.
 *   Quiet days of the chat posted to are respected (`quiet`), as for calls. **Once per meeting occurrence**: the row
 *   goes `planned` → `nudged` with a compare-and-set before posting, so several app copies post once.
 * - **What Microsoft lets Sidekick read (app-only, checked on Microsoft Learn, Oct 25, 2026)**:
 *   - Confirmed: meeting chats carry the same call system messages as group chats (`callStartedEventMessageDetail`
 *     with `callEventType: "meeting"`, `callTranscript…`, `callRecording…`; https://learn.microsoft.com/graph/system-messages).
 *     Listing a chat's messages app-only takes `ChatMessage.Read.Chat` (resource-specific consent, granted when
 *     Sidekick is added to that chat; the Teams app package asks for it since 1.1.0) or `Chat.Read.All`
 *     (https://learn.microsoft.com/graph/api/chat-list-messages). Calendar reads and the join-link lookup take
 *     `Calendars.ReadBasic.All` and `OnlineMeetings.ReadWrite.All` plus the Teams application access policy, the
 *     same as automatic recording (https://learn.microsoft.com/graph/api/user-list-calendarview,
 *     https://learn.microsoft.com/graph/api/onlinemeeting-get). Listing a meeting's transcripts takes
 *     `OnlineMeetingTranscript.Read.All`, which automatic notes already need
 *     (https://learn.microsoft.com/graph/api/onlinemeeting-list-transcripts).
 *   - Assumed, not confirmed: reading any chat app-only with `Chat.Read.All` is one of Microsoft's protected Teams
 *     APIs (needs Microsoft's approval), so Sidekick never relies on it and only reads chats it was added to.
 *     Microsoft doesn't say whether a transcript is listed while transcription is still running or only once it
 *     stops, so the notes-chat card says "if someone already started it, ignore this".
 *   - Not used: Teams' meeting start/end bot events and Graph meeting call-event subscriptions would tell Sidekick
 *     that a meeting really started; they need a webhook per meeting and are a possible follow-up.
 * - **Problems are never silent**: Microsoft refusing the calendar read or the lookup is saved
 *   (`auto_meetings.remind_error`) and shown on each group's Teams chats tab next to the switch; throttling stops that
 *   organization's run and the next one retries; a chat Sidekick may not read falls back to the notes chat.
 * - **Walls**: per organization (`withOrg`), group by group; titles kept only for a group's own meetings; the card is
 *   fixed text (no Claude, no group content apart from the meeting's own title in the group's internal notes chat).
 *
 * Who may call: the job queue only (`meetings.remind`, `meetings.remind.org`, `meetings.remind.check` in
 * lib/job-kinds.ts). Read side: lib/call-nudge.ts `callNudgeStatus` shows `remind_error` and the latest reminder.
 *
 * Tests: tests/meetings-graph.test.mjs (fake Graph calendar, meeting lookup, meeting chat messages and transcripts).
 */
import "server-only";
import { all, asSystem, get, now, run, withOrg } from "./db";
import { auditAsSidekick } from "./auth";
import { ConsentNeededError, graphCall, GraphThrottledError } from "./directory";
import { entraConfigured } from "./entra";
import { autoNotesOrgs } from "./meetings-graph";
import { tenantOfOrg } from "./tenants";
import { NOT_ENDING } from "./billing";
import { span, withTrace } from "./trace";
import { getChatSettings } from "./reminders";
import { localTime } from "./reminder-rules";
import { callsFromMessages, nudgeDue, NUDGE_AFTER_MS, type GraphChatMessage } from "./call-nudge-rules";
import { pickGroup, isOid } from "./meeting-group";
import { cleanTitle, isMeetingId, joinKey, utc } from "./auto-record";
import { notesTargetsFor } from "./notes-chats";
import { NUDGE_TITLE, NUDGE_FOOTNOTE } from "./call-nudge";
import { BRAND } from "./brand";

/** How far back the calendar read reaches (meetings that started before the last read still get checked). */
const LOOKBACK_MS = 30 * 60_000;
/** How far ahead the calendar read reaches. */
const LOOKAHEAD_MS = 2 * 3600_000;
/** After this long past the start, a meeting that hasn't been nudged never is (a late reminder is no use). */
const LATE_MS = 30 * 60_000;
/** At most this many organizers per organization per read (the same cap as automatic recording). */
const MAX_ORGANIZERS = 200;
/** At most this many calendar pages (50 events each) per organizer per read. */
const MAX_PAGES = 2;
/** How many of a meeting chat's latest messages are read each time (Graph allows up to 50). */
const MESSAGES_PER_READ = 25;

/** Where Microsoft refused what the reminder for scheduled meetings needs (saved for the Teams chats tab). */
export const REMIND_DENIED = `${BRAND.name} can't see your groups' scheduled Teams meetings yet, so it can't remind them to start transcription. A Microsoft admin of your organization approves reading calendars and Teams meetings (Users & access → Approve ${BRAND.name} for your organization), and the Teams application access policy must include ${BRAND.name} (see "Automatic notes" in the help center).`;

/** The card in the meeting's own chat: the call reminder's text, about a meeting. */
export const MEETING_NUDGE_TEXT = "This meeting isn't being transcribed yet. So I can write the meeting notes afterwards, turn it on: **More (…) → Record and transcribe → Start transcription**. If someone already started it, ignore this.";
/** Footnote in a meeting chat that isn't one of the group's linked chats (chat commands only work in linked chats). */
export const MEETING_NUDGE_FOOTNOTE = `Don't want these? The Team Lead switches them off on the group's Teams chats tab in the ${BRAND.name} portal.`;
/** The card in the group's notes chat, naming the meeting (Sidekick can't see that meeting's chat). */
export const notesNudgeText = (title: string) =>
  `The Teams meeting “${title}” started a few minutes ago and I can't see whether it's being transcribed. So I can write the meeting notes afterwards, someone in the meeting turns it on: **More (…) → Record and transcribe → Start transcription**. If someone already started it, ignore this.`;

/** One `meeting_nudges` row's status (see the file header). */
export type MeetingNudgeStatus =
  | "planned" | "skipped" | "records" | "off" | "chat" | "nudged" | "transcribing" | "ended" | "quiet" | "nowhere" | "failed" | "late" | "gone";

/* ------------------------------------------------------------------ */
/* Which organizations                                                 */
/* ------------------------------------------------------------------ */

/**
 * Organizations the reminder runs for: automatic notes on (lib/meetings-graph.ts `autoNotesOrgs`, none without a
 * Microsoft app) and at least one group that isn't ending with transcription reminders on.
 */
export async function meetingNudgeOrgs(): Promise<string[]> {
  if (!entraConfigured()) return [];
  const out: string[] = [];
  for (const orgId of await autoNotesOrgs()) {
    const any = await withOrg(orgId, () => get(`SELECT 1 AS ok FROM workspaces w WHERE w.org_id = ? AND (w.call_nudge IS NULL OR w.call_nudge <> 0) AND ${NOT_ENDING} LIMIT 1`, orgId));
    if (any) out.push(orgId);
  }
  return out;
}

/** Records how the last calendar read went (shown on each group's Teams chats tab). Never throws. */
async function noteRead(orgId: string, error: string | null) {
  await run("UPDATE auto_meetings SET remind_checked_at = ?, remind_error = ? WHERE org_id = ?", now(), error ? error.slice(0, 400) : null, orgId)
    .catch((e) => console.error("Couldn't record the meeting reminder check", e));
}

/* ------------------------------------------------------------------ */
/* Planning: the group meetings coming up (job meetings.remind.org)    */
/* ------------------------------------------------------------------ */

/** A calendar event as Sidekick reads it (`$select` keeps it to these). */
type CalendarEvent = {
  subject?: string | null;
  start?: { dateTime?: string; timeZone?: string } | null;
  end?: { dateTime?: string; timeZone?: string } | null;
  isOrganizer?: boolean;
  organizer?: { emailAddress?: { address?: string | null } | null } | null;
  isCancelled?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  attendees?: { type?: string; emailAddress?: { address?: string | null } | null }[];
};

/** The parts of a Graph online meeting this file reads. */
type OnlineMeeting = {
  id?: string;
  subject?: string | null;
  recordAutomatically?: boolean | null;
  chatInfo?: { threadId?: string | null } | null;
  participants?: { attendees?: { identity?: { user?: { id?: string } | null } | null }[] } | null;
};

/** One organizer's Teams meetings in the window (they organize, not cancelled, with a join link). */
async function meetingsInWindow(tenant: string, oid: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  const range = `startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}`;
  let path: string | null = `/v1.0/users/${oid}/calendarView?${range}&$select=subject,start,end,organizer,isOrganizer,isCancelled,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,attendees&$top=50`;
  const out: CalendarEvent[] = [];
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res: { value?: CalendarEvent[]; "@odata.nextLink"?: string } | null = await span("microsoft", "Read the next Teams meetings", () =>
      graphCall<{ value?: CalendarEvent[]; "@odata.nextLink"?: string }>(tenant, "GET", path!, { headers: { Prefer: 'outlook.timezone="UTC"' }, deniedMessage: REMIND_DENIED }),
    );
    for (const e of res?.value ?? []) {
      if (e.isOrganizer && !e.isCancelled && e.isOnlineMeeting && e.onlineMeetingProvider === "teamsForBusiness" && e.onlineMeeting?.joinUrl) out.push(e);
    }
    const next: string | undefined = res?.["@odata.nextLink"];
    path = next ? next.replace(/^https?:\/\/[^/]+/i, "") : null;
  }
  return out;
}

/**
 * Reads the organization's people's Teams meetings around now (see the file header) and remembers the ones that are
 * clearly one group's, once per occurrence. Meetings no longer in an organizer's calendar before they start become
 * `gone`. A refused permission is saved for the Teams chats tab (not retried); throttling and outages throw so the job
 * retries. Returns how many meetings it newly looked at and how many are a group's. Called by the job only.
 */
export async function planOrg(orgId: string, at = new Date()): Promise<{ looked: number; planned: number }> {
  const out = { looked: 0, planned: 0 };
  if (!entraConfigured()) return out;
  const tenant = await tenantOfOrg(orgId);
  if (!tenant) return out;
  const organizers = (await all<{ oid: string }>(
    `SELECT DISTINCT LOWER(u.entra_oid) AS oid FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id JOIN workspaces w ON w.id = wm.workspace_id AND w.org_id = u.org_id
      WHERE u.org_id = ? AND u.entra_oid IS NOT NULL AND ${NOT_ENDING} ORDER BY oid`,
    orgId,
  )).map((o) => o.oid).filter(isOid).slice(0, MAX_ORGANIZERS);
  const people = await all<{ id: string; email: string; oid: string | null }>("SELECT id, LOWER(email) AS email, LOWER(entra_oid) AS oid FROM users WHERE org_id = ?", orgId);
  const idByEmail = new Map(people.map((p) => [p.email, p.id]));
  const idsByOid = new Map<string, string[]>();
  for (const p of people) if (p.oid) idsByOid.set(p.oid, [...(idsByOid.get(p.oid) ?? []), p.id]);
  const from = new Date(at.getTime() - LOOKBACK_MS);
  const to = new Date(at.getTime() + LOOKAHEAD_MS);
  // A meeting looked up once this run serves its other occurrences in the window.
  const lookedUp = new Map<string, OnlineMeeting | null>();
  try {
    for (const oid of organizers) {
      const events = await meetingsInWindow(tenant, oid, from, to);
      const seen: string[] = [];
      for (const e of events) {
        const url = e.onlineMeeting!.joinUrl!;
        const startsAt = utc(e.start);
        if (!startsAt || Date.parse(startsAt) < from.getTime()) continue; // started long ago: too late anyway
        const key = joinKey(url);
        seen.push(`${key}|${startsAt}`);
        if (await get("SELECT 1 AS ok FROM meeting_nudges WHERE org_id = ? AND join_key = ? AND starts_at = ?", orgId, key, startsAt)) continue;
        out.looked++;
        const endsAt = utc(e.end);
        let m = lookedUp.get(key);
        if (m === undefined) {
          const filter = `JoinWebUrl eq '${url.replace(/'/g, "''")}'`;
          const found = await span("microsoft", "Look up a Teams meeting", () =>
            graphCall<{ value?: OnlineMeeting[] }>(tenant, "GET", `/v1.0/users/${oid}/onlineMeetings?$filter=${encodeURIComponent(filter)}`, { deniedMessage: REMIND_DENIED }),
          );
          m = found?.value?.[0] && isMeetingId(found.value[0].id) ? found.value[0] : null;
          lookedUp.set(key, m);
        }
        const save = (r: { status: MeetingNudgeStatus; reason?: string; workspaceId?: string | null; title?: string | null; chatId?: string | null }) => {
          const t = now();
          return run(
            `INSERT INTO meeting_nudges (org_id, join_key, starts_at, ends_at, organizer_oid, online_meeting_id, chat_id, workspace_id, title, status, reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, join_key, starts_at) DO NOTHING`,
            orgId, key, startsAt, endsAt, oid, m?.id ?? null, r.chatId ?? null, r.workspaceId ?? null, r.title ?? null, r.status, r.reason ?? null, t, t,
          );
        };
        if (!m) {
          await save({ status: "skipped", reason: "Microsoft Teams didn't find this meeting." });
          continue;
        }
        // Who's invited: the meeting's account ids, plus calendar invitees matched to Sidekick people by email.
        const organizerIds = idsByOid.get(oid) ?? [];
        const organizerEmail = e.organizer?.emailAddress?.address?.toLowerCase() ?? null;
        const attendeeOids = [...new Set((m.participants?.attendees ?? []).map((a) => a.identity?.user?.id?.toLowerCase()).filter(isOid))].filter((o) => o !== oid);
        const knownUserIds = [...new Set((e.attendees ?? [])
          .map((a) => (a.type !== "resource" ? a.emailAddress?.address?.toLowerCase() : null))
          .filter((x): x is string => !!x && x !== organizerEmail)
          .map((x) => idByEmail.get(x))
          .filter((x): x is string => !!x && !organizerIds.includes(x)))];
        const chatId = m.chatInfo?.threadId ?? null;
        const picked = await pickGroup(orgId, { chatId, organizerOid: oid, attendeeOids, knownUserIds });
        if (!picked || "candidates" in picked) {
          await save({ status: "skipped", reason: picked ? "Several groups' people are invited." : "Not a group's meeting." });
          continue;
        }
        const title = cleanTitle(m.subject ?? e.subject);
        if (m.recordAutomatically) {
          await save({ status: "records", workspaceId: picked.workspaceId, title, chatId });
          continue;
        }
        await save({ status: "planned", workspaceId: picked.workspaceId, title, chatId });
        out.planned++;
      }
      // Planned meetings of this organizer that are no longer in the calendar before they start: moved or cancelled.
      const planned = await all<{ join_key: string; starts_at: string }>(
        "SELECT join_key, starts_at FROM meeting_nudges WHERE org_id = ? AND organizer_oid = ? AND status = 'planned' AND starts_at > ? AND starts_at <= ?",
        orgId, oid, at.toISOString(), to.toISOString(),
      );
      for (const p of planned) {
        if (seen.includes(`${p.join_key}|${p.starts_at}`)) continue;
        await run("UPDATE meeting_nudges SET status = 'gone', updated_at = ? WHERE org_id = ? AND join_key = ? AND starts_at = ? AND status = 'planned'", now(), orgId, p.join_key, p.starts_at);
      }
    }
  } catch (e) {
    if (e instanceof ConsentNeededError) {
      await noteRead(orgId, e.message);
      return out;
    }
    throw e;
  }
  await noteRead(orgId, null);
  return out;
}

/* ------------------------------------------------------------------ */
/* Checking: the meetings that started (job meetings.remind.check)     */
/* ------------------------------------------------------------------ */

/** A planned meeting due for a check. */
type DueMeeting = {
  join_key: string; starts_at: string; ends_at: string | null; organizer_oid: string; online_meeting_id: string | null;
  chat_id: string | null; workspace_id: string; title: string | null;
};

/** A Teams chat Sidekick can post to. */
type Chat = { id: string; service_url: string; workspace_id: string | null; kind: string; name: string | null };

/** Moves a meeting's row from `planned` to `to`; true if this caller made the change (the compare-and-set). */
async function move(orgId: string, m: DueMeeting, to: MeetingNudgeStatus, fields: { posted_to?: string; nudged_at?: string; reason?: string } = {}): Promise<boolean> {
  const r = await run(
    `UPDATE meeting_nudges SET status = ?, posted_to = COALESCE(?, posted_to), nudged_at = COALESCE(?, nudged_at), reason = COALESCE(?, reason), updated_at = ?
      WHERE org_id = ? AND join_key = ? AND starts_at = ? AND status = 'planned'`,
    to, fields.posted_to ?? null, fields.nudged_at ?? null, fields.reason ?? null, now(), orgId, m.join_key, m.starts_at,
  );
  return r.changes === 1;
}

/**
 * The meeting's chat when Sidekick is in it: one of the organization's chats, or a chat Sidekick was added to in the
 * organization's own Microsoft tenant that nobody has assigned to a group yet (those have no organization until
 * assigned, so they're looked up as named system work, by id and tenant only). Removed or being left: none.
 */
async function meetingChat(orgId: string, tenant: string, chatId: string): Promise<Chat | undefined> {
  const own = await get<Chat>("SELECT id, service_url, workspace_id, kind, name FROM teams_conversations WHERE id = ? AND org_id = ? AND removed_at IS NULL AND leaving IS NULL", chatId, orgId);
  if (own) return own;
  return asSystem("meeting reminder: a meeting chat not assigned yet", () => get<Chat>(
    `SELECT id, service_url, workspace_id, kind, name FROM teams_conversations
      WHERE id = ? AND org_id IS NULL AND LOWER(tenant_id) = ? AND kind <> 'personal' AND removed_at IS NULL AND leaving IS NULL`,
    chatId, tenant.toLowerCase(),
  ));
}

/** True when `chat` has reminders on and `at` falls on one of its quiet days (in the chat's time zone). */
async function quietNow(chat: Chat, at: Date): Promise<boolean> {
  const s = await getChatSettings(chat);
  return s.reminders && s.quietDays.includes(localTime(at, s.timeZone).weekday);
}

/**
 * What one due meeting needs (see the file header, steps 1–5): a status to settle on, `wait` to look again next
 * minute, or a card to post in `chat` (`where` says which kind of chat).
 */
async function decideOne(orgId: string, tenant: string, m: DueMeeting, at: Date):
  Promise<{ status: MeetingNudgeStatus; reason?: string } | "wait" | { chat: Chat; where: "meeting" | "notes" }> {
  if (Date.parse(m.starts_at) < at.getTime() - LATE_MS || (m.ends_at && Date.parse(m.ends_at) <= at.getTime())) return { status: "late" };
  const ws = await get<{ call_nudge: number | null }>(`SELECT w.call_nudge FROM workspaces w WHERE w.id = ? AND w.org_id = ? AND ${NOT_ENDING}`, m.workspace_id, orgId);
  if (!ws || ws.call_nudge === 0) return { status: "off" };
  if (await get("SELECT 1 AS ok FROM meeting_autorecord WHERE org_id = ? AND join_key = ? AND status IN ('set', 'already')", orgId, m.join_key)) return { status: "records" };
  const chat = m.chat_id ? await meetingChat(orgId, tenant, m.chat_id) : undefined;
  if (chat && chat.kind === "groupChat" && chat.workspace_id) {
    // A linked group chat: the call reminder (lib/call-nudge.ts) watches it when its group has reminders on.
    const watched = await get(`SELECT 1 AS ok FROM workspaces w WHERE w.id = ? AND w.org_id = ? AND (w.call_nudge IS NULL OR w.call_nudge <> 0) AND ${NOT_ENDING}`, chat.workspace_id, orgId);
    if (watched) return { status: "chat" };
  }
  if (chat) {
    let messages: GraphChatMessage[] | null = null;
    try {
      const res = await span("microsoft", "Read call events in a Teams meeting chat", () =>
        graphCall<{ value?: GraphChatMessage[] }>(tenant, "GET", `/v1.0/chats/${encodeURIComponent(chat.id)}/messages?$top=${MESSAGES_PER_READ}&$orderby=createdDateTime desc`, {
          headers: { Prefer: "include-unknown-enum-members" },
        }),
      );
      messages = res?.value ?? [];
    } catch (e) {
      // The chat permission wasn't granted there: fall back to the notes chat below.
      if (!(e instanceof ConsentNeededError)) throw e;
      console.warn("Sidekick may not read this meeting chat; the reminder goes to the group's notes chat", e.message);
    }
    if (messages) {
      // Calls of this meeting: started at most 15 minutes before the scheduled start (people join early).
      const calls = callsFromMessages(messages).filter((c) => c.startedAt && Date.parse(c.startedAt) >= Date.parse(m.starts_at) - 15 * 60_000);
      if (calls.some((c) => c.transcribing)) return { status: "transcribing" };
      if (!calls.length) return "wait"; // nobody has joined yet
      if (calls.every((c) => c.ended)) return { status: "ended" };
      // A call running long enough (late, ended and old calls are left out by nudgeDue).
      return calls.some((c) => nudgeDue(c, at)) ? { chat, where: "meeting" } : "wait";
    }
  }
  // Sidekick can't see the meeting's call: check what Microsoft lists, then the group's notes chat.
  if (m.online_meeting_id && isMeetingId(m.online_meeting_id) && isOid(m.organizer_oid)) {
    try {
      const t = await span("microsoft", "Check a Teams meeting for transcripts", () =>
        graphCall<{ value?: unknown[] }>(tenant, "GET", `/v1.0/users/${m.organizer_oid}/onlineMeetings/${encodeURIComponent(m.online_meeting_id!)}/transcripts?$top=1`),
      );
      if ((t?.value ?? []).length) return { status: "transcribing" };
    } catch (e) {
      // Can't check (permission or Teams' transcript switch): the card says "if someone already started it, ignore this".
      if (!(e instanceof ConsentNeededError)) throw e;
      console.warn("Couldn't check the meeting for transcripts before reminding", e.message);
    }
  }
  const target = (await notesTargetsFor(orgId, m.workspace_id, false))[0];
  if (!target) return { status: "nowhere", reason: "The group has no internal notes chat in Teams." };
  const notesChat = await get<Chat>("SELECT id, service_url, workspace_id, kind, name FROM teams_conversations WHERE id = ? AND org_id = ?", target.id, orgId);
  return notesChat ? { chat: notesChat, where: "notes" } : { status: "nowhere" };
}

/**
 * Posts the reminder card for one meeting, as its own trace under the organization ("Transcription reminder", shown
 * only when a card is posted), and audits it ("Agent action"). Returns false if Teams refused the post (recorded for
 * the failed-posts watcher by `postCard`; not retried).
 */
async function postNudge(orgId: string, m: DueMeeting, chat: Chat, where: "meeting" | "notes", at: Date): Promise<boolean> {
  const { postCard } = await import("./teams/bot");
  const { noticeCard } = await import("./teams/cards");
  const title = m.title ?? "Teams meeting";
  const linked = !!chat.workspace_id && chat.kind !== "personal";
  const card = where === "meeting"
    ? noticeCard(NUDGE_TITLE, MEETING_NUDGE_TEXT, linked ? NUDGE_FOOTNOTE : MEETING_NUDGE_FOOTNOTE)
    : noticeCard(NUDGE_TITLE, notesNudgeText(title), NUDGE_FOOTNOTE);
  try {
    await withTrace({ name: "Transcription reminder", channel: "teams", kind: "teams", orgId, workspaceId: m.workspace_id, actor: BRAND.name, detached: true }, () =>
      span("teams", "Post the transcription reminder for a scheduled meeting", () => postCard(chat, card, chat.id, "a transcription reminder"), {
        after_seconds: Math.round((at.getTime() - Date.parse(m.starts_at)) / 1000), where,
      }),
    );
  } catch (e) {
    console.error("Couldn't post the meeting transcription reminder", e);
    return false;
  }
  await auditAsSidekick(orgId, where === "meeting"
    ? `Reminded the Teams meeting “${title}” to start transcription in its chat (none had started after 2 minutes)`
    : `Reminded “${chat.name ?? "Teams chat"}” to start transcription in the Teams meeting “${title}” (${BRAND.name} can't see that meeting's chat)`,
  "Agent action", m.workspace_id);
  return true;
}

/**
 * Checks one organization's planned meetings that started at least 2 minutes ago and posts the reminders that are
 * due (see the file header). Throttling stops this organization's run (the next minute retries). Returns how many
 * meetings it settled and how many reminders it posted.
 */
export async function checkOrg(orgId: string, at = new Date()): Promise<{ checked: number; nudged: number }> {
  const out = { checked: 0, nudged: 0 };
  const due = await all<DueMeeting>(
    `SELECT join_key, starts_at, ends_at, organizer_oid, online_meeting_id, chat_id, workspace_id, title FROM meeting_nudges
      WHERE org_id = ? AND status = 'planned' AND workspace_id IS NOT NULL AND starts_at <= ? ORDER BY starts_at LIMIT 200`,
    orgId, new Date(at.getTime() - NUDGE_AFTER_MS).toISOString(),
  );
  if (!due.length) return out;
  const tenant = await tenantOfOrg(orgId);
  if (!tenant) return out;
  for (const m of due) {
    const d = await decideOne(orgId, tenant, m, at);
    if (d === "wait") continue;
    out.checked++;
    if ("status" in d) {
      await move(orgId, m, d.status, { reason: d.reason });
      continue;
    }
    if (await quietNow(d.chat, at)) {
      await move(orgId, m, "quiet");
      continue;
    }
    if (!(await move(orgId, m, "nudged", { posted_to: d.where, nudged_at: now() }))) continue;
    if (await postNudge(orgId, m, d.chat, d.where, at)) out.nudged++;
    else await run("UPDATE meeting_nudges SET status = 'failed', updated_at = ? WHERE org_id = ? AND join_key = ? AND starts_at = ?", now(), orgId, m.join_key, m.starts_at);
  }
  return out;
}

/**
 * The `meetings.remind.check` job (every minute): checks every organization the reminder runs for
 * (`meetingNudgeOrgs`) and posts what's due. One organization's Graph trouble never stops the others; it's logged and
 * that organization is retried next minute. Each organization runs scoped to its own rows (`withOrg`).
 */
export async function checkScheduledMeetings(at = new Date()): Promise<{ meetingsChecked: number; meetingsNudged: number }> {
  const total = { meetingsChecked: 0, meetingsNudged: 0 };
  for (const orgId of await meetingNudgeOrgs()) {
    try {
      const r = await withOrg(orgId, () => span("job", "Check a company's scheduled Teams meetings for transcription", () => checkOrg(orgId, at), { org: orgId }));
      total.meetingsChecked += r.checked;
      total.meetingsNudged += r.nudged;
    } catch (e) {
      console.error(e instanceof GraphThrottledError ? "Microsoft Graph asked to wait; meetings are checked again next minute" : "Couldn't check scheduled meetings for an organization", e);
    }
  }
  return total;
}
