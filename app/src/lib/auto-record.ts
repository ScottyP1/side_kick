/**
 * @file Meetings that record and transcribe by themselves: when an organization opts in, Sidekick looks at the
 * group meetings its people have scheduled in Teams and turns on **Record and transcribe automatically** for them
 * (Graph `onlineMeeting.recordAutomatically`), so the meeting has a transcript (and so notes) without anyone
 * pressing Start transcription. Follow-up to the "Turn on transcription?" reminder (lib/call-nudge.ts), which covers
 * Meet now and calls in a chat, where Teams has no meeting options at all.
 *
 * Concepts
 * - **Why it also records video**: Microsoft Graph has no "transcribe only" property (checked on Microsoft Learn,
 *   Oct 25, 2026, v1.0 and beta). `recordAutomatically: true` is the same as the organizer choosing *Record and
 *   transcribe* in Meeting options: Teams saves a video recording (in the organizer's OneDrive) as well as the
 *   transcript. That's why this is its own switch, **off by default**, that only an Org Owner/Admin turns on
 *   (Meetings page), audited, and explained in plain words where it's switched.
 * - **Which meetings** (`decide`): scheduled Teams meetings in the next 7 days that a group's person organizes
 *   (the people Sidekick already polls for transcripts: group members who signed in with Microsoft), and that are
 *   clearly one group's meeting: its meeting chat is linked to a group, or at least two of the invitees and at least
 *   half of everyone invited (organizer included) are one group's people. Ties, meetings of nobody's group, and any
 *   meeting with someone from another organization invited (a guest or another Microsoft tenant) are left alone:
 *   Sidekick never starts a recording of people outside the organization. People are matched to Sidekick accounts by
 *   Microsoft account id (the organizer, meeting participants) or by email (calendar invitees), so invitees who never
 *   signed in to Sidekick with Microsoft still count for their groups.
 * - **Once per meeting** (`meeting_autorecord`, one row per organization and join link): a meeting Sidekick turned
 *   on is never touched again, so an organizer who switches it back off in Meeting options keeps it off. A recurring
 *   series is one online meeting (one join link), so it's set once for every occurrence. Meetings left alone are
 *   looked at again after an hour (invitees change), or at once on Check now or when the switch is turned on; their
 *   titles aren't kept, but admins and Team Leads see how many were left alone and why.
 * - **Finding the meetings app-only** (no one signed in): Graph can't list a person's online meetings, so Sidekick
 *   reads the organizer's calendar (`GET /users/{id}/calendarView`, application permission `Calendars.ReadBasic.All`:
 *   times, subject, invitees and the Teams join link, never the invitation text), then looks the meeting up by its
 *   join link (`GET /users/{id}/onlineMeetings?$filter=JoinWebUrl eq '…'`, documented for meetings people create
 *   in Teams or Outlook) and patches it (`PATCH /users/{id}/onlineMeetings/{id}`). Both need
 *   `OnlineMeetings.ReadWrite.All` (application) and the Teams application access policy that already lets Sidekick
 *   read transcripts (docs/RUNBOOKS.md → Automatic meeting notes, step 7).
 * - **Problems are never silent**: a permission Microsoft refuses stops the scan and is shown on the Meetings page
 *   with what to approve; a meeting Graph refuses to change is listed with the reason; throttling retries the job.
 * - **Job**: `meetings.record` (every 30 minutes) fans out `meetings.record.org` to every organization with both
 *   switches on (lib/job-kinds.ts). Graph calls only go through lib/directory.ts `graphCall`, each in a trace span.
 *
 * Tests: tests/meetings-graph.test.mjs (fake Graph calendar, lookup and patch).
 */
