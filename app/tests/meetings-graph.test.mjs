/**
 * End-to-end tests for the meetings wave (lib/meetings-graph.ts, lib/saved-items.ts, lib/teams/tab.ts): a copy of the
 * app in multi-tenant mode with a **fake Microsoft Graph**. Covers:
 * - turning automatic notes on (admins only; needs Microsoft connected), the consent-needed message;
 * - the Graph subscription: created with the validation-token handshake, renewed before it runs out, recreated when
 *   Graph forgot it (404) or dropped it (lifecycle `subscriptionRemoved`), removed when switched off;
 * - change notifications: client-state check (forged ones ignored), the transcript captured into the right group
 *   once (a later poll of the same transcript doesn't duplicate it), notes written and posted to the group's notes
 *   chat as a card with "Save to knowledge";
 * - polling fallback (getAllTranscripts) with a cursor per organizer;
 * - Meet now (ad hoc calls): refused until the call transcripts permission is approved (plain message, scheduled
 *   meetings unaffected), then found by polling and notifications, landing in the group of the chat it was started
 *   from (or of the people who spoke) and posted once;
 * - throttling: a short Retry-After waited in place, a long one making the job wait at least that long;
 * - which group: most people, a tie waiting for a lead to pick (only their own group), a meeting of nobody's group
 *   skipped without keeping its title, meeting hours over the plan skipped with the reason; people added by email
 *   recognised through the fake directory (`/users/{id}`, `/users/{email}`; never a guest or another tenant); a
 *   meeting with too few known people waiting, then picked, with **Add to group** for its newcomers (roles, walls,
 *   seats); the title hint (client name or engagement code, whole words);
 * - the notes prompt: commitments however phrased become action items (fake Claude `__COMMITMENTS__`);
 * - "Save to knowledge" from the card and the portal (roles, walls, search source);
 * - the Teams tab with Teams single sign-on (token checks, walls, actions) and its framing headers;
 * - meetings that record by themselves (lib/auto-record.ts): off by default, admins only, needs automatic notes on;
 *   refused until the calendar/meeting-change permissions are approved (said plainly); then the organizer's calendar
 *   is read, each meeting looked up by its join link and patched with recordAutomatically once (a recurring series
 *   once), only when clearly one group's (meeting chat linked, or most invitees), never with outsiders; a change
 *   Teams refuses is listed; an organizer switching it off again is left alone; skipped ones looked at again after a
 *   day; the group's people see their own upcoming meetings; switched off means no calendar reads;
 * - "Is this meeting being transcribed?" for scheduled meetings (lib/meeting-nudge.ts): a group's meeting that started
 *   2+ minutes ago gets one card in its own chat when Sidekick is there (from the chat's call events), else in the
 *   group's notes chat naming the meeting; nothing when transcribing (call event or a listed transcript), when the
 *   group switched reminders off, when the meeting records by itself, for ties or meetings not started yet; a refused
 *   calendar read is shown on the Teams chats tab;
 * - the day a meeting was held: the transcript's own start, not the meeting's first schedule (live case, Oct 29);
 * - live in Teams meetings (lib/live-meetings/, a **fake Recall.ai** server): the group switch (Enterprise only, Team
 *   Lead or admin, audited); `@Sidekick join` in a meeting chat (link from Graph) or with a pasted link; the first chat
 *   message; "Sidekick, …" said → a grounded answer with sources (once, guardrails applied); signed webhooks only; the
 *   guest wall (Shareable sources only once a guest joins); the running list of decisions and "recap"; "Sidekick,
 *   leave"; the meeting ending; notes afterwards written once (live transcript, or the Teams transcript when it came,
 *   never both); live hours counted against the plan (join refused, a running session leaving); every group meeting
 *   joined automatically once; the lobby timeout; the Owner Console report; per-organization isolation;
 * - isolation: another organization sees none of it.
 *
 * Nothing real is touched: its own data folder or the TEST_DATABASE_URL database (wiped first), fake Claude, Teams in
 * local Playground mode with a fake Teams connector, a fake Microsoft with made-up keys. Port TEST_MEET_PORT, else
 * TEST_MT_PORT (the multi-tenant suite runs before this one, never at the same time), else 3220 / 3221.
 *
 *   TEST_DB=sqlite node --test tests/meetings-graph.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const ENGINE = process.env.TEST_DB === "postgres" ? "postgres" : "sqlite";
const PORT = Number(process.env.TEST_MEET_PORT) || Number(process.env.TEST_MT_PORT) || (ENGINE === "postgres" ? 3221 : 3220);
const BASE = `http://localhost:${PORT}`;
const PG_URL = process.env.TEST_DATABASE_URL || "postgres:///sidekick_test";
const DIST = `.next-test-meet-${ENGINE}`;

let server;
let dataDir;
let tsconfigBefore;

const TA = "aaaaaaaa-1111-4111-8111-111111111111"; // Org A's Microsoft tenant
const TB = "bbbbbbbb-2222-4222-8222-222222222222"; // Org B's Microsoft tenant
const TG = "eeeeeeee-5555-4555-8555-555555555555"; // a client's tenant (guests)

/** Graph ids are GUIDs; make stable ones from readable names. */
function guid(name) {
  const h = crypto.createHash("sha1").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const OID = Object.fromEntries(["ann", "lou", "mo", "pat", "quinn", "vic", "bob", "outsider", "guest", "jo", "gus", "ole", "kai", "nia", "ola"].map((n) => [n, guid(`oid-${n}`)]));
/** A Teams meeting id: base64 of "1*<organizer>*0**<meeting chat>". */
const meetingIdFor = (organizer, thread) => Buffer.from(`1*${organizer}*0**${thread}`).toString("base64");

/* ---------- fake Teams connector: everything the bot sends ---------- */
const sent = [];
const connector = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      sent.push({ url: req.url, body: JSON.parse(body || "{}") });
    } catch {
      sent.push({ url: req.url, body });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg-${sent.length}` }));
  });
});
let SERVICE_URL;
const sentTo = (conv, from = 0) => sent.slice(from).filter((m) => decodeURIComponent(m.url).includes(conv)).map((m) => JSON.stringify(m.body)).join("\n");
async function waitFor(conv, re, from = 0, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (re.test(sentTo(conv, from))) return sentTo(conv, from);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${re} in ${conv}: ${sentTo(conv, from).slice(0, 400)}`);
}

/* ---------- fake meeting bots: our own Attendee (the default) and Recall.ai (opt-in), and Azure AI Speech ---------- */
const MEETBOT_SECRET = crypto.randomBytes(32).toString("base64");
/** A session's own key, as Sidekick derives it (lib/live-meetings/launcher.ts botKey). */
const botKeyOf = (session) => crypto.createHmac("sha256", MEETBOT_SECRET).update(`meetbot:${session}`).digest("base64url");
const RECALL_KEY = "test-recall-key";
const LIVE_SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;
// bot id → { provider, url, name, webhook, settings, left, chat: [messages], spoken: [texts], hand: [true/false], log: [everything in order] }
const BOTS = new Map();
const liveFail = { join: null }; // a status to refuse the next join with (either provider)
/** One fake meeting-bot server; `routes` maps an action to the request path that means it. */
function fakeBots(provider, key, paths) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Token ${key}`) return send(401, { detail: "Invalid token." });
      const b = body ? JSON.parse(body) : {};
      if (req.method === "POST" && req.url === paths.create) {
        if (liveFail.join) {
          const status = liveFail.join;
          liveFail.join = null;
          return send(status, { detail: "Meeting URL is not reachable." });
        }
        const id = `${provider}-bot-${BOTS.size + 1}`;
        const webhook = provider === "attendee" ? b.webhooks?.[0]?.url : b.recording_config?.realtime_endpoints?.[0]?.url;
        BOTS.set(id, { provider, url: b.meeting_url, name: b.bot_name, webhook, settings: b, left: false, chat: [], spoken: [], hand: [], log: [] });
        return send(201, { id, meeting_url: b.meeting_url });
      }
      const m = paths.action.exec(req.url);
      const bot = m && BOTS.get(m[1]);
      if (!bot) return send(404, { detail: "Not found." });
      const action = m[2];
      if (action === "leave" || action === "leave_call") bot.left = true;
      else if (action === "send_chat_message") {
        // Attendee takes Teams HTML; kept as plain text here so tests read it easily.
        const text = String(b.message).replace(/<br>/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        bot.chat.push(text);
        bot.log.push(`chat:${text}`);
      } else if (action === "raise_hand") {
        bot.hand.push(b.raised);
        bot.log.push(`hand:${b.raised}`);
      } else if (action === "output_audio") {
        // The fake Azure AI Speech returns the text itself as the "audio", so tests can read what was said.
        const said = Buffer.from(b.data ?? b.b64_data, "base64").toString("utf8");
        bot.spoken.push(said);
        bot.log.push(`speak:${said}`);
      } else return send(404, { detail: "Not found." });
      send(200, {});
    });
  });
}
/*
 * Sidekick's own meeting bot: a fake Azure Resource Manager (and managed identity) that "starts a Container Apps job
 * execution", and a fake container that behaves like meetbot/shim: it long-polls Sidekick for its commands and records
 * them (chat, speak, hand, hearing, leave), and exits (sidekick.exit) when told to leave.
 */
const armCalls = []; // { op: "start" | "stop", path, body, auth }
const ARM_JOB = "/subscriptions/sub-test/resourceGroups/sidekick-rg/providers/Microsoft.App/jobs/sidekick-meetbot";
const arm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/identity") {
      if (req.headers["x-identity-header"] !== "test-identity" || url.searchParams.get("resource") !== "https://management.azure.com/") return send(400, {});
      return send(200, { access_token: "arm-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
    }
    if (req.headers.authorization !== "Bearer arm-token" || url.searchParams.get("api-version") !== "2024-03-01") return send(401, { error: { message: "No." } });
    const b = body ? JSON.parse(body) : {};
    if (req.method === "POST" && url.pathname === `${ARM_JOB}/start`) {
      armCalls.push({ op: "start", body: b });
      if (liveFail.join) {
        const status = liveFail.join;
        liveFail.join = null;
        return send(status, { error: { code: "BadRequest", message: "Meeting URL is not reachable." } });
      }
      const c = b.containers[0];
      const env = Object.fromEntries(c.env.filter((e) => "value" in e).map((e) => [e.name, e.value]));
      const execution = `sidekick-meetbot-${armCalls.length}`;
      BOTS.set(env.SIDEKICK_SESSION, { provider: "attendee", url: env.MEETING_URL, name: env.BOT_NAME, env, container: c, execution, left: false, gone: false, deaf: false, hearing: "captions", chat: [], spoken: [], hand: [], log: [] });
      fakeContainer(env.SIDEKICK_SESSION);
      return send(200, { name: execution, id: `${ARM_JOB}/executions/${execution}` });
    }
    const stop = url.pathname.match(new RegExp(`^${ARM_JOB}/executions/([^/]+)/stop$`));
    if (req.method === "POST" && stop) {
      armCalls.push({ op: "stop", execution: stop[1] });
      const bot = [...BOTS.values()].find((x) => x.execution === stop[1]);
      if (bot) bot.gone = true;
      return send(200, {});
    }
    send(404, { error: { message: "Not found." } });
  });
});
/** The fake container's shim: polls commands until it leaves; `deaf` bots ignore everything (a stuck container). */
async function fakeContainer(session) {
  const bot = BOTS.get(session);
  while (!bot.gone) {
    if (bot.deaf) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    let out;
    try {
      const res = await fetch(`${bot.env.SIDEKICK_URL}/api/live/bot/commands?wait=1`, { headers: { "x-sidekick-bot-session": session, Authorization: `Bearer ${bot.env.SIDEKICK_BOT_KEY}` } });
      if (res.status === 401) return void (bot.gone = true);
      out = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    for (const c of out.commands ?? []) {
      if (c.kind === "chat") {
        bot.chat.push(c.data.text);
        bot.log.push(`chat:${c.data.text}`);
      } else if (c.kind === "hand") {
        bot.hand.push(c.data.raised);
        bot.log.push(`hand:${c.data.raised}`);
      } else if (c.kind === "speak") {
        const said = Buffer.from(c.data.mp3, "base64").toString("utf8");
        bot.spoken.push(said);
        bot.log.push(`speak:${said}`);
      } else if (c.kind === "hearing") {
        bot.hearing = c.data.source;
        bot.log.push(`hearing:${c.data.source}`);
        await pushLive(session, { trigger: "sidekick.hearing", data: { source: c.data.source } });
      } else if (c.kind === "leave") {
        bot.left = true;
        await pushLive(session, { trigger: "bot.state_change", data: { new_state: "ended", event_type: "bot_left" } });
        await pushLive(session, { trigger: "sidekick.exit", data: { reason: "left" } });
        bot.gone = true;
      }
    }
    if (out.stop && !bot.gone) {
      await pushLive(session, { trigger: "sidekick.exit", data: { reason: "Sidekick ended the session" } });
      bot.gone = true;
    }
  }
}
const recall = fakeBots("recall", RECALL_KEY, { create: "/api/v1/bot/", action: /^\/api\/v1\/bot\/([^/]+)\/(leave_call|send_chat_message|output_audio)\/$/ });
// Azure AI Speech (text to speech): the "MP3" is the spoken text, so the bots above can record what was said.
const ttsCalls = [];
const tts = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.headers["ocp-apim-subscription-key"] !== "test-speech-key" || req.headers["content-type"] !== "application/ssml+xml") {
      res.writeHead(401);
      return res.end();
    }
    const voice = body.match(/<voice name="([^"]+)">/)?.[1] ?? null;
    const rate = body.match(/<prosody rate="([^"]+)">/)?.[1] ?? null;
    const text = (body.match(/<voice[^>]*>([\s\S]*)<\/voice>/)?.[1] ?? "").replace(/<\/?prosody[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    ttsCalls.push({ format: req.headers["x-microsoft-outputformat"], text, voice, rate });
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(Buffer.from(text, "utf8"));
  });
});

/** Posts an event to the app's webhook for a bot, in its provider's format and signature. */
async function pushLive(botId, event, { secret, at = Date.now(), sign = true } = {}) {
  const provider = BOTS.get(botId)?.provider ?? "attendee";
  if (provider === "attendee") {
    // What the shim in the bot's container sends: the session's events, signed with its own key over time and body.
    const raw = JSON.stringify([{ bot_id: botId, ...event }]);
    const ts = String(Math.floor(at / 1000));
    const sig = crypto.createHmac("sha256", secret ?? botKeyOf(botId)).update(`${ts}.${raw}`).digest("base64");
    return fetch(`${BASE}/api/live/events/attendee`, { method: "POST", headers: { "content-type": "application/json", ...(sign ? { "x-sidekick-bot-session": botId, "x-sidekick-bot-timestamp": ts, "x-sidekick-bot-signature": `v1,${sig}` } : {}) }, body: raw });
  }
  const raw = JSON.stringify(event);
  const id = `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(at / 1000));
  const key = secret ?? LIVE_SECRET;
  const sig = crypto.createHmac("sha256", Buffer.from(key.slice("whsec_".length), "base64")).update(`${id}.${ts}.${raw}`).digest("base64");
  return fetch(`${BASE}/api/live/events/recall`, { method: "POST", headers: { "content-type": "application/json", ...(sign ? { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` } : {}) }, body: raw });
}
const isAttendee = (botId) => (BOTS.get(botId)?.provider ?? "attendee") === "attendee";
/** The bot's status: "waiting", "in_call", "ended" (`remover` = who removed it), "failed". */
function botStatus(botId, status, { remover } = {}) {
  if (isAttendee(botId)) {
    const state = { waiting: "waiting_room", in_call: "joined_recording", ended: "ended", failed: "fatal_error" }[status];
    return pushLive(botId, { trigger: "bot.state_change", data: { new_state: state, old_state: "joining", created_at: new Date().toISOString(), event_type: status === "ended" ? "meeting_ended" : status, event_sub_type: null, ...(remover ? { event_metadata: { remover_name: remover } } : {}) } });
  }
  const code = { waiting: "in_waiting_room", in_call: "in_call_recording", ended: "call_ended", failed: "fatal" }[status];
  return pushLive(botId, { event: `bot.${code}`, data: { data: { code, sub_code: null, updated_at: new Date().toISOString() }, bot: { id: botId, metadata: {} } } });
}
/** Someone says `text` in the meeting (a finished caption / transcript line). */
const say = (botId, name, text) => isAttendee(botId)
  ? pushLive(botId, { trigger: "transcript.update", data: { speaker_name: name, speaker_uuid: name, timestamp_ms: Date.now(), duration_ms: 1500, transcription: { transcript: text, words: null } } })
  : pushLive(botId, { event: "transcript.data", data: { data: { words: text.split(" ").map((w) => ({ text: w })), participant: { id: 1, name } }, bot: { id: botId, metadata: {} } } });
/** Someone types `text` in the meeting chat. */
const typeIn = (botId, name, text) => isAttendee(botId)
  ? pushLive(botId, { trigger: "chat_messages.update", data: { id: crypto.randomUUID(), to: "everyone", text, sender_name: name, timestamp_ms: Date.now() } })
  : pushLive(botId, { event: "participant_events.chat_message", data: { data: { participant: { id: 2, name }, data: { text, to: "everyone" } }, bot: { id: botId, metadata: {} } } });
/** Someone joins the meeting. */
const joinsMeeting = (botId, name) => isAttendee(botId)
  ? pushLive(botId, { trigger: "participant_events.join_leave", data: { participant_name: name, participant_uuid: name, event_type: "join", event_data: {}, timestamp_ms: Date.now() } })
  : pushLive(botId, { event: "participant_events.join", data: { data: { participant: { id: 3, name, extra_data: {} } }, bot: { id: botId, metadata: {} } } });
/** Someone starts (or stops) talking. */
const speaking = (botId, name, on) => isAttendee(botId)
  ? pushLive(botId, { trigger: "participant_events.speech_start_stop", data: { participant_name: name, participant_uuid: name, event_type: on ? "speech_start" : "speech_stop", event_data: {}, timestamp_ms: Date.now() } })
  : pushLive(botId, { event: `participant_events.speech_${on ? "on" : "off"}`, data: { data: { participant: { id: 4, name } }, bot: { id: botId, metadata: {} } } });
/** Waits until the bot's log (chat, hand, speech, in order) has an entry matching `re` from entry `from` on; returns them joined. */
async function waitLog(botId, re, from = 0, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const text = (BOTS.get(botId)?.log ?? []).slice(from).join("\n");
    if (re.test(text)) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${re} in ${botId}: ${(BOTS.get(botId)?.log ?? []).slice(from).join(" | ").slice(0, 600)}`);
}
/** Waits for a meeting chat message from the bot matching `re` (from message `from` on). */
async function waitChat(botId, re, from = 0, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const text = (BOTS.get(botId)?.chat ?? []).slice(from).join("\n");
    if (re.test(text)) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${re} in ${botId}'s chat: ${(BOTS.get(botId)?.chat ?? []).slice(from).join(" | ").slice(0, 400)}`);
}
const lastBot = () => [...BOTS.keys()].at(-1);
/** Waits until `check()` is true (the bot's container acts on its commands within a second or so). */
async function until(check, what = "the condition", ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}
const logLen = (botId) => BOTS.get(botId).log.length;

/* ---------- fake Microsoft: sign-in keys, app tokens and Graph ---------- */
const MS_CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const { publicKey: msPublic, privateKey: msPrivate } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const msJwk = { ...msPublic.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const msCodes = new Map();
const consented = new Set();
let MS_BASE;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function msJwt(claims) {
  const head = b64({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iat: now, nbf: now, exp: now + 3600, ...claims });
  return `${head}.${body}.${crypto.sign("sha256", Buffer.from(`${head}.${body}`), msPrivate).toString("base64url")}`;
}
const idToken = (tid, nonce, claims) => msJwt({ iss: `${MS_BASE}/${tid}/v2.0`, aud: MS_CLIENT_ID, tid, nonce, ...claims });
/** A Teams single-sign-on token for the tab (what `authentication.getAuthToken()` returns), with overrides. */
const ssoToken = (tid, oid, extra = {}) => msJwt({ iss: `${MS_BASE}/${tid}/v2.0`, aud: `api://localhost:${PORT}/${MS_CLIENT_ID}`, tid, oid, scp: "access_as_user", name: "Someone", ...extra });

// Graph state.
const SUBS = new Map(); // subscription id → body
const subCalls = [];
const MEETINGS = new Map(); // online meeting id → meeting
const TRANSCRIPTS = []; // { id, meetingId, organizer, createdDateTime, vtt }
const pollCalls = [];
const CALLS = []; // ad hoc calls (Meet now): { callId, transcriptId, organizer, createdDateTime, endDateTime, vtt }
const callsApproved = new Set(); // tenants that approved CallTranscripts.Read.All
const callPollCalls = [];
const subRefusal = new Map(); // resource → the 400 Graph answers when a subscription on it is made (Oct 28 live bug)
const transcriptsOff = new Set(); // tenants whose Teams "Transcript API access" switch is off (403 GraphAccessToTranscriptsDisabled)
const throttle = { meeting: [] }; // queue of Retry-After values to answer the next meeting reads with (429)
const CHAT_MSGS = new Map(); // chat id → its latest messages (call events for the transcription reminder)
const chatDenied = new Set(); // chats Graph refuses to read (403: the chat permission wasn't granted there)
const chatReads = []; // every GET /chats/{id}/messages
// Each tenant's people directory (GET /users/{id or sign-in name}): { tenant, id, upn, mail, name, userType }.
const DIRECTORY = [];
const dirCalls = []; // every directory lookup: { tid, key }
const directoryDenied = new Set(); // tenants whose directory permission isn't approved (403 on /users/{id})
const EVENTS = []; // calendar events: { organizer, event } (lib/auto-record.ts reads calendarView)
const recordApproved = new Set(); // tenants that approved Calendars.ReadBasic.All + OnlineMeetings.ReadWrite.All
const patches = []; // every PATCH of an online meeting: { organizer, id, body }
const MEETING_CHAT_LINKS = new Map(); // meeting chat id → its meeting's join link (GET /chats/{id})
const lookups = []; // every online meeting lookup by join link: { organizer, url }
const calendarReads = []; // every calendarView read: { organizer, start, end, select }
const patchRefused = new Set(); // online meeting ids whose PATCH Graph answers 400
const transcriptLists = []; // every list of one meeting's transcripts: { organizer, id } (lib/meeting-nudge.ts)
const vtt = (lines) => `WEBVTT\n\n${lines.map(([who, text], i) => `00:${String(i).padStart(2, "0")}:01.000 --> 00:${String(i).padStart(2, "0")}:09.000\n<v ${who}>${text}</v>`).join("\n\n")}\n`;

async function validateWith(url) {
  // Graph's handshake: POST the address with ?validationToken=… and expect it back as plain text.
  const token = `Validation: Testing client ${crypto.randomUUID()}`;
  const r = await fetch(`${url}?validationToken=${encodeURIComponent(token)}`, { method: "POST" });
  const text = await r.text();
  return r.status === 200 && text === token && (r.headers.get("content-type") ?? "").startsWith("text/plain");
}

const microsoft = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const url = new URL(req.url, MS_BASE);
    const p = decodeURIComponent(url.pathname);
    if (p.endsWith("/discovery/v2.0/keys")) return send(200, { keys: [msJwk] });
    if (p.endsWith("/oauth2/v2.0/token")) {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") === "client_credentials") {
        const tid = p.split("/")[1];
        if (!consented.has(tid)) return send(400, { error: "unauthorized_client", error_description: "AADSTS7000229" });
        return send(200, { access_token: `tok-${tid}`, expires_in: 3600 });
      }
      const c = msCodes.get(f.get("code"));
      msCodes.delete(f.get("code"));
      if (!c || crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return send(400, { error: "invalid_grant" });
      return send(200, { id_token: idToken(c.claims.tid, c.nonce, c.claims) });
    }
    const tid = (req.headers.authorization ?? "").replace("Bearer tok-", "");
    if (!p.startsWith("/v1.0/")) return send(404, { error: "not found" });
    if (!consented.has(tid)) return send(403, { error: { code: "Forbidden" } });
    if (transcriptsOff.has(tid) && (p === "/v1.0/subscriptions" || p.includes("/onlineMeetings/") || p.includes("/adhocCalls/"))) {
      return send(403, { error: { code: "Forbidden", message: "Graph API access to transcripts is disabled for this tenant.", innerError: { code: "GraphAccessToTranscriptsDisabled" } } });
    }
    // A meeting chat's own meeting (lib/live-meetings/sessions.ts reads its join link for "@Sidekick join").
    const chatInfo = p.match(/^\/v1\.0\/chats\/([^/]+)$/);
    if (chatInfo && req.method === "GET") {
      const link = MEETING_CHAT_LINKS.get(chatInfo[1]);
      return link ? send(200, { id: chatInfo[1], chatType: "meeting", onlineMeetingInfo: { joinWebUrl: link } }) : send(404, { error: { code: "NotFound" } });
    }
    // A chat's latest messages (lib/call-nudge.ts reads call events); newest first, at most $top.
    const chatMsgs = p.match(/^\/v1\.0\/chats\/([^/]+)\/messages$/);
    if (chatMsgs && req.method === "GET") {
      chatReads.push({ chat: chatMsgs[1], prefer: req.headers.prefer ?? "", top: url.searchParams.get("$top"), orderby: url.searchParams.get("$orderby") });
      if (chatDenied.has(chatMsgs[1])) return send(403, { error: { code: "Forbidden", message: "Missing role permissions on the request." } });
      const list = [...(CHAT_MSGS.get(chatMsgs[1]) ?? [])].sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
      return send(200, { value: list.slice(0, Number(url.searchParams.get("$top")) || 20) });
    }
    // Subscriptions.
    if (p === "/v1.0/subscriptions" && req.method === "POST") {
      const b = JSON.parse(body);
      // Live Graph (probe, Oct 28): v1.0 refuses the ad hoc call resource outright.
      if (b.resource === "communications/adhocCalls/getAllTranscripts") {
        subCalls.push({ op: "unsupported", body: b, tid });
        return send(400, { error: { code: "InvalidRequest", message: "Subscription for resource 'communications/adhocCalls/getAllTranscripts' is not supported in 'V1' version." } });
      }
      // And allows one subscription per app and tenant on a tenant-wide transcript resource.
      if ([...SUBS.values()].some((x) => x.tid === tid && x.resource === b.resource)) {
        subCalls.push({ op: "limit", body: b, tid });
        return send(403, { error: { code: "ExtensionError", message: "Operation: Create; Exception: [Status Code: Forbidden; Reason: App has reached its limit of '1' subscription(s) on tenant]" } });
      }
      if (subRefusal.has(b.resource)) {
        subCalls.push({ op: "refused", body: b, tid });
        return send(400, subRefusal.get(b.resource));
      }
      subCalls.push({ op: "create", body: b, tid });
      if (!["communications/onlineMeetings/getAllTranscripts", "communications/adhocCalls/getAllTranscripts"].includes(b.resource) || b.changeType !== "created" || !b.clientState) return send(400, { error: { code: "InvalidRequest" } });
      if (!(await validateWith(b.notificationUrl)) || !(await validateWith(b.lifecycleNotificationUrl))) return send(400, { error: { code: "ValidationError", message: "Subscription validation request failed" } });
      const id = crypto.randomUUID();
      SUBS.set(id, { ...b, id, tid });
      return send(201, { id, expirationDateTime: b.expirationDateTime, resource: b.resource });
    }
    if (p === "/v1.0/subscriptions" && req.method === "GET") {
      subCalls.push({ op: "list", tid });
      return send(200, { value: [...SUBS.values()].filter((x) => x.tid === tid).map(({ id, resource, notificationUrl, expirationDateTime }) => ({ id, resource, notificationUrl, expirationDateTime, clientState: null })) });
    }
    const sub = p.match(/^\/v1\.0\/subscriptions\/(.+)$/);
    if (sub) {
      const s = SUBS.get(sub[1]);
      subCalls.push({ op: req.method === "PATCH" ? "renew" : "delete", id: sub[1] });
      if (!s) return send(404, { error: { code: "ResourceNotFound" } });
      if (req.method === "DELETE") {
        SUBS.delete(sub[1]);
        return send(204);
      }
      s.expirationDateTime = JSON.parse(body).expirationDateTime;
      return send(200, { id: s.id, expirationDateTime: s.expirationDateTime });
    }
    // The directory: one person by account id or sign-in name (UPN), only in the tenant asking (like Graph).
    const dirUser = p.match(/^\/v1\.0\/users\/([^/]+)$/);
    if (dirUser && req.method === "GET") {
      const key = dirUser[1].toLowerCase();
      dirCalls.push({ tid, key });
      if (directoryDenied.has(tid)) return send(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } });
      const u = DIRECTORY.find((d) => d.tenant === tid && (d.id === key || d.upn.toLowerCase() === key));
      if (!u) return send(404, { error: { code: "Request_ResourceNotFound" } });
      return send(200, { id: u.id, displayName: u.name, mail: u.mail, userPrincipalName: u.upn, userType: u.userType ?? "Member", accountEnabled: true });
    }
    // Polling: transcripts of meetings one person organized.
    const all = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings\/getAllTranscripts\(meetingOrganizerUserId='([^']+)',startDateTime=([^,]+),endDateTime=([^)]+)\)$/);
    if (all) {
      pollCalls.push({ organizer: all[2], from: all[3], to: all[4] });
      const list = TRANSCRIPTS.filter((t) => t.organizer === all[2] && t.createdDateTime >= all[3] && t.createdDateTime <= all[4]);
      return send(200, { value: list.map((t) => ({ id: t.id, meetingId: t.meetingId, createdDateTime: t.createdDateTime, meetingOrganizer: { user: { id: t.organizer } } })) });
    }
    // Ad hoc calls (Meet now): need CallTranscripts.Read.All.
    if (p.includes("/adhocCalls/") && !callsApproved.has(tid)) return send(403, { error: { code: "Forbidden", message: "API requires one of 'CallTranscripts.Read.All'." } });
    const allCalls = p.match(/^\/v1\.0\/users\/([^/]+)\/adhocCalls\/getAllTranscripts\(userId='([^']+)',startDateTime=([^,]+),endDateTime=([^)]+)\)$/);
    if (allCalls) {
      callPollCalls.push({ organizer: allCalls[2], from: allCalls[3], to: allCalls[4] });
      const list = CALLS.filter((c) => c.organizer === allCalls[2] && c.createdDateTime >= allCalls[3] && c.createdDateTime <= allCalls[4]);
      return send(200, { value: list.map((c) => ({ id: c.transcriptId, meetingId: null, callId: c.callId, createdDateTime: c.createdDateTime, endDateTime: c.endDateTime, meetingOrganizer: { user: { id: c.organizer, tenantId: TA } } })) });
    }
    const callTranscript = p.match(/^\/v1\.0\/users\/([^/]+)\/adhocCalls\/([^/]+)\/transcripts\/([^/]+?)(\/content)?$/);
    if (callTranscript) {
      const c = CALLS.find((x) => x.callId === callTranscript[2] && x.transcriptId === callTranscript[3] && x.organizer === callTranscript[1]);
      if (!c) return send(404, { error: { code: "NotFound" } });
      if (!callTranscript[4]) return send(200, { id: c.transcriptId, callId: c.callId, meetingId: null, createdDateTime: c.createdDateTime, endDateTime: c.endDateTime });
      if (url.searchParams.get("$format") !== "text/vtt") return send(404, { error: { code: "NotFound" } });
      res.writeHead(200, { "content-type": "text/vtt" });
      return void res.end(c.vtt);
    }
    // One transcript's details: its own times (when this occurrence was really held, lib/meetings-graph.ts heldTimes).
    const tmeta = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings\/([^/]+)\/transcripts\/([^/]+)$/);
    if (tmeta && req.method === "GET") {
      const t = TRANSCRIPTS.find((x) => x.id === tmeta[3] && x.meetingId === tmeta[2] && x.organizer === tmeta[1]);
      if (!t) return send(404, { error: { code: "NotFound" } });
      return send(200, { id: t.id, meetingId: t.meetingId, createdDateTime: t.heldStart, endDateTime: t.heldEnd });
    }
    const content = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings\/([^/]+)\/transcripts\/([^/]+)\/content$/);
    if (content) {
      const t = TRANSCRIPTS.find((x) => x.id === content[3] && x.meetingId === content[2]);
      if (!t || url.searchParams.get("$format") !== "text/vtt") return send(404, { error: { code: "NotFound" } });
      res.writeHead(200, { "content-type": "text/vtt" });
      return void res.end(t.vtt);
    }
    // Meetings that record by themselves: the organizer's calendar, the meeting by its join link, and the change.
    const cal = p.match(/^\/v1\.0\/users\/([^/]+)\/calendarView$/);
    if (cal && req.method === "GET") {
      if (!recordApproved.has(tid)) return send(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } });
      const start = url.searchParams.get("startDateTime");
      const end = url.searchParams.get("endDateTime");
      calendarReads.push({ organizer: cal[1], start, end, select: url.searchParams.get("$select"), prefer: req.headers.prefer ?? "" });
      const list = EVENTS.filter((e) => e.calendar === cal[1] && e.event.start.dateTime >= start.slice(0, 19) && e.event.start.dateTime <= end.slice(0, 19));
      return send(200, { value: list.map((e) => e.event) });
    }
    const byLink = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings$/);
    if (byLink && req.method === "GET") {
      if (!recordApproved.has(tid)) return send(403, { error: { code: "Forbidden" } });
      const f = /^JoinWebUrl eq '(.*)'$/.exec(url.searchParams.get("$filter") ?? "");
      const joinUrl = f ? f[1].replace(/''/g, "'") : null;
      lookups.push({ organizer: byLink[1], url: joinUrl });
      const m = [...MEETINGS.values()].find((x) => x.joinUrl && x.joinUrl === joinUrl && x.organizer === byLink[1]);
      return send(200, { value: m ? [m.body] : [] });
    }
    // One meeting's transcripts (lib/meeting-nudge.ts checks before reminding from the notes chat).
    const tlist = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings\/([^/]+)\/transcripts$/);
    if (tlist && req.method === "GET") {
      transcriptLists.push({ organizer: tlist[1], id: tlist[2] });
      const m = MEETINGS.get(tlist[2]);
      if (!m || m.organizer !== tlist[1]) return send(404, { error: { code: "NotFound" } });
      return send(200, { value: TRANSCRIPTS.filter((t) => t.meetingId === tlist[2]).map((t) => ({ id: t.id, meetingId: t.meetingId, createdDateTime: t.createdDateTime })) });
    }
    const meeting = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings\/([^/]+)$/);
    if (meeting && req.method === "PATCH") {
      if (!recordApproved.has(tid)) return send(403, { error: { code: "Forbidden" } });
      const m = MEETINGS.get(meeting[2]);
      if (!m || m.organizer !== meeting[1]) return send(404, { error: { code: "NotFound" } });
      if (patchRefused.has(meeting[2])) return send(400, { error: { code: "BadRequest", message: "Auto recording is not allowed by policy." } });
      const b = JSON.parse(body);
      patches.push({ organizer: meeting[1], id: meeting[2], body: b });
      Object.assign(m.body, b);
      return send(200, m.body);
    }
    if (meeting) {
      if (throttle.meeting.length) return send(429, { error: { code: "TooManyRequests" } }, { "Retry-After": String(throttle.meeting.shift()) });
      const m = MEETINGS.get(meeting[2]);
      return m && m.organizer === meeting[1] ? send(200, m.body) : send(404, { error: { code: "NotFound" } });
    }
    send(404, { error: "not found" });
  });
});

