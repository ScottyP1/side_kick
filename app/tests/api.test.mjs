/**
 * End-to-end API tests: starts a real copy of the app (next dev) against a throwaway database and
 * exercises it like users and Teams would. Nothing real is touched or paid for:
 * - its own data (a temp SQLite folder, or the DATABASE_URL test database, wiped first),
 * - fake Claude (SIDEKICK_FAKE_CLAUDE=1: canned answers, never in production),
 * - Azure search switched off, Teams in local Playground mode with a fake Teams connector.
 *
 * Run with `npm test` (both engines), or one engine:
 *   TEST_DB=sqlite node --test tests/api.test.mjs
 *   TEST_DB=postgres TEST_DATABASE_URL=postgres:///sidekick_test node --test tests/api.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
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
    return { status: res.status, body: json };
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
  };
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