import "server-only";
import crypto from "node:crypto";
import { all, get, newId, now, run } from "./db";
import { audit, auditAsSidekick, HttpError, type User } from "./auth";
import { ConsentNeededError, graphCall, NOT_APPROVED } from "./directory";
import { entraConfigured } from "./entra";
import { enqueue } from "./jobs";
import { span } from "./trace";
import { tenantOfOrg } from "./tenants";
import { NOT_ENDING } from "./billing";
import { autoNotesOn } from "./meetings-graph";
import { pickGroup } from "./meeting-group";
import { BRAND } from "./brand";

/** How far ahead Sidekick looks for meetings to set. */
const LOOKAHEAD_MS = 7 * 86400_000;
/** A meeting left alone is looked at again after this long (its invitees may have changed). */
const RECHECK_SKIPPED_MS = 3600_000;
/** A `checking` claim older than this is from a scan that stopped half way; another scan may take it over. */
const STALE_CLAIM_MS = 15 * 60_000;
/** At most this many organizers per organization per scan (the rest next time, least recently checked first). */
const MAX_ORGANIZERS = 200;
/** At most this many calendar pages (50 events each) per organizer per scan. */
const MAX_PAGES = 5;

/**
 * One `meeting_autorecord` row's status: set by Sidekick, already on, left alone (with a reason), refused, or being
 * checked right now by one scan (`checking`, a claim so two scans running at once never set a meeting twice).
 */
export type AutoRecordStatus = "set" | "already" | "skipped" | "failed" | "checking";

/** The plain message when Microsoft refuses the calendar read or the meeting change (permission not approved). */
export const RECORD_DENIED = `${BRAND.name} can't turn on automatic recording yet. A Microsoft admin of your organization needs to approve the new permissions to read calendars and change Teams meetings (Settings → Microsoft permissions → Approve ${BRAND.name} for your organization), and the Teams application access policy must include ${BRAND.name} (see "Automatic notes" in the help center).`;

/** Whether automatic recording is switched on for this organization (it also needs automatic notes on to run). */
export async function autoRecordOn(orgId: string): Promise<boolean> {
  return Boolean((await get<{ auto_record: number | null }>("SELECT auto_record FROM auto_meetings WHERE org_id = ?", orgId))?.auto_record);
}

/**
 * Turns automatic recording of group meetings on or off for the person's organization (the route checks they're an
 * Org Owner/Admin). On needs automatic notes on first (409 otherwise), and starts a first scan straight away. Off
 * stops Sidekick setting new meetings; meetings it already set keep recording until their organizer changes Meeting
 * options (Sidekick doesn't switch them back, since it can't tell whether the organizer wanted it too). Audited.
 */
export async function setAutoRecord(user: User, enabled: boolean) {
  if (enabled && !(await autoNotesOn(user.org_id))) throw new HttpError(409, "Turn on automatic notes after Teams meetings first. Then you can have group meetings record and transcribe by themselves.");
  const res = await run("UPDATE auto_meetings SET auto_record = ?, auto_record_by = ?, auto_record_at = ? WHERE org_id = ?", enabled ? 1 : 0, user.name, now(), user.org_id);
  if (res.changes !== 1) throw new HttpError(409, "Turn on automatic notes after Teams meetings first.");
  await audit(
    user,
    enabled
      ? "Turned on automatic recording and transcription for groups' scheduled Teams meetings (Teams also saves a video recording)"
      : "Turned off automatic recording and transcription for groups' scheduled Teams meetings",
    "Policy change",
  );
  if (enabled) await requestRecordScan(user.org_id, "on");
}

/**
 * Asks for a scan soon (within the next heartbeat), one that also looks again at meetings it left alone (`recheck`).
 * Check now (`why` "check") runs at most once per organization per minute; turning the switch on (`why` "on", rare
 * and audited) always gets its own scan, even right after a Check now.
 */
export async function requestRecordScan(orgId: string, why: "on" | "check" = "check") {
  const key = why === "on" ? `record:${orgId}:on:${newId()}` : `record:${orgId}:now:${Math.floor(Date.now() / 60_000)}`;
  await enqueue("meetings.record.org", { orgId, payload: { recheck: true }, key });
}

