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
 *   skipped without keeping its title, meeting hours over the plan skipped with the reason;
 * - "Save to knowledge" from the card and the portal (roles, walls, search source);
 * - the Teams tab with Teams single sign-on (token checks, walls, actions) and its framing headers;
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
const OID = Object.fromEntries(["ann", "lou", "mo", "pat", "quinn", "vic", "bob", "outsider", "guest"].map((n) => [n, guid(`oid-${n}`)]));
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
const transcriptsOff = new Set(); // tenants whose Teams "Transcript API access" switch is off (403 GraphAccessToTranscriptsDisabled)
const throttle = { meeting: [] }; // queue of Retry-After values to answer the next meeting reads with (429)
const CHAT_MSGS = new Map(); // chat id → its latest messages (call events for the transcription reminder)
const chatDenied = new Set(); // chats Graph refuses to read (403: the chat permission wasn't granted there)
const chatReads = []; // every GET /chats/{id}/messages
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
      if (b.resource === "communications/adhocCalls/getAllTranscripts" && !callsApproved.has(tid)) {
        subCalls.push({ op: "denied", body: b, tid });
        return send(403, { error: { code: "Forbidden", message: "API requires one of 'CallTranscripts.Read.All'." } });
      }
      subCalls.push({ op: "create", body: b, tid });
      if (!["communications/onlineMeetings/getAllTranscripts", "communications/adhocCalls/getAllTranscripts"].includes(b.resource) || b.changeType !== "created" || !b.clientState) return send(400, { error: { code: "InvalidRequest" } });
      if (!(await validateWith(b.notificationUrl)) || !(await validateWith(b.lifecycleNotificationUrl))) return send(400, { error: { code: "ValidationError", message: "Subscription validation request failed" } });
      const id = crypto.randomUUID();
      SUBS.set(id, { ...b, id, tid });
      return send(201, { id, expirationDateTime: b.expirationDateTime, resource: b.resource });
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
    const content = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings\/([^/]+)\/transcripts\/([^/]+)\/content$/);
    if (content) {
      const t = TRANSCRIPTS.find((x) => x.id === content[3] && x.meetingId === content[2]);
      if (!t || url.searchParams.get("$format") !== "text/vtt") return send(404, { error: { code: "NotFound" } });
      res.writeHead(200, { "content-type": "text/vtt" });
      return void res.end(t.vtt);
    }
    const meeting = p.match(/^\/v1\.0\/users\/([^/]+)\/onlineMeetings\/([^/]+)$/);
    if (meeting) {
      if (throttle.meeting.length) return send(429, { error: { code: "TooManyRequests" } }, { "Retry-After": String(throttle.meeting.shift()) });
      const m = MEETINGS.get(meeting[2]);
      return m && m.organizer === meeting[1] ? send(200, m.body) : send(404, { error: { code: "NotFound" } });
    }
    send(404, { error: "not found" });
  });
});

/** Adds a Teams meeting (and its transcript) to the fake Graph. Returns the ids. */
function addMeeting(name, { organizer, attendees = [], guests = [], chat = `19:meeting_${name}@thread.v2`, minutes = 30, transcript = true, start = new Date(Date.now() - (minutes + 5) * 60_000) } = {}) {
  const meetingId = meetingIdFor(organizer, chat);
  const end = new Date(start.getTime() + minutes * 60_000);
  MEETINGS.set(meetingId, {
    organizer,
    body: {
      id: meetingId, subject: `Meeting ${name}`, startDateTime: start.toISOString(), endDateTime: end.toISOString(), chatInfo: { threadId: chat },
      participants: {
        organizer: { identity: { user: { id: organizer, tenantId: TA } } },
        attendees: [...attendees.map((id) => ({ identity: { user: { id, tenantId: TA } } })), ...guests.map((id) => ({ identity: { user: { id, tenantId: TG } } }))],
      },
    },
  });
  const transcriptId = `MSMj${crypto.createHash("sha1").update(name).digest("hex").slice(0, 20)}`;
  if (transcript) TRANSCRIPTS.push({ id: transcriptId, meetingId, organizer, createdDateTime: new Date(end.getTime() + 60_000).toISOString(), vtt: vtt([["Lou Lead", `In ${name} we decided to move the cutover.`], ["Mo Member", "I'll send the test report by Friday."]]) });
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
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
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
  // Scheduled meetings work; calls started with Meet now still need the new permission, said plainly.
  assert.match(st.lastError, /approve the new call transcripts permission/);
  assert.match(st.lastError, /Scheduled Teams meetings aren't affected/);
  assert.ok(subCalls.some((c) => c.op === "denied" && c.body.resource === "communications/adhocCalls/getAllTranscripts"));
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

test(`[${ENGINE}] which group: a tie waits for a lead to pick one of their groups; nobody's meeting is skipped without its title`, async () => {
  // Quinn (W1 and W2) with Mo (W1) and Pat (W2): two people from each group.
  const tie = addMeeting("tie", { organizer: OID.quinn, attendees: [OID.mo, OID.pat] });
  // Ann alone with someone outside: no group's meeting.
  addMeeting("solo", { organizer: OID.ann, attendees: [OID.outsider] });
  await drain({ sweep: true });
  const forLou = (await lou("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting tie");
  assert.equal(forLou.status, "waiting");
  assert.deepEqual(forLou.candidates.map((c) => c.id), [s.w1], "a lead only sees their own group to pick");
  assert.equal((await ann("GET", "/api/meetings/auto")).body.recent.find((r) => r.title === "Meeting tie").candidates.length, 2);
  assert.ok(!(await mo("GET", "/api/meetings/auto")).body.recent.some((r) => r.title === "Meeting tie"), "a Member doesn't see waiting meetings");
  assert.equal(await scalar("SELECT COUNT(*) FROM graph_meetings WHERE status = 'skipped' AND title IS NULL"), "1", "the solo meeting is skipped and its title not kept");
  assert.ok(!JSON.stringify((await ann("GET", "/api/meetings/auto")).body).includes("Meeting solo"));
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

  // Approved: the call subscription is made, and the poll still finds the call held before approval.
  callsApproved.add(TA);
  const from = sent.length;
  await drain({ sweep: true });
  const callSub = [...SUBS.values()].find((x) => x.resource === "communications/adhocCalls/getAllTranscripts");
  assert.ok(callSub, "a subscription on ad hoc call transcripts");
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

  // A notification for a call in a chat no group has: the people who spoke (Lou and Mo, both W1) decide.
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

test(`[${ENGINE}] subscription upkeep: renewed before it runs out, recreated when Graph forgot or removed it, removed when switched off`, async () => {
  // Less than a day left: renewed in place.
  await dbExec(`UPDATE graph_subscriptions SET expires_at = '${new Date(Date.now() + 3600_000).toISOString()}' WHERE resource = 'communications/onlineMeetings/getAllTranscripts'`);
  await drain({ sweep: true });
  assert.equal(subCalls.filter((c) => c.op === "renew").length, 1);
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

