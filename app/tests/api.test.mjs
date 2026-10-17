/**
 * End-to-end API tests: starts a real copy of the app (next dev) against a throwaway database and
 * exercises it like users and Teams would. Nothing real is touched or paid for:
 * - its own data (a temp SQLite folder, or the DATABASE_URL test database, wiped first),
 * - fake Claude (SIDEKICK_FAKE_CLAUDE=1: canned answers, never in production),
 * - Azure search switched off, Teams in local Playground mode with a fake Teams connector,
 * - a fake Microsoft sign-in service (Entra ID) that signs ID tokens with a key made up for the run.
 *
 * Run with `npm test` (both engines), or one engine:
 *   TEST_DB=sqlite node --test tests/api.test.mjs
 *   TEST_DB=postgres TEST_DATABASE_URL=postgres:///sidekick_test node --test tests/api.test.mjs
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
const PORT = ENGINE === "postgres" ? 3201 : 3200;
const BASE = `http://localhost:${PORT}`;
const PG_URL = process.env.TEST_DATABASE_URL || "postgres:///sidekick_test";

let server;
let dataDir;
let tsconfigBefore;

/* ---------- fake Teams connector: receives everything the bot sends ---------- */
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

/** Waits for the bot to send something matching `pred` to the fake connector. */
async function waitForSent(pred, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = sent.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for a Teams message from the bot");
}
const cardsOf = (m) => (m.body.attachments ?? []).map((a) => a.content);
const cardText = (card) => JSON.stringify(card);

/* ---------- fake Microsoft sign-in (Entra ID): authorize is skipped, token + keys are real-shaped ---------- */
const MS_CLIENT_ID = "test-entra-client";
const { publicKey: msPublic, privateKey: msPrivate } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const msJwk = { ...msPublic.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const msCodes = new Map(); // code → { challenge, nonce, claims }
let MS_BASE;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An ID token signed like Microsoft's (RS256), for the given tenant and claims. */
function msIdToken(tid, nonce, claims, key = msPrivate) {
  const head = b64({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss: `${MS_BASE}/${tid}/v2.0`, aud: MS_CLIENT_ID, tid, nonce, iat: now, nbf: now, exp: now + 3600, ...claims });
  return `${head}.${body}.${crypto.sign("sha256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
}
const microsoft = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url.endsWith("/discovery/v2.0/keys")) return send(200, { keys: [msJwk] });
    if (req.url.endsWith("/oauth2/v2.0/token")) {
      const f = new URLSearchParams(body);
      const c = msCodes.get(f.get("code"));
      msCodes.delete(f.get("code"));
      const pkceOk = c && crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
      if (!c || !pkceOk || f.get("client_id") !== MS_CLIENT_ID) return send(400, { error: "invalid_grant" });
      return send(200, { id_token: msIdToken(c.claims.tid, c.nonce, c.claims, c.key) });
    }
    send(404, { error: "not found" });
  });
});
const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";

/**
 * Signs in with the fake Microsoft: starts the flow like the button does, "signs in" as `claims`
 * (tid, oid, email, name), and follows Microsoft's redirect back. Returns the final redirect target.
 * `opts.cheat` lets tests break one piece (nonce, state cookie, key) to check it's refused.
 */
async function microsoftSignIn(call, claims, { mode, cheat = {}, replay } = {}) {
  const start = await call("GET", `/api/auth/microsoft/start${mode === "link" ? "?mode=link" : ""}`);
  if (start.status !== 307) return { start };
  const u = new URL(start.location);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  const code = crypto.randomUUID();
  msCodes.set(code, { challenge: u.searchParams.get("code_challenge"), nonce: cheat.nonce ?? u.searchParams.get("nonce"), claims, key: cheat.key });
  const back = await (cheat.otherBrowser ?? call)("GET", `/api/auth/microsoft/callback?code=${code}&state=${u.searchParams.get("state")}`);
  if (replay) await call("GET", `/api/auth/microsoft/callback?code=${code}&state=${u.searchParams.get("state")}`);
  return { start, back, to: back.location ? new URL(back.location) : null };
}

/* ---------- a tiny HTTP client with its own cookie jar per user ---------- */
function client() {
  const jar = new Map();
  return async function call(method, url, body, { form } = {}) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: "manual" });
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
    return { status: res.status, body: json, location: res.headers.get("location") };
  };
}

const activity = (overrides) => ({
  id: `act-${Math.random()}`,
  channelId: "msteams",
  serviceUrl: SERVICE_URL,
  from: { id: "teams-user-1", name: "Test User", aadObjectId: "aad-1" },
  recipient: { id: "bot", name: "Sidekick" },
  conversation: { id: "conv-1", conversationType: "personal", tenantId: "tenant-1" },
  ...overrides,
});
const toBot = (a) => fetch(`${BASE}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });

