/**
 * @file Automatic meeting notes: Sidekick notices when a Teams meeting of a group's people ends, downloads its
 * transcript from Microsoft Graph and writes the notes (decisions, action items, open questions, risks) into the
 * right group, then posts them to the group's notes chat in Teams. No bot joins the call: everything comes from
 * the transcript Teams already makes.
 *
 * Concepts
 * - **Automatic notes switch** (`auto_meetings`): off until an Org Owner/Admin turns it on (Meetings page). It
 *   needs the organization connected to its Microsoft tenant (Settings → Microsoft sign-in) and the tenant's
 *   Microsoft admin to approve the transcript permissions (`OnlineMeetingTranscript.Read.All` for scheduled meetings,
 *   `CallTranscripts.Read.All` for calls started with Meet now, plus Teams' application access policy:
 *   docs/RUNBOOKS.md → Automatic meeting notes). Teams must be set to record transcripts.
 * - **Two kinds of Teams call** (`graph_meetings.kind`), found and fetched through different Graph paths:
 *   - `meeting`: a scheduled Teams meeting (an *online meeting*: subject, times, chat and invitees can be read).
 *   - `adhoc`: an *ad hoc call*, e.g. **Meet now** pressed inside a group chat (the main case for teams that work in
 *     group chats). Graph knows only the call id and its transcripts: no subject and no invite list. The chat it was
 *     started from is read out of the transcript id (it embeds the chat's thread id), so a Meet now in a group's
 *     linked chat lands in that group; otherwise the people who spoke (matched by name) count as its people.
 *   Graph files an ad hoc transcript under the person who *started transcription*, so every group member who
 *   signed in with Microsoft is polled. The Graph version for these paths is a setting (`ADHOC_GRAPH_VERSION`).
 *   A missing `CallTranscripts.Read.All` only stops the ad hoc half: scheduled meetings keep working and the
 *   Meetings page asks the admin to approve the new call transcripts permission.
 * - **Two ways to hear about a meeting**, both ending in the same `recordTranscript` (one row per transcript in
 *   `graph_meetings`, so a meeting found both ways is captured once):
 *   1. **Change notifications** (fast): two Graph subscriptions per organization, on
 *      `communications/onlineMeetings/getAllTranscripts` and `communications/adhocCalls/getAllTranscripts`. Graph
 *      POSTs to /api/graph/notifications when a transcript is ready. Graph first checks the address with a **validation token** (echoed back as plain
 *      text), and every notification carries our random **client state**, compared before anything is done.
 *      Subscriptions last at most ~3 days, so a recurring job **renews** them a day ahead and recreates any Graph
 *      dropped (404 on renewal, or a `subscriptionRemoved` lifecycle event at /api/graph/lifecycle).
 *   2. **Polling fallback** (safe): every 15 minutes, for each person in a group who signed in with Microsoft,
 *      Graph's `getAllTranscripts` lists transcripts of meetings they organized, and of ad hoc calls they
 *      started, since the last check (`graph_poll_cursors`; ad hoc calls keep their own cursor, `adhoc:<oid>`, so
 *      calls held before the call permission was approved are still found once it is). Catches anything a
 *      notification missed (and works where Graph can't reach us, e.g. on a laptop).
 * - **Jobs** (lib/jobs.ts, registered in lib/job-kinds.ts), so every step runs once, retries and lands in the
 *   dead-letter list if it keeps failing: `meetings.fetch` (one per transcript: read the meeting, pick the group,
 *   download the transcript, check the plan, save the meeting) then `meetings.notes` (write the notes with Claude
 *   and post them to Teams once). Polling and subscription upkeep are recurring jobs. Payloads hold ids only.
 * - **Which group** (`pickGroup`): the group whose Teams chat is the meeting's own chat (Sidekick added to the
 *   meeting chat and assigned there, or the group chat a Meet now was started from); otherwise the group with the
 *   most of its people in the meeting (organizer, invitees; for an ad hoc call the people who spoke), needing at
 *   least two of them. A tie waits for an Org Owner/Admin or the Team Lead to pick a group
 *   (status `waiting`); a meeting that isn't any group's is skipped and nothing about it is kept but its ids.
 * - **Plan limits**: the meeting's length counts toward the month's meeting hours like an import; over the limit,
 *   paused AI, a read-only plan or a used-up AI credit (long meetings) skip the meeting with a plain reason shown
 *   on the Meetings page and in the audit log. Nothing is ever charged beyond the plan.
 * - **Throttling**: Graph's 429/503 Retry-After is honored: short waits in place, longer ones make the job retry
 *   no sooner than Graph asked (lib/directory.ts `GraphThrottledError`, lib/jobs.ts).
 * - **Walls**: everything is per organization (its own tenant, subscriptions, rows); captured meetings belong to
 *   exactly one group and are seen only through `requireWorkspace` like imported ones.
 *
 * Tests point GRAPH_BASE at a fake Graph (tests/meetings-graph.test.mjs).
 */
import "server-only";
import crypto from "node:crypto";
import { all, get, newId, now, run, tx } from "./db";
import { audit, auditAsSidekick, HttpError, type User } from "./auth";
import { ConsentNeededError, graphCall } from "./directory";
import { entraConfigured } from "./entra";
import { enqueue } from "./jobs";
import { span } from "./trace";
import { tenantOfOrg, portalUrl } from "./tenants";
import { NOT_ENDING, orgAccess } from "./billing";
import { assertCanAdd } from "./limits";
import { transcriptMinutes } from "./plans";
import { creditGate } from "./credit";
import { assertEnabled, FeatureOffError } from "./owner";
import { MAX_TRANSCRIPT_CHARS, vttToTranscript } from "./extract";
import { processMeeting } from "./sidekick";
import { postMeetingNotes } from "./teams/bot";
import { remindAfterMeeting } from "./reminders";
import { BRAND } from "./brand";

/** The Graph resource for every scheduled-meeting transcript in a tenant (one subscription per organization). */
export const TRANSCRIPTS_RESOURCE = "communications/onlineMeetings/getAllTranscripts";
/** The Graph resource for every ad hoc call transcript in a tenant (Meet now; needs `CallTranscripts.Read.All`). */
export const ADHOC_TRANSCRIPTS_RESOURCE = "communications/adhocCalls/getAllTranscripts";
/**
 * The Graph version used for ad hoc call paths: "v1.0" (default) or "beta" (`SIDEKICK_GRAPH_ADHOC_VERSION`).
 * Microsoft documents the adhocCalls APIs in v1.0, but its Teams transcripts overview says ad hoc calls work "only in
 * beta" and its own sample uses beta; this switch lets the live server follow whichever the probe
 * (app/scripts/probe-call-transcripts.mjs) shows actually lists Meet now transcripts, without a code change.
 */
export const ADHOC_GRAPH_VERSION = process.env.SIDEKICK_GRAPH_ADHOC_VERSION === "beta" ? "beta" : "v1.0";
/** Which kind of Teams call a `graph_meetings` row is: a scheduled online meeting, or an ad hoc call (Meet now). */
export type CallKind = "meeting" | "adhoc";
/** How long a new or renewed subscription lasts. Graph allows up to 4,230 minutes for transcripts; stay below. */
const SUBSCRIPTION_MINUTES = 4_200;
/** Renew a subscription once it has less than this left (the hourly upkeep job then has many tries). */
const RENEW_BEFORE_MS = 24 * 3600_000;
/** How far back the first poll looks when automatic notes are switched on. */
const FIRST_POLL_LOOKBACK_MS = 24 * 3600_000;
/** Each poll re-reads this much before the last one (transcripts can appear late); rows are unique, so no duplicates. */
const POLL_OVERLAP_MS = 30 * 60_000;
/** At most this many organizers per organization per poll (the rest next time, oldest-checked first). */
const MAX_ORGANIZERS_PER_POLL = 200;