/** Adds a Teams meeting (and its transcript) to the fake Graph. Returns the ids. */
function addMeeting(name, { organizer, attendees = [], guests = [], others = [], subject = `Meeting ${name}`, lines, chat = `19:meeting_${name}@thread.v2`, minutes = 30, transcript = true, start = new Date(Date.now() - (minutes + 5) * 60_000), held = start } = {}) {
  const meetingId = meetingIdFor(organizer, chat);
  const end = new Date(start.getTime() + minutes * 60_000);
  MEETINGS.set(meetingId, {
    organizer,
    body: {
      id: meetingId, subject, startDateTime: start.toISOString(), endDateTime: end.toISOString(), chatInfo: { threadId: chat },
      participants: {
        organizer: { identity: { user: { id: organizer, tenantId: TA } } },
        attendees: [...attendees.map((id) => ({ identity: { user: { id, tenantId: TA } } })), ...guests.map((id) => ({ identity: { user: { id, tenantId: TG } } })), ...others.map(({ id, tenantId }) => ({ identity: { user: { id, tenantId } } }))],
      },
    },
  });
  const transcriptId = `MSMj${crypto.createHash("sha1").update(name).digest("hex").slice(0, 20)}`;
  // `held`: the day this occurrence really took place (a series or a meeting held again later keeps its first schedule).
  const heldStart = held.toISOString();
  const heldEnd = new Date(held.getTime() + minutes * 60_000).toISOString();
  if (transcript) TRANSCRIPTS.push({ id: transcriptId, meetingId, organizer, heldStart, heldEnd, createdDateTime: new Date(Math.max(end.getTime(), Date.parse(heldEnd)) + 60_000).toISOString(), vtt: vtt(lines ?? [["Lou Lead", `In ${name} we decided to move the cutover.`], ["Mo Member", "I'll send the test report by Friday."]]) });
  return { meetingId, transcriptId, chat };
}

/**
 * Adds a Meet now call (an ad hoc call) started from a Teams chat, with its transcript, to the fake Graph. Like the
 * real one, the transcript id is base64 of "…19:<chat>@thread.v2#<call id>-…-TranscriptV2". Returns the ids.
 */
function addCall(name, { organizer, chat, speakers = [["Lou Lead", `In ${name} we decided to move the cutover.`], ["Mo Member", "I'll send the test report by Friday."]], minutes = 20 } = {}) {
  const callId = guid(`call-${name}`);
  const end = new Date(Date.now() - 2 * 60_000);
  const start = new Date(end.getTime() - minutes * 60_000);
  const transcriptId = Buffer.from(`3##${chat}#${callId}-${Math.floor(start.getTime() / 1000)}-TranscriptV2`).toString("base64");
  CALLS.push({ callId, transcriptId, organizer, createdDateTime: start.toISOString(), endDateTime: end.toISOString(), vtt: vtt(speakers) });
  return { callId, transcriptId, chat };
}

/** Signs in with the fake Microsoft. */
async function microsoftSignIn(call, claims, { mode } = {}) {
  const start = await call("GET", `/api/auth/microsoft/start${mode === "link" ? "?mode=link" : ""}`);
  assert.equal(start.status, 307, JSON.stringify(start.body));
  const u = new URL(start.location);
  const code = crypto.randomUUID();
  msCodes.set(code, { challenge: u.searchParams.get("code_challenge"), nonce: u.searchParams.get("nonce"), claims });
  const back = await call("GET", `/api/auth/microsoft/callback?code=${code}&state=${u.searchParams.get("state")}`);
  return back.location ? new URL(back.location, BASE) : null;
}

/** A tiny HTTP client with its own cookie jar; `headers` adds request headers (e.g. a bearer token). */
function client() {
  const jar = new Map();
  return async function call(method, url, body, headers = {}) {
    const h = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...headers };
    const form = body instanceof FormData;
    if (body !== undefined && !form) h["content-type"] = "application/json";
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : form ? body : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, location: res.headers.get("location"), headers: res.headers };
  };
}
async function firstSignIn(call, email, temp) {
  const r = await call("POST", "/api/auth/login", { email, password: temp });
  if (r.status === 200) assert.equal((await call("POST", "/api/auth/password", { current: temp, next: "a new password 123" })).status, 200);
}