/**
 * Every organization with automatic notes and automatic recording both on, not suspended. None when this server has
 * no Microsoft app set up (a laptop or the demo world), so nothing tries to reach Microsoft.
 */
export async function autoRecordOrgs(): Promise<string[]> {
  if (!entraConfigured()) return [];
  return (await all<{ org_id: string }>(
    "SELECT a.org_id FROM auto_meetings a JOIN orgs o ON o.id = a.org_id WHERE a.enabled = 1 AND a.auto_record = 1 AND o.status <> 'Suspended'",
  )).map((r) => r.org_id);
}

/**
 * The automatic-recording part of the Meetings page status: the switch, who changed it, the last scan and its
 * problem (admins and leads only, `manager`), and upcoming meetings Sidekick turned on in the groups the person may
 * see (`workspaceIds`).
 */
export async function autoRecordStatus(orgId: string, opts: { workspaceIds: string[]; manager: boolean }) {
  const row = await get<{ auto_record: number | null; auto_record_by: string | null; auto_record_at: string | null; record_checked_at: string | null; record_error: string | null }>(
    "SELECT auto_record, auto_record_by, auto_record_at, record_checked_at, record_error FROM auto_meetings WHERE org_id = ?", orgId,
  );
  const allowed = new Set(opts.workspaceIds);
  const rows = await all<{ title: string | null; starts_at: string | null; status: AutoRecordStatus; workspace_id: string | null; name: string | null }>(
    `SELECT r.title, r.starts_at, r.status, r.workspace_id, w.name FROM meeting_autorecord r LEFT JOIN workspaces w ON w.id = r.workspace_id AND w.org_id = r.org_id
      WHERE r.org_id = ? AND r.status IN ('set', 'already') AND r.starts_at >= ? ORDER BY r.starts_at LIMIT 50`,
    orgId, new Date(Date.now() - 3600_000).toISOString(),
  );
  // Upcoming meetings left alone, by reason (no titles are kept for these): admins and leads only.
  const skipped = opts.manager
    ? await all<{ reason: string | null; n: number }>(
      "SELECT reason, COUNT(*) AS n FROM meeting_autorecord WHERE org_id = ? AND status = 'skipped' AND (starts_at IS NULL OR starts_at >= ?) GROUP BY reason ORDER BY reason",
      orgId, new Date().toISOString(),
    )
    : [];
  const failed = opts.manager
    ? await all<{ title: string | null; reason: string | null; workspace_id: string | null }>(
      "SELECT title, reason, workspace_id FROM meeting_autorecord WHERE org_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 10", orgId,
    )
    : [];
  return {
    enabled: Boolean(row?.auto_record),
    changedBy: row?.auto_record_by ?? null,
    changedAt: row?.auto_record_at ?? null,
    lastCheckAt: row?.record_checked_at ?? null,
    lastError: opts.manager ? row?.record_error ?? null : null,
    /** The last error is a Microsoft permission not approved: the page links to Settings → Microsoft permissions. */
    permissionMissing: Boolean(opts.manager && row?.record_error && [RECORD_DENIED, NOT_APPROVED].includes(row.record_error)),
    upcoming: rows
      .filter((r) => r.workspace_id && allowed.has(r.workspace_id))
      .slice(0, 10)
      .map((r) => ({ title: r.title ?? "Teams meeting", startsAt: r.starts_at, status: r.status, group: r.name ?? "" })),
    skipped: skipped.map((r) => ({ reason: r.reason ?? "Left alone.", count: Number(r.n) })),
    failed: failed.filter((r) => !r.workspace_id || allowed.has(r.workspace_id)).map((r) => ({ title: r.title ?? "Teams meeting", reason: r.reason })),
  };
}

/* ------------------------------------------------------------------ */
/* Scanning one organization (job meetings.record.org)                 */
/* ------------------------------------------------------------------ */