/** One `graph_meetings` row. */
export type GraphMeeting = {
  id: string;
  org_id: string;
  /** The online meeting id (kind `meeting`) or the ad hoc call id (kind `adhoc`). */
  online_meeting_id: string;
  kind: CallKind;
  transcript_id: string;
  organizer_oid: string;
  via: "notification" | "poll";
  status: "queued" | "captured" | "done" | "skipped" | "waiting" | "failed";
  reason: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  workspace_id: string | null;
  candidates: string | null;
  meeting_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Sidekick acting on its own in an organization (writes notes for a captured meeting; shown as "Sidekick"). */
const sidekickActor = (orgId: string): User => ({ id: "sidekick", org_id: orgId, name: BRAND.name, email: "", role: "Member", must_change_password: 0 });

/* ------------------------------------------------------------------ */
/* The switch and its status                                           */
/* ------------------------------------------------------------------ */

/** Whether automatic notes are on for this organization. */
export async function autoNotesOn(orgId: string): Promise<boolean> {
  return Boolean((await get<{ enabled: number }>("SELECT enabled FROM auto_meetings WHERE org_id = ?", orgId))?.enabled);
}

/**
 * Turns automatic notes on or off for the person's organization (the route checks they're an Org Owner/Admin).
 * On needs the organization connected to Microsoft (409 otherwise). Turning on starts a first check straight
 * away (poll + subscription); turning off removes the subscription (best effort) and stops new captures (meetings
 * already captured stay). Audited.
 */
export async function setAutoNotes(user: User, enabled: boolean) {
  const tenant = await tenantOfOrg(user.org_id);
  if (enabled && !tenant) throw new HttpError(409, `Connect ${BRAND.name} to your Microsoft 365 organization first (Settings → Microsoft sign-in). Then turn on automatic notes.`);
  await run(
    `INSERT INTO auto_meetings (org_id, enabled, changed_by, changed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
    user.org_id, enabled ? 1 : 0, user.name, now(),
  );
  await audit(user, enabled ? "Turned on automatic notes after Teams meetings" : "Turned off automatic notes after Teams meetings", "Policy change");
  if (enabled) {
    await requestCheck(user.org_id);
  } else {
    await enqueue("meetings.subscription", { orgId: user.org_id, key: `subscription:${user.org_id}:off:${newId()}` });
  }
}

/**
 * Asks for a check soon (within the next heartbeat): a poll and a subscription upkeep for this organization. At
 * most one waiting request per organization per minute ("Check now" pressed twice runs once).
 */
export async function requestCheck(orgId: string) {
  const minute = Math.floor(Date.now() / 60_000);
  await enqueue("meetings.subscription", { orgId, key: `subscription:${orgId}:now:${minute}` });
  await enqueue("meetings.poll.org", { orgId, key: `poll:${orgId}:now:${minute}` });
}

/** Records how the last Graph check went for the organization (shown on the Meetings page). Never throws. */
async function noteCheck(orgId: string, error: string | null) {
  const t = now();
  await run(
    error
      ? "UPDATE auto_meetings SET last_poll_at = ?, last_error = ?, last_error_at = ? WHERE org_id = ?"
      : "UPDATE auto_meetings SET last_poll_at = ?, last_ok_at = ?, last_error = NULL WHERE org_id = ?",
    ...(error ? [t, error.slice(0, 400), t, orgId] : [t, t, orgId]),
  ).catch((e) => console.error("Couldn't record the meetings check", e));
}

/** A failure as a plain sentence for the Meetings page (consent, throttling and Graph errors already are). */
const plainError = (e: unknown) => (e instanceof HttpError ? e.message : `Checking Microsoft Teams for meetings failed. ${BRAND.name} will try again by itself.`);

/**
 * The automatic-notes status for the Meetings page: the switch, whether Microsoft is connected, the subscription,
 * the last check, and recent captured meetings (only in `workspaceIds`: the groups the person may see; waiting
 * and skipped ones only for those who may pick a group, `manager`).
 */
export async function autoNotesStatus(orgId: string, opts: { workspaceIds: string[]; manager: boolean }) {
  const row = await get<{ enabled: number; changed_by: string | null; changed_at: string | null; last_poll_at: string | null; last_ok_at: string | null; last_error: string | null; last_error_at: string | null }>(
    "SELECT enabled, changed_by, changed_at, last_poll_at, last_ok_at, last_error, last_error_at FROM auto_meetings WHERE org_id = ?", orgId,
  );
  const sub = await get<{ expires_at: string }>("SELECT expires_at FROM graph_subscriptions WHERE org_id = ? ORDER BY expires_at DESC LIMIT 1", orgId);
  const rows = await all<GraphMeeting>(
    "SELECT * FROM graph_meetings WHERE org_id = ? AND status IN ('captured', 'done', 'waiting', 'skipped', 'failed') AND title IS NOT NULL ORDER BY created_at DESC LIMIT 100",
    orgId,
  );
  const allowed = new Set(opts.workspaceIds);
  const names = new Map((await all<{ id: string; name: string }>("SELECT id, name FROM workspaces WHERE org_id = ?", orgId)).map((w) => [w.id, w.name]));
  const recent = rows
    .filter((r) => (r.workspace_id ? allowed.has(r.workspace_id) : opts.manager))
    .filter((r) => opts.manager || r.status === "captured" || r.status === "done")
    .slice(0, 30)
    .map((r) => {
      const candidates = (JSON.parse(r.candidates ?? "[]") as string[]).filter((id) => allowed.has(id));
      return {
        id: r.id, title: r.title, status: r.status, reason: r.reason, startedAt: r.started_at, endedAt: r.ended_at, via: r.via,
        workspace: r.workspace_id ? { id: r.workspace_id, name: names.get(r.workspace_id) ?? "" } : null,
        meetingId: r.meeting_id,
        candidates: candidates.map((id) => ({ id, name: names.get(id) ?? "" })),
      };
    })
    // A waiting meeting is only shown to someone who can pick at least one of its groups.
    .filter((r) => r.status !== "waiting" || r.candidates.length);
  return {
    enabled: Boolean(row?.enabled),
    connected: Boolean(await tenantOfOrg(orgId)),
    changedBy: row?.changed_by ?? null,
    changedAt: row?.changed_at ?? null,
    lastCheckAt: row?.last_poll_at ?? null,
    lastOkAt: row?.last_ok_at ?? null,
    lastError: row?.last_error ?? null,
    instant: Boolean(sub && sub.expires_at > now()),
    recent,
  };
}

/* ------------------------------------------------------------------ */
/* Recording a transcript (from a notification or a poll)              */
/* ------------------------------------------------------------------ */

/**
 * The organizer's Microsoft account id and the meeting chat's thread id, read from an online meeting id. Teams
 * meeting ids are base64 of "1*<organizer id>*0**<meeting chat thread id>"; anything else gives nulls.
 */
export function decodeMeetingId(meetingId: string): { organizerOid: string | null; threadId: string | null } {
  try {
    const parts = Buffer.from(meetingId, "base64").toString("utf8").split("*");
    const oid = parts[1] ?? "";
    const thread = parts[4] ?? "";
    return { organizerOid: /^[0-9a-f-]{36}$/i.test(oid) ? oid.toLowerCase() : null, threadId: /^19:[\w.@:-]+$/.test(thread) ? thread : null };
  } catch {
    return { organizerOid: null, threadId: null };
  }
}

/**
 * The chat thread id an ad hoc call's transcript id carries, or null. Ad hoc transcript ids are base64 of a few
 * bytes, then "19:<chat>@thread.v2" (group chats; "@unq.gbl.spaces" for one-to-one chats), then "#<call id>-…".
 * Used to tell which Teams chat a Meet now call was started from (Graph's ad hoc call has no chat field).
 */
export function decodeTranscriptThread(transcriptId: string): string | null {
  try {
    const text = Buffer.from(transcriptId, "base64").toString("latin1");
    const m = /19:[\w.:-]+?@(?:thread\.v2|thread\.skype|unq\.gbl\.spaces)/.exec(text);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * Graph ids are base64 (with "/" possible in transcript ids) or GUIDs; anything else (quotes, spaces, very long) is
 * refused before it's stored. Ids are always URL-encoded when put in a Graph path.
 */
const isGraphId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 512 && /^[\w\-=+./]+$/.test(s);
/** Microsoft account ids are GUIDs. */
const isOid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * Notes that a transcript exists for a meeting or ad hoc call and queues its `meetings.fetch` job, once per
 * transcript per organization (the row is unique and the job key is the transcript id). Only ids are stored at
 * this point. `meetingId` is the online meeting id, or the call id when `kind` is `adhoc` (then `organizerOid`,
 * the person who started the call, is required: a call id doesn't contain it). Returns true when it was new.
 * Ignored when automatic notes are off. Called by notifications and polling only.
 */
export async function recordTranscript(orgId: string, t: { meetingId: string; transcriptId: string; organizerOid?: string | null; via: "notification" | "poll"; kind?: CallKind }): Promise<boolean> {
  const kind: CallKind = t.kind === "adhoc" ? "adhoc" : "meeting";
  if (!isGraphId(t.meetingId) || !isGraphId(t.transcriptId)) return false;
  if (!(await autoNotesOn(orgId))) return false;
  const organizer = isOid(t.organizerOid) ? t.organizerOid.toLowerCase() : kind === "meeting" ? decodeMeetingId(t.meetingId).organizerOid : null;
  if (!organizer) return false;
  const id = newId();
  const res = await run(
    `INSERT INTO graph_meetings (id, org_id, online_meeting_id, kind, transcript_id, organizer_oid, via, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (org_id, transcript_id) DO NOTHING`,
    id, orgId, t.meetingId, kind, t.transcriptId, organizer, t.via, now(), now(),
  );
  if (!res.changes) return false;
  await enqueue("meetings.fetch", { orgId, payload: { id }, key: `meeting-fetch:${orgId}:${t.transcriptId}` });
  return true;
}

/* ------------------------------------------------------------------ */
/* Change notifications (POST /api/graph/notifications and /lifecycle) */
/* ------------------------------------------------------------------ */

/** Compares two secrets without leaking their content through timing. */
const sameSecret = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

/** The subscription a notification names, if its client state matches ours. Anything else is ignored. */
async function trustedSubscription(n: { subscriptionId?: unknown; clientState?: unknown }) {
  if (typeof n.subscriptionId !== "string" || typeof n.clientState !== "string" || n.subscriptionId.length > 100) return null;
  const sub = await get<{ id: string; org_id: string; client_state: string }>("SELECT id, org_id, client_state FROM graph_subscriptions WHERE id = ?", n.subscriptionId);
  return sub && sameSecret(sub.client_state, n.clientState) ? sub : null;
}

/**
 * The meeting (or call), transcript and (when present) organizer ids in a notification's resource path, and which
 * kind it is. Graph writes both `onlineMeetings('…')/transcripts('…')` and `adhocCalls/…/transcripts/…` styles
 * (and `adhoccalls` in lower case), so all are accepted.
 */
export function parseTranscriptResource(resource: unknown): { meetingId: string; transcriptId: string; organizerOid: string | null; kind: CallKind } | null {
  if (typeof resource !== "string" || resource.length > 2000) return null;
  const ids = (name: string) =>
    new RegExp(`${name}\\('([^']+)'\\)\\/transcripts\\('([^']+)'\\)`, "i").exec(resource) ??
    new RegExp(`${name}\\/([^/(]+)\\/transcripts\\('([^']+)'\\)`, "i").exec(resource) ??
    new RegExp(`${name}\\('([^']+)'\\)\\/transcripts\\/([^/?(]+)`, "i").exec(resource) ??
    new RegExp(`${name}\\/([^/(]+)\\/transcripts\\/([^/?(]+)`, "i").exec(resource);
  const meeting = ids("onlineMeetings");
  const adhoc = meeting ? null : ids("adhocCalls");
  const m = meeting ?? adhoc;
  if (!m) return null;
  const user = /users\('([^']+)'\)/i.exec(resource) ?? /users\/([^/]+)\//i.exec(resource);
  return { meetingId: m[1], transcriptId: m[2], organizerOid: user && isOid(user[1]) ? user[1] : null, kind: adhoc ? "adhoc" : "meeting" };
}

/**
 * Handles a batch of transcript notifications from Graph. Each one must name a subscription we made and carry its
 * client state; the transcript is then recorded (and its fetch job queued). Never throws for a bad item, so one
 * odd notification can't make Graph resend the whole batch. Returns counts for the trace.
 */
export async function handleNotifications(body: unknown): Promise<{ accepted: number; ignored: number }> {
  const items = Array.isArray((body as { value?: unknown })?.value) ? ((body as { value: unknown[] }).value).slice(0, 200) : [];
  let accepted = 0;
  let ignored = 0;
  for (const raw of items) {
    const n = (raw ?? {}) as { subscriptionId?: unknown; clientState?: unknown; resource?: unknown };
    const sub = await trustedSubscription(n);
    const ids = sub ? parseTranscriptResource(n.resource) : null;
    if (!sub || !ids) {
      ignored++;
      continue;
    }
    if (await recordTranscript(sub.org_id, { ...ids, via: "notification" })) accepted++;
  }
  return { accepted, ignored };
}

/**
 * Handles Graph's lifecycle notifications for our subscriptions: `reauthorizationRequired` (renew it now),
 * `subscriptionRemoved` (forget it and make a new one) and `missed` (some notifications were dropped: poll now).
 * Same client-state check as notifications.
 */
export async function handleLifecycle(body: unknown): Promise<{ handled: number; ignored: number }> {
  const items = Array.isArray((body as { value?: unknown })?.value) ? ((body as { value: unknown[] }).value).slice(0, 200) : [];
  let handled = 0;
  let ignored = 0;
  for (const raw of items) {
    const n = (raw ?? {}) as { subscriptionId?: unknown; clientState?: unknown; lifecycleEvent?: unknown };
    const sub = await trustedSubscription(n);
    if (!sub) {
      ignored++;
      continue;
    }
    const slot = Math.floor(Date.now() / 60_000);
    if (n.lifecycleEvent === "subscriptionRemoved") {
      await run("DELETE FROM graph_subscriptions WHERE id = ?", sub.id);
      await enqueue("meetings.subscription", { orgId: sub.org_id, key: `subscription:${sub.org_id}:removed:${slot}` });
    } else if (n.lifecycleEvent === "reauthorizationRequired") {
      await run("UPDATE graph_subscriptions SET expires_at = ? WHERE id = ?", new Date(0).toISOString(), sub.id);
      await enqueue("meetings.subscription", { orgId: sub.org_id, key: `subscription:${sub.org_id}:reauth:${slot}` });
    } else if (n.lifecycleEvent === "missed") {
      await enqueue("meetings.poll.org", { orgId: sub.org_id, key: `poll:${sub.org_id}:missed:${slot}` });
    } else {
      ignored++;
      continue;
    }
    handled++;
  }
  return { handled, ignored };
}

/**
 * Graph's validation handshake: when a subscription is made, Graph calls the notification address with
 * `?validationToken=…` and expects it back as plain text within 10 seconds. Returns that response, or null when
 * the request isn't a validation. The token is only echoed as text/plain (never HTML) and is length-capped.
 */
export function validationResponse(req: Request): Response | null {
  const token = new URL(req.url).searchParams.get("validationToken");
  if (token === null) return null;
  if (token.length > 2048) return new Response("Bad validation token", { status: 400 });
  return new Response(token, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
}

/* ------------------------------------------------------------------ */
/* Subscription upkeep (job meetings.subscription)                     */
/* ------------------------------------------------------------------ */

/**
 * Where Graph should send notifications, or null when this server can't receive them (no public address set:
 * then polling alone does the work). Graph needs https; plain http is accepted only outside production (tests).
 */
export function notificationBase(): string | null {
  const url = process.env.SIDEKICK_PUBLIC_URL;
  if (!url) return null;
  if (!url.startsWith("https://") && process.env.NODE_ENV === "production") return null;
  return portalUrl("");
}

/** The transcript subscriptions Sidekick keeps per organization, and the refusal message for each. */
const SUBSCRIBED: { resource: string; denied: () => string }[] = [
  { resource: TRANSCRIPTS_RESOURCE, denied: () => TRANSCRIPT_DENIED },
  { resource: ADHOC_TRANSCRIPTS_RESOURCE, denied: () => ADHOC_DENIED },
];

/**
 * Keeps one live subscription per transcript resource (scheduled meetings, ad hoc calls) for the organization
 * while automatic notes are on: renews one when it has less than a day left (a 404 means Graph dropped it: a new
 * one is made), creates one when there's none, and deletes them when the switch is off. Each resource is handled
 * on its own, so a missing call transcripts permission never stops the scheduled-meeting subscription. Returns
 * what it did. Consent problems are recorded for the Meetings page and don't fail the job (polling reports the
 * same); throttling and network errors do (retried). Called by the `meetings.subscription` job only.
 */
export async function ensureSubscription(orgId: string, at = new Date()): Promise<{ created: number; renewed: number; removed: number }> {
  const out = { created: 0, renewed: 0, removed: 0 };
  // No Microsoft app on this server (a laptop or the demo world): nothing to talk to.
  if (!entraConfigured()) return out;
  const on = await autoNotesOn(orgId);
  const tenant = await tenantOfOrg(orgId);
  const subs = await all<{ id: string; tenant_id: string; resource: string; expires_at: string }>("SELECT id, tenant_id, resource, expires_at FROM graph_subscriptions WHERE org_id = ?", orgId);
  const base = notificationBase();
  // Off, disconnected from Microsoft, moved to another tenant, or a resource no longer used: remove (best effort).
  for (const s of subs) {
    if (on && tenant === s.tenant_id && base && SUBSCRIBED.some((r) => r.resource === s.resource)) continue;
    await span("microsoft", "Remove a Microsoft Graph subscription", () => graphCall(s.tenant_id, "DELETE", `/v1.0/subscriptions/${encodeURIComponent(s.id)}`)).catch((e) => console.error("Couldn't remove the Graph subscription", e));
    await run("DELETE FROM graph_subscriptions WHERE id = ?", s.id);
    out.removed++;
  }
  if (!on || !tenant || !base) return out;
  const expiry = new Date(at.getTime() + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  let denied: string | null = null;
  for (const { resource, denied: deniedMessage } of SUBSCRIBED) {
    try {
      const done = await keepSubscription(orgId, tenant, resource, deniedMessage(), subs.filter((s) => s.tenant_id === tenant && s.resource === resource), base, expiry, at);
      if (done === "renewed") out.renewed++;
      if (done === "created") out.created++;
    } catch (e) {
      if (!(e instanceof ConsentNeededError)) throw e;
      // The first refusal is the one to fix first (scheduled meetings come before ad hoc calls).
      denied ??= e.message;
    }
  }
  if (denied) await noteCheck(orgId, denied);
  return out;
}

/** Renews or creates the organization's subscription on one transcript resource; "kept" when nothing was due. */
async function keepSubscription(
  orgId: string, tenant: string, resource: string, deniedMessage: string,
  live: { id: string; expires_at: string }[], base: string, expiry: string, at: Date,
): Promise<"kept" | "renewed" | "created"> {
  for (const s of live) {
    if (new Date(s.expires_at).getTime() - at.getTime() > RENEW_BEFORE_MS) return "kept";
    const renewed = await span("microsoft", "Renew the Microsoft Graph subscription", () =>
      graphCall<{ expirationDateTime?: string }>(tenant, "PATCH", `/v1.0/subscriptions/${encodeURIComponent(s.id)}`, { body: { expirationDateTime: expiry }, deniedMessage, deniedCodes: TRANSCRIPT_DENIED_CODES }),
    );
    if (renewed) {
      await run("UPDATE graph_subscriptions SET expires_at = ?, renewed_at = ? WHERE id = ?", renewed.expirationDateTime ?? expiry, now(), s.id);
      return "renewed";
    }
    // 404: Graph no longer has it (expired or removed). Make a new one below.
    await run("DELETE FROM graph_subscriptions WHERE id = ?", s.id);
  }
  const clientState = crypto.randomBytes(32).toString("base64url");
  const made = await span("microsoft", "Create a Microsoft Graph subscription", () =>
    graphCall<{ id?: string; expirationDateTime?: string }>(tenant, "POST", "/v1.0/subscriptions", {
      body: {
        changeType: "created",
        notificationUrl: `${base}/api/graph/notifications`,
        lifecycleNotificationUrl: `${base}/api/graph/lifecycle`,
        resource,
        expirationDateTime: expiry,
        clientState,
        latestSupportedTlsVersion: "v1_2",
      },
      deniedMessage, deniedCodes: TRANSCRIPT_DENIED_CODES,
    }), { resource: resource === ADHOC_TRANSCRIPTS_RESOURCE ? "adhoc" : "meeting" },
  );
  if (!made?.id || !isGraphId(made.id)) throw new HttpError(502, "Microsoft Graph didn't confirm the meeting subscription.");
  await run(
    "INSERT INTO graph_subscriptions (id, org_id, tenant_id, resource, client_state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    made.id, orgId, tenant, resource, clientState, made.expirationDateTime ?? expiry, now(),
  );
  return "created";
}

/** The plain message when Microsoft refuses transcript access (consent or Teams' access policy missing). */
export const TRANSCRIPT_DENIED = `${BRAND.name} can't read your Teams meeting transcripts yet. A Microsoft admin of your organization needs to approve the meeting transcripts permission and allow ${BRAND.name} in Teams (see "Automatic notes" in the help center).`;

/**
 * The plain message when Microsoft refuses ad hoc call transcripts (Meet now) while scheduled meetings may work: the
 * tenant approved Sidekick before `CallTranscripts.Read.All` was added, so its Microsoft admin approves again.
 */
export const ADHOC_DENIED = `${BRAND.name} can't read transcripts of Teams calls started with Meet now (for example in a group chat) yet. A Microsoft admin of your organization needs to approve the new call transcripts permission (Users & access → Approve ${BRAND.name} for your organization). Scheduled Teams meetings aren't affected.`;

/**
 * Messages for Graph refusals that need a tenant switch rather than a permission: since Microsoft's 2026 change,
 * Teams' **Transcript API access** (`EnableGraphTranscriptAccess`) is off by default and Graph answers 403
 * `GraphAccessToTranscriptsDisabled` even with every permission approved. Speaker names
 * (`EnableAttributedTranscripts`) are a second switch. Fix: docs/RUNBOOKS.md → Automatic meeting notes, step 3 + 4.
 */
export const TRANSCRIPT_DENIED_CODES: Record<string, string> = {
  GraphAccessToTranscriptsDisabled: `Microsoft Teams in your organization doesn't let apps read meeting transcripts yet. A Teams admin needs to turn on "Transcript API access" (Microsoft Graph access) in the Teams meeting settings, or run Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true (see "Automatic notes" in the help center).`,
  SpeakerAttributionNotAllowed: `Microsoft Teams in your organization doesn't share speaker names in meeting transcripts yet. A Teams admin needs to run Set-CsTeamsMeetingConfiguration -EnableAttributedTranscripts $true (see "Automatic notes" in the help center).`,
};

/* ------------------------------------------------------------------ */
/* Polling fallback (job meetings.poll.org)                            */
/* ------------------------------------------------------------------ */

/** A transcript as Graph lists it (`callId` is set for ad hoc calls, whose `meetingId` is null). */
type GraphTranscript = { id?: string; meetingId?: string | null; callId?: string | null; createdDateTime?: string; endDateTime?: string; meetingOrganizer?: { user?: { id?: string } } };

/** The cursor key for one organizer's ad hoc calls in `graph_poll_cursors` (scheduled meetings use the bare oid). */
const adhocCursor = (oid: string) => `adhoc:${oid}`;

/**
 * Lists every page of one `getAllTranscripts` address and records each transcript. Next pages come as full Graph
 * addresses; only the path is used, always against Graph itself. Returns how many were new.
 */
async function listTranscripts(orgId: string, tenant: string, first: string, kind: CallKind, organizer: string, deniedMessage: string): Promise<number> {
  let found = 0;
  let path: string | null = first;
  for (let page = 0; path && page < 20; page++) {
    const res: { value?: GraphTranscript[]; "@odata.nextLink"?: string } | null = await span("microsoft", kind === "adhoc" ? "List Teams call transcripts" : "List Teams meeting transcripts", () =>
      graphCall<{ value?: GraphTranscript[]; "@odata.nextLink"?: string }>(tenant, "GET", path!, { deniedMessage, deniedCodes: TRANSCRIPT_DENIED_CODES }),
    );
    for (const t of res?.value ?? []) {
      const meetingId = kind === "adhoc" ? t.callId : t.meetingId;
      if (t.id && meetingId && (await recordTranscript(orgId, { meetingId, transcriptId: t.id, organizerOid: t.meetingOrganizer?.user?.id ?? organizer, via: "poll", kind }))) found++;
    }
    const next: string | undefined = res?.["@odata.nextLink"];
    path = next ? next.replace(/^https?:\/\/[^/]+/i, "") : null;
  }
  return found;
}

/**
 * Asks Graph for transcripts of meetings organized, and ad hoc calls (Meet now) started, by the organization's
 * people (everyone in a group who has signed in with Microsoft) since the last poll, and records each one.
 * Progress is saved per organizer and kind, so a throttled run picks up where it stopped. When Microsoft refuses
 * the ad hoc calls (call transcripts permission not approved yet) the scheduled meetings are still polled, the
 * Meetings page says what to approve, and the ad hoc cursor stays put so those calls are found once approved.
 * Returns how many new transcripts it found and how many people it checked. Called by `meetings.poll.org` only.
 */
export async function pollOrg(orgId: string, at = new Date()): Promise<{ found: number; organizers: number }> {
  if (!entraConfigured() || !(await autoNotesOn(orgId))) return { found: 0, organizers: 0 };
  const tenant = await tenantOfOrg(orgId);
  if (!tenant) {
    await noteCheck(orgId, `Connect ${BRAND.name} to your Microsoft 365 organization (Settings → Microsoft sign-in) so it can find your Teams meetings.`);
    return { found: 0, organizers: 0 };
  }
  const since = (await get<{ changed_at: string | null }>("SELECT changed_at FROM auto_meetings WHERE org_id = ?", orgId))?.changed_at;
  const organizers = await all<{ oid: string; polled_until: string | null }>(
    `SELECT DISTINCT LOWER(u.entra_oid) AS oid, c.polled_until FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id JOIN workspaces w ON w.id = wm.workspace_id AND w.org_id = u.org_id
       LEFT JOIN graph_poll_cursors c ON c.org_id = u.org_id AND c.organizer_oid = LOWER(u.entra_oid)
      WHERE u.org_id = ? AND u.entra_oid IS NOT NULL AND ${NOT_ENDING}
      ORDER BY c.polled_until`,
    orgId,
  );
  const adhocCursors = new Map((await all<{ organizer_oid: string; polled_until: string }>(
    "SELECT organizer_oid, polled_until FROM graph_poll_cursors WHERE org_id = ? AND organizer_oid LIKE 'adhoc:%'", orgId,
  )).map((c) => [c.organizer_oid, c.polled_until]));
  const saveCursor = (key: string, to: string) => run(
    `INSERT INTO graph_poll_cursors (org_id, organizer_oid, polled_until) VALUES (?, ?, ?)
     ON CONFLICT (org_id, organizer_oid) DO UPDATE SET polled_until = excluded.polled_until`,
    orgId, key, to,
  );
  const firstFrom = Math.max(new Date(since ?? 0).getTime() - 3600_000, at.getTime() - FIRST_POLL_LOOKBACK_MS);
  const fromCursor = (polledUntil: string | null | undefined) => new Date(polledUntil ? new Date(polledUntil).getTime() - POLL_OVERLAP_MS : firstFrom).toISOString();
  let found = 0;
  let checked = 0;
  let adhocDenied: string | null = null;
  try {
    for (const o of organizers.slice(0, MAX_ORGANIZERS_PER_POLL)) {
      if (!isOid(o.oid)) continue;
      const to = at.toISOString();
      found += await listTranscripts(orgId, tenant, `/v1.0/users/${o.oid}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${o.oid}',startDateTime=${fromCursor(o.polled_until)},endDateTime=${to})`, "meeting", o.oid, TRANSCRIPT_DENIED);
      await saveCursor(o.oid, to);
      if (!adhocDenied) {
        try {
          found += await listTranscripts(orgId, tenant, `/${ADHOC_GRAPH_VERSION}/users/${o.oid}/adhocCalls/getAllTranscripts(userId='${o.oid}',startDateTime=${fromCursor(adhocCursors.get(adhocCursor(o.oid)))},endDateTime=${to})`, "adhoc", o.oid, ADHOC_DENIED);
          await saveCursor(adhocCursor(o.oid), to);
        } catch (e) {
          // Not approved (or Teams' transcript switch off): stop asking about calls this round, keep the meetings.
          if (!(e instanceof ConsentNeededError)) throw e;
          adhocDenied = e.message;
        }
      }
      checked++;
    }
  } catch (e) {
    await noteCheck(orgId, plainError(e));
    // Consent is the admin's to fix: recorded, not retried. Throttling and outages retry (after Retry-After).
    if (e instanceof ConsentNeededError) return { found, organizers: checked };
    throw e;
  }
  await noteCheck(orgId, adhocDenied);
  return { found, organizers: checked };
}

/**
 * Every organization with automatic notes on and not paused (the recurring poll and upkeep fan out to these). None
 * when this server has no Microsoft app set up (a laptop or the demo world), so nothing tries to reach Microsoft.
 */
export async function autoNotesOrgs(): Promise<string[]> {
  if (!entraConfigured()) return [];
  return (await all<{ org_id: string }>("SELECT a.org_id FROM auto_meetings a JOIN orgs o ON o.id = a.org_id WHERE a.enabled = 1 AND o.status <> 'Suspended'")).map((r) => r.org_id);
}

/* ------------------------------------------------------------------ */
/* Which group a meeting belongs to                                    */
/* ------------------------------------------------------------------ */

/**
 * Picks the group a meeting belongs to:
 * 1. the group whose linked Teams chat is the meeting's own chat (`chatId`), if any;
 * 2. otherwise the group with the most of its people in the meeting (organizer and invitees, matched by Microsoft
 *    account id), at least two of them; the organizer counts as a tie-breaker.
 * Groups that are ending are never picked. Returns `{ workspaceId }`, `{ candidates }` (a tie: someone picks), or
 * null (no group's meeting).
 */
export async function pickGroup(orgId: string, m: { chatId: string | null; organizerOid: string; attendeeOids: string[] }): Promise<{ workspaceId: string } | { candidates: string[] } | null> {
  if (m.chatId) {
    const chat = await get<{ workspace_id: string }>(
      `SELECT c.workspace_id FROM teams_conversations c JOIN workspaces w ON w.id = c.workspace_id AND w.org_id = c.org_id
        WHERE c.id = ? AND c.org_id = ? AND ${NOT_ENDING}`,
      m.chatId, orgId,
    );
    if (chat) return { workspaceId: chat.workspace_id };
  }
  const oids = [...new Set([m.organizerOid, ...m.attendeeOids].filter(isOid).map((o) => o.toLowerCase()))].slice(0, 300);
  if (!oids.length) return null;
  const rows = await all<{ workspace_id: string; user_id: string; oid: string }>(
    `SELECT wm.workspace_id, u.id AS user_id, LOWER(u.entra_oid) AS oid FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id JOIN workspaces w ON w.id = wm.workspace_id AND w.org_id = u.org_id
      WHERE u.org_id = ? AND LOWER(u.entra_oid) IN (${oids.map(() => "?").join(", ")}) AND ${NOT_ENDING}`,
    orgId, ...oids,
  );
  const people = new Map<string, Set<string>>();
  const hasOrganizer = new Set<string>();
  for (const r of rows) {
    if (!people.has(r.workspace_id)) people.set(r.workspace_id, new Set());
    people.get(r.workspace_id)!.add(r.user_id);
    if (r.oid === m.organizerOid.toLowerCase()) hasOrganizer.add(r.workspace_id);
  }
  const scored = [...people].filter(([, p]) => p.size >= 2).map(([ws, p]) => ({ ws, score: p.size * 2 + (hasOrganizer.has(ws) ? 1 : 0) }));
  if (!scored.length) return null;
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best).map((s) => s.ws).sort();
  return top.length === 1 ? { workspaceId: top[0] } : { candidates: top };
}

/* ------------------------------------------------------------------ */
/* Fetch a transcript (job meetings.fetch)                             */
/* ------------------------------------------------------------------ */

/** The parts of a Graph online meeting Sidekick reads. */
type GraphOnlineMeeting = {
  subject?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  chatInfo?: { threadId?: string | null } | null;
  participants?: {
    organizer?: { identity?: { user?: { id?: string; tenantId?: string } } } | null;
    attendees?: { identity?: { user?: { id?: string; tenantId?: string } | null; guest?: unknown; phone?: unknown } | null }[];
  } | null;
};

/** Marks a graph_meetings row with a new status (and a plain reason), only from the expected status. */
async function setStatus(id: string, from: GraphMeeting["status"][], to: GraphMeeting["status"], fields: Partial<Pick<GraphMeeting, "reason" | "title" | "started_at" | "ended_at" | "workspace_id" | "candidates" | "meeting_id">> = {}) {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  const res = await run(
    `UPDATE graph_meetings SET status = ?, updated_at = ?${keys.map((k) => `, ${k} = ?`).join("")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
    to, now(), ...keys.map((k) => (fields[k] ?? null) as string | null), id, ...from,
  );
  return res.changes === 1;
}

/** "Contoso weekly" as a short, single-line title (meeting subjects can be long or empty). */
const cleanTitle = (s: string | null | undefined, fallback = "Teams meeting") => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || fallback;

/** An ad hoc call's transcript as Graph describes it (its times; the call itself has no subject or invitees). */
type GraphCallTranscript = { createdDateTime?: string | null; endDateTime?: string | null };

/** What `fetchTranscript` needs to know about a meeting or call, whichever kind it is. */
type CallInfo = {
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  /** The Teams chat the meeting or call belongs to (its thread id), if known. */
  chatId: string | null;
  /** Invitees' Microsoft account ids (scheduled meetings); null for ad hoc calls (worked out from the speakers). */
  attendeeOids: string[] | null;
  /** Whether anyone from outside the organization took part (guests, phone, another tenant). */
  guests: boolean;
  /** The Graph path of the transcript (its `/content` is downloaded). */
  transcriptPath: string;
};

/**
 * Reads what Graph knows about a captured row's meeting or call: for a scheduled meeting the online meeting
 * (subject, times, chat, invitees); for an ad hoc call the transcript's own times, the chat its id embeds, and
 * that chat's name as the title ("Wave 2 cutover call") when Sidekick knows the chat. Null when Graph no longer
 * has it (404).
 */
async function readCall(orgId: string, tenant: string, row: GraphMeeting): Promise<CallInfo | null> {
  if (row.kind === "adhoc") {
    const transcriptPath = `/${ADHOC_GRAPH_VERSION}/users/${row.organizer_oid}/adhocCalls/${encodeURIComponent(row.online_meeting_id)}/transcripts/${encodeURIComponent(row.transcript_id)}`;
    const t = await span("microsoft", "Read the Teams call transcript", () => graphCall<GraphCallTranscript>(tenant, "GET", transcriptPath, { deniedMessage: ADHOC_DENIED, deniedCodes: TRANSCRIPT_DENIED_CODES }));
    if (!t) return null;
    const chatId = decodeTranscriptThread(row.transcript_id);
    const chat = chatId ? await get<{ name: string | null }>("SELECT name FROM teams_conversations WHERE id = ? AND org_id = ? AND workspace_id IS NOT NULL", chatId, orgId) : undefined;
    return {
      title: chat?.name ? cleanTitle(`${chat.name} call`) : "Teams call",
      startedAt: t.createdDateTime ?? null, endedAt: t.endDateTime ?? null, chatId, attendeeOids: null,
      // Graph doesn't list an ad hoc call's people, so guests can't be told apart: treated as none.
      guests: false, transcriptPath,
    };
  }
  const base = `/v1.0/users/${row.organizer_oid}/onlineMeetings/${encodeURIComponent(row.online_meeting_id)}`;
  const meeting = await span("microsoft", "Read the Teams meeting", () => graphCall<GraphOnlineMeeting>(tenant, "GET", base, { deniedMessage: TRANSCRIPT_DENIED, deniedCodes: TRANSCRIPT_DENIED_CODES }));
  if (!meeting) return null;
  const attendees = meeting.participants?.attendees ?? [];
  return {
    title: cleanTitle(meeting.subject),
    startedAt: meeting.startDateTime ?? null, endedAt: meeting.endDateTime ?? null,
    chatId: meeting.chatInfo?.threadId ?? decodeMeetingId(row.online_meeting_id).threadId,
    attendeeOids: attendees.map((a) => a.identity?.user?.id ?? "").filter(Boolean),
    // Client guests: anyone from another Microsoft organization (or a guest/phone) in the meeting.
    guests: attendees.some((a) => {
      const u = a.identity?.user;
      return Boolean(a.identity?.guest || a.identity?.phone || (u?.tenantId && u.tenantId.toLowerCase() !== tenant.toLowerCase()));
    }),
    transcriptPath: `${base}/transcripts/${encodeURIComponent(row.transcript_id)}`,
  };
}

/**
 * The Microsoft account ids of the organization's people who spoke in a transcript (WebVTT `<v Name>` voices),
 * matched by their name in Sidekick. A name two people share is left out. Used for ad hoc calls, whose people
 * Graph doesn't list.
 */
export async function speakerOids(orgId: string, vtt: string): Promise<string[]> {
  const names = [...new Set([...vtt.matchAll(/<v\s+([^>]{1,120})>/g)].map((m) => m[1].trim().toLowerCase()).filter(Boolean))].slice(0, 100);
  if (!names.length) return [];
  const rows = await all<{ name: string; oid: string }>(
    `SELECT LOWER(name) AS name, LOWER(entra_oid) AS oid FROM users WHERE org_id = ? AND entra_oid IS NOT NULL AND LOWER(name) IN (${names.map(() => "?").join(", ")})`,
    orgId, ...names,
  );
  const byName = new Map<string, Set<string>>();
  for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? new Set()).add(r.oid));
  return [...byName.values()].filter((oids) => oids.size === 1).map((oids) => [...oids][0]);
}

/**
 * Runs one captured transcript: reads the meeting or ad hoc call (`readCall`), picks the group, downloads the
 * transcript, checks the plan (meeting hours, paused AI, read-only plan, AI credit) and saves it as a meeting in
 * that group (status Processing), then queues `meetings.notes`. For an ad hoc call the group is the linked chat
 * it was started from, else the transcript is downloaded first and its speakers count as the call's people.
 * Safe to run twice: only a `queued` row is worked on, and the switch to `captured` is a compare-and-set. A
 * transcript Graph hasn't finished yet (404) throws, so the job tries again a little later. Returns counts for
 * the job. Called by the `meetings.fetch` job only.
 */
export async function fetchTranscript(orgId: string, rowId: string): Promise<{ captured: number; skipped: number; waiting: number }> {
  const none = { captured: 0, skipped: 0, waiting: 0 };
  const row = await get<GraphMeeting>("SELECT * FROM graph_meetings WHERE id = ? AND org_id = ?", rowId, orgId);
  if (!row) return none;
  // Already captured (a crash after saving): make sure its notes job exists.
  if (row.status === "captured" && row.meeting_id) {
    await enqueue("meetings.notes", { orgId, workspaceId: row.workspace_id, payload: { meetingId: row.meeting_id }, key: `meeting-notes:${row.meeting_id}` });
    return none;
  }
  if (row.status !== "queued") return none;
  const skip = async (reason: string, fields: Parameters<typeof setStatus>[3] = {}) => {
    await setStatus(row.id, ["queued"], "skipped", { reason, ...fields });
    return { ...none, skipped: 1 };
  };
  if (!(await autoNotesOn(orgId))) return skip("Automatic notes were turned off.");
  const tenant = await tenantOfOrg(orgId);
  if (!tenant) return skip(`${BRAND.name} isn't connected to your Microsoft 365 organization any more.`);
  const adhoc = row.kind === "adhoc";
  const call = await readCall(orgId, tenant, row);
  if (!call) return skip(adhoc ? "Microsoft Teams no longer has this call." : "Microsoft Teams no longer has this meeting.");
  const { title } = call;
  const timing = { title, started_at: call.startedAt, ended_at: call.endedAt };

  // The transcript, downloaded once (an ad hoc call may need it to pick the group).
  let vttText: string | null | undefined;
  const download = async () => {
    if (vttText === undefined) {
      vttText = await span("microsoft", adhoc ? "Download the call transcript" : "Download the meeting transcript", () =>
        graphCall<string>(tenant, "GET", `${call.transcriptPath}/content?$format=text/vtt`, { raw: true, deniedMessage: adhoc ? ADHOC_DENIED : TRANSCRIPT_DENIED, deniedCodes: TRANSCRIPT_DENIED_CODES }),
      );
    }
    if (vttText === null) throw new HttpError(503, "The transcript isn't ready in Microsoft Teams yet. It will be fetched again shortly.");
    return vttText;
  };

  // The group: preset by someone who picked it (a waiting meeting), else worked out from the chat and the people.
  let workspaceId = row.workspace_id;
  if (!workspaceId) {
    let picked = await pickGroup(orgId, { chatId: call.chatId, organizerOid: row.organizer_oid, attendeeOids: call.attendeeOids ?? [] });
    // An ad hoc call outside a linked chat: the people who spoke are its people.
    if (!picked && call.attendeeOids === null) picked = await pickGroup(orgId, { chatId: null, organizerOid: row.organizer_oid, attendeeOids: await speakerOids(orgId, await download()) });
    if (!picked) {
      // Not any group's meeting: keep only the ids (no title), so nothing about other people's meetings is stored.
      await setStatus(row.id, ["queued"], "skipped", { reason: adhoc ? "Not a call of one group's people." : "Not a meeting of one group's people." });
      return { ...none, skipped: 1 };
    }
    if ("candidates" in picked) {
      await setStatus(row.id, ["queued"], "waiting", { ...timing, candidates: JSON.stringify(picked.candidates), reason: `People from several groups were in this ${adhoc ? "call" : "meeting"}. Pick the group it belongs to.` });
      return { ...none, waiting: 1 };
    }
    workspaceId = picked.workspaceId;
  }
  const withGroup = { ...timing, workspace_id: workspaceId };

  // The plan: read-only, paused or restricted AI, meeting hours, AI credit (as for an import).
  if ((await orgAccess(orgId)).mode === "read_only") return skip("Your plan is read-only, so no new notes are written.", withGroup);
  try {
    await assertEnabled("extract", orgId);
  } catch (e) {
    // Paused for everyone by the Sidekick team is temporary: try again later. Restricted for this org: skip.
    if (e instanceof FeatureOffError && e.reason === "restricted") return skip("Meeting notes are turned off for your organization.", withGroup);
    throw e;
  }

  const vtt = await download();
  const transcript = (vtt.trimStart().startsWith("WEBVTT") ? vttToTranscript(vtt) : vtt).trim();
  if (!transcript) return skip(`The ${adhoc ? "call" : "meeting"}'s transcript was empty.`, withGroup);
  if (transcript.length > MAX_TRANSCRIPT_CHARS) return skip("The transcript is longer than about five hours of talk, so no notes were written.", withGroup);

  const spanMin = call.startedAt && call.endedAt ? Math.ceil((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 60_000) : NaN;
  const minutes = Number.isFinite(spanMin) && spanMin > 0 && spanMin < 24 * 60 ? spanMin : transcriptMinutes(transcript);
  try {
    await assertCanAdd(orgId, "meetingHours", minutes / 60);
    await creditGate("extract", orgId, { size: transcript.length });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 402 || e instanceof FeatureOffError)) {
      const reason = e.status === 402 ? "This month's meeting hours on your plan are used up." : "This month's AI credit is used up, so long meetings get no notes.";
      await auditAsSidekick(orgId, `Didn't write notes for the Teams meeting “${title}”: ${reason}`, "Agent action", workspaceId);
      return skip(reason, withGroup);
    }
    throw e;
  }

  // A second transcript of the same meeting (transcription stopped and started again) is a part of its own.
  const earlier = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM graph_meetings WHERE org_id = ? AND online_meeting_id = ? AND kind = ? AND meeting_id IS NOT NULL", orgId, row.online_meeting_id, row.kind))?.n ?? 0);
  const meetingTitle = earlier ? `${title} (part ${earlier + 1})` : title;
  const heldAt = (call.startedAt ?? now()).slice(0, 10);
  const meetingId = newId();
  const saved = await tx(async () => {
    if (!(await setStatus(row.id, ["queued"], "captured", { ...withGroup, meeting_id: meetingId, reason: null }))) return false;
    await run(
      `INSERT INTO meetings (id, org_id, workspace_id, title, held_at, external_guests, status, transcript, imported_by, created_at, duration_min, source, graph_meeting_id)
       VALUES (?, ?, ?, ?, ?, ?, 'Processing', ?, ?, ?, ?, 'teams', ?)`,
      meetingId, orgId, workspaceId, meetingTitle, heldAt, call.guests ? 1 : 0, transcript, "Microsoft Teams", now(), minutes, row.id,
    );
    return true;
  });
  if (!saved) return none;
  await auditAsSidekick(orgId, `Captured the Teams ${adhoc ? "call" : "meeting"} “${meetingTitle}” (${minutes} min)`, "Data", workspaceId);
  await enqueue("meetings.notes", { orgId, workspaceId, payload: { meetingId }, key: `meeting-notes:${meetingId}` });
  return { ...none, captured: 1 };
}

/* ------------------------------------------------------------------ */
/* Notes for a captured meeting (job meetings.notes)                   */
/* ------------------------------------------------------------------ */

/**
 * Writes the notes for a captured meeting (Claude, lib/sidekick.ts `processMeeting`) unless they're already
 * written, then posts them once to the group's notes chats in Teams and sends the after-meeting reminders.
 * The post is claimed with `notes_posted_at`, so a retried job never posts twice. A Claude failure throws (the
 * job retries; the meeting shows Failed with Try again meanwhile).
 */
export async function writeNotes(orgId: string, meetingId: string): Promise<{ written: number; posted: number }> {
  const m = await get<{ id: string; status: string; workspace_id: string; graph_meeting_id: string | null }>(
    "SELECT id, status, workspace_id, graph_meeting_id FROM meetings WHERE id = ? AND org_id = ?", meetingId, orgId,
  );
  if (!m) return { written: 0, posted: 0 };
  let written = 0;
  if (m.status !== "Ready") {
    await processMeeting(sidekickActor(orgId), m.id);
    written = 1;
  }
  let posted = 0;
  const claim = await run("UPDATE meetings SET notes_posted_at = ? WHERE id = ? AND org_id = ? AND notes_posted_at IS NULL", now(), m.id, orgId);
  if (claim.changes) {
    posted = await postMeetingNotes(orgId, m.id);
    await remindAfterMeeting(orgId, m.id).catch((e) => console.error("Teams reminders after the meeting failed", e));
  }
  if (m.graph_meeting_id) await setStatus(m.graph_meeting_id, ["captured"], "done");
  return { written, posted };
}

/* ------------------------------------------------------------------ */
/* People picking a group, or trying again                             */
/* ------------------------------------------------------------------ */

/**
 * Someone picks the group for a waiting meeting (`ws` must be one of its candidate groups and one they manage:
 * the route checks `requireManage`), or asks to try a skipped/failed one again (Org Owners/Admins). The row goes
 * back to `queued` and a fresh fetch job is queued. Audited.
 */
export async function retryCapture(user: User, id: unknown, workspaceId: string | null): Promise<void> {
  const row = typeof id === "string" ? await get<GraphMeeting>("SELECT * FROM graph_meetings WHERE id = ? AND org_id = ?", id, user.org_id) : undefined;
  if (!row || !row.title) throw new HttpError(404, "Meeting not found.");
  if (workspaceId) {
    if (!(JSON.parse(row.candidates ?? "[]") as string[]).includes(workspaceId)) throw new HttpError(400, "Pick one of the groups shown for this meeting.");
    // The candidates stay on the row, so a second pick is told it was already picked.
    if (!(await setStatus(row.id, ["waiting"], "queued", { workspace_id: workspaceId, reason: null }))) throw new HttpError(409, "Someone already picked a group for this meeting.");
    await audit(user, `Picked the group for the Teams meeting “${row.title}”`, "Data", workspaceId);
  } else {
    if (row.status !== "skipped" && row.status !== "failed") throw new HttpError(400, "Only a skipped or failed meeting can be tried again.");
    if (!(await setStatus(row.id, ["skipped", "failed"], "queued", { reason: null }))) throw new HttpError(409, "This meeting is already being tried again.");
    await audit(user, `Asked ${BRAND.name} to try the Teams meeting “${row.title}” again`, "Data", row.workspace_id);
  }
  await enqueue("meetings.fetch", { orgId: user.org_id, payload: { id: row.id }, key: `meeting-fetch:${user.org_id}:${row.transcript_id}:${newId()}` });
}

/**
 * Called when a `meetings.fetch` job is dead (every attempt failed): the row shows Failed with the reason, so an
 * admin can try again from the Meetings page.
 */
export async function markFetchFailed(orgId: string, rowId: string, error: unknown) {
  await run(
    "UPDATE graph_meetings SET status = 'failed', reason = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'queued'",
    plainError(error).slice(0, 300), now(), rowId, orgId,
  );
}