const TICK_SECRET = crypto.randomBytes(24).toString("hex");
/** One heartbeat of the job queue (`sweep` runs every recurring job now). */
const tick = (body = {}) => fetch(`${BASE}/api/jobs/tick`, { method: "POST", headers: { "x-sidekick-tick": TICK_SECRET, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
/** Heartbeats until no job is left to run now. */
async function drain(first = {}) {
  let r = await tick(first);
  for (let i = 0; i < 10 && r.ran; i++) r = await tick();
  return r;
}
const toBot = (a) => fetch(`${BASE}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
const activity = (conv, overrides = {}) => ({
  id: `act-${Math.random()}`, channelId: "msteams", serviceUrl: SERVICE_URL,
  from: { id: "29:lou", name: "Lou Lead", aadObjectId: OID.lou }, recipient: { id: "bot", name: "Sidekick" },
  conversation: { id: conv, conversationType: "groupChat", tenantId: TA, name: `Chat ${conv}` }, ...overrides,
});
/** The scheduled-meeting subscription in the database (the upkeep test changes only this one). */
const MEET_SUB = "graph_subscriptions WHERE resource = 'communications/onlineMeetings/getAllTranscripts'";
/** Posts a Graph notification batch to the app, as Graph would. */
const notify = (value) => fetch(`${BASE}/api/graph/notifications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });

/** Reads one value straight from the test database. */
async function scalar(sql) {
  if (ENGINE === "postgres") return execFileSync("psql", [PG_URL, "-tAc", sql], { encoding: "utf8" }).trim();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "sidekick.db"), { readOnly: true, timeout: 10000 });
  try {
    const row = db.prepare(sql).get();
    return row ? String(Object.values(row)[0] ?? "") : "";
  } finally {
    db.close();
  }
}
/** Changes the test database directly (to move time along: expiries, retry times). */
async function dbExec(sql) {
  if (ENGINE === "postgres") return void execFileSync("psql", [PG_URL, "-tAc", sql]);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "sidekick.db"), { timeout: 10000 });
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/* ---------- start / stop ---------- */
before(async () => {
  await new Promise((r) => connector.listen(0, "127.0.0.1", r));
  SERVICE_URL = `http://127.0.0.1:${connector.address().port}`;
  await new Promise((r) => microsoft.listen(0, "127.0.0.1", r));
  MS_BASE = `http://127.0.0.1:${microsoft.address().port}`;
  for (const srv of [arm, recall, tts]) await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  tsconfigBefore = fs.readFileSync(path.join(APP, "tsconfig.json"), "utf8");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    NEXT_DIST_DIR: DIST,
    SIDEKICK_FAKE_CLAUDE: "1",
    ANTHROPIC_API_KEY: "",
    AZURE_SEARCH_ENDPOINT: "",
    AZURE_SEARCH_API_KEY: "",
    AZURE_OPENAI_ENDPOINT: "",
    AZURE_OPENAI_API_KEY: "",
    TEAMS_LOCAL_PLAYGROUND: "true",
    CLIENT_ID: "",
    CLIENT_SECRET: "",
    TENANT_ID: "dddddddd-4444-4444-8444-444444444444",
    SIDEKICK_MULTI_TENANT: "1",
    // The app's own address: Graph sends notifications here (plain http is allowed outside production).
    SIDEKICK_PUBLIC_URL: BASE,
    SIDEKICK_SCHEDULER: "off",
    ENTRA_CLIENT_ID: MS_CLIENT_ID,
    ENTRA_CLIENT_SECRET: "test-entra-secret",
    ENTRA_TENANT: "",
    ENTRA_LOGIN_BASE: MS_BASE,
    GRAPH_BASE: MS_BASE,
    TEAMS_APP_ID: "sidekick-test-app",
    SIDEKICK_TICK_SECRET: TICK_SECRET,
    // Live in meetings: our own meeting bot (fake Attendee, with the raise-hand patch) by default, Recall.ai for an
    // organization that opts in, Azure AI Speech for spoken answers, waits 20x shorter, notes handed over at once.
    SIDEKICK_MEETBOT_JOB: "sidekick-meetbot",
    AZURE_SUBSCRIPTION_ID: "sub-test",
    SIDEKICK_MEETBOT_IMAGE: "sidekicklabsacr.azurecr.io/meetbot:v1.89.2-test",
    SIDEKICK_MEETBOT_SECRET: MEETBOT_SECRET,
    SIDEKICK_ARM_BASE: `http://127.0.0.1:${arm.address().port}`,
    IDENTITY_ENDPOINT: `http://127.0.0.1:${arm.address().port}/identity`,
    IDENTITY_HEADER: "test-identity",
    ATTENDEE_RAISE_HAND: "1",
    RECALL_API_KEY: RECALL_KEY,
    RECALL_BASE_URL: `http://127.0.0.1:${recall.address().port}`,
    SIDEKICK_LIVE_WEBHOOK_SECRET: LIVE_SECRET,
    AZURE_SPEECH_KEY: "test-speech-key",
    AZURE_SPEECH_TTS_URL: `http://127.0.0.1:${tts.address().port}/cognitiveservices/v1`,
    SIDEKICK_LIVE_TIME_SCALE: "0.05",
    SIDEKICK_LIVE_HANDOFF_MIN: "0",
  };
  if (ENGINE === "postgres") {
    const dbName = new URL(PG_URL.replace("postgres:///", "postgres://localhost/")).pathname.slice(1);
    execFileSync("dropdb", ["--if-exists", dbName]);
    execFileSync("createdb", [dbName]);
    env.DATABASE_URL = PG_URL;
  } else {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-meet-test-"));
    env.SIDEKICK_DATA_DIR = dataDir;
    env.DATABASE_URL = "";
  }
  server = spawn(path.join(APP, "node_modules/.bin/next"), ["dev", "--port", String(PORT)], { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => process.env.TEST_VERBOSE && process.stdout.write(d));
  server.stderr.on("data", (d) => process.env.TEST_VERBOSE && process.stderr.write(d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/auth/setup`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("The test app didn't start");
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
  }
  connector.close();
  microsoft.close();
  for (const b of BOTS.values()) b.gone = true;
  for (const srv of [arm, recall, tts]) srv.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(path.join(APP, DIST), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  if (tsconfigBefore) fs.writeFileSync(path.join(APP, "tsconfig.json"), tsconfigBefore);
});

/* ---------- the organizations ---------- */
const ann = client(); // Org A's Org Owner
const lou = client(); // Team Lead of W1
const mo = client(); // Member of W1
const pat = client(); // Member of W2
const quinn = client(); // Member of W1 and W2
const vic = client(); // Viewer of W1
const bob = client(); // Org B's Org Owner
const owner = client(); // the Sidekick operator
const s = {};
const CHAT_W1 = "19:w1-notes@thread.v2";

test(`[${ENGINE}] setup: Org A (tenant A) with two groups and its people signed in with Microsoft once; Org B elsewhere`, async () => {
  assert.equal((await ann("POST", "/api/auth/setup", { org: "Org A", name: "Ann Owner", email: "ann@a.test", password: "correct horse battery" })).status, 200);
  s.w1 = (await ann("POST", "/api/workspaces", { name: "W1" })).body.id;
  s.w2 = (await ann("POST", "/api/workspaces", { name: "W2" })).body.id;
  assert.ok(s.w1 && s.w2);
  const people = [
    [lou, "Lou Lead", "lou@a.test", "Team Lead", [s.w1], OID.lou],
    [mo, "Mo Member", "mo@a.test", "Member", [s.w1], OID.mo],
    [pat, "Pat Person", "pat@a.test", "Member", [s.w2], OID.pat],
    [quinn, "Quinn Both", "quinn@a.test", "Member", [s.w1, s.w2], OID.quinn],
    [vic, "Vic Viewer", "vic@a.test", "Viewer", [s.w1], OID.vic],
  ];
  assert.ok(await microsoftSignIn(ann, { tid: TA, oid: OID.ann, email: "ann@a.test", name: "Ann Owner" }, { mode: "link" }));
  for (const [c, name, email, role, workspaces, oid] of people) {
    const u = await ann("POST", "/api/users", { name, email, role, workspaces });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    await firstSignIn(c, email, u.body.tempPassword);
    assert.equal((await microsoftSignIn(c, { tid: TA, oid, email, name })).pathname, "/");
  }
  // W1's notes chat: the Team Lead adds Sidekick and assigns the chat to W1.
  await toBot(activity(CHAT_W1, { type: "installationUpdate", action: "add" }));
  await waitFor(CHAT_W1, /not set up/);
  assert.equal((await lou("POST", "/api/teams-links", { id: CHAT_W1, ws: s.w1 })).status, 200);

  assert.equal((await owner("POST", "/api/owner/auth/setup", { name: "Op", email: "op@sidekick.test", password: "correct horse battery" })).status, 200);
  const b = await owner("POST", "/api/owner/tenants", { org: "Org B", name: "Bob Owner", email: "bob@b.test" });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  await firstSignIn(bob, "bob@b.test", b.body.tempPassword);
  s.bw = (await bob("POST", "/api/workspaces", { name: "B work" })).body.id;
  assert.ok(await microsoftSignIn(bob, { tid: TB, oid: OID.bob, email: "bob@b.test", name: "Bob Owner" }, { mode: "link" }));
});

test(`[${ENGINE}] automatic notes: off by default, only admins switch it, consent problems are shown plainly`, async () => {
  const st = (await ann("GET", "/api/meetings/auto")).body;
  assert.equal(st.enabled, false);
  assert.equal(st.connected, true);
  assert.equal((await lou("PUT", "/api/meetings/auto", { enabled: true })).status, 403, "a Team Lead can't switch it");
  assert.equal((await mo("PUT", "/api/meetings/auto", { enabled: true })).status, 403);
  assert.equal((await mo("POST", "/api/meetings/auto", { action: "check" })).status, 403);
  assert.equal((await ann("PUT", "/api/meetings/auto", { enabled: "yes" })).status, 400);
  assert.equal((await ann("PUT", "/api/meetings/auto", { enabled: true })).status, 200);
  // Microsoft hasn't approved Sidekick in tenant A yet: the check records why, nothing breaks.
  await drain();
  const after = (await ann("GET", "/api/meetings/auto")).body;
  assert.equal(after.enabled, true);
  assert.match(after.lastError, /approve/i);
  assert.equal(after.instant, false);
  assert.equal(SUBS.size, 0);
  // A Member sees the switch is on but not the admin's problem text.
  assert.equal((await mo("GET", "/api/meetings/auto")).body.enabled, true);
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Turned on automatic notes after Teams meetings/);
});

test(`[${ENGINE}] automatic notes: Teams' transcript switch being off is named as its own fix, not as missing consent`, async () => {
  // Every permission approved, but the tenant's "Transcript API access" (EnableGraphTranscriptAccess) is off.
  consented.add(TA);
  transcriptsOff.add(TA);
  try {
    await drain({ sweep: true });
    const st = (await ann("GET", "/api/meetings/auto")).body;
    assert.match(st.lastError, /Transcript API access/);
    assert.doesNotMatch(st.lastError, /approve the meeting transcripts permission/);
    assert.equal(SUBS.size, 0);
  } finally {
    transcriptsOff.delete(TA);
    consented.delete(TA);
  }
});

test(`[${ENGINE}] Graph subscription: created after consent with the validation handshake; the notification address echoes tokens as text`, async () => {
  const echo = await fetch(`${BASE}/api/graph/notifications?validationToken=${encodeURIComponent("<b>abc</b>")}`, { method: "POST" });
  assert.equal(echo.status, 200);
  assert.equal(await echo.text(), "<b>abc</b>");
  assert.match(echo.headers.get("content-type"), /^text\/plain/);
  consented.add(TA);
  await drain({ sweep: true });
  const created = subCalls.filter((c) => c.op === "create");
  assert.equal(created.length, 1, JSON.stringify(subCalls));
  assert.equal(created[0].body.notificationUrl, `${BASE}/api/graph/notifications`);
  assert.equal(created[0].body.lifecycleNotificationUrl, `${BASE}/api/graph/lifecycle`);
  assert.ok(new Date(created[0].body.expirationDateTime) > new Date(Date.now() + 2 * 86400_000), "about three days");
  assert.equal(SUBS.size, 1);
  s.sub = [...SUBS.values()][0];
  const st = (await ann("GET", "/api/meetings/auto")).body;
  assert.equal(st.instant, true);
  // Scheduled meetings work; calls started with Meet now still need the new permission, said plainly (by the poll).
  assert.match(st.lastError, /approve the new call transcripts permission/);
  assert.match(st.lastError, /Scheduled Teams meetings aren't affected/);
  assert.ok(!subCalls.some((c) => c.body?.resource === "communications/adhocCalls/getAllTranscripts"), "no ad hoc call subscription is asked for (Graph v1.0 refuses it)");
  // A second upkeep run with plenty of time left changes nothing.
  await drain({ sweep: true });
  assert.equal(subCalls.filter((c) => c.op === "create").length, 1);
  assert.equal(subCalls.filter((c) => c.op === "renew").length, 0);
});

test(`[${ENGINE}] notification: a forged one is ignored; a real one captures the meeting into the group with most of its people, once`, async () => {
  const m1 = addMeeting("m1", { organizer: OID.lou, attendees: [OID.mo, OID.outsider], minutes: 30 });
  s.m1 = m1;
  const resource = `communications/onlineMeetings('${m1.meetingId}')/transcripts('${m1.transcriptId}')`;
  // Wrong client state, unknown subscription, garbage: 202 and nothing recorded.
  for (const bad of [{ subscriptionId: s.sub.id, clientState: "guess", resource }, { subscriptionId: "nope", clientState: s.sub.clientState, resource }, { subscriptionId: s.sub.id, clientState: s.sub.clientState, resource: "users('x')/messages('y')" }]) {
    assert.equal((await notify([bad])).status, 202);
  }
  assert.equal(await scalar("SELECT COUNT(*) FROM graph_meetings"), "0");
  // The real one (Graph may send it twice).
  const real = { subscriptionId: s.sub.id, clientState: s.sub.clientState, changeType: "created", resource, resourceData: { id: m1.transcriptId }, tenantId: TA };
  assert.equal((await notify([real, real])).status, 202);
  assert.equal(await scalar("SELECT COUNT(*) FROM graph_meetings"), "1");
  const from = sent.length;
  await drain();
  const meetings = (await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings;
  const got = meetings.find((m) => m.title === "Meeting m1");
  assert.ok(got, JSON.stringify(meetings));
  assert.equal(got.source, "teams");
  assert.equal(got.status, "Ready");
  assert.equal(got.decisions, 1);
  s.meeting1 = got.id;
  assert.equal((await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings.length, 0, "not in the other group");
  // The notes card went to W1's notes chat, with Save to knowledge, then the action items.
  const card = await waitFor(CHAT_W1, /MEETING NOTES · W1/, from);
  assert.match(card, /Captured from Microsoft Teams/);
  assert.match(card, /Save to knowledge/);
  assert.match(card, /sidekick\.knowledge\.save/);
  await waitFor(CHAT_W1, /Send the test report/, from);
  // The transcript itself is stored like an imported one; the status lists it as written.
  const detail = (await mo("GET", `/api/meetings/${s.meeting1}`)).body;
  assert.match(detail.meeting.transcript, /Lou Lead: In m1 we decided to move the cutover/);
  assert.equal(detail.meeting.duration_min, 30);
  const st = (await mo("GET", "/api/meetings/auto")).body;
  assert.ok(st.recent.some((r) => r.title === "Meeting m1" && r.status === "done" && r.workspace.id === s.w1));
  // The same transcript found again by polling: no second meeting, no second post.
  const posted = sent.length;
  await drain({ sweep: true });
  assert.equal((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.filter((m) => m.title === "Meeting m1").length, 1);
  assert.equal(sentTo(CHAT_W1, posted).includes("Meeting notes"), false, "posted once");
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Captured the Teams meeting “Meeting m1” \(30 min\)/);
});

test(`[${ENGINE}] polling fallback: a meeting Graph never notified about is found with getAllTranscripts, per organizer`, async () => {
  addMeeting("m2", { organizer: OID.pat, attendees: [OID.quinn], minutes: 45 });
  const calls = pollCalls.length;
  await drain({ sweep: true });
  assert.ok(pollCalls.slice(calls).some((c) => c.organizer === OID.pat), "Pat's meetings were checked");
  assert.ok(pollCalls.slice(calls).every((c) => c.organizer !== OID.bob), "never another organization's people");
  const w2 = (await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings;
  assert.ok(w2.some((m) => m.title === "Meeting m2" && m.status === "Ready" && m.source === "teams"), JSON.stringify(w2));
  // The next poll starts from where the last one stopped (minus a small overlap), not from scratch.
  const before = pollCalls.length;
  await drain({ sweep: true });
  const again = pollCalls.slice(before).find((c) => c.organizer === OID.pat);
  assert.ok(again && new Date(again.from) > new Date(Date.now() - 3600_000), JSON.stringify(again));
});

test(`[${ENGINE}] held date: a meeting held again on a later day shows the day it was held on the notes card, not its first schedule (live case, Oct 29)`, async () => {
  // "Wave 2 cutover sync" was scheduled three days ago and held again today on the same link: Graph's meeting still
  // says three days ago; only the transcript knows the day it was really held.
  const scheduled = new Date(Date.now() - 3 * 86400_000);
  const held = new Date(Date.now() - 40 * 60_000);
  const w = addMeeting("wave2", { organizer: OID.lou, attendees: [OID.mo], subject: "Wave 2 cutover sync", start: scheduled, held, minutes: 25 });
  const from = sent.length;
  const resource = `communications/onlineMeetings('${w.meetingId}')/transcripts('${w.transcriptId}')`;
  assert.equal((await notify([{ subscriptionId: s.sub.id, clientState: s.sub.clientState, changeType: "created", resource, tenantId: TA }])).status, 202);
  await drain();
  const heldDay = held.toISOString().slice(0, 10);
  const scheduledDay = scheduled.toISOString().slice(0, 10);
  const card = await waitFor(CHAT_W1, /Wave 2 cutover sync/, from);
  assert.ok(card.includes(heldDay), "the card shows the day it was held");
  assert.ok(!card.includes(scheduledDay), "not the first scheduled day");
  const got = (await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.find((m) => m.title === "Wave 2 cutover sync");
  const detail = (await mo("GET", `/api/meetings/${got.id}`)).body.meeting;
  assert.equal(detail.held_at, heldDay);
  assert.equal(detail.duration_min, 25, "the length comes from the transcript's own times");
});

test(`[${ENGINE}] which group: a tie waits for a lead to pick one of their groups; nobody's meeting is skipped without its title`, async () => {
  // Quinn (W1 and W2) with Mo (W1) and Pat (W2): two people from each group.
  const tie = addMeeting("tie", { organizer: OID.quinn, attendees: [OID.mo, OID.pat] });
  // Ann (in W1 and W2) with someone Sidekick doesn't know: unclear, so it waits too (never dropped silently).
  addMeeting("solo", { organizer: OID.ann, attendees: [OID.outsider] });
  // Nobody from any group (someone outside Sidekick with a client guest), heard of by notification: skipped.
  const nobody = addMeeting("nobody", { organizer: OID.outsider, guests: [OID.guest] });
  assert.equal((await notify([{ subscriptionId: s.sub.id, clientState: s.sub.clientState, changeType: "created", resource: `communications/onlineMeetings('${nobody.meetingId}')/transcripts('${nobody.transcriptId}')`, tenantId: TA }])).status, 202);
  await drain({ sweep: true });
  const forLou = (await lou("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting tie");
  assert.equal(forLou.status, "waiting");
  assert.deepEqual(forLou.candidates.map((c) => c.id), [s.w1], "a lead only sees their own group to pick");
  assert.equal((await ann("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting tie").candidates.length, 2);
  assert.ok(!(await mo("GET", "/api/meetings/auto")).body.recent.some((r) => r.title === "Meeting tie"), "a Member doesn't see waiting meetings");
  assert.equal(await scalar("SELECT COUNT(*) FROM graph_meetings WHERE status = 'skipped' AND title IS NULL"), "1", "nobody's meeting is skipped and its title not kept");
  assert.ok(!JSON.stringify((await ann("GET", "/api/meetings/auto")).body).includes("Meeting nobody"));
  const solo = (await ann("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting solo");
  assert.equal(solo.status, "waiting");
  assert.equal(solo.unclear, true);
  assert.match(solo.reason, /fewer than two people from one group/);
  assert.equal(await scalar("SELECT COUNT(*) FROM meetings WHERE title = 'Meeting solo'"), "0", "nothing written before someone picks");
  s.solo = solo;
  // Who may pick: not a Member, not another org, not a group that isn't a candidate.
  assert.equal((await mo("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.w1 })).status, 403);
  assert.equal((await bob("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.bw })).status, 404, "another org can't even find it");
  assert.equal((await lou("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.w2 })).status, 404, "a lead can't pick a group they don't lead");
  const pick = await lou("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.w1 });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  assert.equal((await ann("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.w2 })).status, 409, "picked once");
  await drain();
  assert.ok((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting tie" && m.status === "Ready"));
  assert.ok(!(await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings.some((m) => m.title === "Meeting tie"));
  s.tie = tie;
});

test(`[${ENGINE}] the meeting's own chat decides the group when it's linked`, async () => {
  // Pat's W2 chat is the meeting chat; the people are mostly W1's, but the chat wins.
  const chat = "19:meeting_w2room@thread.v2";
  await toBot(activity(chat, { type: "installationUpdate", action: "add" }));
  await waitFor(chat, /not set up/);
  assert.equal((await ann("POST", "/api/teams-links", { id: chat, ws: s.w2 })).status, 200);
  addMeeting("room", { organizer: OID.lou, attendees: [OID.mo, OID.vic], chat });
  await drain({ sweep: true });
  assert.ok((await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings.some((m) => m.title === "Meeting room"));
  assert.ok(!(await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting room"));
});

test(`[${ENGINE}] Meet now in a group chat (ad hoc call): needs the call permission, then lands in the chat's group and posts notes once`, async () => {
  // W2's "Wave 2 cutover" group chat; Lou (W1) presses Meet now there and talks with Mo (W1): the chat wins.
  const chat = "19:wave2cutover@thread.v2";
  await toBot(activity(chat, { type: "installationUpdate", action: "add" }));
  await waitFor(chat, /not set up/);
  assert.equal((await ann("POST", "/api/teams-links", { id: chat, ws: s.w2 })).status, 200);
  const wave = addCall("wave", { organizer: OID.lou, chat });
  // Not approved yet: nothing captured, the panel says what to approve, scheduled meetings still polled.
  const meetPolls = pollCalls.length;
  await drain({ sweep: true });
  assert.equal(await scalar(`SELECT COUNT(*) FROM graph_meetings WHERE transcript_id = '${wave.transcriptId}'`), "0");
  assert.ok(pollCalls.length > meetPolls, "scheduled meetings are still checked");
  assert.match((await ann("GET", "/api/meetings/auto")).body.lastError, /new call transcripts permission/);

  // Approved: the poll finds the call held before approval.
  callsApproved.add(TA);
  const from = sent.length;
  await drain({ sweep: true });
  // Approved or not, there's no ad hoc call subscription (Graph v1.0 refuses it): the poll finds calls.
  assert.ok(![...SUBS.values()].some((x) => x.resource === "communications/adhocCalls/getAllTranscripts"));
  assert.ok(callPollCalls.some((c) => c.organizer === OID.lou && new Date(c.from) < new Date(Date.now() - 20 * 60_000)), JSON.stringify(callPollCalls.slice(-3)));
  assert.equal(await scalar(`SELECT kind FROM graph_meetings WHERE transcript_id = '${wave.transcriptId}'`), "adhoc");
  const w2 = (await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings;
  const got = w2.find((m) => m.title === `Chat ${chat} call`);
  assert.ok(got, JSON.stringify(w2.map((m) => m.title)));
  assert.equal(got.status, "Ready");
  assert.equal(got.source, "teams");
  assert.ok(!(await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.id === got.id), "not in the people's group");
  assert.equal((await pat("GET", `/api/meetings/${got.id}`)).body.meeting.duration_min, 20);
  const posts = () => sent.slice(from).filter((m) => JSON.stringify(m.body).includes("MEETING NOTES · W2")).length;
  const start = Date.now();
  while (!posts() && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 150));
  assert.equal(posts(), 1, "notes posted to the group's notes chat");
  assert.equal((await ann("GET", "/api/meetings/auto")).body.lastError, null);
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Captured the Teams call “Chat 19:wave2cutover@thread.v2 call” \(20 min\)/);
  // Polled again: no second meeting, no second post.
  await drain({ sweep: true });
  assert.equal(posts(), 1, "posted once");
  assert.equal((await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings.filter((m) => m.title === got.title).length, 1);

  // A notification for a call in a chat no group has: the people who spoke (Lou and Mo, both W1) decide. (Delivered
  // under the org's one subscription: the handler reads the kind of call from the resource.)
  const callSub = [...SUBS.values()].find((x) => x.tid === TA && x.resource === "communications/onlineMeetings/getAllTranscripts");
  const side = addCall("side", { organizer: OID.lou, chat: "19:unlinked-side@thread.v2" });
  const resource = `users/${OID.lou}/adhocCalls/${side.callId}/transcripts/${side.transcriptId}`;
  assert.equal((await notify([{ subscriptionId: callSub.id, clientState: "guess", resource }])).status, 202);
  assert.equal(await scalar(`SELECT COUNT(*) FROM graph_meetings WHERE transcript_id = '${side.transcriptId}'`), "0", "forged one ignored");
  assert.equal((await notify([{ subscriptionId: callSub.id, clientState: callSub.clientState, changeType: "created", resource, tenantId: TA }])).status, 202);
  assert.equal(await scalar(`SELECT via FROM graph_meetings WHERE transcript_id = '${side.transcriptId}'`), "notification");
  await drain();
  assert.ok((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Teams call" && m.status === "Ready"));
  // A call of nobody's group (Ann alone): skipped, nothing kept but the ids.
  addCall("alone", { organizer: OID.ann, chat: "19:unlinked-alone@thread.v2", speakers: [["Ann Owner", "Just me here."]] });
  await drain({ sweep: true });
  assert.equal(await scalar("SELECT COUNT(*) FROM graph_meetings WHERE kind = 'adhoc' AND status = 'skipped' AND title IS NULL"), "1");
});

test(`[${ENGINE}] throttling: a short Retry-After is waited in place; a long one makes the job wait at least that long`, async () => {
  throttle.meeting.push(1);
  addMeeting("busy1", { organizer: OID.lou, attendees: [OID.mo] });
  await drain({ sweep: true });
  assert.ok((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting busy1"), "fetched after waiting 1 s");

  throttle.meeting.push(600, 600, 600);
  const busy = addMeeting("busy2", { organizer: OID.lou, attendees: [OID.mo] });
  await drain({ sweep: true });
  assert.equal(await scalar(`SELECT status FROM graph_meetings WHERE transcript_id = '${busy.transcriptId}'`), "queued");
  const runAt = await scalar(`SELECT run_at FROM jobs WHERE idempotency_key = 'meeting-fetch:' || (SELECT org_id FROM graph_meetings WHERE transcript_id = '${busy.transcriptId}') || ':${busy.transcriptId}'`);
  assert.ok(new Date(runAt).getTime() > Date.now() + 9 * 60_000, `retried no sooner than Graph asked (${runAt})`);
  assert.match(await scalar(`SELECT last_error FROM jobs WHERE kind = 'meetings.fetch' AND status = 'queued'`), /busy/i);
  // Time passes (the job is due again) and Graph answers: the meeting is captured.
  throttle.meeting.length = 0;
  await dbExec(`UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'meetings.fetch' AND status = 'queued'`);
  await drain();
  assert.ok((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting busy2"));
});

test(`[${ENGINE}] plan limits: over this month's meeting hours, a meeting is skipped with the reason, and can be tried again`, async () => {
  const orgA = (await owner("GET", "/api/owner/tenants")).body.tenants.find((t) => t.name === "Org A").id;
  assert.equal((await owner("PATCH", `/api/owner/tenants/${orgA}/terms`, { limits: { meetingHours: 1 } })).status, 200);
  addMeeting("long", { organizer: OID.lou, attendees: [OID.mo], minutes: 120 });
  await drain({ sweep: true });
  const row = (await ann("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting long");
  assert.equal(row.status, "skipped");
  assert.match(row.reason, /meeting hours on your plan are used up/);
  assert.ok(!(await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting long"));
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Didn't write notes for the Teams meeting “Meeting long”/);
  // Only admins try again; with room on the plan it goes through.
  assert.equal((await lou("POST", "/api/meetings/auto", { action: "retry", id: row.id })).status, 403);
  assert.equal((await owner("PATCH", `/api/owner/tenants/${orgA}/terms`, { limits: { meetingHours: 1000 } })).status, 200);
  assert.equal((await ann("POST", "/api/meetings/auto", { action: "retry", id: row.id })).status, 200);
  await drain();
  assert.ok((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting long"));
});

test(`[${ENGINE}] Save to knowledge: from the Teams card (rebuilt for everyone) and the portal, with roles and walls`, async () => {
  const detail = (await mo("GET", `/api/meetings/${s.meeting1}`)).body;
  const decision = detail.items.find((i) => i.kind === "decision");
  const risk = detail.items.find((i) => i.kind === "risk");
  const question = detail.items.find((i) => i.kind === "question");
  const click = async (verb, itemId, from = { id: "29:mo", name: "Mo Member", aadObjectId: OID.mo }) =>
    (await toBot(activity(CHAT_W1, { type: "invoke", name: "adaptiveCard/action", from, value: { action: { type: "Action.Execute", verb, data: { itemId, meetingId: s.meeting1 } } } }))).text();
  const saved = await click("sidekick.knowledge.save", decision.id);
  assert.match(saved, /application\/vnd\.microsoft\.card\.adaptive/);
  assert.match(saved, /Saved to knowledge by Mo Member/);
  assert.match(saved, /sidekick\.knowledge\.unsave/);
  assert.equal(await scalar(`SELECT pinned FROM items WHERE id = '${decision.id}'`), "1");
  assert.ok(Number(await scalar(`SELECT COUNT(*) FROM passages WHERE source_id = 'saved:${decision.id}'`)) >= 1, "it's its own search source");
  // A Viewer can't, an open question can't be saved, another group's item isn't found from this chat.
  assert.match(await click("sidekick.knowledge.save", risk.id, { id: "29:vic", name: "Vic Viewer", aadObjectId: OID.vic }), /can't save things to knowledge/);
  assert.match(await click("sidekick.knowledge.save", question.id), /Only decisions, requirements/);
  const w2Meeting = (await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings[0];
  const w2Item = (await pat("GET", `/api/meetings/${w2Meeting.id}`)).body.items.find((i) => i.kind === "decision");
  assert.match(await click("sidekick.knowledge.save", w2Item.id), /couldn't find that item in this group/);
  // Undo from the card, then the portal: Members can, Viewers and other orgs can't.
  assert.match(await click("sidekick.knowledge.unsave", decision.id), /Save to knowledge/);
  assert.equal(await scalar(`SELECT COUNT(*) FROM passages WHERE source_id = 'saved:${decision.id}'`), "0");
  assert.equal((await vic("PATCH", `/api/items/${risk.id}`, { saved: true })).status, 403);
  assert.equal((await bob("PATCH", `/api/items/${risk.id}`, { saved: true })).status, 404);
  assert.equal((await pat("PATCH", `/api/items/${risk.id}`, { saved: true })).status, 404, "another group's member can't");
  assert.equal((await mo("PATCH", `/api/items/${risk.id}`, { saved: "yes" })).status, 400);
  const ok = await mo("PATCH", `/api/items/${risk.id}`, { saved: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = (await mo("GET", `/api/meetings/${s.meeting1}`)).body.items.find((i) => i.id === risk.id);
  assert.equal(after.pinned, 1);
  assert.equal(after.saved_by, "Mo Member");
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Saved risk “Test risk” to knowledge in the portal/);
  s.risk = risk.id;
});

test(`[${ENGINE}] Teams tab: single sign-on token checks, the person's own groups only, and actions with their role`, async () => {
  const tab = (who, url, token, method = "GET", body) => who(method, url, body, token === null ? {} : { authorization: `Bearer ${token}` });
  const anon = client();
  assert.equal((await tab(anon, "/api/teams-tab", null)).status, 401, "no token");
  assert.equal((await tab(mo, "/api/teams-tab", null)).status, 401, "a portal cookie isn't enough");
  assert.equal((await tab(anon, "/api/teams-tab", ssoToken(TA, OID.mo, { aud: "api://evil.test/x" }))).status, 401, "wrong audience");
  assert.equal((await tab(anon, "/api/teams-tab", ssoToken(TA, OID.mo, { scp: "User.Read" }))).status, 401, "wrong scope");
  assert.equal((await tab(anon, "/api/teams-tab", ssoToken(TA, OID.mo, { iss: `${MS_BASE}/${TB}/v2.0` }))).status, 401, "issuer of another tenant");
  assert.equal((await tab(anon, "/api/teams-tab", ssoToken(TA, OID.mo, { exp: Math.floor(Date.now() / 1000) - 3600 }))).status, 401, "expired");
  assert.equal((await tab(anon, "/api/teams-tab", ssoToken(TA, OID.outsider))).status, 403, "not a Sidekick user");
  assert.equal((await tab(anon, "/api/teams-tab", ssoToken("cccccccc-3333-4333-8333-333333333333", OID.mo))).status, 403, "a tenant nobody signed up with");

  const moToken = ssoToken(TA, OID.mo, { name: "Mo Member" });
  const view = (await tab(anon, "/api/teams-tab", moToken)).body;
  assert.deepEqual(view.groups.map((g) => g.id), [s.w1]);
  assert.equal(view.ws, s.w1);
  assert.ok(view.meetings.some((m) => m.title === "Meeting m1" && m.source === "teams"));
  assert.ok(view.actions.some((a) => a.text === "Send the test report"));
  assert.equal((await tab(anon, `/api/teams-tab?ws=${s.w2}`, moToken)).status, 404, "not another group");
  assert.equal((await tab(anon, `/api/teams-tab?ws=${s.bw}`, moToken)).status, 404, "not another org");
  // In a chat tab the chat's group opens; one meeting's notes with the saved state.
  const quinnToken = ssoToken(TA, OID.quinn);
  assert.equal((await tab(anon, `/api/teams-tab?chat=${encodeURIComponent("19:meeting_w2room@thread.v2")}`, quinnToken)).body.ws, s.w2);
  assert.equal((await tab(anon, `/api/teams-tab?chat=${encodeURIComponent("19:meeting_w2room@thread.v2")}`, moToken)).body.ws, s.w1, "a chat of a group they're not in doesn't open it");
  const notes = (await tab(anon, `/api/teams-tab?ws=${s.w1}&meeting=${s.meeting1}`, moToken)).body.meeting;
  assert.equal(notes.summary, "Test summary of the meeting.");
  assert.equal(notes.items.find((i) => i.id === s.risk).pinned, 1);
  assert.equal((await tab(anon, `/api/teams-tab?ws=${s.w1}&meeting=${s.meeting1}`, quinnToken)).status, 200);
  assert.equal((await tab(anon, `/api/teams-tab?ws=${s.w2}&meeting=${s.meeting1}`, quinnToken)).status, 404, "a meeting is only found in its own group");
  // Actions: Mo marks an item done; Vic (Viewer) can't; Bob's token sees only Org B.
  const item = view.actions.find((a) => a.text === "Send the test report");
  assert.equal((await tab(anon, "/api/teams-tab", ssoToken(TA, OID.vic), "POST", { action: "done", id: item.id, ws: s.w1 })).status, 403);
  assert.equal((await tab(anon, "/api/teams-tab", moToken, "POST", { action: "done", id: item.id, ws: s.w2 })).status, 404);
  const done = await tab(anon, "/api/teams-tab", moToken, "POST", { action: "done", id: item.id, ws: s.w1 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(await scalar(`SELECT status FROM action_items WHERE id = '${item.id}'`), "Done");
  assert.equal((await tab(anon, "/api/teams-tab", moToken, "POST", { action: "unsave", id: s.risk, ws: s.w1 })).status, 200);
  const bobView = (await tab(anon, "/api/teams-tab", ssoToken(TB, OID.bob))).body;
  assert.deepEqual(bobView.groups.map((g) => g.id), [s.bw]);
  assert.equal(bobView.meetings.length, 0);
});

test(`[${ENGINE}] Teams tab pages: only Teams may frame them; every other page still refuses framing`, async () => {
  for (const p of ["/teams/tab", "/teams/config"]) {
    const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/teams\.microsoft\.com /, p);
    assert.doesNotMatch(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, p);
    assert.equal(r.headers.get("x-frame-options"), null, p);
  }
  for (const p of ["/", "/login", "/pricing", "/api/health"]) {
    const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
    assert.equal(r.headers.get("x-frame-options"), "DENY", p);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, p);
  }
});

test(`[${ENGINE}] people added by email: recognised through the tenant's directory (once, audited); never a guest or another tenant`, async () => {
  // Added by email, never signed in with Microsoft. Jo's sign-in name differs from their Sidekick email (only the
  // mail matches); Gus is a guest in tenant A with a matching mail; Ole's account lives in tenant B; Kai's sign-in
  // name is their Sidekick email.
  for (const [name, email, ws] of [["Jo New", "jo@a.test", s.w1], ["Gus Guest", "gus@client.test", s.w1], ["Ole Other", "ole@a.test", s.w1], ["Kai Email", "kai@a.test", s.w2]]) {
    const u = await ann("POST", "/api/users", { name, email, role: "Member", workspaces: [ws] });
    assert.equal(u.status, 200, JSON.stringify(u.body));
  }
  DIRECTORY.push(
    { tenant: TA, id: OID.jo, upn: "jo.new@a.onmicrosoft.test", mail: "jo@a.test", name: "Jo New" },
    { tenant: TA, id: OID.gus, upn: "gus_client.test#EXT#@a.onmicrosoft.test", mail: "gus@client.test", name: "Gus Guest", userType: "Guest" },
    { tenant: TB, id: OID.ole, upn: "ole@b.test", mail: "ole@a.test", name: "Ole Other" },
    { tenant: TA, id: OID.kai, upn: "kai@a.test", mail: "kai@a.test", name: "Kai Email" },
  );
  const oidOf = (email) => scalar(`SELECT COALESCE(LOWER(entra_oid), '') FROM users WHERE email = '${email}'`);
  // Lou with Jo, Gus and Ole: only Jo counts, so W1 has two people and gets it.
  addMeeting("email1", { organizer: OID.lou, attendees: [OID.jo, OID.gus], others: [{ id: OID.ole, tenantId: TB }] });
  await drain({ sweep: true });
  assert.ok((await lou("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting email1" && m.status === "Ready"));
  assert.equal(await oidOf("jo@a.test"), OID.jo, "Jo's account id was saved");
  assert.equal(await oidOf("gus@client.test"), "", "a guest is never linked, even with a matching mail");
  assert.equal(await oidOf("ole@a.test"), "", "another tenant's account is never linked");
  assert.ok(!dirCalls.some((c) => c.key === OID.ole), "another tenant's invitee isn't even looked up");
  // The poll found Kai (no account id) by their email once, and now checks their meetings.
  assert.equal(await oidOf("kai@a.test"), OID.kai);
  assert.ok(pollCalls.some((c) => c.organizer === OID.kai), "Kai's meetings are polled");
  await drain({ sweep: true });
  assert.equal(dirCalls.filter((c) => c.key === "kai@a.test").length, 1, "looked up once");
  assert.equal(dirCalls.filter((c) => c.key === "jo@a.test").length, 1, "Jo's email was tried once too (no match: their sign-in name differs)");
  // A second meeting with Jo: no second lookup, no second audit line.
  const before = dirCalls.length;
  addMeeting("email2", { organizer: OID.lou, attendees: [OID.jo] });
  await drain({ sweep: true });
  assert.ok((await lou("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting email2"));
  assert.ok(!dirCalls.slice(before).some((c) => c.key === OID.jo));
  assert.equal(await scalar("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%recognised them in a Teams meeting by their email%'"), "1");
  assert.equal(await scalar("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%looked for their Teams meetings by their email%'"), "1");
});

test(`[${ENGINE}] new members: a meeting with one known group person waits; after a pick the picker adds the newcomers (seats respected)`, async () => {
  // Mo (W1) with Nia and Ola (tenant A, not in Sidekick yet), Gus (a guest in tenant A) and a client guest.
  DIRECTORY.push(
    { tenant: TA, id: OID.nia, upn: "nia@a.test", mail: "nia@a.test", name: "Nia New" },
    { tenant: TA, id: OID.ola, upn: "ola@a.test", mail: "ola@a.test", name: "Ola Also" },
  );
  const from = sent.length;
  addMeeting("newbie", { organizer: OID.mo, attendees: [OID.nia, OID.ola, OID.gus], guests: [OID.guest] });
  await drain({ sweep: true });
  const forLou = (await lou("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting newbie");
  assert.equal(forLou?.status, "waiting", "a lead sees it: one of their group's people was there");
  assert.equal(forLou.unclear, true);
  assert.deepEqual(forLou.candidates.map((c) => c.id), [s.w1]);
  assert.ok(!(await pat("GET", "/api/meetings/auto")).body.recent.some((r) => r.title === "Meeting newbie"), "a Member doesn't");
  assert.ok(!(await bob("GET", "/api/meetings/auto")).body.recent.some((r) => r.title === "Meeting newbie"), "another org doesn't");
  const forAnn = (await ann("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting newbie");
  assert.equal(forAnn.candidates[0].id, s.w1, "the groups its people are in come first");
  assert.ok(forAnn.candidates.some((c) => c.id === s.w2), "an admin may pick any group for an unclear meeting");
  // Nothing is written, kept or posted before someone picks: only ids, title and time.
  assert.equal(await scalar("SELECT COUNT(*) FROM meetings WHERE title = 'Meeting newbie'"), "0");
  assert.equal(await scalar("SELECT COALESCE(newcomers, '') || COALESCE(workspace_id, '') FROM graph_meetings WHERE title = 'Meeting newbie'"), "");
  assert.ok(!sentTo(CHAT_W1, from).includes("newbie"));
  // Picking: not a Member, not a group a lead doesn't lead, not another org.
  assert.equal((await mo("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.w1 })).status, 403);
  assert.equal((await lou("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.w2 })).status, 404);
  assert.equal((await bob("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.bw })).status, 404);
  assert.equal((await lou("POST", "/api/meetings/auto", { action: "assign", id: forLou.id, ws: s.w1 })).status, 200);
  await drain();
  assert.ok((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting newbie" && m.status === "Ready"), "notes written after the pick");
  // The picker sees who isn't in W1 yet: Nia and Ola, never the guests or Mo.
  const row = (await lou("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting newbie");
  assert.deepEqual(row.newcomers.map((p) => p.name).sort(), ["Nia New", "Ola Also"]);
  assert.ok(!(await mo("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting newbie").newcomers.length, "only managers see newcomers");
  // Add to group: a lead or admin of that group only, people on the list only.
  assert.equal((await mo("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.nia })).status, 403);
  assert.equal((await vic("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.nia })).status, 403);
  assert.equal((await bob("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.nia })).status, 404);
  assert.equal((await lou("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.gus })).status, 404, "a guest is never offered");
  const added = await lou("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.nia });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.created, true);
  assert.equal(await scalar(`SELECT COUNT(*) FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE u.email = 'nia@a.test' AND wm.workspace_id = '${s.w1}' AND u.role = 'Member' AND LOWER(u.entra_oid) = '${OID.nia}'`), "1");
  assert.equal((await lou("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.nia })).status, 409, "already in");
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Added Nia New \(nia@a\.test\) to group “W1” from the Teams meeting “Meeting newbie”/);
  // A full plan refuses a new person (402); with room it works.
  const orgA = (await owner("GET", "/api/owner/tenants")).body.tenants.find((t) => t.name === "Org A").id;
  assert.equal((await owner("PATCH", `/api/owner/tenants/${orgA}/terms`, { limits: { seats: 1, meetingHours: 1000 } })).status, 200);
  assert.equal((await lou("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.ola })).status, 402);
  assert.equal(await scalar("SELECT COUNT(*) FROM users WHERE email = 'ola@a.test'"), "0");
  assert.equal((await owner("PATCH", `/api/owner/tenants/${orgA}/terms`, { limits: { seats: 1000, meetingHours: 1000 } })).status, 200);
  assert.equal((await ann("POST", "/api/meetings/auto", { action: "add-person", id: row.id, oid: OID.ola })).status, 200);
  assert.deepEqual((await lou("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting newbie").newcomers, [], "the list empties as people are added");
});

test(`[${ENGINE}] title hint: a tie or an unclear meeting goes to the one group its title names, and the notes say so`, async () => {
  assert.equal((await ann("PATCH", `/api/workspaces/${s.w1}`, { client: "Litware", code: "LIT-DATA-26" })).status, 200);
  assert.equal((await ann("PATCH", `/api/workspaces/${s.w2}`, { client: "Fabrikam" })).status, 200);
  // Quinn, Mo and Pat tie between W1 and W2 (as in the tie test); the title names Litware only.
  addMeeting("lit", { organizer: OID.quinn, attendees: [OID.mo, OID.pat], subject: "litware cutover review" });
  // The engagement code works too.
  addMeeting("code", { organizer: OID.quinn, attendees: [OID.mo, OID.pat], subject: "Steering LIT-DATA-26" });
  // Both clients named: still a tie, waits.
  addMeeting("both", { organizer: OID.quinn, attendees: [OID.mo, OID.pat], subject: "Litware and Fabrikam planning" });
  // A client name inside another word doesn't count ("Litwares" is not "Litware").
  addMeeting("part", { organizer: OID.quinn, attendees: [OID.mo, OID.pat], subject: "Litwares offsite" });
  // Unclear (Quinn with someone unknown): the title names Fabrikam, so W2.
  addMeeting("fab", { organizer: OID.quinn, attendees: [OID.outsider], subject: "Fabrikam check-in" });
  await drain({ sweep: true });
  const w1 = (await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings;
  const lit = w1.find((m) => m.title === "litware cutover review");
  assert.ok(lit && w1.some((m) => m.title === "Steering LIT-DATA-26"), JSON.stringify(w1.map((m) => m.title)));
  assert.match((await mo("GET", `/api/meetings/${lit.id}`)).body.meeting.summary, /^Picked Litware from the meeting title\./);
  assert.ok((await pat("GET", `/api/meetings?ws=${s.w2}`)).body.meetings.some((m) => m.title === "Fabrikam check-in"));
  const st = (await ann("GET", "/api/meetings/auto")).body.recent;
  assert.equal(st.find((r) => r.title === "Litware and Fabrikam planning")?.status, "waiting");
  assert.equal(st.find((r) => r.title === "Litwares offsite")?.status, "waiting");
  // Nobody picked these by hand, so there's no newcomers list.
  assert.deepEqual(st.find((r) => r.title === "Fabrikam check-in").newcomers, []);
});

test(`[${ENGINE}] notes prompt: commitments however phrased become action items owned by whoever committed; floated ideas don't`, async () => {
  addMeeting("natural", {
    organizer: OID.lou, attendees: [OID.mo],
    lines: [
      ["Lou Lead", "__COMMITMENTS__ Thanks both, quick one today."],
      ["Mo Member", "The vendor contract is a mess. Leave it with me."],
      ["Lou Lead", "Could you get the load numbers to Pat before the review?"],
      ["Mo Member", "On it."],
      ["Quinn Both", "Maybe we could try a new dashboard for the steering group someday."],
      ["Lou Lead", "Let me check the budget with finance first."],
    ],
  });
  await drain({ sweep: true });
  const m = (await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.find((x) => x.title === "Meeting natural");
  assert.ok(m, "captured");
  const actions = (await mo("GET", `/api/meetings/${m.id}`)).body.actions.map((a) => `${a.owner}: ${a.text}`).sort();
  assert.deepEqual(actions, [
    "Lou Lead: Let me check the budget with finance first.",
    "Mo Member: Could you get the load numbers to Pat before the review?",
    "Mo Member: The vendor contract is a mess. Leave it with me.",
  ]);
});

test(`[${ENGINE}] directory permission missing: email matching can't run, so the Meetings panel says so (managers only) until it works again`, async () => {
  directoryDenied.add(TA);
  addMeeting("nodir", { organizer: OID.lou, attendees: [OID.mo, OID.outsider] });
  await drain({ sweep: true });
  assert.ok((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.some((m) => m.title === "Meeting nodir"), "matching by saved account ids still works");
  const forAnn = (await ann("GET", "/api/meetings/auto")).body;
  assert.match(forAnn.directoryProblem ?? "", /approve reading your directory/);
  const dirRow = (await ann("GET", "/api/microsoft-permissions")).body.rows.find((r) => r.id === "User.Read.All");
  assert.equal(dirRow.status, "missing", "Settings → Microsoft permissions marks the directory permission Not approved");
  assert.match(dirRow.reason, /refused reading your directory/);
  assert.match((await lou("GET", "/api/meetings/auto")).body.directoryProblem ?? "", /added by email/, "a Team Lead sees it too");
  assert.equal((await mo("GET", "/api/meetings/auto")).body.directoryProblem, null, "a Member doesn't");
  assert.equal((await bob("GET", "/api/meetings/auto")).body.directoryProblem ?? null, null, "another org doesn't");
  // Approved: the next lookup works and the notice goes away.
  directoryDenied.delete(TA);
  addMeeting("dirok", { organizer: OID.lou, attendees: [OID.mo, OID.outsider] });
  await drain({ sweep: true });
  assert.equal((await ann("GET", "/api/meetings/auto")).body.directoryProblem, null);
});

test(`[${ENGINE}] isolation: another organization sees none of Org A's Teams meetings or switches`, async () => {
  const st = (await bob("GET", "/api/meetings/auto")).body;
  assert.equal(st.enabled, false);
  assert.deepEqual(st.recent, []);
  assert.equal((await bob("GET", `/api/meetings?ws=${s.w1}`)).status, 404);
  const tie = (await ann("GET", "/api/meetings/auto")).body.recent[0];
  assert.equal((await bob("POST", "/api/meetings/auto", { action: "retry", id: tie.id })).status, 404);
  // Org A's subscription with Org B's own (unknown) meeting: recorded under Org A only if A's state matches.
  assert.equal(await scalar(`SELECT COUNT(*) FROM graph_meetings WHERE org_id <> (SELECT org_id FROM graph_subscriptions LIMIT 1)`), "0");
});

test(`[${ENGINE}] subscription upkeep: a stray subscription Sidekick lost track of is removed, and Graph's 400 is reported with its reason`, async () => {
  // Graph allows one per app and tenant: with the stray left in place the create would hit the limit.
  // A row lost (e.g. a restored database) while Graph still has the subscription: the next upkeep makes a new one
  // and deletes the stray at Graph, so leftovers never pile up or stand in the way.
  const stray = await scalar(`SELECT id FROM ${MEET_SUB}`);
  assert.ok(SUBS.has(stray));
  await dbExec(`DELETE FROM ${MEET_SUB}`);
  await drain({ sweep: true });
  const fresh = await scalar(`SELECT id FROM ${MEET_SUB}`);
  assert.ok(fresh && fresh !== stray && SUBS.has(fresh));
  assert.equal(SUBS.has(stray), false, "the stray was deleted at Graph");
  assert.ok(subCalls.some((c) => c.op === "list" && c.tid === TA), "Graph's list was read first");

  // Oct 28 live: every hourly run failed with a bare "Microsoft Graph answered 400" and used all 4 attempts.
  // Now the job stops at once with Graph's own code and message (nothing secret), and the other resource still runs.
  subRefusal.set("communications/onlineMeetings/getAllTranscripts", {
    error: { code: "ValidationError", message: "Subscription validation request failed. Notification endpoint must respond with 200 OK to validation request. clientState=abcdef Bearer eyJ0eXAiOiJKV1QiLCJhbGciOi" },
  });
  SUBS.delete(fresh);
  await dbExec(`DELETE FROM ${MEET_SUB}`);
  const before = Number(await scalar("SELECT COUNT(*) FROM jobs WHERE kind = 'meetings.subscription' AND status = 'dead'"));
  await drain({ sweep: true });
  const dead = (col) => scalar(`SELECT ${col} FROM jobs WHERE kind = 'meetings.subscription' AND status = 'dead' ORDER BY updated_at DESC, id DESC LIMIT 1`);
  const job = { attempts: await dead("attempts"), last_error: await dead("last_error") };
  assert.equal(Number(await scalar("SELECT COUNT(*) FROM jobs WHERE kind = 'meetings.subscription' AND status = 'dead'")), before + 1);
  assert.equal(Number(job.attempts), 1, "a 400 isn't retried: the same request gets the same answer");
  assert.match(job.last_error, /^GraphRequestError: Microsoft Graph answered 400 ValidationError: Subscription validation request failed/);
  assert.doesNotMatch(job.last_error, /abcdef|eyJ0eX/, "nothing token-like is kept");
  assert.equal(await scalar(`SELECT COUNT(*) FROM ${MEET_SUB}`), "0");
  assert.ok(!subCalls.some((c) => c.op === "limit"), "never a second subscription past Microsoft's limit of one");

  // Another server (same Microsoft app, another address) holds the tenant's one subscription: no create (it would
  // only hit the limit), never deleted, and the job says plainly which address holds it.
  subRefusal.clear();
  SUBS.set("held-elsewhere", { id: "held-elsewhere", tid: TA, resource: "communications/onlineMeetings/getAllTranscripts", notificationUrl: "https://staging.example.test/api/graph/notifications" });
  const creates = subCalls.filter((c) => c.op === "create" || c.op === "limit").length;
  await drain({ sweep: true });
  assert.equal(subCalls.filter((c) => c.op === "create" || c.op === "limit").length, creates, "no create attempted");
  assert.ok(SUBS.has("held-elsewhere"), "someone else's subscription is left alone");
  assert.match(await dead("last_error"), /answered 403 SubscriptionLimit: Microsoft allows one subscription per app and tenant/);

  // Freed (and the 400 fixed at Graph's end): the next upkeep makes it again.
  SUBS.delete("held-elsewhere");
  await drain({ sweep: true });
  assert.equal(await scalar(`SELECT COUNT(*) FROM ${MEET_SUB}`), "1");
  // Renewed, never recreated, while it lives: the next runs make no new one.
  const made = subCalls.filter((c) => c.op === "create").length;
  await dbExec(`UPDATE graph_subscriptions SET expires_at = '${new Date(Date.now() + 3600_000).toISOString()}' WHERE resource = 'communications/onlineMeetings/getAllTranscripts'`);
  await drain({ sweep: true });
  assert.equal(subCalls.filter((c) => c.op === "create").length, made, "renewed in place");
});

test(`[${ENGINE}] subscription upkeep: renewed before it runs out, recreated when Graph forgot or removed it, removed when switched off`, async () => {
  // Less than a day left: renewed in place.
  const renewsBefore = subCalls.filter((c) => c.op === "renew").length;
  await dbExec(`UPDATE graph_subscriptions SET expires_at = '${new Date(Date.now() + 3600_000).toISOString()}' WHERE resource = 'communications/onlineMeetings/getAllTranscripts'`);
  await drain({ sweep: true });
  assert.equal(subCalls.filter((c) => c.op === "renew").length, renewsBefore + 1);
  assert.ok(new Date(await scalar(`SELECT expires_at FROM ${MEET_SUB}`)) > new Date(Date.now() + 2 * 86400_000));
  // Graph lost it (expired): the renewal gets 404 and a new one is made.
  const oldId = await scalar(`SELECT id FROM ${MEET_SUB}`);
  SUBS.delete(oldId);
  await dbExec(`UPDATE graph_subscriptions SET expires_at = '${new Date(Date.now() - 60_000).toISOString()}' WHERE resource = 'communications/onlineMeetings/getAllTranscripts'`);
  await drain({ sweep: true });
  const newId = await scalar(`SELECT id FROM ${MEET_SUB}`);
  assert.notEqual(newId, oldId);
  assert.ok(SUBS.has(newId));
  assert.equal(await scalar(`SELECT COUNT(*) FROM ${MEET_SUB}`), "1");
  // Lifecycle: a forged event is ignored; "reauthorizationRequired" renews, "subscriptionRemoved" recreates, "missed" polls.
  const sub = SUBS.get(newId);
  const life = (value) => fetch(`${BASE}/api/graph/lifecycle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
  assert.equal((await life([{ subscriptionId: newId, clientState: "nope", lifecycleEvent: "subscriptionRemoved" }])).status, 202);
  assert.equal(await scalar(`SELECT id FROM ${MEET_SUB}`), newId);
  const renews = subCalls.filter((c) => c.op === "renew").length;
  assert.equal((await life([{ subscriptionId: newId, clientState: sub.clientState, lifecycleEvent: "reauthorizationRequired" }])).status, 202);
  await drain();
  assert.equal(subCalls.filter((c) => c.op === "renew").length, renews + 1);
  SUBS.delete(newId);
  assert.equal((await life([{ subscriptionId: newId, clientState: sub.clientState, lifecycleEvent: "subscriptionRemoved" }])).status, 202);
  await drain();
  const third = await scalar(`SELECT id FROM ${MEET_SUB}`);
  assert.ok(third && third !== newId && SUBS.has(third));
  const polls = pollCalls.length;
  assert.equal((await life([{ subscriptionId: third, clientState: SUBS.get(third).clientState, lifecycleEvent: "missed" }])).status, 202);
  await drain();
  assert.ok(pollCalls.length > polls, "missed notifications trigger a poll");
  // Switched off: the subscription is removed at Graph, and new transcripts are ignored.
  assert.equal((await ann("PUT", "/api/meetings/auto", { enabled: false })).status, 200);
  await drain();
  assert.equal(SUBS.size, 0);
  assert.equal(await scalar("SELECT COUNT(*) FROM graph_subscriptions"), "0");
  const late = addMeeting("late", { organizer: OID.lou, attendees: [OID.mo] });
  assert.equal((await notify([{ subscriptionId: third, clientState: "x", resource: `communications/onlineMeetings('${late.meetingId}')/transcripts('${late.transcriptId}')` }])).status, 202);
  await drain({ sweep: true });
  assert.equal(await scalar(`SELECT COUNT(*) FROM graph_meetings WHERE transcript_id = '${late.transcriptId}'`), "0");
});

/* ---------- "Turn on transcription" reminders in calls (lib/call-nudge.ts) ---------- */

/** A Teams call event in a chat (`kind`: callStarted, callEnded, callTranscript, callRecording), `minutesAgo` old. */
const callEvent = (kind, callId, minutesAgo) => ({
  id: String(Date.now() - minutesAgo * 60_000 + Math.floor(Math.random() * 1000)), messageType: "systemEventMessage",
  createdDateTime: new Date(Date.now() - minutesAgo * 60_000).toISOString(), body: { contentType: "html", content: "<systemEventMessage/>" },
  eventDetail: { "@odata.type": `#microsoft.graph.${kind}EventMessageDetail`, callId },
});
/** Adds call events to a chat's messages in the fake Graph. */
const postEvents = (chat, ...events) => CHAT_MSGS.set(chat, [...(CHAT_MSGS.get(chat) ?? []), ...events]);
/** How many transcription reminders were posted to a chat since `from`. */
const nudgesIn = (chat, from) => (sentTo(chat, from).match(/Start transcription/g) ?? []).length;
/** "@Sidekick <text>" in a chat from `from` (default Lou, the Team Lead); returns what Sidekick answered. */
async function sayTo(chat, text, from) {
  const i = sent.length;
  const atSidekick = { type: "mention", mentioned: { id: "bot", name: "Sidekick" }, text: "<at>Sidekick</at>" };
  await toBot(activity(chat, { type: "message", text: `<at>Sidekick</at> ${text}`, entities: [atSidekick], ...(from ? { from } : {}) }));
  return waitFor(chat, /./, i);
}
const MO_TEAMS = () => ({ id: "29:mo", name: "Mo Member", aadObjectId: OID.mo });

test(`[${ENGINE}] transcription reminder: a call with no transcription after 2 minutes gets one card, once, traced and audited`, async () => {
  assert.equal((await ann("PUT", "/api/meetings/auto", { enabled: true })).status, 200);
  await drain({ sweep: true });
  const st = (await mo("GET", `/api/workspaces/${s.w1}/call-nudge`)).body;
  assert.equal(st.enabled, true, "on by default");
  assert.equal(st.autoNotes, true);
  assert.equal(st.canManage, false);
  assert.deepEqual(st.unreadable, []);
  // A call started a minute ago: too early.
  const from = sent.length;
  postEvents(CHAT_W1, callEvent("callStarted", "call-1", 1));
  await drain({ sweep: true });
  assert.equal(nudgesIn(CHAT_W1, from), 0);
  const read = chatReads.findLast((r) => r.chat === CHAT_W1);
  assert.ok(read, "the linked group chat is read");
  assert.match(read.prefer, /include-unknown-enum-members/);
  assert.equal(read.orderby, "createdDateTime desc");
  // Three minutes in and still nothing: one reminder, saying where the button is and how to stop these.
  CHAT_MSGS.set(CHAT_W1, [callEvent("callStarted", "call-1", 3)]);
  await drain({ sweep: true });
  const out = await waitFor(CHAT_W1, /Start transcription/, from);
  assert.match(out, /Record and transcribe/);
  assert.match(out, /stop transcription reminders/);
  await drain({ sweep: true });
  assert.equal(nudgesIn(CHAT_W1, from), 1, "once per call");
  assert.equal(await scalar("SELECT status FROM call_nudges WHERE call_id = 'call-1'"), "nudged");
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Reminded%transcription%' ORDER BY id DESC LIMIT 1"), /to start transcription/);
  let traced = "0";
  for (let i = 0; i < 40 && traced === "0"; i++) {
    traced = await scalar("SELECT COUNT(*) FROM traces WHERE name = 'Transcription reminder'");
    if (traced === "0") await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(traced, "1", "a reminder shows on the Activity page");
  assert.ok((await lou("GET", `/api/workspaces/${s.w1}/call-nudge`)).body.last?.chat, "the tab shows the latest reminder");
});

test(`[${ENGINE}] transcription reminder: nothing for a transcribed, ended or old call, nor twice within 30 minutes; quiet days respected`, async () => {
  const from = sent.length;
  postEvents(CHAT_W1,
    callEvent("callStarted", "call-2", 4), callEvent("callTranscript", "call-2", 3),
    callEvent("callStarted", "call-3", 5), callEvent("callEnded", "call-3", 1),
    callEvent("callStarted", "call-4", 45),
    callEvent("callStarted", "call-5", 3));
  await drain({ sweep: true });
  assert.equal(nudgesIn(CHAT_W1, from), 0);
  assert.equal(await scalar("SELECT status FROM call_nudges WHERE call_id = 'call-2'"), "transcribing");
  assert.equal(await scalar("SELECT status FROM call_nudges WHERE call_id = 'call-3'"), "ended");
  assert.equal(await scalar("SELECT COUNT(*) FROM call_nudges WHERE call_id = 'call-4'"), "0", "old calls aren't even kept");
  assert.equal(await scalar("SELECT status FROM call_nudges WHERE call_id = 'call-5'"), "skipped", "the chat had a reminder minutes ago");
  // A chat with reminders on and every day quiet: no reminder.
  await dbExec("DELETE FROM call_nudges");
  const org = await scalar(`SELECT org_id FROM workspaces WHERE id = '${s.w1}'`);
  const quiet = JSON.stringify({ reminders: true, quietDays: [0, 1, 2, 3, 4, 5, 6], timeZone: "Europe/London" });
  const saved = await scalar(`SELECT json FROM teams_chat_settings WHERE conversation_id = '${CHAT_W1}'`);
  await dbExec(`DELETE FROM teams_chat_settings WHERE conversation_id = '${CHAT_W1}'`);
  await dbExec(`INSERT INTO teams_chat_settings (conversation_id, org_id, workspace_id, json, updated_by, updated_at) VALUES ('${CHAT_W1}', '${org}', '${s.w1}', '${quiet}', 'test', '${new Date().toISOString()}')`);
  CHAT_MSGS.set(CHAT_W1, [callEvent("callStarted", "call-6", 3)]);
  await drain({ sweep: true });
  assert.equal(nudgesIn(CHAT_W1, from), 0);
  assert.equal(await scalar("SELECT status FROM call_nudges WHERE call_id = 'call-6'"), "quiet");
  await dbExec(saved ? `UPDATE teams_chat_settings SET json = '${saved.replaceAll("'", "''")}' WHERE conversation_id = '${CHAT_W1}'` : `DELETE FROM teams_chat_settings WHERE conversation_id = '${CHAT_W1}'`);
});

test(`[${ENGINE}] transcription reminder: the switch (Team Lead or admin, portal or Teams), audited; off means the chat isn't read`, async () => {
  const url = `/api/workspaces/${s.w1}/call-nudge`;
  assert.equal((await mo("PUT", url, { enabled: false })).status, 403, "a Member can't switch it");
  assert.equal((await vic("PUT", url, { enabled: false })).status, 403);
  assert.equal((await pat("GET", url)).status, 404, "another group's people don't see it");
  assert.equal((await bob("GET", url)).status, 404, "another organization doesn't see it");
  assert.equal((await bob("PUT", url, { enabled: false })).status, 404);
  assert.equal((await ann("PUT", url, { enabled: "no" })).status, 400);
  const off = await lou("PUT", url, { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.changedBy, "Lou Lead");
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Turned off%transcription%' ORDER BY id DESC LIMIT 1"), /Turned off/);
  await dbExec("DELETE FROM call_nudges");
  const from = sent.length;
  const reads = chatReads.filter((r) => r.chat === CHAT_W1).length;
  CHAT_MSGS.set(CHAT_W1, [callEvent("callStarted", "call-7", 3)]);
  await drain({ sweep: true });
  assert.equal(nudgesIn(CHAT_W1, from), 0);
  assert.equal(chatReads.filter((r) => r.chat === CHAT_W1).length, reads, "a switched-off group's chats aren't read");
  // From Teams: a Member is refused; the Team Lead turns it back on, and the running call gets its reminder.
  assert.match(await sayTo(CHAT_W1, "start transcription reminders", MO_TEAMS()), /Only the Team Lead or an admin/);
  assert.equal((await ann("GET", url)).body.enabled, false);
  assert.match(await sayTo(CHAT_W1, "start transcription reminders"), /Done/);
  assert.equal((await ann("GET", url)).body.enabled, true);
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Turned on%transcription%' ORDER BY id DESC LIMIT 1"), /from Teams/);
  const before = sent.length;
  await drain({ sweep: true });
  await waitFor(CHAT_W1, /Start transcription/, before);
  assert.match(await sayTo(CHAT_W1, "stop transcription reminders"), /won't remind/);
  assert.equal((await ann("GET", url)).body.enabled, false);
  assert.match(await sayTo(CHAT_W1, "stop transcription reminders"), /already off/);
  assert.equal((await lou("PUT", url, { enabled: true })).status, 200);
});

test(`[${ENGINE}] transcription reminder: a chat Microsoft won't let Sidekick read is named on the Teams chats tab`, async () => {
  chatDenied.add(CHAT_W1);
  await drain({ sweep: true });
  const st = (await lou("GET", `/api/workspaces/${s.w1}/call-nudge`)).body;
  assert.equal(st.unreadable.length, 1, JSON.stringify(st));
  assert.notEqual(await scalar(`SELECT error FROM call_watch WHERE conversation_id = '${CHAT_W1}'`), "");
  chatDenied.delete(CHAT_W1);
  await drain({ sweep: true });
  assert.deepEqual((await lou("GET", `/api/workspaces/${s.w1}/call-nudge`)).body.unreadable, []);
});


/* ---------- Meetings that record and transcribe by themselves (lib/auto-record.ts) ---------- */

/** A Teams join link for a meeting (with the characters real ones have: %, ?, quotes in context). */
const joinUrlFor = (name) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${name}%40thread.v2/0?context=%7b%22Tid%22%3a%22${TA}%22%7d&n='${name}'`;
/**
 * Schedules a Teams meeting in the fake Graph: an online meeting (no transcript yet) plus the organizer's calendar
 * event(s) for it, `occurrences` days apart (a recurring series shares one join link). Returns the meeting id.
 */
function schedule(name, { organizer, attendees = [], guests = [], emails = [], chat, inDays = 1, occurrences = 1, recordAutomatically = false, event = {} } = {}) {
  const thread = chat ?? `19:meeting_${name}@thread.v2`;
  const meetingId = meetingIdFor(organizer, thread);
  const joinUrl = joinUrlFor(name);
  const start = new Date(Date.now() + inDays * 86400_000);
  MEETINGS.set(meetingId, {
    organizer, joinUrl,
    body: {
      id: meetingId, subject: `Planned ${name}`, startDateTime: start.toISOString(), endDateTime: new Date(start.getTime() + 1800_000).toISOString(), chatInfo: { threadId: thread }, joinWebUrl: joinUrl, recordAutomatically,
      participants: {
        organizer: { identity: { user: { id: organizer, tenantId: TA } } },
        attendees: [...attendees.map((id) => ({ identity: { user: { id, tenantId: TA } } })), ...guests.map((id) => ({ identity: { user: { id, tenantId: TG } } }))],
      },
    },
  });
  for (let i = 0; i < occurrences; i++) {
    const at = new Date(start.getTime() + i * 86400_000);
    EVENTS.push({
      calendar: organizer,
      event: {
        subject: `Planned ${name}`, start: { dateTime: at.toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" },
        end: { dateTime: new Date(at.getTime() + 1800_000).toISOString().slice(0, 19) + ".0000000", timeZone: "UTC" }, isOrganizer: true, isCancelled: false, isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness", onlineMeeting: { joinUrl },
        attendees: [...emails.map((address) => ({ type: "required", emailAddress: { address } })), { type: "resource", emailAddress: { address: "room-1@a.test" } }],
        ...event,
      },
    });
  }
  return meetingId;
}
const patched = (id) => patches.filter((x) => x.id === id).length;

test(`[${ENGINE}] meetings that record by themselves: off by default, admins only, needs automatic notes on, refused permissions said plainly`, async () => {
  const st = (await ann("GET", "/api/meetings/auto")).body;
  assert.equal(st.enabled, true, "automatic notes are on from the reminder tests");
  assert.equal(st.autoRecord.enabled, false, "off by default");
  assert.equal((await lou("PUT", "/api/meetings/auto", { autoRecord: true })).status, 403, "a Team Lead can't switch it");
  assert.equal((await mo("PUT", "/api/meetings/auto", { autoRecord: true })).status, 403);
  assert.equal((await ann("PUT", "/api/meetings/auto", { autoRecord: "yes" })).status, 400);
  assert.equal((await bob("PUT", "/api/meetings/auto", { autoRecord: true })).status, 409, "Org B hasn't turned on automatic notes");
  // Nothing is read from calendars while it's off.
  s.plan = schedule("plan", { organizer: OID.lou, attendees: [OID.mo], emails: ["mo@a.test", "quinn@a.test"] });
  await drain({ sweep: true });
  assert.equal(calendarReads.length, 0);
  assert.equal(patches.length, 0);
  // On, but tenant A hasn't approved the new permissions yet: the scan says what to approve and changes nothing.
  const on = await ann("PUT", "/api/meetings/auto", { autoRecord: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  await drain();
  const after = (await ann("GET", "/api/meetings/auto")).body.autoRecord;
  assert.equal(after.enabled, true);
  assert.match(after.lastError, /approve the new permissions to read calendars and change Teams meetings/);
  assert.equal(patches.length, 0);
  assert.equal((await lou("GET", "/api/meetings/auto")).body.autoRecord.lastError, after.lastError, "a Team Lead sees the problem too");
  assert.equal((await mo("GET", "/api/meetings/auto")).body.autoRecord.lastError, null, "a Member doesn't");
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Turned on automatic recording and transcription for groups' scheduled Teams meetings \(Teams also saves a video recording\)/);
});

test(`[${ENGINE}] meetings that record by themselves: clearly one group's meetings are set once; outsiders, ties and minorities are left alone`, async () => {
  recordApproved.add(TA);
  const series = schedule("series", { organizer: OID.lou, emails: ["mo@a.test"], occurrences: 3 });
  const linked = schedule("linked", { organizer: OID.lou, attendees: [OID.mo, OID.vic], chat: "19:meeting_w2room@thread.v2" }); // chat linked to W2
  const client = schedule("client", { organizer: OID.lou, attendees: [OID.mo], guests: [OID.guest] });
  const tie = schedule("tie2", { organizer: OID.quinn, emails: ["mo@a.test", "pat@a.test"] });
  const minority = schedule("minority", { organizer: OID.lou, emails: ["mo@a.test", "x1@elsewhere.test", "x2@elsewhere.test", "x3@elsewhere.test"] });
  const already = schedule("already", { organizer: OID.lou, emails: ["mo@a.test"], recordAutomatically: true });
  const refused = schedule("refused", { organizer: OID.lou, emails: ["quinn@a.test"] });
  patchRefused.add(refused);
  const notMine = schedule("notmine", { organizer: OID.lou, emails: ["mo@a.test"], event: { isOrganizer: false } });
  const cancelled = schedule("cancelled", { organizer: OID.lou, emails: ["mo@a.test"], event: { isCancelled: true } });
  const later = schedule("later", { organizer: OID.lou, emails: ["mo@a.test"], inDays: 10 });
  assert.equal((await ann("POST", "/api/meetings/auto", { action: "check" })).status, 200);
  // Check now and the 30-minute scan run together: each meeting is still claimed, set and audited once.
  await drain({ sweep: true });
  // The calendar is read for the next 7 days, in UTC, keeping to the fields Sidekick needs.
  const read = calendarReads.find((c) => c.organizer === OID.lou);
  assert.ok(read, JSON.stringify(calendarReads));
  assert.ok(new Date(read.end) - new Date(read.start) <= 7 * 86400_000 + 1000);
  assert.match(read.prefer, /outlook\.timezone="UTC"/);
  assert.doesNotMatch(read.select, /body/);
  assert.ok(calendarReads.every((c) => c.organizer !== OID.bob), "never another organization's people");
  // The join link is looked up exactly (quotes doubled and undone, encoding kept).
  assert.ok(lookups.some((l) => l.url === joinUrlFor("plan")), JSON.stringify(lookups.slice(0, 2)));
  // Set: the plan (all W1), the series once, the meeting whose chat is linked to W2.
  assert.equal(patched(s.plan), 1);
  assert.deepEqual(patches.find((x) => x.id === s.plan).body, { recordAutomatically: true }, "nothing else is changed");
  assert.equal(patched(series), 1, "a recurring series is set once");
  assert.equal(patched(linked), 1);
  // Left alone.
  for (const id of [client, tie, minority, already, notMine, cancelled, later]) assert.equal(patched(id), 0);
  const status = (id) => scalar(`SELECT status || '|' || COALESCE(reason, '') FROM meeting_autorecord WHERE online_meeting_id = '${id}'`);
  assert.match(await status(client), /^skipped\|People from outside your organization/);
  assert.match(await status(tie), /^skipped\|Several groups/);
  assert.match(await status(minority), /^skipped\|Fewer than half/);
  assert.match(await status(already), /^already\|/);
  assert.match(await status(refused), /^failed\|Microsoft Teams didn't accept the change/);
  assert.equal(await scalar("SELECT COUNT(*) FROM meeting_autorecord WHERE status = 'skipped' AND title IS NOT NULL"), "0", "titles of meetings left alone aren't kept");
  assert.equal(await scalar(`SELECT workspace_id FROM meeting_autorecord WHERE online_meeting_id = '${linked}'`), s.w2);
  // Audited per meeting, traced, and the scan's own status is clean.
  const audit = JSON.stringify((await ann("GET", "/api/audit")).body);
  assert.equal((audit.match(/Turned on automatic recording and transcription for the Teams meeting “Planned plan”/g) ?? []).length, 1, "audited once");
  assert.doesNotMatch(audit, /Planned client|Planned minority/);
  assert.notEqual(await scalar("SELECT COUNT(*) FROM trace_spans WHERE name = 'Turn on automatic recording for a Teams meeting'"), "0");
  assert.notEqual(await scalar("SELECT COUNT(*) FROM trace_spans WHERE name = 'Read upcoming Teams meetings'"), "0");
  const st = (await ann("GET", "/api/meetings/auto")).body.autoRecord;
  assert.equal(st.lastError, null);
  assert.ok(st.failed.some((f) => f.title === "Planned refused" && /meeting policy allows automatic recording/.test(f.reason)), JSON.stringify(st.failed));
  // Each group's people see their own group's upcoming meetings only.
  const forMo = (await mo("GET", "/api/meetings/auto")).body.autoRecord.upcoming.map((m) => m.title);
  assert.ok(forMo.includes("Planned plan") && forMo.includes("Planned already"), JSON.stringify(forMo));
  assert.ok(!forMo.includes("Planned linked"), "W2's meeting isn't shown to a W1-only member");
  assert.deepEqual((await mo("GET", "/api/meetings/auto")).body.autoRecord.failed, [], "Members don't see problems");
  assert.ok((await pat("GET", "/api/meetings/auto")).body.autoRecord.upcoming.some((m) => m.title === "Planned linked" && m.group === "W2"));
  s.recordSkipped = client;
});

test(`[${ENGINE}] meetings that record by themselves: an organizer turning it off stays off; skipped ones are looked at again later; off stops reading`, async () => {
  // Lou switches recording off again in Meeting options: Sidekick doesn't turn it back on.
  MEETINGS.get(s.plan).body.recordAutomatically = false;
  const before = patches.length;
  const lookupsBefore = lookups.length;
  await drain({ sweep: true });
  assert.equal(patches.filter((x) => x.id === s.plan).length, 1, "set once, never again");
  // Nothing else is patched; the refused one is tried again (it failed), the skipped ones aren't yet.
  assert.deepEqual(patches.slice(before).map((x) => x.id), []);
  assert.ok(!lookups.slice(lookupsBefore).some((l) => l.url === joinUrlFor("client")), "a skipped meeting isn't looked up again within a day");
  assert.ok(lookups.slice(lookupsBefore).some((l) => l.url === joinUrlFor("refused")), "a failed one is");
  // A day later the skipped one is looked at again (its invitees may have changed); the guest is gone now.
  MEETINGS.get(s.recordSkipped).body.participants.attendees = [{ identity: { user: { id: OID.mo, tenantId: TA } } }];
  await dbExec(`UPDATE meeting_autorecord SET updated_at = '${new Date(Date.now() - 2 * 86400_000).toISOString()}' WHERE status = 'skipped'`);
  await drain({ sweep: true });
  assert.equal(patched(s.recordSkipped), 1);
  // Switched off: audited, and calendars aren't read any more.
  assert.equal((await ann("PUT", "/api/meetings/auto", { autoRecord: false })).status, 200);
  // (The transcription reminder for scheduled meetings reads the next 2 hours; only 7-day reads are automatic recording's.)
  const recordReads = () => calendarReads.filter((c) => new Date(c.end) - new Date(c.start) > 86400_000).length;
  const reads = recordReads();
  await drain({ sweep: true });
  assert.equal(recordReads(), reads);
  assert.equal((await ann("GET", "/api/meetings/auto")).body.autoRecord.enabled, false);
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Turned off automatic recording and transcription/);
  // Isolation: Org B sees none of it.
  const b = (await bob("GET", "/api/meetings/auto")).body.autoRecord;
  assert.equal(b.enabled, false);
  assert.deepEqual(b.upcoming, []);
  assert.deepEqual(b.failed, []);
  assert.equal(await scalar(`SELECT COUNT(*) FROM meeting_autorecord WHERE org_id <> (SELECT org_id FROM users WHERE email = 'ann@a.test')`), "0");
});

test(`[${ENGINE}] meetings that record by themselves: invitees who never signed in with Microsoft count by email (live case, Oct 25)`, async () => {
  // Like Cody's live meeting: the organizer (Quinn, in W1 and W2) has a Microsoft account id; the two invitees are W1
  // people with no Microsoft account id in Sidekick, invited by email in another case; the meeting lists no attendees.
  for (const [name, email] of [["Jo Noid", "jo.noid@a.test"], ["Oz Noid", "oz.noid@a.test"]]) {
    const u = await ann("POST", "/api/users", { name, email, role: "Member", workspaces: [s.w1] });
    assert.equal(u.status, 200, JSON.stringify(u.body));
  }
  const live = schedule("live", { organizer: OID.quinn, emails: ["JO.NOID@A.test", "Oz.Noid@A.Test", "quinn.other-address@a.test"], event: { organizer: { emailAddress: { address: "quinn.other-address@a.test" } } } });
  const unknown = schedule("unknowns", { organizer: OID.quinn, emails: ["jo.noid@a.test", "who1@a.test", "who2@a.test", "who3@a.test"] });
  // Turning the switch back on scans at once and looks again at meetings it left alone before.
  assert.equal((await ann("PUT", "/api/meetings/auto", { autoRecord: true })).status, 200);
  await drain();
  assert.equal(patched(live), 1, "two of W1's people invited by email plus the organizer: W1's meeting");
  assert.equal(await scalar(`SELECT workspace_id FROM meeting_autorecord WHERE online_meeting_id = '${live}'`), s.w1);
  assert.equal(patched(unknown), 0, "Quinn and Jo are 2 of 5 invited: not most of the meeting");
  assert.match(await scalar(`SELECT reason FROM meeting_autorecord WHERE online_meeting_id = '${unknown}'`), /Fewer than half/);
  // Admins and leads see how many upcoming meetings were left alone and why (no titles); Members don't.
  const st = (await ann("GET", "/api/meetings/auto")).body.autoRecord;
  assert.ok(st.skipped.some((k) => /Fewer than half/.test(k.reason) && k.count >= 1), JSON.stringify(st.skipped));
  assert.ok(!JSON.stringify(st.skipped).includes("Planned"), "no titles");
  assert.deepEqual((await mo("GET", "/api/meetings/auto")).body.autoRecord.skipped, []);
  assert.equal((await ann("PUT", "/api/meetings/auto", { autoRecord: false })).status, 200);
});


/* ---------- "Is this meeting being transcribed?" for scheduled meetings (lib/meeting-nudge.ts) ---------- */

/** Days from now for a meeting that started `n` minutes ago (negative) or starts in `n` minutes. */
const minutes = (n) => n / 1440;
/** The meeting_nudges row of an online meeting: "status|posted_to". */
const remindRow = (id) => scalar(`SELECT status || '|' || COALESCE(posted_to, '') FROM meeting_nudges WHERE online_meeting_id = '${id}'`);

test(`[${ENGINE}] scheduled meetings: one reminder in the meeting's chat where Sidekick is, else in the group's notes chat; nothing when transcribing`, async () => {
  const st = (await lou("GET", `/api/workspaces/${s.w1}/call-nudge`)).body;
  assert.equal(st.enabled, true);
  assert.equal(st.autoNotes, true);
  // Sidekick was added to two meeting chats (not assigned to a group); the others' chats it can't see.
  const standupChat = "19:meeting_standup@thread.v2";
  const retroChat = "19:meeting_retro@thread.v2";
  for (const chat of [standupChat, retroChat]) {
    await toBot(activity(chat, { type: "installationUpdate", action: "add" }));
    await waitFor(chat, /not set up/);
  }
  const from = sent.length;
  const standup = schedule("standup", { organizer: OID.lou, attendees: [OID.mo], emails: ["mo@a.test"], inDays: minutes(-3) });
  CHAT_MSGS.set(standupChat, [callEvent("callStarted", "standup-call", 3)]);
  const retro = schedule("retro", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(-4) });
  CHAT_MSGS.set(retroChat, [callEvent("callStarted", "retro-call", 4), callEvent("callRecording", "retro-call", 3)]);
  const review = schedule("review", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(-4) });
  const demo = schedule("demo", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(-5) });
  TRANSCRIPTS.push({ id: "MSMjdemo-transcript", meetingId: demo, organizer: OID.lou, createdDateTime: "2020-01-01T00:00:00.000Z", vtt: vtt([["Lou Lead", "Demo."]]) });
  const early = schedule("early", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(-1) });
  const later = schedule("soonmeeting", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(40) });
  const tie = schedule("tiemeeting", { organizer: OID.quinn, emails: ["mo@a.test", "pat@a.test"], inDays: minutes(-3) });
  await drain({ sweep: true });
  // In the meeting's own chat: the steps, and how to stop them from the portal (no chat commands in an unassigned chat).
  const inChat = await waitFor(standupChat, /Start transcription/, from);
  assert.match(inChat, /This meeting isn't being transcribed yet/);
  assert.match(inChat, /Record and transcribe/);
  assert.match(inChat, /Teams chats tab/);
  assert.ok(chatReads.some((r) => r.chat === standupChat && /include-unknown-enum-members/.test(r.prefer)), "the meeting chat is read for call events");
  // Not in the meeting's chat: the group's notes chat, naming the meeting.
  const inNotes = await waitFor(CHAT_W1, /Start transcription/, from);
  assert.match(inNotes, /Planned review/);
  assert.match(inNotes, /can't see whether it's being transcribed/);
  assert.match(inNotes, /stop transcription reminders/);
  assert.ok(transcriptLists.some((t) => t.id === review), "Microsoft's transcript list is checked first");
  assert.match(await remindRow(standup), /^nudged\|meeting$/);
  assert.match(await remindRow(review), /^nudged\|notes$/);
  // Nothing for a meeting being recorded, one Teams already lists a transcript for, one that just started, one later,
  // or a meeting of two groups (left alone, its title not kept).
  assert.equal(nudgesIn(retroChat, from), 0);
  assert.doesNotMatch(sentTo(CHAT_W1, from), /Planned demo|Planned early|Planned soonmeeting|Planned tiemeeting/);
  assert.match(await remindRow(retro), /^transcribing\|/);
  assert.match(await remindRow(demo), /^transcribing\|/);
  assert.match(await remindRow(early), /^planned\|/);
  assert.match(await remindRow(later), /^planned\|/);
  assert.equal(await scalar(`SELECT status || '|' || COALESCE(title, '') FROM meeting_nudges WHERE online_meeting_id = '${tie}'`), "skipped|", "ties are left alone, titles not kept");
  // (The meeting that just started would be reminded a minute later; settle it so later tests count only their own.)
  await dbExec(`UPDATE meeting_nudges SET status = 'late' WHERE online_meeting_id = '${early}'`);
  // Once per meeting: more checks post nothing new.
  await drain({ sweep: true });
  await drain({ sweep: true });
  assert.equal(nudgesIn(standupChat, from), 1);
  assert.equal(nudgesIn(CHAT_W1, from), 1);
  // Audited, traced, and shown on the Teams chats tab.
  const audit = JSON.stringify((await ann("GET", "/api/audit")).body);
  assert.match(audit, /Reminded the Teams meeting “Planned standup” to start transcription in its chat/);
  assert.match(audit, /to start transcription in the Teams meeting “Planned review”/);
  assert.notEqual(await scalar("SELECT COUNT(*) FROM trace_spans WHERE name = 'Post the transcription reminder for a scheduled meeting'"), "0");
  assert.notEqual(await scalar("SELECT COUNT(*) FROM trace_spans WHERE name = 'Read the next Teams meetings'"), "0");
  const after = (await mo("GET", `/api/workspaces/${s.w1}/call-nudge`)).body;
  assert.match(after.last.chat, /Planned (standup|review)/);
  assert.equal(after.scheduledProblem, null);
  // A meeting moved before it starts is forgotten at the next read.
  EVENTS.splice(EVENTS.findIndex((e) => e.event.subject === "Planned soonmeeting"), 1);
  await drain({ sweep: true });
  assert.match(await remindRow(later), /^gone\|/);
});

test(`[${ENGINE}] scheduled meetings: nothing when the group switched reminders off or the meeting records by itself`, async () => {
  const url = `/api/workspaces/${s.w1}/call-nudge`;
  assert.equal((await lou("PUT", url, { enabled: false })).status, 200);
  const from = sent.length;
  const off = schedule("offmeeting", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(-3) });
  await drain({ sweep: true });
  assert.equal(nudgesIn(CHAT_W1, from), 0);
  assert.match(await remindRow(off), /^off\|/);
  assert.equal((await lou("PUT", url, { enabled: true })).status, 200);
  // Recording by itself: set in Teams already, or by Sidekick (automatic recording's row for the same join link).
  const selfRec = schedule("selfrecording", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(-3), recordAutomatically: true });
  const sidekickRec = schedule("sidekickrecording", { organizer: OID.lou, attendees: [OID.mo], inDays: minutes(-3) });
  const org = await scalar("SELECT org_id FROM users WHERE email = 'ann@a.test'");
  const key = crypto.createHash("sha256").update(joinUrlFor("sidekickrecording")).digest("hex");
  const t = new Date().toISOString();
  await dbExec(`INSERT INTO meeting_autorecord (org_id, join_key, organizer_oid, workspace_id, status, title, starts_at, created_at, updated_at) VALUES ('${org}', '${key}', '${OID.lou}', '${s.w1}', 'set', 'Planned sidekickrecording', '${t}', '${t}', '${t}')`);
  await drain({ sweep: true });
  assert.equal(nudgesIn(CHAT_W1, from), 0);
  assert.match(await remindRow(selfRec), /^records\|/);
  assert.match(await remindRow(sidekickRec), /^records\|/);
});

test(`[${ENGINE}] scheduled meetings: a refused calendar read is shown on the Teams chats tab; another organization sees none of it`, async () => {
  recordApproved.delete(TA);
  await drain({ sweep: true });
  const st = (await lou("GET", `/api/workspaces/${s.w1}/call-nudge`)).body;
  assert.match(st.scheduledProblem ?? "", /can't see your groups' scheduled Teams meetings/);
  recordApproved.add(TA);
  await drain({ sweep: true });
  assert.equal((await lou("GET", `/api/workspaces/${s.w1}/call-nudge`)).body.scheduledProblem, null);
  // Isolation: rows only for Org A; Org B can't see Org A's group or its reminders.
  assert.equal(await scalar(`SELECT COUNT(*) FROM meeting_nudges WHERE org_id <> (SELECT org_id FROM users WHERE email = 'ann@a.test')`), "0");
  assert.equal((await bob("GET", `/api/workspaces/${s.w1}/call-nudge`)).status, 404);
  assert.equal((await pat("GET", `/api/workspaces/${s.w1}/call-nudge`)).status, 404);
  const b = (await bob("GET", `/api/workspaces/${s.bw}/call-nudge`)).body;
  assert.equal(b.last, null);
  assert.equal(b.scheduledProblem, null);
  assert.ok(calendarReads.every((c) => c.organizer !== OID.bob), "never another organization's calendars");
});


/* ---------- Live in Teams meetings (lib/live-meetings/, fake Recall.ai) ---------- */

/** Uploads a text document to a group as `call` (`audience` internal or shareable). */
async function uploadDoc(call, ws, name, text, audience = "internal") {
  const form = new FormData();
  form.append("ws", ws);
  form.append("audience", audience);
  form.append("files", new File([text], name, { type: "text/markdown" }));
  const r = await call("POST", "/api/docs", form);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const LIVE1 = "19:meeting_live1@thread.v2";
/** Graph tells the app a meeting's transcript is ready, through Org A's current subscription (recreated by the upkeep tests). */
function transcriptReady(m) {
  const sub = [...SUBS.values()].find((x) => x.tid === TA && x.resource === "communications/onlineMeetings/getAllTranscripts");
  assert.ok(sub, "Org A's transcript subscription");
  return notify([{ subscriptionId: sub.id, clientState: sub.clientState, changeType: "created", resource: `communications/onlineMeetings('${m.meetingId}')/transcripts('${m.transcriptId}')`, tenantId: TA }]);
}
const liveUrl = (ws) => `/api/workspaces/${ws}/live`;
const sessionOf = (botId, col) => scalar(`SELECT ${col} FROM live_sessions WHERE bot_id = '${botId}'`);
/** Waits until a session's column has the expected value (the webhook's follow-ups run after its reply). */
async function waitSession(botId, col, want, ms = 20000) {
  const start = Date.now();
  let got;
  while (Date.now() - start < ms) {
    got = await sessionOf(botId, col);
    if (got === want) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(got, want, `${botId} ${col}`);
}

test(`[${ENGINE}] live: the group switch is Enterprise only, for the Team Lead or an admin, audited; another organization can't see it`, async () => {
  const st = (await mo("GET", liveUrl(s.w1))).body;
  assert.equal(st.mode, "off", "off by default");
  assert.equal(st.canManage, false);
  assert.equal(st.configured, true);
  s.orgA = (await owner("GET", "/api/owner/tenants")).body.tenants.find((t) => t.name === "Org A").id;
  assert.equal((await owner("PATCH", `/api/owner/tenants/${s.orgA}/billing`, { plan: "business", status: "active" })).status, 200);
  assert.equal((await lou("GET", liveUrl(s.w1))).body.included, false);
  const refused = await lou("PUT", liveUrl(s.w1), { mode: "ask" });
  assert.equal(refused.status, 402, "not in the Business plan");
  assert.match(refused.body.error, /Live in meetings/);
  assert.equal((await mo("PUT", liveUrl(s.w1), { mode: "ask" })).status, 403, "a Member can't switch it");
  assert.equal((await owner("PATCH", `/api/owner/tenants/${s.orgA}/billing`, { plan: "enterprise" })).status, 200);
  assert.equal((await lou("PUT", liveUrl(s.w1), { mode: "sometimes" })).status, 400);
  const on = await lou("PUT", liveUrl(s.w1), { mode: "ask" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.mode, "ask");
  assert.equal(on.body.changedBy, "Lou Lead");
  assert.equal(on.body.hours.limit, 100, "Enterprise includes 100 live hours a month");
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Turned Sidekick live in meetings%' ORDER BY id DESC LIMIT 1"), /on when someone asks/);
  assert.equal((await bob("GET", liveUrl(s.w1))).status, 404, "another organization's group is not found");
  assert.equal((await bob("PUT", liveUrl(s.w1), { mode: "off" })).status, 404);
});

test(`[${ENGINE}] live: @Sidekick join in a meeting chat joins as "Sidekick (notes)", says how to remove it, and answers "Sidekick, …" with sources once`, async () => {
  // A meeting chat Sidekick's Teams app is in, assigned to W1; Graph knows its meeting's join link.
  MEETING_CHAT_LINKS.set(LIVE1, joinUrlFor("live1"));
  await toBot(activity(LIVE1, { type: "installationUpdate", action: "add" }));
  await waitFor(LIVE1, /not set up/);
  assert.equal((await lou("POST", "/api/teams-links", { id: LIVE1, ws: s.w1 })).status, 200);
  assert.match(await sayTo(LIVE1, "join", { id: "29:vic", name: "Vic Viewer", aadObjectId: OID.vic }), /Viewers can't bring/);
  assert.equal(BOTS.size, 0);
  assert.match(await sayTo(LIVE1, "join"), /Joining now as “Sidekick \(notes\)”.*lobby/);
  const bot = lastBot();
  s.bot1 = bot;
  assert.equal(BOTS.get(bot).url, joinUrlFor("live1"), "the meeting's own link, from Graph");
  assert.equal(BOTS.get(bot).name, "Sidekick (notes)");
  assert.equal(BOTS.get(bot).provider, "attendee", "Sidekick's own meeting bot by default");
  // One Container Apps job execution for this meeting: its size, the meeting's settings, the job's secrets by name only.
  const started = armCalls.filter((c) => c.op === "start").at(-1).body.containers[0];
  assert.equal(started.image, "sidekicklabsacr.azurecr.io/meetbot:v1.89.2-test");
  assert.deepEqual(started.resources, { cpu: 2, memory: "4Gi" });
  assert.equal(BOTS.get(bot).env.SIDEKICK_URL, BASE, "the container calls out to Sidekick");
  assert.equal(BOTS.get(bot).env.SIDEKICK_BOT_KEY, botKeyOf(bot), "its own key, for this meeting only");
  assert.equal(BOTS.get(bot).env.RAISE_HAND, "1");
  assert.ok(started.env.some((e) => e.name === "AZURE_SPEECH_KEY" && e.secretRef === "speech-key" && !("value" in e)), "secrets by reference, never their values");
  assert.ok(await sessionOf(bot, "launched_at"), "its container time counts from now");
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE '%sent to the Teams meeting%' ORDER BY id DESC LIMIT 1"), /invited by Lou Lead/);
  assert.match(await sayTo(LIVE1, "join"), /already in this meeting/, "never twice in one meeting");
  // Waiting in the lobby, then let in: the first message says it's listening and how to remove it (through the Teams bot).
  const from = sent.length;
  assert.equal((await botStatus(bot, "waiting")).status, 202);
  assert.equal(await sessionOf(bot, "status"), "joining");
  assert.equal((await botStatus(bot, "in_call")).status, 202);
  const intro = await waitFor(LIVE1, /listening for W1/, from);
  assert.match(intro, /remove Sidekick \(notes\) from the participants/);
  assert.match(intro, /Sidekick, leave/);
  assert.doesNotMatch(intro, /Client guests are here/);
  assert.equal(BOTS.get(bot).chat.length, 0, "Sidekick's own Teams bot posts in this chat, not the provider");
  assert.equal(await sessionOf(bot, "status"), "live");
  // Admitted twice (statuses can repeat): one hello.
  await botStatus(bot, "in_call");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((sentTo(LIVE1, from).match(/listening for W1/g) ?? []).length, 1);
  // Someone asks out loud: hand up at once, a short spoken answer (Azure AI Speech, citations left out), then the
  // normal Ask pipeline's full answer with its sources in the meeting chat, and the hand down.
  const asked = sent.length;
  const log0 = logLen(bot);
  assert.equal((await say(bot, "Lou Lead", "Okay. Sidekick, what did we decide about the cutover?")).status, 202);
  const answer = await waitFor(LIVE1, /Test answer from/, asked);
  assert.match(answer, /what did we decide about the cutover/);
  assert.match(answer, /Sources/);
  const acts = (await waitLog(bot, /hand:false/, log0)).split("\n");
  assert.deepEqual(acts.map((a) => a.split(":")[0]), ["hand", "speak", "hand"], "hand up, then spoken, then hand down (the chat goes through Teams)");
  assert.match(acts[1], /^speak:Test answer from S1, S2(, S\d+)*\.$/, "short, no [S1] read aloud");
  assert.equal(ttsCalls.at(-1).format, "audio-24khz-48kbitrate-mono-mp3");
  // Speech-to-text sending it again within a minute: answered once.
  await say(bot, "Lou Lead", "Okay. Sidekick, what did we decide about the cutover?");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((sentTo(LIVE1, asked).match(/Test answer from/g) ?? []).length, 1);
  assert.equal(await sessionOf(bot, "answers"), "1");
  // The answer's grounding check applies: an answer citing nothing real becomes "I don't know".
  const ungrounded = sent.length;
  await say(bot, "Mo Member", "Sidekick, __UNGROUNDED__ when is the cutover?");
  await waitFor(LIVE1, /I don't know/, ungrounded);
  assert.doesNotMatch(sentTo(LIVE1, ungrounded), /definitely on Friday/);
  // Lines that don't call Sidekick are only listened to.
  const quiet = sent.length;
  await say(bot, "Mo Member", "Let's look at the test plan next.");
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(sentTo(LIVE1, quiet), "");
  assert.equal(await sessionOf(bot, "line_count"), "4");
});

test(`[${ENGINE}] live: webhooks must be signed by the meeting bot (wrong secret, no signature: 401, nothing stored)`, async () => {
  const lines = await sessionOf(s.bot1, "line_count");
  const event = { trigger: "transcript.update", data: { speaker_name: "Forger", transcription: { transcript: "Sidekick, leave" } } };
  assert.equal((await pushLive(s.bot1, event, { secret: crypto.randomBytes(32).toString("base64") })).status, 401);
  assert.equal((await pushLive(s.bot1, event, { sign: false })).status, 401);
  assert.equal(await sessionOf(s.bot1, "line_count"), lines);
  assert.equal(await sessionOf(s.bot1, "status"), "live");
  // An unknown bot is ignored (202, nothing about anyone); another provider's address doesn't know this bot.
  assert.equal((await say("attendee-bot-999", "Someone", "Sidekick, leave")).status, 202);
  assert.equal((await fetch(`${BASE}/api/live/events/nobody`, { method: "POST", body: "{}" })).status, 404);
});

test(`[${ENGINE}] live: with a pasted link Sidekick posts through the provider; once a guest joins it only uses Shareable sources`, async () => {
  await uploadDoc(lou, s.w1, "zebra-internal.md", "Zebracode rollout plan. The zebracode rollout plan is internal: zebracode waves, zebracode budget, zebracode risks.");
  await uploadDoc(lou, s.w1, "zebra-shareable.md", "Zebracode summary for the client.", "shareable");
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("live2")}`), /Joining now/);
  const bot = lastBot();
  s.bot2 = bot;
  assert.equal(await sessionOf(bot, "chat_via"), "provider", "Sidekick's Teams app isn't in that meeting's chat");
  assert.equal(await sessionOf(bot, "thread_id"), "19:meeting_live2@thread.v2", "the meeting chat from the link");
  assert.equal(await sessionOf(bot, "title"), "Teams meeting", "not the name of the chat the link was pasted in");
  await botStatus(bot, "in_call");
  assert.match(await waitChat(bot, /listening for W1/), /Sidekick, leave/);
  await say(bot, "Mo Member", "Sidekick, what is the zebracode rollout plan?");
  const before = await waitChat(bot, /Test answer/, 1);
  assert.match(before, /Sources: \[S1\] zebra-internal\.md/);
  // A client guest joins: Sidekick says so once, and from then on answers only from Shareable sources.
  const n = BOTS.get(bot).chat.length;
  await joinsMeeting(bot, "Gus Client (Guest)");
  assert.match(await waitChat(bot, /only use sources marked Shareable/, n), /outside your organization/);
  assert.equal((await lou("GET", liveUrl(s.w1))).body.sessions.find((x) => x.status === "live" && x.guests)?.title, "Teams meeting");
  const m = BOTS.get(bot).chat.length;
  await say(bot, "Mo Member", "Sidekick, what is the zebracode rollout plan now?");
  const after = await waitChat(bot, /Test answer/, m);
  assert.match(after, /zebra-shareable\.md/);
  assert.doesNotMatch(after, /zebra-internal/);
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'A guest joined%' ORDER BY id DESC LIMIT 1"), /Shareable sources only/);
  // Typed in the meeting chat (no Teams bot there): the same. Sidekick's own messages coming back are ignored.
  const k = BOTS.get(bot).chat.length;
  await typeIn(bot, "Sidekick (notes)", "Sidekick, recap");
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(BOTS.get(bot).chat.length, k);
  await typeIn(bot, "Mo Member", "Sidekick, recap");
  assert.match(await waitChat(bot, /Nothing decided or assigned yet/, k), /every few minutes/);
});

test(`[${ENGINE}] live: a running list of decisions and action items; "Sidekick, leave"; the notes come from the live transcript once`, async () => {
  const bot = s.bot2;
  await say(bot, "Lou Lead", "In the review we decided to move the cutover to Saturday.");
  await say(bot, "Mo Member", "I'll send the load test report by Friday.");
  for (let i = 0; i < 8; i++) await say(bot, i % 2 ? "Lou Lead" : "Mo Member", `Point ${i} about the test environment.`);
  await drain();
  const live = (await mo("GET", liveUrl(s.w1))).body.sessions.find((x) => x.status === "live" && x.title === "Teams meeting");
  assert.ok(live.decisions.some((d) => /move the cutover to Saturday/.test(d.text) && d.who === "Lou Lead"), JSON.stringify(live));
  assert.ok(live.actions.some((a) => /send the load test report/.test(a.text) && a.who === "Mo Member" && a.due === "Friday"), JSON.stringify(live));
  const n = BOTS.get(bot).chat.length;
  await say(bot, "Lou Lead", "Sidekick, what have we decided?");
  const recap = await waitChat(bot, /Decisions so far/, n);
  assert.match(recap, /move the cutover to Saturday \(Lou Lead\)/);
  assert.match(recap, /send the load test report.*Mo Member, by Friday/);
  // "Sidekick, leave": it says goodbye and leaves; the reason is kept and audited.
  const k = BOTS.get(bot).chat.length;
  await say(bot, "Mo Member", "Sidekick, leave.");
  await waitChat(bot, /Okay, leaving now/, k);
  await waitSession(bot, "status", "ended");
  await until(() => BOTS.get(bot).left, `${bot} left`);
  assert.equal(await sessionOf(bot, "end_reason"), "Mo Member asked Sidekick to leave.");
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Sidekick (notes) left%' ORDER BY id DESC LIMIT 1"), /asked Sidekick to leave/);
  // No Teams transcript came: the live transcript becomes the meeting, and the usual notes are written and posted once.
  const from = sent.length;
  await drain();
  assert.equal(await sessionOf(bot, "handoff"), "live");
  await waitFor(CHAT_W1, /MEETING NOTES · W1/, from);
  const notes = (await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.filter((x) => x.source === "teams-live");
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.equal(notes[0].status, "Ready");
  const detail = (await mo("GET", `/api/meetings/${notes[0].id}`)).body.meeting;
  assert.match(detail.transcript, /Lou Lead: In the review we decided to move the cutover to Saturday\./);
  assert.equal(await scalar(`SELECT COUNT(*) FROM live_lines WHERE session_id = (SELECT id FROM live_sessions WHERE bot_id = '${bot}')`), "0", "the live lines are gone");
  // Teams' own transcript of the same meeting turns up later: skipped, so there's never a second set of notes.
  const late = addMeeting("live2", { organizer: OID.lou, attendees: [OID.mo] });
  const posted = sent.length;
  assert.equal((await transcriptReady(late)).status, 202);
  await drain();
  assert.equal(await scalar(`SELECT status || '|' || reason FROM graph_meetings WHERE transcript_id = '${late.transcriptId}'`), "skipped|Notes for this meeting were already written from Sidekick's live session.");
  assert.equal((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.filter((x) => x.title === "Meeting live2").length, 0);
  assert.equal(sentTo(CHAT_W1, posted).includes("MEETING NOTES"), false);
});

test(`[${ENGINE}] live: when Teams' transcript arrives, it writes the notes; the meeting ending stops Sidekick without a second set`, async () => {
  const bot = s.bot1;
  const t = addMeeting("live1", { organizer: OID.lou, attendees: [OID.mo], chat: LIVE1 });
  assert.equal((await transcriptReady(t)).status, 202);
  await drain();
  assert.equal(await sessionOf(bot, "handoff"), "graph", "the Teams transcript claimed the session");
  assert.equal((await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.filter((x) => x.title === "Meeting live1").length, 1);
  // The meeting ends (the provider says so): Sidekick stops; it isn't asked to leave a meeting that's over.
  assert.equal((await botStatus(bot, "ended")).status, 202);
  await waitSession(bot, "status", "ended");
  assert.equal(await sessionOf(bot, "end_reason"), "The meeting ended.");
  assert.equal(BOTS.get(bot).left, false);
  await drain();
  const live = (await mo("GET", `/api/meetings?ws=${s.w1}`)).body.meetings.filter((x) => x.source === "teams-live");
  assert.equal(live.length, 1, "still only the first live meeting's notes");
  assert.equal(await scalar(`SELECT COUNT(*) FROM live_lines WHERE session_id = (SELECT id FROM live_sessions WHERE bot_id = '${bot}')`), "0");
  assert.equal((await mo("GET", liveUrl(s.w1))).body.sessions.find((x) => x.endReason === "The meeting ended.").notes, "From the Teams transcript");
  // Status events after the end change nothing.
  await botStatus(bot, "in_call");
  assert.equal(await sessionOf(bot, "status"), "ended");
});

test(`[${ENGINE}] live: a question to the room nobody answers: hand up, called on → short spoken answer, then the full answer in the chat; quiet otherwise`, async () => {
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("room1")}`), /Joining now/);
  const bot = lastBot();
  s.bot3 = bot;
  await botStatus(bot, "in_call");
  await waitChat(bot, /listening for W1/);
  const quietFor = async (n, ms = 1200) => {
    await new Promise((r) => setTimeout(r, ms));
    return BOTS.get(bot).log.slice(n);
  };
  // Someone in the meeting answers it: Sidekick stays out of it.
  let n = logLen(bot);
  await say(bot, "Lou Lead", "When is the zebracode rollout happening?");
  await say(bot, "Mo Member", "It starts with the first wave next month.");
  assert.deepEqual(await quietFor(n), [], "someone answered");
  // A question to a person by name isn't for Sidekick.
  n = logLen(bot);
  await say(bot, "Lou Lead", "Mo, what does the zebracode rollout plan cover?");
  assert.deepEqual(await quietFor(n), []);
  // Nobody knows: the hand goes up (well within 2 seconds of the pause here), nothing is said until it's called on.
  n = logLen(bot);
  await say(bot, "Lou Lead", "What does the zebracode rollout plan cover again?");
  const t0 = Date.now();
  await say(bot, "Mo Member", "Not sure, good question.");
  await waitLog(bot, /hand:true/, n);
  assert.ok(Date.now() - t0 < 4000, `hand up after ${Date.now() - t0} ms`);
  assert.doesNotMatch((await quietFor(n, 600)).join("\n"), /speak:|chat:/, "waits to be called on");
  // Called on: hand down, a short spoken answer, then the full answer with sources in the chat.
  await say(bot, "Lou Lead", "Go ahead, Sidekick.");
  await waitLog(bot, /chat:/, n);
  const acts = BOTS.get(bot).log.slice(n);
  assert.deepEqual(acts.map((a) => a.split(":")[0]), ["hand", "hand", "speak", "chat"], acts.join(" | "));
  assert.equal(acts[1], "hand:false");
  assert.match(acts[2], /^speak:Test answer from S1/);
  assert.doesNotMatch(acts[2], /\[S\d\]/);
  assert.match(acts[3], /What does the zebracode rollout plan cover again\?[\s\S]*Sources: \[S1\]/);
  // Not confident (nothing in the group's knowledge): it stays quiet. Judging people: never, even when asked.
  n = logLen(bot);
  await say(bot, "Lou Lead", "Who is bringing the snacks to the Lisbon offsite?");
  assert.deepEqual(await quietFor(n, 1500), [], "low confidence: quiet");
  const c = BOTS.get(bot).chat.length;
  await say(bot, "Lou Lead", "Sidekick, rank the consultants on this project.");
  const refusal = await waitChat(bot, /rank the consultants/, c);
  assert.doesNotMatch(refusal, /Test answer/);
  assert.doesNotMatch(BOTS.get(bot).log.slice(n).join("\n"), /speak:/, "a refusal isn't spoken");
});

test(`[${ENGINE}] live: never talks over anyone; speaks after a pause when the group allows it; a hand nobody calls on goes down with the answer in the chat`, async () => {
  const bot = s.bot3;
  assert.equal((await lou("PUT", liveUrl(s.w1), { voice: "auto", pauseS: 3 })).status, 200);
  assert.equal((await mo("PUT", liveUrl(s.w1), { voice: "off" })).status, 403);
  assert.equal((await lou("PUT", liveUrl(s.w1), { pauseS: 99 })).status, 400);
  let n = logLen(bot);
  await speaking(bot, "Mo Member", true);
  await say(bot, "Lou Lead", "Which waves does the zebracode rollout plan have?");
  await waitLog(bot, /hand:true/, n);
  await new Promise((r) => setTimeout(r, 900));
  assert.doesNotMatch(BOTS.get(bot).log.slice(n).join("\n"), /speak:/, "Mo is still talking");
  await speaking(bot, "Mo Member", false);
  await waitLog(bot, /chat:/, n);
  assert.deepEqual(BOTS.get(bot).log.slice(n).map((a) => a.split(":")[0]), ["hand", "hand", "speak", "chat"]);
  // Back to speaking only when called on; nobody calls on it: after a minute (3 s here) the answer goes to the chat.
  assert.equal((await lou("PUT", liveUrl(s.w1), { voice: "called" })).status, 200);
  n = logLen(bot);
  await say(bot, "Lou Lead", "How is the zebracode rollout budget split?");
  await say(bot, "Mo Member", "No idea.");
  await waitLog(bot, /hand:true/, n);
  await new Promise((r) => setTimeout(r, 3300));
  await drain({ sweep: true });
  const expired = await waitLog(bot, /chat:/, n);
  assert.match(expired, /In case it helps \(I had my hand up\)/);
  assert.doesNotMatch(expired, /speak:/);
  // Spoken answers off: the answer goes straight to the chat, no hand (the chat interrupts nobody).
  assert.equal((await lou("PUT", liveUrl(s.w1), { voice: "off" })).status, 200);
  n = logLen(bot);
  await say(bot, "Lou Lead", "Where is the zebracode rollout summary kept?");
  await say(bot, "Mo Member", "Hmm, not sure.");
  await waitLog(bot, /chat:/, n);
  assert.deepEqual(BOTS.get(bot).log.slice(n).map((a) => a.split(":")[0]), ["chat"]);
  assert.equal((await lou("PUT", liveUrl(s.w1), { voice: "called" })).status, 200);
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Changed Sidekick''s live meeting settings%' ORDER BY id DESC LIMIT 1"), /voice "called"/);
});

test(`[${ENGINE}] live: quiet mode for one meeting; Sidekick asks its own question when an action item has no date; only its name then the question`, async () => {
  const bot = s.bot3;
  let c = BOTS.get(bot).chat.length;
  await say(bot, "Lou Lead", "Sidekick, quiet.");
  await waitChat(bot, /I'll stay quiet/, c);
  assert.equal(await sessionOf(bot, "quiet"), "1");
  let n = logLen(bot);
  await say(bot, "Lou Lead", "What does the zebracode summary say about wave two?");
  await say(bot, "Mo Member", "Not sure.");
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(BOTS.get(bot).log.slice(n), [], "quiet: nothing volunteered");
  await say(bot, "Mo Member", "Sidekick, what is the zebracode rollout plan about?");
  await waitLog(bot, /chat:/, n);
  assert.deepEqual(BOTS.get(bot).log.slice(n).map((a) => a.split(":")[0]), ["chat"], "asked: answered in the chat, no hand, no voice");
  c = BOTS.get(bot).chat.length;
  await say(bot, "Lou Lead", "Sidekick, you can speak up.");
  await waitChat(bot, /raise my hand when I can help/, c);
  assert.equal(await sessionOf(bot, "quiet"), "0");
  // Only its name, then the question in the next line.
  n = logLen(bot);
  await say(bot, "Mo Member", "Sidekick?");
  await say(bot, "Mo Member", "what is in the zebracode summary for the client");
  await waitLog(bot, /chat:[\s\S]*zebracode summary for the client/, n);
  // Its own question: an action item with no date, asked once, with its hand up, spoken when called on.
  await say(bot, "Lou Lead", "I'll update the runbook.");
  for (let i = 0; i < 12; i++) await say(bot, "Mo Member", `Detail ${i} about the rollout environment.`);
  n = logLen(bot);
  await drain();
  await waitLog(bot, /hand:true/, n);
  await say(bot, "Lou Lead", "Yes, Sidekick?");
  const asked = await waitLog(bot, /chat:Quick check/, n);
  assert.match(asked, /speak:Quick check: by when should Lou Lead do “update the runbook”\?/);
  await drain();
  assert.equal((BOTS.get(bot).log.join("\n").match(/Quick check: by when should Lou Lead/g) ?? []).length, 2, "asked once (spoken + chat)");
  await say(bot, "Lou Lead", "Sidekick, leave.");
  await waitSession(bot, "status", "ended");
});

test(`[${ENGINE}] live: the hosted meeting bot (Recall.ai) only when the Org Owner chooses it; it can't raise a hand, so ✋ goes in the chat`, async () => {
  assert.equal((await lou("GET", liveUrl(s.w1))).body.provider.id, "attendee");
  assert.equal((await lou("PUT", "/api/live/provider", { provider: "recall" })).status, 403, "Org Owner only");
  assert.equal((await ann("PUT", "/api/live/provider", { provider: "nobody" })).status, 400);
  assert.equal((await ann("PUT", "/api/live/provider", { provider: "recall" })).status, 200);
  const st = (await lou("GET", liveUrl(s.w1))).body;
  assert.equal(st.provider.id, "recall");
  assert.equal(st.provider.hosted, true);
  assert.match(st.provider.where, /receives the meeting's audio/);
  assert.equal(st.can.raiseHand, false);
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Chose Recall.ai%' ORDER BY id DESC LIMIT 1"), /live in meetings/);
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("hosted1")}`), /Joining now/);
  const bot = lastBot();
  assert.equal(BOTS.get(bot).provider, "recall");
  assert.equal(BOTS.get(bot).webhook, `${BASE}/api/live/events/recall`);
  await botStatus(bot, "in_call");
  await waitChat(bot, /listening for W1/);
  // Its webhooks are checked with Recall's own signature (an old timestamp is refused).
  assert.equal((await pushLive(bot, { event: "transcript.data", data: { data: { words: [{ text: "Sidekick, leave" }], participant: { name: "X" } }, bot: { id: bot } } }, { at: Date.now() - 3600_000 })).status, 401);
  const n = logLen(bot);
  await say(bot, "Lou Lead", "What does the zebracode rollout plan cover in wave three?");
  await say(bot, "Mo Member", "Don't know.");
  await waitLog(bot, /chat:✋ I can help with that/, n);
  await say(bot, "Lou Lead", "Sidekick, go ahead.");
  await waitLog(bot, /speak:[\s\S]*chat:[\s\S]*Sources/, n);
  await say(bot, "Lou Lead", "Sidekick, leave.");
  await waitSession(bot, "status", "ended");
  assert.equal((await ann("PUT", "/api/live/provider", { provider: "attendee" })).status, 200);
  // The sub-processor page says Recall.ai only applies to organizations that choose it.
  const subs = (await client()("GET", "/privacy/subprocessors")).body;
  assert.match(subs, /Recall\.ai \(hosted meeting bot\)/);
  assert.match(subs, /Only for organizations whose Org Owner chose the hosted meeting bot/);
});

test(`[${ENGINE}] live: hours count against the plan; joining is refused when they're used up and a running session leaves`, async () => {
  // The second session lasted an hour.
  await dbExec(`UPDATE live_sessions SET joined_at = '${new Date(Date.now() - 90 * 60_000).toISOString()}', ended_at = '${new Date(Date.now() - 30 * 60_000).toISOString()}' WHERE bot_id = '${s.bot2}'`);
  const used = (await lou("GET", liveUrl(s.w1))).body.hours.used;
  assert.ok(used >= 1 && used < 1.2, String(used));
  assert.equal((await owner("PATCH", `/api/owner/tenants/${s.orgA}/terms`, { limits: { liveMeetingHours: 1 } })).status, 200);
  const bots = BOTS.size;
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("live3")}`), /allows 1 live meeting hour/);
  assert.equal(BOTS.size, bots, "no bot was sent");
  assert.equal((await owner("PATCH", `/api/owner/tenants/${s.orgA}/terms`, { limits: { liveMeetingHours: 2 } })).status, 200);
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("live3")}`), /Joining now/);
  const bot = lastBot();
  await botStatus(bot, "in_call");
  await waitChat(bot, /listening for W1/);
  await dbExec(`UPDATE live_sessions SET joined_at = '${new Date(Date.now() - 61 * 60_000).toISOString()}' WHERE bot_id = '${bot}'`);
  const n = BOTS.get(bot).chat.length;
  await drain({ sweep: true });
  await waitSession(bot, "status", "ended");
  assert.equal(await sessionOf(bot, "end_reason"), "This month's live meeting hours are used up.");
  await until(() => BOTS.get(bot).left, `${bot} left`);
  assert.match(BOTS.get(bot).chat.slice(n).join("\n"), /hours are used up, so I'm leaving/);
  assert.equal((await owner("PATCH", `/api/owner/tenants/${s.orgA}/terms`, { limits: null })).status, 200);
  // A provider refusing the join: the session shows failed with the reason, and the chat is told.
  liveFail.join = 400;
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("live4")}`), /couldn't join the meeting.*not reachable/);
  const failed = (await lou("GET", liveUrl(s.w1))).body.sessions.find((x) => x.status === "failed");
  assert.match(failed.error, /not reachable/);
});

test(`[${ENGINE}] live: "Every group meeting" joins a group's scheduled meeting once as it starts; nobody letting it in gives up after 15 minutes`, async () => {
  // Only this test's meeting: the reminder tests' meetings that started a few minutes ago are set aside.
  await dbExec("UPDATE meeting_nudges SET status = 'gone'");
  assert.equal((await lou("PUT", liveUrl(s.w1), { mode: "auto" })).status, 200);
  schedule("liveauto", { organizer: OID.lou, attendees: [OID.mo], guests: [OID.guest], emails: ["mo@a.test"], inDays: minutes(-1) });
  await drain({ sweep: true });
  await drain({ sweep: true });
  const auto = [...BOTS.entries()].filter(([, b]) => b.url === joinUrlFor("liveauto"));
  assert.equal(auto.length, 1, "joined once");
  const [bot] = auto[0];
  assert.equal(await sessionOf(bot, "invited_by"), "auto");
  assert.equal(await sessionOf(bot, "guests"), "1", "a guest from another organization is invited");
  assert.equal(await sessionOf(bot, "title"), "Planned liveauto");
  await drain({ sweep: true });
  assert.equal([...BOTS.values()].filter((b) => b.url === joinUrlFor("liveauto")).length, 1, "not again");
  // Still in the lobby 15 minutes later: Sidekick gives up and says why.
  await dbExec(`UPDATE live_sessions SET created_at = '${new Date(Date.now() - 16 * 60_000).toISOString()}' WHERE bot_id = '${bot}'`);
  await drain({ sweep: true });
  await waitSession(bot, "status", "failed");
  assert.match(await sessionOf(bot, "end_reason"), /Nobody let Sidekick \(notes\) in from the lobby/);
  await until(() => BOTS.get(bot).left, `${bot} left`);
  assert.equal((await lou("PUT", liveUrl(s.w1), { mode: "ask" })).status, 200);
});

/** A line heard by Azure speech-to-text in the bot's container (the shim marks it). */
const sttLine = (botId, name, text) => pushLive(botId, { trigger: "transcript.update", data: { speaker_name: name, transcription: { transcript: text }, source: "azure_stt" } });
const sessionSql = (bot) => `(SELECT id FROM live_sessions WHERE bot_id = '${bot}')`;

test(`[${ENGINE}] live: our own bot hears with Teams captions first; stalled or unavailable captions switch it to Azure speech-to-text, minute by minute`, async () => {
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("hear1")}`), /Joining now/);
  const bot = lastBot();
  s.hearBot = bot;
  await botStatus(bot, "in_call");
  await waitChat(bot, /listening for W1/);
  assert.equal(await sessionOf(bot, "hearing"), "captions", "captions first: free, and Microsoft transcribes inside Teams");
  await say(bot, "Lou Lead", "Captions work at the start.");
  // Mo talks, but no caption comes (20 s here 1 s): Sidekick tells the bot to hear with Azure speech-to-text.
  await speaking(bot, "Mo Member", true);
  await new Promise((r) => setTimeout(r, 1300));
  await speaking(bot, "Mo Member", false);
  await until(() => BOTS.get(bot).hearing === "stt", "the switch to speech-to-text");
  await waitSession(bot, "hearing", "stt");
  const lines = Number(await sessionOf(bot, "line_count"));
  await sttLine(bot, "Mo Member", "We moved the zebracode review to Thursday.");
  await waitSession(bot, "line_count", String(lines + 1));
  // A caption arriving while on speech-to-text isn't a second copy of the line; it only says captions work again.
  await say(bot, "Mo Member", "We moved the zebracode review to Thursday.");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await sessionOf(bot, "line_count"), String(lines + 1));
  assert.ok(await sessionOf(bot, "captions_at"));
  assert.ok(Number(await scalar(`SELECT COUNT(*) FROM live_hearing WHERE session_id = ${sessionSql(bot)} AND source IN ('stt', 'both')`)) >= 1, "speech-to-text minutes are counted");
  assert.match((await lou("GET", liveUrl(s.w1))).body.sessions.find((x) => x.status === "live").hearing, /Azure speech-to-text/);
  // Another meeting where Teams captions can't be turned on: straight to speech-to-text.
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("hear2")}`), /Joining now/);
  const other = lastBot();
  await botStatus(other, "in_call");
  await waitChat(other, /listening for W1/);
  await pushLive(other, { trigger: "sidekick.captions_unavailable", data: { reason: "Teams captions couldn't be turned on" } });
  await until(() => BOTS.get(other).hearing === "stt", "speech-to-text when captions are unavailable");
  s.hearBot2 = other;
});

test(`[${ENGINE}] live: the bot's container exits when it leaves; one that doesn't is stopped in Azure`, async () => {
  const bot = s.hearBot;
  // It hears with speech-to-text now: a caption would only say captions work again.
  await sttLine(bot, "Lou Lead", "Sidekick, leave.");
  await waitSession(bot, "status", "ended");
  await until(() => BOTS.get(bot).gone, "the container exiting");
  await until(async () => (await sessionOf(bot, "exited_at")) !== "", "exited_at");
  assert.equal(armCalls.filter((c) => c.op === "stop" && c.execution === BOTS.get(bot).execution).length, 0, "it left by itself: nothing to stop");
  // A stuck container: it takes no commands. Stopped from the portal, it doesn't exit; a few minutes later Azure stops it.
  const stuck = s.hearBot2;
  BOTS.get(stuck).deaf = true;
  const id = await sessionOf(stuck, "id");
  assert.equal((await lou("POST", liveUrl(s.w1), { action: "stop", session: id })).status, 200);
  assert.equal(await sessionOf(stuck, "exited_at"), "");
  await dbExec(`UPDATE live_sessions SET ended_at = '${new Date(Date.now() - 10 * 60_000).toISOString()}' WHERE bot_id = '${stuck}'`);
  await drain({ sweep: true });
  assert.ok(armCalls.some((c) => c.op === "stop" && c.execution === BOTS.get(stuck).execution), "stopped in Azure");
  assert.notEqual(await sessionOf(stuck, "exited_at"), "");
});

test(`[${ENGINE}] live: the Owner Console's cost meter, and the platform cap: warning at 80%, paused at 100% (running meetings finish)`, async () => {
  assert.equal((await mo("PUT", "/api/owner/live/cap", { kind: "usd", amount: 1 })).status, 401, "operators only");
  let r = (await owner("GET", "/api/owner/live")).body;
  assert.deepEqual(r.cap.cap, { kind: "usd", amount: 50 }, "$50 a month until set");
  assert.equal(r.cap.level, "ok");
  // One meeting's container ran an hour: 2 vCPU × $0.000024 + 4 GiB × $0.000003 per second = $0.216.
  await dbExec(`UPDATE live_sessions SET launched_at = '${new Date(Date.now() - 2 * 3600_000).toISOString()}', exited_at = '${new Date(Date.now() - 3600_000).toISOString()}' WHERE bot_id = '${s.hearBot}'`);
  r = (await owner("GET", "/api/owner/live")).body;
  assert.ok(r.spend.containerUsd >= 0.21 && r.spend.containerUsd < 0.3, JSON.stringify(r.spend));
  assert.ok(r.spend.sttMinutes >= 1, "speech-to-text minutes");
  assert.ok(r.spend.ttsChars > 0 && r.spend.ttsUsd >= 0, "spoken characters");
  assert.ok(r.spend.onPaceUsd >= r.spend.totalUsd);
  assert.deepEqual(r.spend.size, { cpu: 2, memoryGib: 4 });
  // A meeting running when the cap is reached finishes.
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("cap1")}`), /Joining now/);
  const running = lastBot();
  await botStatus(running, "in_call");
  await waitChat(running, /listening for W1/);
  // Warning at 80%: the cap set so this month is at about 90%.
  const spent = (await owner("GET", "/api/owner/live")).body.spend.totalUsd;
  assert.equal((await owner("PUT", "/api/owner/live/cap", { kind: "euros", amount: 5 })).status, 400);
  const warn = await owner("PUT", "/api/owner/live/cap", { kind: "usd", amount: Math.round((spent / 0.9) * 100) / 100 });
  assert.equal(warn.status, 200, JSON.stringify(warn.body));
  assert.equal(warn.body.level, "warn");
  await drain({ sweep: true });
  assert.match(await scalar("SELECT action FROM platform_log WHERE action LIKE 'Live meeting bots are at%' ORDER BY id DESC LIMIT 1"), /of this month's cap/);
  assert.ok((await owner("GET", "/api/owner/overview")).body.alerts.some((a) => a.href === "/owner/live" && a.kind === "warn"));
  assert.match(await scalar("SELECT action FROM platform_log WHERE action LIKE 'Set the live meeting bot cap%' ORDER BY id DESC LIMIT 1"), /\$/);
  // Reached: no new meetings, said plainly; the running one isn't stopped.
  assert.equal((await owner("PUT", "/api/owner/live/cap", { kind: "usd", amount: Math.round(spent * 50) / 100 })).body.level, "reached");
  const starts = armCalls.filter((c) => c.op === "start").length;
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("cap2")}`), /Live help is paused[\s\S]*notes after meetings still work/);
  assert.equal(armCalls.filter((c) => c.op === "start").length, starts, "no container started");
  await drain({ sweep: true });
  assert.equal(await sessionOf(running, "status"), "live", "the meeting already running finishes");
  assert.match(await scalar("SELECT action FROM platform_log WHERE action LIKE 'Live meeting bots reached%' ORDER BY id DESC LIMIT 1"), /joins no new meetings/);
  assert.ok((await owner("GET", "/api/owner/overview")).body.alerts.some((a) => a.href === "/owner/live" && a.kind === "bad"));
  // In meeting hours instead: plenty left, so it joins again. Back to the default afterwards.
  assert.equal((await owner("PUT", "/api/owner/live/cap", { kind: "hours", amount: 1000 })).body.level, "ok");
  assert.equal((await owner("PUT", "/api/owner/live/cap", { kind: "usd", amount: 50 })).status, 200);
  await say(running, "Lou Lead", "Sidekick, leave.");
  await waitSession(running, "status", "ended");
});

test(`[${ENGINE}] live: Sidekick's voice: the organization's default (admins), a group's own (Team Lead), Play sample made once, the bot speaks with it`, async () => {
  let v = (await mo("GET", "/api/live/voice")).body;
  assert.equal(v.voiceId, "en-US-AndrewMultilingualNeural");
  assert.equal(v.speed, 1);
  assert.equal(v.canManage, false);
  assert.equal(v.speechReady, true);
  assert.ok(v.voices.some((x) => x.gender === "neutral") && v.voices.some((x) => x.accent === "British"), "male, female and neutral voices, several accents");
  assert.equal((await mo("PUT", "/api/live/voice", { voiceId: "en-GB-SoniaNeural" })).status, 403);
  assert.equal((await ann("PUT", "/api/live/voice", { voiceId: "en-GB-MadeUpNeural" })).status, 400, "only listed voices");
  assert.equal((await ann("PUT", "/api/live/voice", { speed: 1.5 })).status, 400);
  v = (await ann("PUT", "/api/live/voice", { voiceId: "en-GB-SoniaNeural", speed: 1.1 })).body;
  assert.equal(v.voiceId, "en-GB-SoniaNeural");
  assert.match(await scalar("SELECT action FROM audit_log WHERE action LIKE 'Set Sidekick''s voice in meetings%' ORDER BY id DESC LIMIT 1"), /Sonia · female, British at 1.1×/);
  // Play sample: made once with Azure AI Speech, then from the cache.
  assert.equal((await mo("POST", "/api/live/voice/sample", { voiceId: "en-AU-WilliamNeural" })).status, 403);
  const calls = ttsCalls.length;
  const first = await lou("POST", "/api/live/voice/sample", { voiceId: "en-AU-WilliamNeural", speed: 1 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.cached, false);
  assert.match(Buffer.from(first.body.mp3, "base64").toString("utf8"), /^Hi, I'm Sidekick\./);
  assert.equal(ttsCalls.at(-1).voice, "en-AU-WilliamNeural");
  const again = await lou("POST", "/api/live/voice/sample", { voiceId: "en-AU-WilliamNeural", speed: 1 });
  assert.equal(again.body.cached, true);
  assert.equal(ttsCalls.length, calls + 1, "the second play costs nothing");
  // The group's own voice, then the bot speaks with it.
  assert.equal((await lou("PUT", liveUrl(s.w1), { voiceId: "en-XX-NopeNeural" })).status, 400);
  const g = (await lou("PUT", liveUrl(s.w1), { voiceId: "en-IN-NeerjaNeural", speed: 0.9 })).body;
  assert.equal(g.settings.voiceId, "en-IN-NeerjaNeural");
  assert.equal(g.orgVoice, "en-GB-SoniaNeural");
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("voice1")}`), /Joining now/);
  const bot = lastBot();
  await botStatus(bot, "in_call");
  await waitChat(bot, /listening for W1/);
  let n = logLen(bot);
  await say(bot, "Lou Lead", "Sidekick, what is the zebracode rollout plan?");
  await waitLog(bot, /speak:/, n);
  assert.equal(ttsCalls.at(-1).voice, "en-IN-NeerjaNeural");
  assert.equal(ttsCalls.at(-1).rate, "-10%");
  // Back to the organization's voice.
  assert.equal((await lou("PUT", liveUrl(s.w1), { voiceId: null, speed: null })).status, 200);
  n = logLen(bot);
  await say(bot, "Lou Lead", "Sidekick, what does the zebracode summary say?");
  await waitLog(bot, /speak:/, n);
  assert.equal(ttsCalls.at(-1).voice, "en-GB-SoniaNeural");
  assert.equal(ttsCalls.at(-1).rate, "+10%");
  await say(bot, "Lou Lead", "Sidekick, leave.");
  await waitSession(bot, "status", "ended");
});

test(`[${ENGINE}] live: Owner Console report; Stop from the portal; isolation (another organization sees and stops nothing)`, async () => {
  assert.equal((await mo("GET", "/api/owner/live")).status, 401);
  const r = (await owner("GET", "/api/owner/live")).body;
  assert.equal(r.configured, true);
  assert.equal(r.provider, "attendee, recall", "both meeting bots are set up here; Sidekick's own first");
  const a = r.orgs.find((o) => o.org === "Org A");
  assert.ok(a.sessions >= 5 && a.failures >= 2 && a.hours >= 1 && a.answers >= 3, JSON.stringify(a));
  assert.ok(r.failures.some((f) => /lobby/.test(f.endReason ?? "")), JSON.stringify(r.failures));
  assert.doesNotMatch(JSON.stringify(r), /zebracode|cutover to Saturday/, "nothing said in a meeting");
  // A running session: Org B can't stop it or see it; a Member can't; the Team Lead can.
  assert.match(await sayTo(CHAT_W1, `join ${joinUrlFor("live5")}`), /Joining now/);
  const bot = lastBot();
  await botStatus(bot, "in_call");
  await waitChat(bot, /listening/);
  const id = await sessionOf(bot, "id");
  assert.equal((await bob("POST", liveUrl(s.bw), { action: "stop", session: id })).status, 404);
  assert.equal((await mo("POST", liveUrl(s.w1), { action: "stop", session: id })).status, 403);
  assert.deepEqual((await bob("GET", liveUrl(s.bw))).body.sessions, []);
  assert.equal(await scalar(`SELECT COUNT(*) FROM live_sessions WHERE org_id <> '${s.orgA}'`), "0");
  const stopped = await lou("POST", liveUrl(s.w1), { action: "stop", session: id });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  await until(() => BOTS.get(bot).left, `${bot} left`);
  assert.match(BOTS.get(bot).chat.join("\n"), /stopped from the portal/);
  assert.equal((await lou("POST", liveUrl(s.w1), { action: "stop", session: id })).status, 409);
  // "@Sidekick leave" with nothing running.
  assert.match(await sayTo(CHAT_W1, "leave"), /not in a meeting for this group/);
});