/** A calendar event as Sidekick reads it (`$select` keeps it to these). */
type CalendarEvent = {
  subject?: string | null;
  start?: { dateTime?: string; timeZone?: string } | null;
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
  startDateTime?: string | null;
  recordAutomatically?: boolean | null;
  chatInfo?: { threadId?: string | null } | null;
  participants?: {
    organizer?: { identity?: { user?: { id?: string; tenantId?: string } | null } | null } | null;
    attendees?: { identity?: { user?: { id?: string; tenantId?: string } | null; guest?: unknown; phone?: unknown } | null }[];
  } | null;
};

const isOid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
/** Online meeting ids are base64; anything else is refused before it goes into a Graph path. */
const isMeetingId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 512 && /^[\w\-=+/]+$/.test(s);
/** The row key for a meeting: a hash of its join link (the link itself is never stored). */
const joinKey = (url: string) => crypto.createHash("sha256").update(url).digest("hex");
/** A calendar time Graph gave in UTC (asked for with the Prefer header) as an ISO string, or null. */
const utc = (t: CalendarEvent["start"]) => {
  if (!t?.dateTime) return null;
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const cleanTitle = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "Teams meeting";

/**
 * Whether a meeting is clearly one group's, and which: `{ workspaceId }`, or `{ reason }` to leave it alone.
 * Rules (see the file header): nobody from another organization; then the shared group rule (lib/meeting-group.ts
 * `pickGroup`, the same one automatic notes use: linked meeting chat, else most of a group's people, at least two,
 * the organizer breaking a tie); a tie or an unclear meeting is left alone; and, unless the chat decided, the group's
 * people must be at least half of everyone invited (organizer included; people Sidekick doesn't know count against it).
 * `organizerOid` / `attendeeOids` are the meeting's Microsoft account ids (matched by the shared rule, by email through
 * the directory where needed); `knownUserIds` are Sidekick people recognised from the calendar by email (invitees who
 * never signed in with Microsoft and that the meeting doesn't list, as on Oct 25, 2026); `invitedCount` counts
 * everyone invited but the organizer.
 */
export async function decide(
  orgId: string,
  m: { chatId: string | null; organizerOid: string; attendeeOids: string[]; knownUserIds: string[]; invitedCount: number; outsiders: boolean },
): Promise<{ workspaceId: string } | { reason: string }> {
  if (m.outsiders) return { reason: `People from outside your organization are invited. ${BRAND.name} never turns on recording for them.` };
  const picked = await pickGroup(orgId, { chatId: m.chatId, organizerOid: m.organizerOid, attendeeOids: m.attendeeOids, knownUserIds: m.knownUserIds });
  if (!picked) return { reason: "Not a group's meeting (fewer than two of a group's people invited)." };
  if ("candidates" in picked) return { reason: "Several groups' people are invited, so it isn't clearly one group's meeting." };
  if (m.chatId) {
    const linked = await get("SELECT 1 AS ok FROM teams_conversations WHERE id = ? AND org_id = ? AND workspace_id = ?", m.chatId, orgId, picked.workspaceId);
    if (linked) return picked;
  }
  // Not by its chat: most of the meeting must be the group's people. Account ids are read after pickGroup, which
  // may just have linked someone found by email in the directory.
  const oids = [...new Set([m.organizerOid, ...m.attendeeOids].map((o) => o.toLowerCase()))];
  const ids = [...new Set(m.knownUserIds)];
  const inGroup = await get<{ n: number }>(
    `SELECT COUNT(DISTINCT u.id) AS n FROM users u JOIN workspace_members wm ON wm.user_id = u.id
      WHERE wm.workspace_id = ? AND u.org_id = ?
        AND (LOWER(u.entra_oid) IN (${oids.map(() => "?").join(", ")})${ids.length ? ` OR u.id IN (${ids.map(() => "?").join(", ")})` : ""})`,
    picked.workspaceId, orgId, ...oids, ...ids,
  );
  const total = Math.max(m.invitedCount + 1, new Set([...oids, ...ids]).size);
  if (Number(inGroup?.n ?? 0) * 2 < total) return { reason: "Fewer than half of the people invited are in the group." };
  return picked;
}

/** Records what Sidekick did with one meeting (upsert by join link). Titles are kept only for set meetings. */
async function saveRow(orgId: string, key: string, r: { meetingId?: string | null; organizer: string; workspaceId?: string | null; status: AutoRecordStatus; reason?: string | null; title?: string | null; startsAt: string | null }) {
  const t = now();
  const keepTitle = r.status === "set" || r.status === "already" || r.status === "failed";
  await run(
    `INSERT INTO meeting_autorecord (org_id, join_key, online_meeting_id, organizer_oid, workspace_id, status, reason, title, starts_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, join_key) DO UPDATE SET online_meeting_id = excluded.online_meeting_id, organizer_oid = excluded.organizer_oid,
       workspace_id = excluded.workspace_id, status = excluded.status, reason = excluded.reason, title = excluded.title,
       starts_at = excluded.starts_at, updated_at = excluded.updated_at`,
    orgId, key, r.meetingId ?? null, r.organizer, r.workspaceId ?? null, r.status, r.reason ?? null, keepTitle ? r.title ?? null : null, r.startsAt, t, t,
  );
}

/** Records how the last scan went (shown to admins and leads on the Meetings page). Never throws. */
async function noteScan(orgId: string, error: string | null) {
  await run("UPDATE auto_meetings SET record_checked_at = ?, record_error = ? WHERE org_id = ?", now(), error ? error.slice(0, 400) : null, orgId)
    .catch((e) => console.error("Couldn't record the automatic recording check", e));
}

/** The organizer's upcoming Teams meetings they organize (calendar view, next 7 days, every page up to MAX_PAGES). */
async function upcomingMeetings(tenant: string, oid: string, at: Date): Promise<{ events: CalendarEvent[]; noLink: number }> {
  const range = `startDateTime=${encodeURIComponent(at.toISOString())}&endDateTime=${encodeURIComponent(new Date(at.getTime() + LOOKAHEAD_MS).toISOString())}`;
  let path: string | null = `/v1.0/users/${oid}/calendarView?${range}&$select=subject,start,organizer,isOrganizer,isCancelled,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,attendees&$top=50`;
  const events: CalendarEvent[] = [];
  let noLink = 0;
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res: { value?: CalendarEvent[]; "@odata.nextLink"?: string } | null = await span("microsoft", "Read upcoming Teams meetings", () =>
      graphCall<{ value?: CalendarEvent[]; "@odata.nextLink"?: string }>(tenant, "GET", path!, { headers: { Prefer: 'outlook.timezone="UTC"' }, deniedMessage: RECORD_DENIED }),
    );
    for (const e of res?.value ?? []) {
      if (!e.isOrganizer || e.isCancelled || !e.isOnlineMeeting || e.onlineMeetingProvider !== "teamsForBusiness") continue;
      if (e.onlineMeeting?.joinUrl) events.push(e);
      else noLink++;
    }
    const next: string | undefined = res?.["@odata.nextLink"];
    path = next ? next.replace(/^https?:\/\/[^/]+/i, "") : null;
  }
  return { events, noLink };
}