/* ---------- start / stop the app ---------- */
before(async () => {
  await new Promise((r) => connector.listen(0, "127.0.0.1", r));
  SERVICE_URL = `http://127.0.0.1:${connector.address().port}`;
  await new Promise((r) => microsoft.listen(0, "127.0.0.1", r));
  MS_BASE = `http://127.0.0.1:${microsoft.address().port}`;
  tsconfigBefore = fs.readFileSync(path.join(APP, "tsconfig.json"), "utf8");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    NEXT_DIST_DIR: `.next-test-${ENGINE}`,
    SIDEKICK_FAKE_CLAUDE: "1",
    ANTHROPIC_API_KEY: "",
    AZURE_SEARCH_ENDPOINT: "",
    AZURE_SEARCH_API_KEY: "",
    AZURE_OPENAI_ENDPOINT: "",
    AZURE_OPENAI_API_KEY: "",
    TEAMS_LOCAL_PLAYGROUND: "true",
    CLIENT_ID: "",
    CLIENT_SECRET: "",
    TENANT_ID: "",
    SIDEKICK_PUBLIC_URL: "",
    // Microsoft sign-in against the fake Microsoft above (ENTRA_LOGIN_BASE is ignored in production).
    ENTRA_CLIENT_ID: MS_CLIENT_ID,
    ENTRA_CLIENT_SECRET: "test-entra-secret",
    ENTRA_TENANT: "organizations",
    ENTRA_LOGIN_BASE: "",
  };
  env.ENTRA_LOGIN_BASE = MS_BASE;
  if (ENGINE === "postgres") {
    const dbName = new URL(PG_URL.replace("postgres:///", "postgres://localhost/")).pathname.slice(1);
    execFileSync("dropdb", ["--if-exists", dbName]);
    execFileSync("createdb", [dbName]);
    env.DATABASE_URL = PG_URL;
  } else {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-test-"));
    env.SIDEKICK_DATA_DIR = dataDir;
    env.DATABASE_URL = "";
  }
  server = spawn(path.join(APP, "node_modules/.bin/next"), ["dev", "--port", String(PORT)], { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => process.env.TEST_VERBOSE && process.stdout.write(d));
  server.stderr.on("data", (d) => process.env.TEST_VERBOSE && process.stderr.write(d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/setup`);
      if (r.ok) return;
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
  fs.rmSync(path.join(APP, `.next-test-${ENGINE}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  if (tsconfigBefore) fs.writeFileSync(path.join(APP, "tsconfig.json"), tsconfigBefore); // next dev edits it
});

/* ---------- shared state across the steps ---------- */
const admin = client();
const member = client();
const viewer = client();
const owner = client();
const s = {};

test(`[${ENGINE}] first-run setup creates the org, and only works once`, async () => {
  const r = await admin("POST", "/api/auth/setup", { org: "Test Org", name: "Test Admin", email: "admin@test.local", password: "correct horse battery" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await client()("POST", "/api/auth/setup", { org: "X", name: "X", email: "x@test.local", password: "correct horse battery" });
  assert.equal(again.status, 409);
});

test(`[${ENGINE}] sign-in: wrong password gives the same message as an unknown email`, async () => {
  const wrong = await client()("POST", "/api/auth/login", { email: "admin@test.local", password: "nope nope nope" });
  const unknown = await client()("POST", "/api/auth/login", { email: "nobody@test.local", password: "nope nope nope" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, unknown.body.error);
});

test(`[${ENGINE}] admin creates two workspaces and two people (member, viewer) in workspace A only`, async () => {
  s.wsA = (await admin("POST", "/api/workspaces", { name: "Workspace A" })).body.id;
  s.wsB = (await admin("POST", "/api/workspaces", { name: "Workspace B" })).body.id;
  assert.ok(s.wsA && s.wsB);
  const m = await admin("POST", "/api/users", { name: "Mia Member", email: "member@test.local", role: "Member", workspaces: [s.wsA] });
  const v = await admin("POST", "/api/users", { name: "Vic Viewer", email: "viewer@test.local", role: "Viewer", workspaces: [s.wsA] });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal((await member("POST", "/api/auth/login", { email: "member@test.local", password: m.body.tempPassword })).status, 200);
  assert.equal((await viewer("POST", "/api/auth/login", { email: "viewer@test.local", password: v.body.tempPassword })).status, 200);
});

test(`[${ENGINE}] workspace walls: a member can't see or use a workspace they're not in`, async () => {
  assert.equal((await member("GET", `/api/docs?ws=${s.wsA}`)).status, 200);
  assert.equal((await member("GET", `/api/docs?ws=${s.wsB}`)).status, 404);
  assert.equal((await member("POST", "/api/ask", { ws: s.wsB, question: "anything" })).status, 404);
  const mine = (await member("GET", "/api/workspaces")).body.workspaces.map((w) => w.id);
  assert.deepEqual(mine, [s.wsA]);
});

test(`[${ENGINE}] roles: viewers can't change content, members can't create workspaces or see usage`, async () => {
  const form = new FormData();
  form.append("ws", s.wsA);
  form.append("files", new File(["hello"], "x.txt", { type: "text/plain" }));
  assert.equal((await viewer("POST", "/api/docs", undefined, { form })).status, 403);
  assert.equal((await viewer("POST", "/api/memory/refresh", { ws: s.wsA })).status, 403);
  assert.equal((await member("POST", "/api/workspaces", { name: "Nope" })).status, 403);
  assert.equal((await member("GET", "/api/usage")).status, 403);
  assert.equal((await member("GET", "/api/audit")).status, 403);
});

test(`[${ENGINE}] uploads: shareable and internal documents are indexed`, async () => {
  for (const [name, audience, text] of [
    ["Runbook.md", "shareable", "The wave 2 cutover is on November 12 for 48 stores."],
    ["Budget notes.md", "internal", "Internal: hours are 6 percent over budget in October."],
  ]) {
    const form = new FormData();
    form.append("ws", s.wsA);
    form.append("audience", audience);
    form.append("files", new File([text], name, { type: "text/markdown" }));
    const r = await member("POST", "/api/docs", undefined, { form });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results[0].ok, true);
  }
  const docs = (await member("GET", `/api/docs?ws=${s.wsA}`)).body;
  assert.equal(docs.docs.length, 2);
});

test(`[${ENGINE}] unsupported files are refused with a clear reason, not silently dropped`, async () => {
  const form = new FormData();
  form.append("ws", s.wsA);
  form.append("files", new File(["MZ"], "virus.exe"));
  const r = await member("POST", "/api/docs", undefined, { form });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /isn't supported/);
});

test(`[${ENGINE}] ask: answers cite the workspace's sources (keyword search on this engine)`, async () => {
  const r = await member("POST", "/api/ask", { ws: s.wsA, question: "When is the wave 2 cutover?" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.found, true);
  assert.ok(r.body.sources.some((x) => x.title === "Runbook.md"));
});

test(`[${ENGINE}] client guests present: internal documents are never used`, async () => {
  const internal = await member("POST", "/api/ask", { ws: s.wsA, question: "hours over budget October" });
  assert.ok(internal.body.sources.some((x) => x.title === "Budget notes.md"));
  const guests = await member("POST", "/api/ask", { ws: s.wsA, question: "hours over budget October", guests: true });
  assert.ok(!guests.body.sources.some((x) => x.title === "Budget notes.md"));
});

test(`[${ENGINE}] a question with no matching sources is logged as a gap, without calling Claude`, async () => {
  const r = await member("POST", "/api/ask", { ws: s.wsA, question: "zebra quantum pineapple" });
  assert.equal(r.body.found, false);
  assert.equal(r.body.sources.length, 0);
});

test(`[${ENGINE}] meeting import writes notes and action items`, async () => {
  const form = new FormData();
  form.append("ws", s.wsA);
  form.append("title", "Test standup");
  form.append("text", "Priya: we decided to test. Maria will send the report.");
  const r = await member("POST", "/api/meetings", undefined, { form });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.meeting = r.body.id;
  const m = (await member("GET", `/api/meetings/${s.meeting}`)).body;
  assert.equal(m.meeting.status, "Ready");
  assert.equal(m.actions.length, 2);
  assert.ok(m.items.some((i) => i.kind === "decision"));
  s.actionA = m.actions[0].id;
});

test(`[${ENGINE}] when AI processing fails, the meeting is marked Failed with the reason (no silent failure)`, async () => {
  const form = new FormData();
  form.append("ws", s.wsA);
  form.append("title", "Broken meeting");
  form.append("text", "__FAIL__ this transcript makes fake Claude fail");
  const r = await member("POST", "/api/meetings", undefined, { form });
  assert.ok(r.status >= 400, "the import should report an error");
  assert.match(r.body.error, /fake failure/);
  assert.match(r.body.ref, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, "server problems come with a reference code");
  s.failRef = r.body.ref;
  const list = (await member("GET", `/api/meetings?ws=${s.wsA}`)).body.meetings;
  const broken = list.find((x) => x.title === "Broken meeting");
  assert.equal(broken.status, "Failed");
  assert.ok(broken.error);
});

test(`[${ENGINE}] action items: members can update, viewers can't`, async () => {
  assert.equal((await member("PATCH", `/api/action-items/${s.actionA}`, { status: "Done" })).status, 200);
  assert.equal((await viewer("PATCH", `/api/action-items/${s.actionA}`, { status: "Open" })).status, 403);
  assert.equal((await member("PATCH", `/api/action-items/${s.actionA}`, { status: "Banana" })).status, 400);
});

test(`[${ENGINE}] knowledge map refresh works and keeps coverage within 0-100`, async () => {
  assert.equal((await member("POST", "/api/memory/refresh", { ws: s.wsA })).status, 200);
  const mem = (await member("GET", `/api/memory?ws=${s.wsA}`)).body;
  assert.ok(mem.topics.length >= 1);
  assert.ok(mem.topics.every((t) => t.coverage >= 0 && t.coverage <= 100));
});

test(`[${ENGINE}] home page numbers and usage load (the queries that differ most between engines)`, async () => {
  const o = await member("GET", "/api/overview");
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.stats.documents, 2);
  const u = await admin("GET", "/api/usage");
  assert.equal(u.status, 200, JSON.stringify(u.body));
});

test(`[${ENGINE}] Teams: installing Sidekick in an unlinked chat posts a link code`, async () => {
  const r = await toBot(activity({ type: "installationUpdate", action: "add" }));
  assert.ok(r.status < 300, `bot returned ${r.status}`);
  const msg = await waitForSent((m) => cardsOf(m).some((c) => /Link this chat/.test(cardText(c))));
  s.code = cardText(cardsOf(msg)[0]).match(/[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];
  assert.ok(s.code);
});

test(`[${ENGINE}] Teams: linking needs a valid code and an admin`, async () => {
  assert.equal((await admin("POST", "/api/teams-links", { code: "AAAA-BBBB", ws: s.wsA })).status, 404);
  assert.equal((await member("POST", "/api/teams-links", { code: s.code, ws: s.wsA })).status, 403);
  const ok = await admin("POST", "/api/teams-links", { code: s.code.toLowerCase().replace("-", " "), ws: s.wsA });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const links = (await admin("GET", "/api/teams-links")).body.links;
  assert.equal(links.length, 1);
});

test(`[${ENGINE}] Teams: a question gets an answer card with sources`, async () => {
  const before = sent.length;
  const r = await toBot(activity({ type: "message", text: "When is the wave 2 cutover?" }));
  assert.ok(r.status < 300);
  const msg = await waitForSent((m) => sent.indexOf(m) >= before && cardsOf(m).some((c) => /Sources/.test(cardText(c))));
  assert.match(cardText(cardsOf(msg)[0]), /Runbook\.md/);
});

test(`[${ENGINE}] Teams: card buttons update action items, but only inside the linked workspace`, async () => {
  const done = await (await toBot(activity({ type: "invoke", name: "adaptiveCard/action", value: { action: { type: "Action.Execute", verb: "sidekick.action.reopen", data: { itemId: s.actionA } } } }))).json();
  assert.equal(done.type ?? done.body?.type, "application/vnd.microsoft.card.adaptive");
  // An item from workspace B must be refused from a chat linked to workspace A.
  const form = new FormData();
  form.append("ws", s.wsB);
  form.append("title", "B meeting");
  form.append("text", "Something in B.");
  const bm = await admin("POST", "/api/meetings", undefined, { form });
  const bItem = (await admin("GET", `/api/meetings/${bm.body.id}`)).body.actions[0].id;
  const refused = await (await toBot(activity({ type: "invoke", name: "adaptiveCard/action", value: { action: { type: "Action.Execute", verb: "sidekick.action.done", data: { itemId: bItem } } } }))).json();
  assert.match(JSON.stringify(refused), /couldn't find that action item/);
});

test(`[${ENGINE}] Teams Playground mode refuses requests that would reply to a non-local address`, async () => {
  const r = await toBot(activity({ type: "message", text: "hi", serviceUrl: "https://evil.example.com" }));
  assert.equal(r.status, 401);
});

test(`[${ENGINE}] owner kill switch pauses answering for everyone, with a clear message`, async () => {
  assert.equal((await owner("POST", "/api/owner/auth/setup", { name: "Owner", email: "owner@test.local", password: "correct horse battery" })).status, 200);
  assert.equal((await owner("POST", "/api/owner/releases", { key: "ask", enabled: false })).status, 200);
  const paused = await member("POST", "/api/ask", { ws: s.wsA, question: "When is the wave 2 cutover?" });
  assert.equal(paused.status, 503);
  assert.match(paused.body.error, /paused/);
  assert.equal((await owner("POST", "/api/owner/releases", { key: "ask", enabled: true })).status, 200);
});

test(`[${ENGINE}] a suspended organization is locked out with a clear message, and comes back on resume`, async () => {
  const orgId = (await owner("GET", "/api/owner/tenants")).body.tenants.find((t) => t.name === "Test Org").id;
  assert.equal((await owner("PATCH", `/api/owner/tenants/${orgId}`, { status: "Suspended" })).status, 200);
  const locked = await member("GET", "/api/me");
  assert.equal(locked.status, 403);
  assert.match(locked.body.error, /paused/);
  assert.equal((await owner("PATCH", `/api/owner/tenants/${orgId}`, { status: "Active" })).status, 200);
  assert.equal((await member("GET", "/api/me")).status, 200);
});

test(`[${ENGINE}] the owner can look up a reference code a client saw`, async () => {
  const perf = (await owner("GET", "/api/owner/performance")).body;
  const hit = perf.appErrors.find((e) => e.ref === s.failRef);
  assert.ok(hit, "the failed meeting's reference code is in the error log");
  assert.match(hit.message, /fake failure/);
  assert.equal(hit.route, "/api/meetings");
});

test(`[${ENGINE}] client accounts can't reach the Owner Console`, async () => {
  assert.equal((await admin("GET", "/api/owner/overview")).status, 401);
});

test(`[${ENGINE}] the audit log recorded the important actions`, async () => {
  const log = (await admin("GET", "/api/audit")).body;
  const text = JSON.stringify(log);
  for (const phrase of ["Created workspace", "Uploaded", "Imported meeting", "Linked Teams"]) assert.match(text, new RegExp(phrase));
});

test(`[${ENGINE}] health check reports the database engine and reveals no data`, async () => {
  const r = await client()("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.database.engine, ENGINE);
  assert.deepEqual(Object.keys(r.body).sort(), ["claude", "database", "ok", "search", "teams"]);
});

test(`[${ENGINE}] Activity: admins see traces with their steps; members can't`, async () => {
  assert.equal((await member("GET", "/api/activity?view=overview")).status, 403);
  await member("POST", "/api/ask", { ws: s.wsA, question: "When is the wave 2 cutover?" });
  await new Promise((r) => setTimeout(r, 500)); // traces are saved just after the response
  const list = (await admin("GET", "/api/activity?view=traces&q=ask")).body.traces;
  const ask = list.find((t) => t.name === "POST /api/ask" && t.status === "ok");
  assert.ok(ask, "the question was traced");
  assert.equal(ask.actor, "Mia Member");
  assert.equal(ask.channel, "portal");
  const d = (await admin("GET", `/api/activity?view=trace&id=${ask.id}`)).body;
  const kinds = d.spans.map((x) => x.kind);
  assert.ok(kinds.includes("search"), `search step recorded (got ${kinds})`);
  assert.ok(kinds.includes("ai"), "Claude step recorded");
  const search = d.spans.find((x) => x.kind === "search");
  assert.equal(search.attrs.engine, "local keyword");
  assert.ok(search.attrs.results >= 1);
  assert.ok(d.trace.db_queries > 0, "database queries counted");
  // The trace never contains document text.
  assert.doesNotMatch(JSON.stringify(d), /48 stores/);
});

test(`[${ENGINE}] Activity: failures are traced with their reference code, and Teams answers are traced too`, async () => {
  const failed = (await admin("GET", `/api/activity?view=traces&q=${s.failRef}`)).body.traces;
  assert.equal(failed.length, 1, "the failed meeting import can be found by its reference code");
  assert.equal(failed[0].status, "error");
  const teams = (await admin("GET", "/api/activity?view=traces&channel=teams")).body.traces;
  assert.ok(teams.some((t) => t.name === "Teams answer" && t.actor === "Test User (Teams)"));
  const overview = (await admin("GET", "/api/activity?view=overview&days=1")).body;
  assert.ok(overview.kpis.requests > 0 && overview.kpis.teams > 0);
  assert.equal(overview.series.length, 24);
  const live = (await admin("GET", "/api/activity?view=live")).body;
  assert.ok(live.connections.claude && live.connections.search && live.connections.database);
});

test(`[${ENGINE}] Activity: one organization never sees another's traces`, async () => {
  const other = client();
  const r = await owner("POST", "/api/owner/tenants", { org: "Other Org", name: "Other Admin", email: "other@test.local" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await other("POST", "/api/auth/login", { email: "other@test.local", password: r.body.tempPassword })).status, 200);
  const theirs = (await other("GET", "/api/activity?view=traces")).body.traces;
  assert.ok(theirs.every((t) => t.actor !== "Mia Member" && t.actor !== "Test User"));
  const mine = (await admin("GET", "/api/activity?view=traces")).body.traces;
  const leaked = await other("GET", `/api/activity?view=trace&id=${mine[0].id}`);
  assert.equal(leaked.status, 404);
});

test(`[${ENGINE}] live orb: everyone signed in gets health and counts, only admins see names`, async () => {
  const forMember = await member("GET", "/api/activity?view=live");
  assert.equal(forMember.status, 200);
  assert.deepEqual(forMember.body.people, [], "members don't see who is active");
  assert.ok(forMember.body.peopleCount >= 1);
  const forAdmin = (await admin("GET", "/api/activity?view=live")).body;
  assert.ok(forAdmin.people.length >= 1, "admins see names");
  assert.equal((await client()("GET", "/api/activity?view=live")).status, 401, "signed-out visitors see nothing");
});

test(`[${ENGINE}] assistant: proposes an action but changes nothing until the person confirms`, async () => {
  const before = (await admin("GET", "/api/workspaces")).body.workspaces.length;
  const r = await admin("POST", "/api/assistant", { message: "create workspace Fabrikam Bank", history: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action.type, "create_workspace");
  assert.equal(r.body.action.confirm, true);
  assert.deepEqual(r.body.action.request, { method: "POST", url: "/api/workspaces", body: { name: "Fabrikam Bank", code: null } });
  assert.equal((await admin("GET", "/api/workspaces")).body.workspaces.length, before, "nothing created before Confirm");
  // Confirm = the browser sends the fixed request to the regular route.
  const done = await admin(r.body.action.request.method, r.body.action.request.url, r.body.action.request.body);
  assert.equal(done.status, 200);
  assert.equal((await admin("GET", "/api/workspaces")).body.workspaces.length, before + 1);
});

test(`[${ENGINE}] assistant: only offers actions the person's role allows`, async () => {
  const ws = await member("POST", "/api/assistant", { message: "create workspace Sneaky" });
  assert.equal(ws.status, 200);
  assert.equal(ws.body.action, null, "members can't create workspaces, so no confirm card");
  const person = await viewer("POST", "/api/assistant", { message: "add Sam Sneaky sam@test.local" });
  assert.equal(person.body.action, null, "viewers can't add people");
  const ok = await admin("POST", "/api/assistant", { message: "add Sam Smith sam@test.local" });
  assert.equal(ok.body.action.type, "add_person");
  assert.equal(ok.body.action.request.url, "/api/users");
});

test(`[${ENGINE}] assistant: plain questions, bad input, signed out, and the kill switch`, async () => {
  const q = await member("POST", "/api/assistant", { message: "How do I import a meeting?", history: [{ role: "user", text: "hi" }, { role: "system", text: "ignored" }] });
  assert.equal(q.status, 200);
  assert.equal(typeof q.body.reply, "string");
  assert.equal(q.body.action, null);
  assert.equal((await member("POST", "/api/assistant", { message: "  " })).status, 400);
  assert.equal((await member("POST", "/api/assistant", { message: "x".repeat(1001) })).status, 400);
  assert.equal((await client()("POST", "/api/assistant", { message: "hi" })).status, 401);
  assert.equal((await owner("POST", "/api/owner/releases", { key: "assist", enabled: false })).status, 200);
  const paused = await member("POST", "/api/assistant", { message: "hi" });
  assert.equal(paused.status, 503);
  assert.match(paused.body.error, /paused/);
  assert.equal((await owner("POST", "/api/owner/releases", { key: "assist", enabled: true })).status, 200);
});

/* ---------- Microsoft sign-in (Entra ID) ---------- */
const errorOf = (r) => decodeURIComponent(r.to?.searchParams.get("error") ?? "");

test(`[${ENGINE}] Microsoft: no sign-in until the Org Owner connects the organization's tenant`, async () => {
  const r = await microsoftSignIn(client(), { tid: TENANT, oid: "oid-admin", email: "admin@test.local", name: "Test Admin" });
  assert.equal(r.to.pathname, "/login");
  assert.match(errorOf(r), /isn't connected to Sidekick/);
  assert.equal((await member("GET", "/api/auth/microsoft/start?mode=link")).status, 403, "only Org Owners connect");
  const linked = await microsoftSignIn(admin, { tid: TENANT, oid: "oid-admin", email: "someone.else@test.local", name: "Test Admin" }, { mode: "link" });
  assert.equal(linked.to.pathname + linked.to.search, "/settings?microsoft=connected");
  const status = (await admin("GET", "/api/auth/microsoft")).body;
  assert.equal(status.connected, true);
  assert.equal(status.tenantId, TENANT);
  assert.equal(status.linked, true, "the owner's own account is linked");
  const other = client();
  const taken = await microsoftSignIn(other, { tid: TENANT, oid: "x", email: "x@test.local" });
  assert.match(errorOf(taken), /haven't been added/);
});

test(`[${ENGINE}] Microsoft: people who were added sign in; strangers, other tenants and personal accounts can't`, async () => {
  const mia = client();
  const ok = await microsoftSignIn(mia, { tid: TENANT, oid: "oid-member", email: "MEMBER@test.local", name: "Mia M." });
  assert.equal(ok.to.pathname, "/", errorOf(ok));
  const me = (await mia("GET", "/api/me")).body;
  assert.equal(me.user.email, "member@test.local");
  assert.equal(me.user.role, "Member", "role comes from Sidekick, not Microsoft");
  // Matched by account id from now on, even if the email changes at Microsoft.
  const again = await microsoftSignIn(client(), { tid: TENANT, oid: "oid-member", email: "mia.renamed@test.local" });
  assert.equal(again.to.pathname, "/");
  assert.match(errorOf(await microsoftSignIn(client(), { tid: TENANT, oid: "oid-stranger", email: "stranger@test.local" })), /haven't been added/);
  assert.match(errorOf(await microsoftSignIn(client(), { tid: OTHER_TENANT, oid: "oid-member", email: "member@test.local" })), /isn't connected/);
  assert.match(errorOf(await microsoftSignIn(client(), { tid: "9188040d-6c67-4c5b-b112-36a304b66dad", oid: "p", email: "member@test.local" })), /Personal Microsoft accounts/);
  const vic = client();
  assert.equal((await microsoftSignIn(vic, { tid: TENANT, oid: "oid-viewer", email: "viewer@test.local" })).to.pathname, "/");
  const users = (await admin("GET", "/api/users")).body.users;
  assert.equal(users.find((u) => u.email === "viewer@test.local").microsoft, 1);
});

test(`[${ENGINE}] Microsoft: forged, replayed or cross-browser replies are refused`, async () => {
  const claims = { tid: TENANT, oid: "oid-member", email: "member@test.local" };
  assert.match(errorOf(await microsoftSignIn(client(), claims, { cheat: { nonce: "wrong" } })), /doesn't match this browser/);
  const forger = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.match(errorOf(await microsoftSignIn(client(), claims, { cheat: { key: forger } })), /couldn't be verified/);
  const attacker = client();
  assert.match(errorOf(await microsoftSignIn(client(), claims, { cheat: { otherBrowser: attacker } })), /different browser/);
  const c = client();
  const first = await microsoftSignIn(c, claims, { replay: true });
  assert.equal(first.to.pathname, "/");
  const back = await c("GET", `/api/auth/microsoft/callback?code=x&state=${new URL(first.start.location).searchParams.get("state")}`);
  assert.match(decodeURIComponent(new URL(back.location).searchParams.get("error")), /expired|took too long|different browser/);
  const cancelled = await c("GET", "/api/auth/microsoft/callback?error=access_denied&error_description=AADSTS65004%3A+User+declined");
  assert.match(decodeURIComponent(new URL(cancelled.location).searchParams.get("error")), /cancelled/);
});

test(`[${ENGINE}] Microsoft: Teams messages from a linked account use that person's name and role`, async () => {
  const fromViewer = { from: { id: "teams-vic", name: "Vic in Teams", aadObjectId: "oid-viewer" }, conversation: { id: "conv-1", conversationType: "personal", tenantId: TENANT } };
  const refused = await (await toBot(activity({ ...fromViewer, type: "invoke", name: "adaptiveCard/action", value: { action: { type: "Action.Execute", verb: "sidekick.action.done", data: { itemId: s.actionA } } } }))).json();
  assert.match(JSON.stringify(refused), /role \(Viewer\) can't change action items/);
  const fromMember = { ...fromViewer, from: { id: "teams-mia", name: "Mia in Teams", aadObjectId: "oid-member" } };
  const done = await (await toBot(activity({ ...fromMember, type: "invoke", name: "adaptiveCard/action", value: { action: { type: "Action.Execute", verb: "sidekick.action.done", data: { itemId: s.actionA } } } }))).json();
  assert.equal(done.type ?? done.body?.type, "application/vnd.microsoft.card.adaptive");
  // The same account id from a different tenant is not trusted as that person.
  const spoof = { ...fromViewer, conversation: { ...fromViewer.conversation, tenantId: OTHER_TENANT } };
  const asGuest = await (await toBot(activity({ ...spoof, type: "invoke", name: "adaptiveCard/action", value: { action: { type: "Action.Execute", verb: "sidekick.action.reopen", data: { itemId: s.actionA } } } }))).json();
  assert.equal(asGuest.type ?? asGuest.body?.type, "application/vnd.microsoft.card.adaptive", "treated as a guest Member of the linked chat");
  const before = sent.length;
  await toBot(activity({ ...fromViewer, type: "message", text: "When is the wave 2 cutover?" }));
  await waitForSent((m) => sent.indexOf(m) >= before && cardsOf(m).some((c) => /Sources/.test(cardText(c))));
  const msgs = (await admin("GET", "/api/activity?view=messages")).body.messages;
  const mine = msgs.find((m) => m.asked_by === "Vic Viewer");
  assert.ok(mine, "the question is recorded under the person's Sidekick name");
  assert.equal(mine.channel, "teams");
});

test(`[${ENGINE}] Microsoft: requiring it turns passwords off and signs password users out`, async () => {
  const pw = client();
  // The viewer still has a password session from earlier; it must end.
  assert.equal((await viewer("GET", "/api/me")).status, 200);
  assert.equal((await member("PATCH", "/api/auth/microsoft", { required: true })).status, 403);
  assert.equal((await admin("PATCH", "/api/auth/microsoft", { required: true })).status, 200);
  assert.equal((await viewer("GET", "/api/me")).status, 401, "password sessions were ended");
  assert.equal((await admin("GET", "/api/me")).status, 200, "the owner stays signed in");
  const refused = await pw("POST", "/api/auth/login", { email: "admin@test.local", password: "correct horse battery" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /signs in with Microsoft/);
  assert.equal((await microsoftSignIn(client(), { tid: TENANT, oid: "oid-viewer", email: "viewer@test.local" })).to.pathname, "/", "Microsoft still works");
  assert.equal((await admin("PATCH", "/api/auth/microsoft", { required: false })).status, 200);
  assert.equal((await pw("POST", "/api/auth/login", { email: "admin@test.local", password: "correct horse battery" })).status, 200);
  assert.equal((await admin("DELETE", "/api/auth/microsoft")).status, 200);
  assert.equal((await admin("GET", "/api/auth/microsoft")).body.connected, false);
});
