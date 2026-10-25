/**
 * End-to-end tests for multi-tenant Microsoft/Teams: a second copy of the app started in **multi-tenant mode**
 * (SIDEKICK_MULTI_TENANT=1, the bot keeping its home tenant), with two customer organizations tied to two Microsoft tenants. Covers:
 * - an activity from a tenant nobody signed up with gets the sign-up card and nothing is stored;
 * - one tenant's Microsoft token never opens another tenant's org (tid / issuer checks);
 * - chats waiting to be assigned show only to their own org, and only the allowed roles can assign them;
 * - the link code still works as a fallback, but only within the org's own tenant;
 * - `@Sidekick add/remove @name` in Teams: who may, who can be added, auditing;
 * - `@Sidekick post meeting notes here` / `stop posting notes here`: who may (per role, strangers, another org's
 *   owner), chats with client guests, auditing;
 * - directory import with a fake Microsoft Graph: admin approval, consent-needed message, rules, isolation;
 * - who added Sidekick: a Team Lead never signed in with Microsoft is recognised by email (Graph), someone unknown
 *   gets "I don't know you in Sidekick yet", and removing + re-adding Sidekick clears a stuck "leaving" chat.
 * The main suite (tests/api.test.mjs) runs single-tenant mode and checks it behaves as before.
 *
 * Nothing real is touched: its own data folder or the TEST_DATABASE_URL database (wiped first), fake Claude,
 * Teams in local Playground mode with a fake Teams connector, and a fake Microsoft (sign-in, app tokens and
 * Graph) whose keys are made up for the run. Ports 3210 (SQLite) / 3211 (Postgres).
 *
 *   TEST_DB=sqlite node --test tests/teams-multitenant.test.mjs
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
const PORT = Number(process.env.TEST_MT_PORT) || (ENGINE === "postgres" ? 3211 : 3210);
const BASE = `http://localhost:${PORT}`;
const PG_URL = process.env.TEST_DATABASE_URL || "postgres:///sidekick_test";
const DIST = `.next-test-mt-${ENGINE}`;

let server;
let dataDir;
let tsconfigBefore;

const TA = "aaaaaaaa-1111-4111-8111-111111111111"; // Org A's Microsoft tenant
const TB = "bbbbbbbb-2222-4222-8222-222222222222"; // Org B's Microsoft tenant
const TX = "cccccccc-3333-4333-8333-333333333333"; // a company that never signed up

/* ---------- fake Teams connector: chat roster lookups + everything the bot sends ---------- */
const sent = [];
// The chat roster Teams would return for a mentioned person (by their Teams id).
const ROSTER = {
  "29:maria": { id: "29:maria", name: "Maria Lopez", aadObjectId: "oid-maria", email: "maria@a.test", tenantId: TA, userRole: "user" },
  "29:gus": { id: "29:gus", name: "Gus Guest", aadObjectId: "oid-gus", email: "gus@elsewhere.test", tenantId: TA, userRole: "guest" },
  "29:ann": { id: "29:ann", name: "Ann Owner", aadObjectId: "oid-ann", email: "ann@a.test", tenantId: TA, userRole: "user" },
  "29:mo": { id: "29:mo", name: "Mo Member", aadObjectId: "oid-mo", email: "mo@a.test", tenantId: TA, userRole: "user" },
};
// Chats Sidekick is no longer in (Teams answers 403 "BotNotInConversationRoster" for their member list).
const GONE = new Set();
const connector = http.createServer((req, res) => {
  // A chat's whole roster (the notes picker's member counts, the "Assign a chat" list, the leaving timer's check).
  const roster = decodeURIComponent(req.url).split("?")[0].match(/\/v3\/conversations\/([^/]+)\/members\/?$/);
  if (req.method === "GET" && roster) {
    const gone = GONE.has(roster[1]);
    res.writeHead(gone ? 403 : 200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(gone ? { error: { code: "BotNotInConversationRoster", message: "The bot is not part of the conversation roster." } } : Object.values(ROSTER)));
  }
  const member = decodeURIComponent(req.url).match(/\/v3\/conversations\/[^/]+\/members\/(.+)$/);
  if (req.method === "GET" && member) {
    const p = ROSTER[member[1]];
    res.writeHead(p ? 200 : 404, { "content-type": "application/json" });
    return void res.end(JSON.stringify(p ?? { error: { code: "MemberNotFoundInConversation" } }));
  }
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

/** Everything the bot sent to one conversation since `from` (an index into `sent`), as text. */
const sentTo = (conv, from = 0) => sent.slice(from).filter((m) => decodeURIComponent(m.url).includes(conv)).map((m) => JSON.stringify(m.body)).join("\n");
/** Waits until the bot sent something to `conv` (after index `from`) that matches `re`. */
async function waitFor(conv, re, from = 0, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (re.test(sentTo(conv, from))) return sentTo(conv, from);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${re} in ${conv}: ${sentTo(conv, from).slice(0, 400)}`);
}

/* ---------- fake Microsoft: sign-in, app tokens (client credentials) and Graph ---------- */
const MS_CLIENT_ID = "test-entra-client";
const { publicKey: msPublic, privateKey: msPrivate } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const msJwk = { ...msPublic.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const msCodes = new Map();
const consented = new Set(); // tenants whose Microsoft admin approved Sidekick
const TEAMS_APP_ID = "sidekick-test-app";
// Where Sidekick is installed (chat or team id → Graph installations), and where it removed itself from.
const INSTALLED = new Map();
const removedFrom = [];
// Chats where Microsoft refuses Sidekick's self-removal (as if that permission weren't approved).
const DENY_SELF_REMOVAL = new Set();
// Each tenant's directory.
const DIRECTORY = {
  [TA]: [
    { id: "oid-pat", displayName: "Pat Person", mail: "pat@a.test", userPrincipalName: "pat@a.test", jobTitle: "Engineer", userType: "Member", accountEnabled: true },
    { id: "oid-priya", displayName: "Priya Patel", mail: "priya@a.test", userPrincipalName: "priya@a.test", jobTitle: "PM", userType: "Member", accountEnabled: true },
    { id: "oid-pguest", displayName: "Pete Guest", mail: "pete@else.test", userPrincipalName: "pete_else.test#EXT#@a.test", userType: "Guest", accountEnabled: true },
  ].map((u) => ({ ...u, id: guid(u.id) })),
  [TB]: [{ id: guid("oid-bea"), displayName: "Bea B", mail: "bea@b.test", userPrincipalName: "bea@b.test", userType: "Member", accountEnabled: true }],
};
/** Graph ids are GUIDs; make stable ones from readable names. */
function guid(name) {
  const h = crypto.createHash("sha1").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
let MS_BASE;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function msIdToken(tid, nonce, claims) {
  const head = b64({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss: `${MS_BASE}/${tid}/v2.0`, aud: MS_CLIENT_ID, tid, nonce, iat: now, nbf: now, exp: now + 3600, ...claims });
  return `${head}.${body}.${crypto.sign("sha256", Buffer.from(`${head}.${body}`), msPrivate).toString("base64url")}`;
}
const microsoft = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const url = new URL(req.url, MS_BASE);
    if (url.pathname.endsWith("/discovery/v2.0/keys")) return send(200, { keys: [msJwk] });
    if (url.pathname.endsWith("/oauth2/v2.0/token")) {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") === "client_credentials") {
        const tid = url.pathname.split("/")[1];
        if (f.get("client_id") !== MS_CLIENT_ID) return send(401, { error: "invalid_client" });
        if (!consented.has(tid)) return send(400, { error: "unauthorized_client", error_description: "AADSTS7000229: missing service principal" });
        return send(200, { access_token: `tok-${tid}`, expires_in: 3600 });
      }
      const c = msCodes.get(f.get("code"));
      msCodes.delete(f.get("code"));
      const pkceOk = c && crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
      if (!c || !pkceOk) return send(400, { error: "invalid_grant" });
      return send(200, { id_token: msIdToken(c.claims.tid, c.nonce, c.claims) });
    }
    // Teams app installations in chats and teams (Sidekick removing itself).
    const apps = url.pathname.match(/^\/v1\.0\/(chats|teams)\/([^/]+)\/installedApps(?:\/(.+))?$/);
    if (apps) {
      const tid = (req.headers.authorization ?? "").replace("Bearer tok-", "");
      if (!consented.has(tid)) return send(403, { error: { code: "Forbidden" } });
      const where = decodeURIComponent(apps[2]);
      if (DENY_SELF_REMOVAL.has(where)) return send(403, { error: { code: "Forbidden" } });
      const list = INSTALLED.get(where) ?? [];
      if (req.method === "GET") return send(200, { value: list });
      if (req.method === "DELETE") {
        const id = decodeURIComponent(apps[3] ?? "");
        if (!list.some((i) => i.id === id)) return send(404, { error: { code: "NotFound" } });
        INSTALLED.set(where, list.filter((i) => i.id !== id));
        removedFrom.push(where);
        res.writeHead(204);
        return void res.end();
      }
    }
    if (url.pathname.startsWith("/v1.0/users")) {
      const tid = (req.headers.authorization ?? "").replace("Bearer tok-", "");
      if (!consented.has(tid)) return send(403, { error: { code: "Authorization_RequestDenied" } });
      const people = DIRECTORY[tid] ?? [];
      const one = url.pathname.match(/^\/v1\.0\/users\/(.+)$/);
      if (one) {
        const u = people.find((p) => p.id === one[1]);
        return u ? send(200, u) : send(404, { error: { code: "Request_ResourceNotFound" } });
      }
      const q = (url.searchParams.get("$search") ?? "").match(/displayName:([^"]*)"/)?.[1]?.toLowerCase() ?? "";
      return send(200, { value: people.filter((p) => !q || p.displayName.toLowerCase().includes(q) || p.mail.includes(q)) });
    }
    send(404, { error: "not found" });
  });
});

/** Signs in with the fake Microsoft (see tests/api.test.mjs). Returns the final redirect target. */
async function microsoftSignIn(call, claims, { mode } = {}) {
  const start = await call("GET", `/api/auth/microsoft/start${mode === "link" ? "?mode=link" : ""}`);
  if (start.status !== 307) return { start };
  const u = new URL(start.location);
  const code = crypto.randomUUID();
  msCodes.set(code, { challenge: u.searchParams.get("code_challenge"), nonce: u.searchParams.get("nonce"), claims });
  const back = await call("GET", `/api/auth/microsoft/callback?code=${code}&state=${u.searchParams.get("state")}`);
  return { start, back, to: back.location ? new URL(back.location) : null };
}
/**
 * The message a redirect left for the page: the address only says `?error=1`, the text travels in the one-time
 * `sk_flash` cookie (lib/flash.ts), so a link can't put its own words on Sidekick's pages.
 */
const flashOf = (res) => {
  if (!res?.location) return "";
  const q = new URL(res.location, BASE).searchParams;
  if (!q.has("error")) return "";
  assert.equal(q.get("error"), "1", "the address never carries the message itself");
  return decodeURIComponent(res.cookies?.sk_flash ?? "");
};
const errorOf = (r) => flashOf(r.back);

/** A tiny HTTP client with its own cookie jar. */
function client() {
  const jar = new Map();
  return async function call(method, url, body) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
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
    return { status: res.status, body: json, location: res.headers.get("location"), cookies: Object.fromEntries(jar) };
  };
}
async function firstSignIn(call, email, temp) {
  const r = await call("POST", "/api/auth/login", { email, password: temp });
  if (r.status === 200) assert.equal((await call("POST", "/api/auth/password", { current: temp, next: "a new password 123" })).status, 200);
  return r;
}

/** A Teams activity in tenant `tid`, in conversation `conv` (group chat by default). */
const activity = (tid, conv, overrides = {}) => ({
  id: `act-${Math.random()}`,
  channelId: "msteams",
  serviceUrl: SERVICE_URL,
  from: { id: "29:someone", name: "Someone", aadObjectId: "oid-someone" },
  recipient: { id: "bot", name: "Sidekick" },
  conversation: { id: conv, conversationType: "groupChat", tenantId: tid, name: `Chat ${conv}` },
  ...overrides,
});
const atSidekick = { type: "mention", mentioned: { id: "bot", name: "Sidekick" }, text: "<at>Sidekick</at>" };
const at = (teamsId) => ({ type: "mention", mentioned: { id: teamsId, name: ROSTER[teamsId]?.name ?? "Someone" }, text: `<at>${ROSTER[teamsId]?.name ?? "Someone"}</at>` });
/** "@Sidekick <verb> @person…" from `from` in `conv` (tenant A). */
const command = (conv, from, verb, ...people) =>
  activity(TA, conv, { type: "message", from, text: `<at>Sidekick</at> ${verb} ${people.map((p) => `<at>${ROSTER[p]?.name}</at>`).join(" ")}`, entities: [atSidekick, ...people.map(at)] });
const TICK_SECRET = crypto.randomBytes(24).toString("hex");
/** Runs the reminder timer's heartbeat once (it also makes Sidekick leave stale chats). */
const tick = () => fetch(`${BASE}/api/reminders/tick`, { method: "POST", headers: { "x-sidekick-tick": TICK_SECRET, "content-type": "application/json" }, body: JSON.stringify({ sweep: true }) }).then((r) => r.json());
/** Sidekick is added to a group chat in tenant A by `from` (Teams also records the installation for Graph). */
const install = (conv, from) => {
  INSTALLED.set(conv, [{ id: `inst-${conv}`, teamsApp: { id: "catalog-id", externalId: TEAMS_APP_ID } }]);
  return toBot(activity(TA, conv, { type: "installationUpdate", action: "add", from }));
};
const LOU = { id: "29:lou", name: "Lou Lead", aadObjectId: "oid-lou" };
const MO = { id: "29:mo", name: "Mo Member", aadObjectId: "oid-mo" };
const ANN = { id: "29:ann", name: "Ann Owner", aadObjectId: "oid-ann" };
const toBot = (a) => fetch(`${BASE}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });

/** Counts rows straight in the test database (to check nothing was stored). */
async function count(sql) {
  if (ENGINE === "postgres") return Number(execFileSync("psql", [PG_URL, "-tAc", sql], { encoding: "utf8" }).trim());
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "sidekick.db"), { readOnly: true, timeout: 10000 });
  try {
    return Number(Object.values(db.prepare(sql).get())[0]);
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
    // Multi-tenant mode as recommended: the bot keeps its home tenant (a single-tenant Azure Bot), and sign-in
    // plus the directory use a separate multi-tenant Entra app (ENTRA_* below).
    TENANT_ID: "dddddddd-4444-4444-8444-444444444444",
    SIDEKICK_MULTI_TENANT: "1",
    SIDEKICK_PUBLIC_URL: "https://sidekick.example.test",
    SIDEKICK_SCHEDULER: "off",
    ENTRA_CLIENT_ID: MS_CLIENT_ID,
    ENTRA_CLIENT_SECRET: "test-entra-secret",
    ENTRA_TENANT: "",
    ENTRA_LOGIN_BASE: MS_BASE,
    GRAPH_BASE: MS_BASE,
    TEAMS_APP_ID,
    // The 7-day wait and the hourly retry, shortened; only the tick call below triggers leaving.
    SIDEKICK_LEAVE_AFTER_MS: "1000",
    SIDEKICK_LEAVE_RETRY_MS: "0",
    SIDEKICK_TICK_SECRET: TICK_SECRET,
  };
  if (ENGINE === "postgres") {
    const dbName = new URL(PG_URL.replace("postgres:///", "postgres://localhost/")).pathname.slice(1);
    execFileSync("dropdb", ["--if-exists", dbName]);
    execFileSync("createdb", [dbName]);
    env.DATABASE_URL = PG_URL;
  } else {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-mt-test-"));
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

/* ---------- the two customer organizations ---------- */
const ann = client(); // Org A's Org Owner (tenant TA)
const lou = client(); // Org A's Team Lead of W1
const mo = client(); // Org A's Member of W1
const bob = client(); // Org B's Org Owner (tenant TB)
const s = {};

test(`[${ENGINE}] multi-tenant setup: two organizations, each tied to its own Microsoft tenant`, async () => {
  assert.equal((await ann("POST", "/api/auth/setup", { org: "Org A", name: "Ann Owner", email: "ann@a.test", password: "correct horse battery" })).status, 200);
  s.w1 = (await ann("POST", "/api/workspaces", { name: "W1" })).body.id;
  s.w2 = (await ann("POST", "/api/workspaces", { name: "W2" })).body.id;
  const lead = await ann("POST", "/api/users", { name: "Lou Lead", email: "lou@a.test", role: "Team Lead", workspaces: [s.w1] });
  const mem = await ann("POST", "/api/users", { name: "Mo Member", email: "mo@a.test", role: "Member", workspaces: [s.w1] });
  await firstSignIn(lou, "lou@a.test", lead.body.tempPassword);
  await firstSignIn(mo, "mo@a.test", mem.body.tempPassword);
  // Ann connects Org A to tenant A; Lou and Mo then sign in with Microsoft once (saves their account ids).
  assert.equal((await microsoftSignIn(ann, { tid: TA, oid: "oid-ann", email: "ann@a.test", name: "Ann Owner" }, { mode: "link" })).to.search, "?microsoft=connected");
  assert.equal((await microsoftSignIn(lou, { tid: TA, oid: "oid-lou", email: "lou@a.test", name: "Lou Lead" })).to.pathname, "/");
  assert.equal((await microsoftSignIn(mo, { tid: TA, oid: "oid-mo", email: "mo@a.test", name: "Mo Member" })).to.pathname, "/");

  const owner = client();
  assert.equal((await owner("POST", "/api/owner/auth/setup", { name: "Op", email: "op@sidekick.test", password: "correct horse battery" })).status, 200);
  const b = await owner("POST", "/api/owner/tenants", { org: "Org B", name: "Bob Owner", email: "bob@b.test" });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  await firstSignIn(bob, "bob@b.test", b.body.tempPassword);
  s.bw = (await bob("POST", "/api/workspaces", { name: "B work" })).body.id;
  // Org B can't take tenant A; it ties its own tenant B.
  assert.match(errorOf(await microsoftSignIn(bob, { tid: TA, oid: "oid-bob", email: "bob@b.test" }, { mode: "link" })), /already connected to another Sidekick organization/);
  assert.equal((await microsoftSignIn(bob, { tid: TB, oid: "oid-bob", email: "bob@b.test", name: "Bob Owner" }, { mode: "link" })).to.search, "?microsoft=connected");
});

test(`[${ENGINE}] multi-tenant: one tenant's Microsoft token never opens another tenant's org`, async () => {
  // Mo exists in Org A (tenant A). A valid tenant B token with Mo's email lands in Org B, where Mo isn't.
  assert.match(errorOf(await microsoftSignIn(client(), { tid: TB, oid: "oid-mo-in-b", email: "mo@a.test" })), /haven't been added to Org B/);
  // A token that claims tenant A but was issued by tenant B's issuer fails verification.
  assert.match(errorOf(await microsoftSignIn(client(), { tid: TA, iss: `${MS_BASE}/${TB}/v2.0`, oid: "oid-mo", email: "mo@a.test" })), /couldn't be verified/);
  // A tenant nobody signed up with.
  assert.match(errorOf(await microsoftSignIn(client(), { tid: TX, oid: "x", email: "x@x.test" })), /isn't connected to Sidekick/);
  // The real thing still works.
  assert.equal((await microsoftSignIn(client(), { tid: TA, oid: "oid-mo", email: "mo@a.test" })).to.pathname, "/");
});

test(`[${ENGINE}] multi-tenant: a company that hasn't signed up gets the sign-up card, and nothing is stored`, async () => {
  const from = sent.length;
  await toBot(activity(TX, "19:unknown@thread.v2", { type: "installationUpdate", action: "add" }));
  const card = await waitFor("19:unknown@thread.v2", /isn't set up for your organization yet/, from);
  assert.match(card, /https:\/\/sidekick\.example\.test\/signup/);
  // A plain message there gets no reply; a mention gets the card again.
  const before = sent.length;
  await toBot(activity(TX, "19:unknown@thread.v2", { type: "message", text: "lunch?" }));
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(sentTo("19:unknown@thread.v2", before), "", "plain messages are ignored");
  await toBot(activity(TX, "19:unknown@thread.v2", { type: "message", text: "<at>Sidekick</at> hi", entities: [atSidekick] }));
  await waitFor("19:unknown@thread.v2", /isn't set up/, before);
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE tenant_id = 'cccccccc-3333-4333-8333-333333333333'"), 0);
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:unknown@thread.v2'"), 0);
});

test(`[${ENGINE}] chat picker: only leads and admins add Sidekick; it waits silently for its own org and is assigned only in the portal`, async () => {
  // A Member (not a Team Lead or admin) adds Sidekick: a short card, and Sidekick marks the chat to leave.
  const REFUSED = "19:refused@thread.v2";
  const f0 = sent.length;
  await install(REFUSED, MO);
  await waitFor(REFUSED, /Only a Team Lead or admin can add me to a chat, so I'm leaving/, f0);
  s.refused = REFUSED;
  // Someone Sidekick doesn't know (and the directory can't be read yet): a plain "I don't know you", no leaving
  // for good, and the chat isn't waiting to be assigned.
  const UNKNOWN = "19:stranger@thread.v2";
  const u0 = sent.length;
  await install(UNKNOWN, { id: "29:gina", name: "Gina Adder", aadObjectId: "oid-gina" });
  const unknownCard = await waitFor(UNKNOWN, /I don't know you in Sidekick yet/, u0);
  assert.match(unknownCard, /Ask your Sidekick admin to add you, then sign in to the Sidekick portal with Microsoft once and add me again/);
  assert.doesNotMatch(unknownCard, /I'm leaving/);
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:stranger@thread.v2' AND leaving = 'unknown'"), 1);
  s.unknown = UNKNOWN;

  // The Team Lead adds Sidekick: one notice, no buttons, no code.
  const CHAT = "19:wave2@thread.v2";
  const from = sent.length;
  await install(CHAT, LOU);
  const card = await waitFor(CHAT, /not set up for this chat yet/, from);
  assert.match(card, /A Team Lead needs to assign this chat to a group in the Sidekick portal\. Until then I won't read, save or answer anything here/);
  assert.match(card, /within 7 days, I'll leave the chat/);
  assert.doesNotMatch(card, /Action\.|"text":"\*?\*?[A-Z2-9]{4}-[A-Z2-9]{4}|\*\*[A-Z2-9]{4}-[A-Z2-9]{4}\*\*/, "no buttons and no link code");

  // Until it's assigned, Sidekick doesn't answer (only repeats the notice) and saves nothing.
  const m0 = sent.length;
  await toBot(activity(TA, CHAT, { type: "message", from: LOU, text: "<at>Sidekick</at> when is the cutover?", entities: [atSidekick] }));
  await waitFor(CHAT, /not set up for this chat yet/, m0);
  await toBot(activity(TA, CHAT, { type: "message", from: LOU, text: "plain chatter before assignment" }));
  await toBot(activity(TA, REFUSED, { type: "message", from: LOU, text: "<at>Sidekick</at> hello?", entities: [atSidekick] }));
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(sentTo(REFUSED, m0), "", "a chat Sidekick is leaving gets no replies");
  assert.equal(await count("SELECT COUNT(*) FROM chat_messages"), 0);

  // Who sees it waiting: the admin (all) and the lead who added it; not Members, not another org; never the refused chat.
  const waitingFor = async (who) => (await who("GET", "/api/teams-links")).body.waiting ?? [];
  const mine = (await waitingFor(ann)).find((w) => w.id === CHAT);
  assert.ok(mine, "Org A's admin sees it");
  assert.equal(mine.added_by, "Lou Lead");
  assert.equal(mine.kind, "groupChat");
  assert.ok(mine.leaves_at > mine.created_at);
  assert.ok((await waitingFor(lou)).some((w) => w.id === CHAT), "the Team Lead who added it sees it");
  assert.ok(!(await waitingFor(ann)).some((w) => w.id === REFUSED));
  assert.ok(!(await waitingFor(ann)).some((w) => w.id === UNKNOWN), "nor a chat whose adder Sidekick doesn't know");
  assert.deepEqual(await waitingFor(mo), [], "a Member doesn't");
  assert.deepEqual(await waitingFor(bob), [], "another org never does");
  // An admin adds Sidekick to another chat: the lead doesn't see that one.
  const OTHER = "19:admins-chat@thread.v2";
  await install(OTHER, ANN);
  await waitFor(OTHER, /not set up/);
  assert.ok((await waitingFor(ann)).some((w) => w.id === OTHER));
  assert.ok(!(await waitingFor(lou)).some((w) => w.id === OTHER), "a lead only sees the chats they added");
  assert.equal((await lou("POST", "/api/teams-links", { id: OTHER, ws: s.w1 })).status, 404, "nor assigns them");
  s.other = OTHER;

  // Who may assign it, and where.
  assert.equal((await mo("POST", "/api/teams-links", { id: CHAT, ws: s.w1 })).status, 403);
  assert.equal((await bob("POST", "/api/teams-links", { id: CHAT, ws: s.bw })).status, 404, "another org can't take it");
  assert.equal((await lou("POST", "/api/teams-links", { id: CHAT, ws: s.w2 })).status, 404, "a lead only assigns to groups they lead");
  const ok = await lou("POST", "/api/teams-links", { id: CHAT, ws: s.w1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.tracking, true, "assigned means Sidekick reads every message");
  assert.equal((await ann("POST", "/api/teams-links", { id: CHAT, ws: s.w2 })).status, 404, "once assigned it's not waiting any more");
  assert.ok(!(await waitingFor(ann)).some((w) => w.id === CHAT));
  const link = (await ann("GET", "/api/teams-links")).body.links.find((l) => l.id === CHAT);
  assert.equal(link.workspace_id, s.w1);
  assert.equal(link.settings.track, true);
  const assigned = await waitFor(CHAT, /Assigned to W1/, from);
  assert.match(assigned, /Lou Lead assigned this chat to \*\*W1\*\*.*I read every message here/);
  assert.equal((await ann("PATCH", "/api/teams-links/settings", { id: CHAT, changes: { track: false } })).status, 400, "no switching tracking off in an assigned chat");
  // Now plain messages are kept.
  await toBot(activity(TA, CHAT, { type: "message", from: LOU, text: "The cutover moved to November 19." }));
  for (let i = 0; i < 20 && !(await count("SELECT COUNT(*) FROM chat_messages")); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(await count("SELECT COUNT(*) FROM chat_messages"), 1, "only the message after assignment");
  const audit = JSON.stringify((await ann("GET", "/api/audit")).body);
  assert.match(audit, /Linked Teams chat “Chat 19:wave2@thread.v2” to workspace “W1”/);
  assert.match(audit, /settings: message tracking on/);
  s.chat = CHAT;

  // Removing Sidekick needs the Microsoft admin's approval first: a clear answer, and nothing changes.
  const before = await ann("POST", "/api/teams-links/remove", { id: OTHER });
  assert.equal(before.status, 409);
  assert.equal(before.body.consent, "needed");
  assert.ok((await waitingFor(ann)).some((w) => w.id === OTHER), "still waiting");
});

test(`[${ENGINE}] Teams: @Sidekick add/remove @name works only for the workspace's lead or an admin, and is audited`, async () => {
  const lead = { id: "29:lou", name: "Lou Lead", aadObjectId: "oid-lou" };
  const member = { id: "29:mo", name: "Mo Member", aadObjectId: "oid-mo" };
  const stranger = { id: "29:x", name: "Xavier", aadObjectId: "oid-x" };
  const bobInA = { id: "29:bob", name: "Bob Owner", aadObjectId: "oid-bob" };
  const run = async (from, verb, ...people) => {
    const i = sent.length;
    await toBot(command(s.chat, from, verb, ...people));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const out = sentTo(s.chat, i);
      if (out) return out;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("No reply");
  };

  assert.match(await run(member, "add", "29:maria"), /Only this group's Team Lead or an Org Admin can add people to W1/);
  assert.match(await run(stranger, "add", "29:maria"), /I don't know you in Sidekick yet/);
  assert.match(await run(bobInA, "add", "29:maria"), /I don't know you in Sidekick yet/, "another org's owner has no say here");

  // The lead adds Maria, who isn't in Sidekick yet: created as a Microsoft-sign-in Member of W1.
  assert.match(await run(lead, "add", "29:maria"), /Added Maria Lopez to W1\. They're new to Sidekick/);
  const maria = (await ann("GET", "/api/users")).body.users.find((u) => u.email === "maria@a.test");
  assert.ok(maria, "Maria has an account");
  assert.equal(maria.role, "Member");
  assert.equal(maria.microsoft, 1);
  assert.equal(maria.must_change_password, 0, "no temporary password");
  assert.deepEqual(maria.workspaces, [s.w1]);
  assert.equal((await client()("POST", "/api/auth/login", { email: "maria@a.test", password: "microsoft-only" })).status, 401, "no password works");
  assert.equal((await microsoftSignIn(client(), { tid: TA, oid: "oid-maria", email: "maria@a.test" })).to.pathname, "/", "Microsoft does");
  assert.match(await run(lead, "add", "29:maria"), /already in W1/);
  assert.match(await run(lead, "add", "29:gus"), /guest from another organization/);
  assert.match(await run(lead, "add", "29:ann"), /Org Owner and already sees every workspace/);

  // Removing: never the Org Owner, never yourself; Maria is taken off W1 but keeps her account.
  assert.match(await run(lead, "remove", "29:ann"), /sees every workspace/);
  assert.match(await run(lead, "remove", "29:maria"), /Took Maria Lopez off W1/);
  const after = (await ann("GET", "/api/users")).body.users.find((u) => u.email === "maria@a.test");
  assert.deepEqual(after.workspaces, []);
  assert.match(await run(member, "remove", "29:maria"), /Only this group's Team Lead or an Org Admin can take people off W1/);
  // The Org Owner can do it too.
  assert.match(await run({ id: "29:ann", name: "Ann Owner", aadObjectId: "oid-ann" }, "add", "29:maria"), /Added Maria Lopez to W1\./);

  const audit = JSON.stringify((await ann("GET", "/api/audit")).body);
  assert.match(audit, /Added Maria Lopez \(maria@a.test\) as Member \(Microsoft sign-in\) from Teams/);
  assert.match(audit, /Took Maria Lopez \(maria@a.test\) off workspace “W1” from Teams/);
  // "add" without a mention is just a question, answered as usual (not a command).
  const i = sent.length;
  await toBot(activity(TA, s.chat, { type: "message", text: "<at>Sidekick</at> add a risk section to the plan?", entities: [atSidekick], from: lead }));
  await new Promise((r) => setTimeout(r, 1500));
  assert.doesNotMatch(sentTo(s.chat, i), /People for W1|can't do that/);
});

test(`[${ENGINE}] Teams: "@Sidekick post meeting notes here" works only for the group's lead or an admin, and respects client guests`, async () => {
  const say = async (conv, from, text) => {
    const i = sent.length;
    await toBot(activity(TA, conv, { type: "message", from, text: `<at>Sidekick</at> ${text}`, entities: [atSidekick] }));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const out = sentTo(conv, i);
      if (out) return out;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("No reply");
  };
  const plan = async () => (await ann("GET", `/api/workspaces/${s.w1}/notes-chats`)).body;
  const MO = { id: "29:mo", name: "Mo Member", aadObjectId: "oid-mo" };
  const BOB = { id: "29:bob", name: "Bob Owner", aadObjectId: "oid-bob" };

  // Members, people Sidekick doesn't know and another organization's owner get a polite no; nothing changes.
  assert.match(await say(s.chat, MO, "post meeting notes here"), /Only the Team Lead or an admin can change where notes go/);
  assert.match(await say(s.chat, { id: "29:x", name: "Xavier", aadObjectId: "oid-x" }, "notes here"), /Only the Team Lead or an admin can change where notes go/);
  assert.match(await say(s.chat, BOB, "post meeting notes here"), /Only the Team Lead or an admin/);
  assert.equal((await plan()).mode, "unset");

  // The group's Team Lead: this chat gets the notes.
  assert.match(await say(s.chat, LOU, "post meeting notes here"), /Done ✓ Meeting notes for W1 will be posted here\./);
  let p = await plan();
  assert.deepEqual([p.mode, p.targets, p.chosenBy], ["chosen", [s.chat], "Lou Lead"]);
  assert.match(await say(s.chat, LOU, "send meeting notes here"), /already go here/);

  // A second chat, with client guests: accepted, but internal meetings' notes never go there.
  const CLIENT = "19:w1-client@thread.v2";
  await install(CLIENT, LOU);
  const f0 = sent.length;
  assert.equal((await lou("POST", "/api/teams-links", { id: CLIENT, ws: s.w1 })).status, 200);
  await waitFor(CLIENT, /Assigned to W1/, f0);
  assert.equal((await lou("PATCH", "/api/teams-links", { id: CLIENT, guests: true })).status, 200);
  const guestReply = await say(CLIENT, ANN, "Post meeting notes here please");
  assert.match(guestReply, /Done ✓ Meeting notes for W1 will be posted here\. They also still go to “Chat 19:wave2@thread\.v2”\./);
  assert.match(guestReply, /Client guests are in this chat, so only notes of meetings the client attended come here: internal meetings' notes never do/);
  p = await plan();
  assert.deepEqual(p.targets.slice().sort(), [s.chat, CLIENT].sort());

  // Stopping: a Member can't; the lead can, and the last chat stopping leaves notes in the portal.
  assert.match(await say(CLIENT, MO, "stop posting notes here"), /Only the Team Lead or an admin/);
  assert.match(await say(CLIENT, LOU, "stop posting notes here"), /won't be posted here any more\. They still go to “Chat 19:wave2@thread\.v2”/);
  assert.match(await say(CLIENT, LOU, "stop posting notes here"), /don't come here, so there's nothing to stop/);
  assert.match(await say(s.chat, LOU, "don't post notes here"), /No other chat gets them now, so they stay in the Sidekick portal/);
  assert.equal((await plan()).mode, "none");
  assert.match(await say(s.chat, LOU, "post meeting notes here"), /Done ✓/);

  // Audited like the portal picker, marked "from Teams"; Bob's org never sees it.
  const audit = JSON.stringify((await ann("GET", "/api/audit")).body);
  assert.match(audit, /Meeting notes now go to: “Chat 19:wave2@thread\.v2”, “Chat 19:w1-client@thread\.v2” \(from Teams\)/);
  assert.match(audit, /Meeting notes now go to: not posted in Teams \(portal only\) \(from Teams\)/);
  assert.doesNotMatch(JSON.stringify((await bob("GET", "/api/audit")).body), /Meeting notes now go to/);
  // The help card lists the commands.
  assert.match(await say(s.chat, MO, "help"), /post meeting notes here.*stop posting notes here/);
});

test(`[${ENGINE}] directory import: needs the Microsoft admin's approval, then imports Microsoft-sign-in people`, async () => {
  const status = (await ann("GET", "/api/directory")).body;
  assert.equal(status.connected, true);
  assert.equal(status.approvedAt, null);
  assert.equal(status.canApprove, true);
  assert.ok(status.permissions.some((p) => /User\.Read\.All/.test(p.name)));
  assert.equal((await mo("GET", "/api/directory")).status, 403, "Members can't");

  // Not approved yet: a clear "consent needed" answer.
  const before = await ann("GET", "/api/directory?q=pat");
  assert.equal(before.status, 409);
  assert.equal(before.body.consent, "needed");
  assert.match(before.body.error, /isn't approved for your Microsoft 365 organization yet/);

  // Only Org Owners/Admins start the approval; it goes to Microsoft for Org A's own tenant.
  const leadTry = await lou("GET", "/api/auth/microsoft/consent");
  assert.equal(new URL(leadTry.location).pathname + new URL(leadTry.location).search, "/users?error=1");
  assert.match(flashOf(leadTry), /Only Org Owners and Org Admins/);
  const start = await ann("GET", "/api/auth/microsoft/consent");
  assert.equal(start.status, 307);
  const u = new URL(start.location);
  assert.equal(u.pathname, `/${TA}/v2.0/adminconsent`);
  assert.equal(u.searchParams.get("client_id"), MS_CLIENT_ID);
  // An approval reported for another tenant is refused; then the real one is recorded.
  const wrong = await ann("GET", `/api/auth/microsoft/callback?admin_consent=True&tenant=${TB}&state=${u.searchParams.get("state")}`);
  assert.match(flashOf(wrong), /different Microsoft organization/);
  const again = new URL((await ann("GET", "/api/auth/microsoft/consent")).location);
  consented.add(TA);
  const back = await ann("GET", `/api/auth/microsoft/callback?admin_consent=True&tenant=${TA}&state=${again.searchParams.get("state")}`);
  assert.equal(new URL(back.location).pathname + new URL(back.location).search, "/users?microsoft=approved");
  assert.ok((await ann("GET", "/api/directory")).body.approvedAt);

  // Search: guests are left out; people already in Sidekick are marked.
  const found = (await ann("GET", "/api/directory?q=p")).body.people;
  assert.deepEqual(found.map((p) => p.name).sort(), ["Pat Person", "Priya Patel"]);
  const pat = found.find((p) => p.name === "Pat Person");
  assert.equal(pat.inSidekick, false);

  // Rules: a lead only Member/Viewer into the workspaces they lead.
  assert.equal((await lou("POST", "/api/directory/import", { ids: [pat.id], role: "Org Admin", workspaces: [s.w1] })).status, 403);
  assert.match((await lou("POST", "/api/directory/import", { ids: [pat.id], role: "Member", workspaces: [s.w2] })).body.error, /Pick at least one of your groups/);
  const r = await ann("POST", "/api/directory/import", { ids: [pat.id, guid("oid-pguest"), guid("oid-bea")], role: "Viewer", workspaces: [s.w2] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.added.map((a) => [a.name, a.created]), [["Pat Person", true]]);
  assert.equal(r.body.skipped.length, 2, "a guest and someone from another tenant are skipped");
  const patUser = (await ann("GET", "/api/users")).body.users.find((x) => x.email === "pat@a.test");
  assert.equal(patUser.role, "Viewer");
  assert.equal(patUser.microsoft, 1);
  assert.equal(patUser.must_change_password, 0);
  assert.deepEqual(patUser.workspaces, [s.w2]);
  assert.equal((await ann("GET", "/api/directory?q=pat")).body.people[0].inSidekick, true);
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Imported Pat Person \(pat@a.test\) from Microsoft 365 as Viewer/);
  assert.equal((await microsoftSignIn(client(), { tid: TA, oid: guid("oid-pat"), email: "pat@a.test" })).to.pathname, "/");
});

test(`[${ENGINE}] isolation: another org never sees or imports this org's directory, people or waiting chats`, async () => {
  // Org B's tenant isn't approved: consent needed, nothing from tenant A.
  const b = await bob("GET", "/api/directory?q=pat");
  assert.equal(b.status, 409);
  assert.doesNotMatch(JSON.stringify(b.body), /Pat|Priya/);
  consented.add(TB);
  const bSearch = (await bob("GET", "/api/directory?q=")).body.people.map((p) => p.name);
  assert.deepEqual(bSearch, ["Bea B"]);
  // Importing tenant A's person by id from Org B: not in tenant B's directory, so skipped.
  const imp = await bob("POST", "/api/directory/import", { ids: [guid("oid-priya")], role: "Member", workspaces: [s.bw] });
  assert.equal(imp.body.added.length, 0);
  assert.match(imp.body.skipped[0].reason, /Not found in your Microsoft 365 directory/);
  assert.ok(!(await bob("GET", "/api/users")).body.users.some((x) => /@a\.test$/.test(x.email)));
  // Org B's admin approval can't be recorded for Org A, and A's chats never wait in B.
  assert.deepEqual((await bob("GET", "/api/teams-links")).body.waiting, []);
  assert.ok(!(await bob("GET", "/api/teams-links")).body.links.some((l) => l.id === s.chat));
});

test(`[${ENGINE}] leaving chats: removed from the portal, refused installs and chats nobody assigned within 7 days`, async () => {
  // The Microsoft admin approved Sidekick in the directory test above, so it may remove itself now.
  assert.ok(consented.has(TA));
  // Who may remove: not a Member, not a lead for a chat in a group they don't lead or one they didn't add.
  assert.equal((await mo("POST", "/api/teams-links/remove", { id: s.chat })).status, 403);
  assert.equal((await lou("POST", "/api/teams-links/remove", { id: s.other })).status, 404);
  assert.equal((await bob("POST", "/api/teams-links/remove", { id: s.chat })).status, 404, "another org can't");
  // The lead removes Sidekick from the assigned chat: gone from Teams, its saved messages forgotten.
  const r = await lou("POST", "/api/teams-links/remove", { id: s.chat });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(removedFrom.includes(s.chat));
  assert.equal(await count("SELECT COUNT(*) FROM chat_messages"), 0);
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:wave2@thread.v2'"), 0);
  assert.ok(!(await ann("GET", "/api/teams-links")).body.links.some((l) => l.id === s.chat));
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Lou Lead.*Removed Sidekick from Teams chat “Chat 19:wave2@thread.v2” \(forgot 1 saved message\)/);

  // The timer: the refused install is removed now that it's allowed, and the admin's chat that nobody
  // assigned (the wait is shortened to a second here) gets a goodbye and is left.
  await new Promise((res) => setTimeout(res, 1100));
  const f = sent.length;
  const out = await tick();
  assert.ok(out.leftChats >= 2, JSON.stringify(out));
  assert.ok(removedFrom.includes(s.refused), "the refused install is gone");
  assert.ok(removedFrom.includes(s.other), "the unassigned chat is left");
  assert.ok(removedFrom.includes(s.unknown), "so is a chat held for an unknown adder, after the same wait");
  assert.match(sentTo(s.other, f), /Nobody assigned this chat to a group in the Sidekick portal within 7 days, so I'm leaving/);
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE id IN ('19:refused@thread.v2', '19:admins-chat@thread.v2')"), 0);
});

/** Waits until a SQL count reaches `n` (the bot works after answering Teams). */
async function countBecomes(sql, n, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await count(sql)) === n) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(await count(sql), n, sql);
}

test(`[${ENGINE}] who added Sidekick: a Team Lead not linked to Microsoft yet is recognised by email; nobody matching gets a plain answer`, async () => {
  // Tenant A's directory can be read now (approved in the directory test).
  assert.ok(consented.has(TA));
  const grace = client();
  // Grace was added on Users & access with her work email (other capitals than Microsoft's) and never used Microsoft sign-in.
  const g = await ann("POST", "/api/users", { name: "Grace Kim", email: "Grace.Kim@a.test", role: "Team Lead", workspaces: [s.w1] });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  await firstSignIn(grace, "grace.kim@a.test", g.body.tempPassword);
  DIRECTORY[TA].push({ id: guid("oid-grace"), displayName: "Grace Kim", mail: "grace.kim@a.test", userPrincipalName: "grace.kim@a.test", userType: "Member", accountEnabled: true });
  DIRECTORY[TA].push({ id: guid("oid-hana"), displayName: "Hana Ito", mail: "hana@a.test", userPrincipalName: "hana@a.test", userType: "Member", accountEnabled: true });
  const GRACE = { id: "29:grace", name: "Grace Kim", aadObjectId: guid("oid-grace") };

  // Grace adds Sidekick to a new group chat: her Microsoft account is linked, and it's a normal add.
  const CHAT = "19:litware-data@thread.v2";
  const f = sent.length;
  await install(CHAT, GRACE);
  await waitFor(CHAT, /not set up for this chat yet/, f);
  assert.doesNotMatch(sentTo(CHAT, f), /Only a Team Lead|don't know you/);
  assert.equal((await ann("GET", "/api/users")).body.users.find((u) => u.email === "grace.kim@a.test").microsoft, 1, "her Microsoft account is linked now");
  assert.match(JSON.stringify((await ann("GET", "/api/audit")).body), /Grace Kim.*Microsoft account linked when they added Sidekick to a Teams chat/);
  const waiting = (await grace("GET", "/api/teams-links?members=1")).body;
  const mine = waiting.waiting.find((w) => w.id === CHAT);
  assert.ok(mine, "Grace sees the chat she added under waiting");
  assert.equal(waiting.picker, true, "the org is tied to its tenant: chats are assigned from the waiting list");
  assert.equal(mine.added_by, "Grace Kim");
  assert.ok(Array.isArray(mine.members) && mine.members.includes("Maria Lopez"), JSON.stringify(mine));
  assert.ok(!("service_url" in mine), "no Teams addresses in the answer");
  assert.ok((await ann("GET", "/api/teams-links")).body.waiting.some((w) => w.id === CHAT), "and so does the Org Owner");
  assert.deepEqual((await bob("GET", "/api/teams-links")).body.waiting, [], "another org never does");
  assert.equal((await grace("POST", "/api/teams-links", { id: CHAT, ws: s.w1 })).status, 200, "Grace assigns it");

  // Someone in the directory with no Sidekick account: the plain answer, nothing linked, not waiting.
  const HANA = { id: "29:hana", name: "Hana Ito", aadObjectId: guid("oid-hana") };
  const HCHAT = "19:hana@thread.v2";
  const h = sent.length;
  await install(HCHAT, HANA);
  await waitFor(HCHAT, /I don't know you in Sidekick yet\. Ask your Sidekick admin to add you/, h);
  assert.ok(!(await ann("GET", "/api/teams-links")).body.waiting.some((w) => w.id === HCHAT));
  // Ann adds Hana as a Team Lead; when Hana mentions Sidekick there, she's recognised and the chat starts afresh.
  assert.equal((await ann("POST", "/api/users", { name: "Hana Ito", email: "hana@a.test", role: "Team Lead", workspaces: [s.w1] })).status, 200);
  const h2 = sent.length;
  await toBot(activity(TA, HCHAT, { type: "message", from: HANA, text: "<at>Sidekick</at> hello", entities: [atSidekick] }));
  await waitFor(HCHAT, /not set up for this chat yet/, h2);
  const hw = (await ann("GET", "/api/teams-links")).body.waiting.find((w) => w.id === HCHAT);
  assert.equal(hw?.added_by, "Hana Ito");

  // A guest from another company in tenant A whose mail matches a Sidekick person is never linked: unknown.
  assert.equal((await ann("POST", "/api/users", { name: "Gwen Guest", email: "gwen@outside.test", role: "Team Lead", workspaces: [s.w1] })).status, 200);
  DIRECTORY[TA].push({ id: guid("oid-gwen"), displayName: "Gwen Guest", mail: "gwen@outside.test", userPrincipalName: "gwen_outside.test#EXT#@a.test", userType: "Guest", accountEnabled: true });
  const GCHAT = "19:guest-adder@thread.v2";
  const gg = sent.length;
  await install(GCHAT, { id: "29:gwen", name: "Gwen Guest", aadObjectId: guid("oid-gwen") });
  await waitFor(GCHAT, /I don't know you in Sidekick yet/, gg);
  assert.equal((await ann("GET", "/api/users")).body.users.find((u) => u.email === "gwen@outside.test").microsoft, 0, "a guest's account is never linked");
  assert.ok(!(await ann("GET", "/api/teams-links")).body.waiting.some((w) => w.id === GCHAT));
  s.grace = { client: grace, from: GRACE };
});

test(`[${ENGINE}] stuck chats: Microsoft refuses the self-removal, admins see it, and removing + re-adding Sidekick starts afresh`, async () => {
  const { client: grace, from: GRACE } = s.grace;
  // A Member adds Sidekick; Microsoft refuses its self-removal, so the chat stays marked "leaving".
  const STUCK = "19:stuck@thread.v2";
  DENY_SELF_REMOVAL.add(STUCK);
  const f = sent.length;
  await install(STUCK, MO);
  await waitFor(STUCK, /Only a Team Lead or admin can add me to a chat, so I'm leaving/, f);
  await countBecomes("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:stuck@thread.v2' AND leaving = 'installer' AND leave_error = 'consent'", 1);
  // Admins see it under Needs attention, with the Microsoft permission to approve; a Team Lead doesn't.
  await tick(); // runs the watchers (and retries the removal, refused again)
  let finding;
  for (let i = 0; i < 40 && !finding; i++) {
    finding = (await ann("GET", "/api/findings")).body.findings?.find((x) => x.kind === "self_removal");
    if (!finding) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(finding, "the Org Owner sees the finding");
  assert.match(finding.detail, /TeamsAppInstallation\.ReadWriteSelfForChat\.All/);
  assert.equal(finding.actionHref, "/users");
  assert.ok(!(await grace("GET", "/api/findings")).body.findings.some((x) => x.kind === "self_removal"), "admins only");

  // Grace removes Sidekick in Teams and adds it back: the chat waits to be assigned again, for her and the Org Owner.
  await toBot(activity(TA, STUCK, { type: "installationUpdate", action: "remove", from: GRACE }));
  await countBecomes("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:stuck@thread.v2'", 0);
  DENY_SELF_REMOVAL.delete(STUCK);
  const r = sent.length;
  await install(STUCK, GRACE);
  await waitFor(STUCK, /not set up for this chat yet/, r);
  assert.ok((await grace("GET", "/api/teams-links")).body.waiting.some((w) => w.id === STUCK), "Grace sees it waiting");
  assert.ok((await ann("GET", "/api/teams-links")).body.waiting.some((w) => w.id === STUCK), "so does the Org Owner");
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:stuck@thread.v2' AND leaving IS NULL AND added_by_oid IS NOT NULL"), 1);

  // Teams often leaves the adder's name out of the install event: the portal still shows who it was.
  const NONAME = "19:no-name@thread.v2";
  const nn = sent.length;
  await install(NONAME, { id: GRACE.id, aadObjectId: GRACE.aadObjectId });
  await waitFor(NONAME, /not set up for this chat yet/, nn);
  assert.equal((await grace("GET", "/api/teams-links")).body.waiting.find((w) => w.id === NONAME)?.added_by, "Grace Kim", "never \"Someone in Teams\" when Sidekick knows who it was");
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE added_by = 'Someone in Teams'"), 0);

  // A re-add straight over a chat still marked leaving (no removal in between) also starts afresh.
  const AGAIN = "19:again@thread.v2";
  DENY_SELF_REMOVAL.add(AGAIN);
  await install(AGAIN, MO);
  await countBecomes("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:again@thread.v2' AND leave_error = 'consent'", 1);
  await install(AGAIN, GRACE);
  await countBecomes("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:again@thread.v2' AND leaving IS NULL AND leave_error IS NULL", 1);
  assert.ok((await grace("GET", "/api/teams-links")).body.waiting.some((w) => w.id === AGAIN));

  // Teams may report the removal as a member change instead: same result.
  const MEMBER = "19:member-change@thread.v2";
  DENY_SELF_REMOVAL.add(MEMBER);
  await install(MEMBER, MO);
  await countBecomes("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:member-change@thread.v2' AND leave_error = 'consent'", 1);
  await toBot(activity(TA, MEMBER, { type: "conversationUpdate", membersRemoved: [{ id: "bot", name: "Sidekick" }], channelData: { tenant: { id: TA } } }));
  await countBecomes("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:member-change@thread.v2'", 0);

  // The leaving timer stops retrying a chat Teams says Sidekick isn't in any more.
  const LEFT = "19:already-left@thread.v2";
  DENY_SELF_REMOVAL.add(LEFT);
  await install(LEFT, MO);
  await countBecomes("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:already-left@thread.v2' AND leave_error = 'consent'", 1);
  GONE.add(LEFT);
  await tick();
  assert.equal(await count("SELECT COUNT(*) FROM teams_conversations WHERE id = '19:already-left@thread.v2'"), 0);
  assert.ok(!removedFrom.includes(LEFT), "nothing to remove");
});