/**
 * Looks at the upcoming Teams meetings of the organization's people and turns on automatic recording and
 * transcription for those that are clearly one group's (see the file header), once each. Returns how many it turned
 * on and how many meetings it looked at. A refused permission is recorded for the Meetings page (not retried);
 * throttling and outages throw so the job retries. Called by the `meetings.record.org` job only.
 */
export async function scanOrg(orgId: string, at = new Date(), opts: { recheck?: boolean } = {}): Promise<{ turnedOn: number; checked: number }> {
  if (!entraConfigured() || !(await autoNotesOn(orgId)) || !(await autoRecordOn(orgId))) return { turnedOn: 0, checked: 0 };
  const tenant = await tenantOfOrg(orgId);
  if (!tenant) {
    await noteScan(orgId, `Connect ${BRAND.name} to your Microsoft 365 organization (Settings → Microsoft sign-in) so it can set up your Teams meetings.`);
    return { turnedOn: 0, checked: 0 };
  }
  const organizers = (await all<{ oid: string }>(
    `SELECT DISTINCT LOWER(u.entra_oid) AS oid FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id JOIN workspaces w ON w.id = wm.workspace_id AND w.org_id = u.org_id
      WHERE u.org_id = ? AND u.entra_oid IS NOT NULL AND ${NOT_ENDING} ORDER BY oid`,
    orgId,
  )).map((o) => o.oid).filter(isOid).slice(0, MAX_ORGANIZERS);
  // The organization's people, to match meeting participants (Microsoft account id) and calendar invitees (email).
  const people = await all<{ id: string; email: string; oid: string | null }>("SELECT id, LOWER(email) AS email, LOWER(entra_oid) AS oid FROM users WHERE org_id = ?", orgId);
  const idByEmail = new Map(people.map((p) => [p.email, p.id]));
  const idsByOid = new Map<string, string[]>();
  for (const p of people) if (p.oid) idsByOid.set(p.oid, [...(idsByOid.get(p.oid) ?? []), p.id]);
  const seen = new Set<string>();
  // A forced scan (switch turned on, Check now) looks again at every meeting it left alone.
  const recheckBefore = new Date(opts.recheck ? at.getTime() + 1 : at.getTime() - RECHECK_SKIPPED_MS).toISOString();
  const staleBefore = new Date(at.getTime() - STALE_CLAIM_MS).toISOString();
  let turnedOn = 0;
  let checked = 0;
  let missingLinks = 0;
  try {
    for (const oid of organizers) {
      const { events, noLink } = await upcomingMeetings(tenant, oid, at);
      missingLinks += noLink;
      for (const e of events) {
        const url = e.onlineMeeting!.joinUrl!;
        const key = joinKey(url);
        if (seen.has(key)) continue; // another occurrence of the same series
        seen.add(key);
        // Claim the meeting (new, failed, left alone long enough, or a stale claim): only one scan checks it at a time,
        // and a set or already-on meeting is never claimed again.
        const t = now();
        const claim = await run(
          `INSERT INTO meeting_autorecord (org_id, join_key, organizer_oid, status, created_at, updated_at) VALUES (?, ?, ?, 'checking', ?, ?)
           ON CONFLICT (org_id, join_key) DO UPDATE SET status = 'checking', updated_at = excluded.updated_at
           WHERE meeting_autorecord.status = 'failed'
              OR (meeting_autorecord.status = 'skipped' AND meeting_autorecord.updated_at <= ?)
              OR (meeting_autorecord.status = 'checking' AND meeting_autorecord.updated_at <= ?)`,
          orgId, key, oid, t, t, recheckBefore, staleBefore,
        );
        if (claim.changes !== 1) continue;
        checked++;
        const startsAt = utc(e.start);
        const filter = `JoinWebUrl eq '${url.replace(/'/g, "''")}'`;
        const found = await span("microsoft", "Look up a Teams meeting", () =>
          graphCall<{ value?: OnlineMeeting[] }>(tenant, "GET", `/v1.0/users/${oid}/onlineMeetings?$filter=${encodeURIComponent(filter)}`, { deniedMessage: RECORD_DENIED }),
        );
        const m = found?.value?.[0];
        if (!m || !isMeetingId(m.id)) {
          await saveRow(orgId, key, { organizer: oid, status: "skipped", reason: "Microsoft Teams didn't find this meeting.", startsAt });
          continue;
        }
        // Invitees: the meeting's account ids (matched by the shared rule), plus calendar invitees matched to Sidekick
        // people by email (people who never signed in with Microsoft have no account id in Sidekick, and meetings made
        // in Outlook may list no attendees).
        const attendees = m.participants?.attendees ?? [];
        const outsiders = attendees.some((a) => a.identity?.guest || (a.identity?.user?.tenantId && a.identity.user.tenantId.toLowerCase() !== tenant.toLowerCase()));
        const organizerIds = idsByOid.get(oid) ?? [];
        const organizerEmail = e.organizer?.emailAddress?.address?.toLowerCase() ?? null;
        const calendarInvitees = (e.attendees ?? [])
          .map((a) => (a.type !== "resource" ? a.emailAddress?.address?.toLowerCase() : null))
          .filter((x): x is string => !!x && x !== organizerEmail && !organizerIds.includes(idByEmail.get(x) ?? ""));
        const attendeeOids = [...new Set(attendees.map((a) => a.identity?.user?.id?.toLowerCase()).filter(isOid))].filter((o) => o !== oid);
        const knownUserIds = [...new Set(calendarInvitees.map((x) => idByEmail.get(x)).filter((x): x is string => !!x))];
        // Everyone invited but the organizer, whether Sidekick knows them or not (unknown people count against "most").
        const invitedCount = Math.max(attendeeOids.length, new Set(calendarInvitees).size);
        const verdict = await decide(orgId, { chatId: m.chatInfo?.threadId ?? null, organizerOid: oid, attendeeOids, knownUserIds, invitedCount, outsiders });
        const title = cleanTitle(m.subject ?? e.subject);
        if ("reason" in verdict) {
          await saveRow(orgId, key, { meetingId: m.id, organizer: oid, status: "skipped", reason: verdict.reason, startsAt });
          continue;
        }
        if (m.recordAutomatically) {
          await saveRow(orgId, key, { meetingId: m.id, organizer: oid, workspaceId: verdict.workspaceId, status: "already", title, startsAt });
          continue;
        }
        try {
          await span("microsoft", "Turn on automatic recording for a Teams meeting", () =>
            graphCall(tenant, "PATCH", `/v1.0/users/${oid}/onlineMeetings/${encodeURIComponent(m.id!)}`, { body: { recordAutomatically: true }, deniedMessage: RECORD_DENIED }),
          );
        } catch (err) {
          // Permissions and throttling are the whole scan's problem; anything else is this meeting's (shown, retried next scan).
          if (err instanceof ConsentNeededError || !(err instanceof HttpError) || err.status !== 502) throw err;
          await saveRow(orgId, key, { meetingId: m.id, organizer: oid, workspaceId: verdict.workspaceId, status: "failed", reason: `Microsoft Teams didn't accept the change (${err.message.replace(/\.? Try again in a minute\.$/, "")}). Check that the organizer's Teams meeting policy allows automatic recording (AutoRecording Enabled, cloud recording on).`, title, startsAt });
          continue;
        }
        await saveRow(orgId, key, { meetingId: m.id, organizer: oid, workspaceId: verdict.workspaceId, status: "set", title, startsAt });
        await auditAsSidekick(orgId, `Turned on automatic recording and transcription for the Teams meeting “${title}”${startsAt ? ` (${startsAt.slice(0, 10)})` : ""}`, "Agent action", verdict.workspaceId);
        turnedOn++;
      }
    }
  } catch (e) {
    await noteScan(orgId, e instanceof HttpError ? e.message : `Setting up Teams meetings failed. ${BRAND.name} will try again by itself.`);
    if (e instanceof ConsentNeededError) return { turnedOn, checked };
    throw e;
  }
  await noteScan(orgId, missingLinks
    ? `Microsoft didn't share the join link of ${missingLinks} upcoming Teams meeting${missingLinks === 1 ? "" : "s"}, so ${BRAND.name} couldn't set ${missingLinks === 1 ? "it" : "them"}. A Microsoft admin may need to approve reading calendars (see "Automatic notes" in the help center).`
    : null);
  return { turnedOn, checked };
}
