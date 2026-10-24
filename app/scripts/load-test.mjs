/**
 * `npm --prefix app run load:test`: the load test for docs/SCALE.md (roadmap item 6). Runs realistic traffic against a
 * LOCAL copy of Sidekick loaded with the load world (scripts/load-world.mjs) and reports latencies, errors, database
 * time and job-queue lag in plain numbers. Free: Claude, Teams and Microsoft are simulated; nothing leaves this Mac.
 *
 * What it does
 * 1. Starts its own copy of the app (`next dev` on --port, default 3570) against the load database, with fake Claude
 *    (answers after ~--claude-ms, default 1,500 ms, like the real API), the local Teams test path (single tenant
 *    `tenant-1`) pointed at a fake Teams connector here, and the in-app heartbeat off (this script beats instead).
 *    `--base http://localhost:3000` uses a copy that's already running instead (it must have the same settings).
 * 2. Warms every route once (next dev compiles on first use; that time isn't counted).
 * 3. Runs `--users` virtual people (default 40) for `--duration` seconds (default 120). Each one is a signed-in
 *    person from the load world (session cookie `lt-<user id>`), picked so bigger organizations send more traffic,
 *    and loops over a mix with 1-3 s of thinking between actions:
 *    - 45% portal page loads: the page's HTML plus the calls its screen makes (/api/me, findings, the page's data);
 *    - 20% Ask questions (POST /api/ask) in one of their groups;
 *    - 15% Teams messages ("@Sidekick …" in the group's linked chat, through POST /api/messages); the time until the
 *      answer reaches the fake Teams connector is measured too ("teams answer");
 *    - 5% uploads (a small text file, POST /api/docs);
 *    - 15% other reads (activity, usage, meetings, action items).
 *    Meanwhile the job heartbeat (POST /api/jobs/tick) beats every 5 s, starting with a sweep that queues the
 *    watchers for all 100 organizations.
 *    `--noisy` adds one organization (the biggest) firing questions as fast as it can from 20 extra people, and 300
 *    watcher jobs of its own queued a minute before the start, to show whether one company can slow everyone else
 *    down (per-company fairness in Claude calls and in the job queue).
 * 4. Reports per action: count, errors, p50/p95/p99 and max latency; database time per request from the traces the
 *    app saved (queries and ms per request); queue lag (how long due jobs waited before a worker took them, overall and
 *    per company) and the backlog left at the end. Written to --out (default app/.load-results/<time>.json, git-ignored)
 *    and printed as a table.
 *
 * `--fresh <template db>` first re-creates the load database as a copy of that one (e.g. a copy saved right after
 * load:world with `createdb -T sidekick_load sidekick_load_base`), so before/after runs start from the same data.
 * Slow queries (over SIDEKICK_SLOW_QUERY_MS, default 200 here) are written to the .server.log next to the results.
 *
 * Usage: node scripts/load-test.mjs [--db postgres:///sidekick_load] [--fresh sidekick_load_base] [--users 40] [--duration 120] [--noisy]
 *        [--claude-ms 1500] [--capacity 24] [--port 3570] [--base <url>] [--app <checkout>/app] [--label before] [--out <file>]
 * `--capacity N`: fake Claude refuses calls beyond N at once as "rate limited" (like the real account's shared
 * limit), so `--noisy` shows whether one company's flood turns into errors for the others.
 * `--app <dir>`: run another checkout's app folder (e.g. main) with this script, for before/after numbers.
 * Local only: refuses a non-local database and NODE_ENV=production.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import pg from "pg";

const APP = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);
const DB = opt("--db", "postgres:///sidekick_load");
const USERS = Number(opt("--users", "40"));
const DURATION_S = Number(opt("--duration", "120"));
const CLAUDE_MS = Number(opt("--claude-ms", "1500"));
const PORT = Number(opt("--port", "3570"));
const LABEL = opt("--label", "run");
const NOISY = flag("--noisy");
const CAPACITY = Number(opt("--capacity", "0"));
// Another checkout of the app to run (e.g. main, to measure "before" with the same script); default this one.
const APP_DIR = path.resolve(opt("--app", APP));
const OUT = opt("--out", path.join(APP, ".load-results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${LABEL}.json`));
let BASE = opt("--base", `http://localhost:${PORT}`);

if (process.env.NODE_ENV === "production") throw new Error("The load test never runs in production.");
const local = /^postgres(ql)?:\/\/\//.test(DB) || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB).hostname);
if (!local) throw new Error(`Refusing ${DB}: the load test only runs against a Postgres database on this Mac.`);

const FRESH = opt("--fresh", null);
if (FRESH) {
  const name = new URL(DB.replace(/^postgres(ql)?:\/\/\//, "postgres://localhost/")).pathname.slice(1);
  const { spawnSync } = await import("node:child_process");
  spawnSync("dropdb", ["--if-exists", name], { stdio: "inherit" });
  if (spawnSync("createdb", ["-T", FRESH, name], { stdio: "inherit" }).status !== 0) throw new Error(`Couldn't copy ${FRESH} to ${name}.`);
}
const db = new pg.Pool({ connectionString: DB, max: 3 });
const TICK_SECRET = crypto.randomBytes(24).toString("hex");
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- measurements ---------- */
const samples = new Map(); // action → { ms: number[], errors: Map<status, n>, org?: Map }
/** Records one action's latency (and failure status, if any). */
function record(action, ms, status, orgId) {
  let s = samples.get(action);
  if (!s) samples.set(action, (s = { ms: [], errors: new Map(), byOrg: new Map() }));
  s.ms.push(ms);
  if (status >= 400 || status === 0) s.errors.set(status, (s.errors.get(status) ?? 0) + 1);
  if (orgId) {
    const list = s.byOrg.get(orgId) ?? [];
    list.push(ms);
    s.byOrg.set(orgId, list);
  }
}
const pct = (arr, q) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.floor(q * a.length))]);
};

/* ---------- fake Teams connector: accepts every post, times the answers ---------- */
const waitingAnswers = new Map(); // conversation id → [start times]
const connector = http.createServer((req, res) => {
  const conv = decodeURIComponent(req.url).match(/\/v3\/conversations\/([^/]+)\/activities/)?.[1]?.split(";")[0];
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const list = conv ? waitingAnswers.get(conv) : null;
    // A typing indicator isn't the answer; anything with text or cards is.
    if (list?.length && !/"type"\s*:\s*"typing"/.test(body)) record("teams answer (end to end)", Date.now() - list.shift().t, 200, list.org);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg-${Date.now()}` }));
  });
});

/* ---------- HTTP helpers ---------- */
/** One request as a signed-in person (or anonymous with no token); returns status and parsed body. Never throws. */
async function call(token, method, url, body, { form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.cookie = `sk_session=${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: "manual" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, body: { error: String(e) }, ms: performance.now() - t0 };
  }
}
/** Times one action made of several calls (a page load); the action fails if any call does. */
async function timed(action, orgId, fn) {
  const t0 = performance.now();
  let worst = 200;
  const step = async (...args) => {
    const r = await call(...args);
    if (r.status >= 400 || r.status === 0) worst = r.status;
    return r;
  };
  await fn(step);
  record(action, performance.now() - t0, worst, orgId);
}

/* ---------- the people ---------- */
async function loadPeople() {
  const { rows } = await db.query(
    `SELECT u.id, u.org_id, u.role, (SELECT COUNT(*) FROM workspaces w WHERE w.org_id = u.org_id) AS org_groups
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_agent = 'load-test'`,
  );
  if (!rows.length) throw new Error("No load-test sessions in this database: run `npm --prefix app run load:world` first.");
  const { rows: mem } = await db.query(
    `SELECT m.user_id, m.workspace_id FROM workspace_members m JOIN sessions s ON s.user_id = m.user_id WHERE s.user_agent = 'load-test'`,
  );
  const groups = new Map();
  for (const m of mem) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.workspace_id]);
  // Admins see every group: give them a sample of their organization's.
  const { rows: orgWs } = await db.query("SELECT org_id, id FROM workspaces ORDER BY random()");
  const byOrg = new Map();
  for (const w of orgWs) {
    const l = byOrg.get(w.org_id) ?? [];
    if (l.length < 30) l.push(w.id);
    byOrg.set(w.org_id, l);
  }
  return rows.map((r) => ({
    token: `lt-${r.id}`,
    id: r.id,
    org: r.org_id,
    role: r.role,
    weight: Math.sqrt(Number(r.org_groups)),
    groups: ["Org Owner", "Org Admin"].includes(r.role) ? byOrg.get(r.org_id) ?? [] : groups.get(r.id) ?? [],
  })).filter((p) => p.groups.length);
}
/** Picks a person, bigger organizations more often (weight = √groups). */
function weightedPick(people) {
  const total = people.reduce((a, p) => a + p.weight, 0);
  let x = Math.random() * total;
  for (const p of people) if ((x -= p.weight) <= 0) return p;
  return people.at(-1);
}

const TOPICS = ["cutover", "migration", "payroll", "invoice", "onboarding", "budget", "timeline", "vendor", "contract", "testing", "rollout", "security", "backup", "license", "reporting", "integration", "forecast", "staffing", "approval", "compliance"];
const question = () => `What did we decide about the ${rand(TOPICS)} ${rand(["date", "owner", "plan", "risk", "cost"])}?`;
const canEdit = (p) => p.role !== "Viewer";

/* ---------- actions ---------- */
const PAGES = {
  home: (p, ws) => [["GET", "/home"], ["GET", "/api/me"], ["GET", "/api/overview"], ["GET", `/api/findings?ws=${ws}`], ["GET", "/api/support/unread"]],
  knowledge: (p, ws) => [["GET", `/knowledge?ws=${ws}`], ["GET", "/api/me"], ["GET", `/api/docs?ws=${ws}`], ["GET", "/api/support/unread"]],
  meetings: (p, ws) => [["GET", `/meetings?ws=${ws}`], ["GET", "/api/me"], ["GET", `/api/meetings?ws=${ws}`], ["GET", "/api/support/unread"]],
  groups: () => [["GET", "/workspaces"], ["GET", "/api/me"], ["GET", "/api/workspaces"], ["GET", "/api/support/unread"]],
};
let teamsSeq = 0;
const ACTIONS = [
  [45, async (p, ws) => {
    const name = rand(Object.keys(PAGES));
    await timed(`page: ${name}`, p.org, async (step) => {
      const [first, ...rest] = PAGES[name](p, ws);
      await step(p.token, ...first);
      await Promise.all(rest.map((c) => step(p.token, ...c))); // a screen fires its calls together
    });
  }],
  [20, async (p, ws) => {
    const r = await call(p.token, "POST", "/api/ask", { ws, question: question() });
    record("ask (portal)", r.ms, r.status, p.org);
  }],
  [15, async (p, ws) => {
    const conv = `lt-chat-${ws}`;
    const list = waitingAnswers.get(conv) ?? Object.assign([], { org: p.org });
    list.push({ t: Date.now() });
    waitingAnswers.set(conv, list);
    const activity = {
      type: "message", id: `lt-${++teamsSeq}`, channelId: "msteams", serviceUrl: SERVICE_URL, text: `@Sidekick ${question()}`,
      from: { id: `lt-user-${p.id}`, name: "Load Tester", aadObjectId: `lt-aad-${p.id}` }, recipient: { id: "bot", name: "Sidekick" },
      conversation: { id: conv, conversationType: "groupChat", tenantId: "tenant-1", name: "Load chat" },
    };
    const r = await call(null, "POST", "/api/messages", activity);
    record("teams message (accepted)", r.ms, r.status, p.org);
  }],
  [5, async (p, ws) => {
    if (!canEdit(p)) return;
    const form = new FormData();
    form.set("ws", ws);
    form.append("files", new Blob([`Load test note ${crypto.randomUUID()}. The ${rand(TOPICS)} plan moves to next week; ${rand(TOPICS)} owner is Sam.`], { type: "text/plain" }), `load-${Date.now()}.txt`);
    const r = await call(p.token, "POST", "/api/docs", undefined, { form });
    record("upload", r.ms, r.status, p.org);
  }],
  [15, async (p, ws) => {
    // Activity and Usage are for Org Owners/Admins only; everyone else reads their group's lists.
    const admin = ["Org Owner", "Org Admin"].includes(p.role);
    const which = rand(admin ? [["activity", "/api/activity"], ["usage", "/api/usage"], ["overview", "/api/overview"]] : [["meetings list", `/api/meetings?ws=${ws}`], ["overview", "/api/overview"]]);
    const r = await call(p.token, "GET", which[1]);
    record(`read: ${which[0]}`, r.ms, r.status, p.org);
  }],
];
const TOTAL_W = ACTIONS.reduce((a, [w]) => a + w, 0);
const pickAction = () => {
  let x = Math.random() * TOTAL_W;
  for (const [w, fn] of ACTIONS) if ((x -= w) <= 0) return fn;
  return ACTIONS[0][1];
};

/* ---------- the app ---------- */
let server;
let SERVICE_URL;
async function startApp() {
  const env = {
    ...process.env,
    NODE_ENV: "development",
    NEXT_DIST_DIR: ".next-load",
    DATABASE_URL: DB,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? "",
    SIDEKICK_FAKE_CLAUDE: "1",
    SIDEKICK_FAKE_CLAUDE_MS: String(CLAUDE_MS),
    SIDEKICK_FAKE_CLAUDE_CAPACITY: String(CAPACITY),
    ANTHROPIC_API_KEY: "",
    AZURE_SEARCH_ENDPOINT: "",
    AZURE_SEARCH_API_KEY: "",
    AZURE_OPENAI_ENDPOINT: "",
    AZURE_OPENAI_API_KEY: "",
    TEAMS_LOCAL_PLAYGROUND: "true",
    CLIENT_ID: "",
    CLIENT_SECRET: "",
    TENANT_ID: "tenant-1",
    ENTRA_CLIENT_ID: "",
    ENTRA_CLIENT_SECRET: "",
    SIDEKICK_PUBLIC_URL: "",
    SIDEKICK_SCHEDULER: "off",
    SIDEKICK_TICK_SECRET: TICK_SECRET,
    SIDEKICK_SLOW_QUERY_MS: process.env.SIDEKICK_SLOW_QUERY_MS ?? "200",
    SIDEKICK_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    PWNED_PASSWORDS_URL: "",
  };
  const tsconfig = fs.readFileSync(path.join(APP_DIR, "tsconfig.json"), "utf8");
  server = spawn(path.join(APP_DIR, "node_modules/.bin/next"), ["dev", "--port", String(PORT)], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  server.on("exit", () => fs.writeFileSync(path.join(APP_DIR, "tsconfig.json"), tsconfig)); // next dev edits it
  const log = fs.createWriteStream(OUT.replace(/\.json$/, ".server.log"));
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).status < 500) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("The app didn't start (see the .server.log next to the results).");
}
const tick = (sweep, kinds) => call(null, "POST", "/api/jobs/tick", { ...(sweep ? { sweep: true } : {}), ...(kinds ? { kinds } : {}) }, { headers: { "x-sidekick-tick": TICK_SECRET } });

/* ---------- run ---------- */
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await new Promise((r) => connector.listen(0, "127.0.0.1", r));
SERVICE_URL = `http://127.0.0.1:${connector.address().port}`;
if (!argv.includes("--base")) await startApp();
const people = await loadPeople();
console.log(`Load test "${LABEL}": ${USERS} people for ${DURATION_S} s against ${BASE} (fake Claude ~${CLAUDE_MS} ms${NOISY ? ", plus one noisy company" : ""})`);

// Warm-up: compile every route once (not measured). Uses a throwaway sample.
process.stdout.write("Warming up…");
const warm = people[0];
for (let round = 0; round < 2; round++) {
  for (const fn of ACTIONS.map(([, f]) => f)) await fn(warm, warm.groups[0]);
  await tick(false, ["jobs.prune"]); // compiles the route without starting the watchers early
}
samples.clear();
waitingAnswers.clear();
console.log(" done.");

// The noisy company also floods the job queue: 300 watcher runs queued a minute before the test starts (older than
// everyone else's, so a first-come-first-served queue would run all of them first).
const biggest = [...people].sort((a, b) => b.weight - a.weight)[0]?.org;
if (NOISY) {
  const at = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < 300; i += 100) {
    const rows = Array.from({ length: 100 }, (_, k) => [crypto.randomUUID(), biggest, `lt-noisy-${i + k}-${crypto.randomUUID()}`, at]);
    await db.query(
      `INSERT INTO jobs (id, kind, org_id, payload, idempotency_key, status, run_at, attempts, max_attempts, created_at, updated_at)
       SELECT id, 'watch.org', org, '{}', key, 'queued', at, 0, 3, at, at FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) AS t(id, org, key, at)`,
      [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3])],
    );
  }
}
const startedAt = new Date();
const stopAt = Date.now() + DURATION_S * 1000;
const jobsBefore = (await db.query("SELECT COUNT(*)::int AS n FROM jobs")).rows[0].n;
// The heartbeat: a sweep first (watchers for every company), then every 5 s.
const heartbeat = (async () => {
  let first = true;
  while (Date.now() < stopAt) {
    const r = await tick(first);
    record("job heartbeat (tick)", r.ms, r.status);
    first = false;
    await sleep(5000);
  }
})();
const vu = async () => {
  while (Date.now() < stopAt) {
    const p = weightedPick(people);
    await pickAction()(p, rand(p.groups));
    await sleep(1000 + Math.random() * 2000);
  }
};
// The noisy neighbour: the biggest company's people asking back to back, no thinking time.
const noisy = async () => {
  const mine = people.filter((p) => p.org === biggest);
  while (Date.now() < stopAt) {
    const p = rand(mine);
    const r = await call(p.token, "POST", "/api/ask", { ws: rand(p.groups), question: question() });
    record("ask (noisy company)", r.ms, r.status, p.org);
  }
};
const timer = setInterval(() => process.stdout.write("."), 5000);
await Promise.all([heartbeat, ...Array.from({ length: USERS }, vu), ...(NOISY ? Array.from({ length: 20 }, noisy) : [])]);
clearInterval(timer);
const endedAt = new Date();
await sleep(3000); // late Teams answers
console.log("");

/* ---------- report ---------- */
const actions = [...samples.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => {
  const errors = [...s.errors.values()].reduce((a, b) => a + b, 0);
  return { action: name, count: s.ms.length, errors, errorCodes: Object.fromEntries(s.errors), p50: pct(s.ms, 0.5), p95: pct(s.ms, 0.95), p99: pct(s.ms, 0.99), max: Math.round(Math.max(0, ...s.ms)) };
});
// Ask latency for everyone except the noisy company (the fairness check).
const others = [...(samples.get("ask (portal)")?.byOrg ?? new Map())].filter(([o]) => !NOISY || o !== biggest).flatMap(([, l]) => l);
const fairness = NOISY ? { noisyOrg: biggest, othersAskP50: pct(others, 0.5), othersAskP95: pct(others, 0.95), othersAskCount: others.length } : null;

const w = [startedAt.toISOString(), endedAt.toISOString()];
const dbTime = (await db.query(
  `SELECT name, COUNT(*)::int AS n, ROUND(AVG(db_queries))::int AS queries, ROUND(AVG(db_ms))::int AS db_ms_avg,
          (PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY db_ms))::int AS db_ms_p95, ROUND(AVG(duration_ms))::int AS total_ms_avg
     FROM traces WHERE started_at >= $1 AND started_at <= $2 GROUP BY name ORDER BY COUNT(*) DESC LIMIT 25`, w,
)).rows;
const lag = (await db.query(
  `SELECT COUNT(*)::int AS n,
          (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lag))::int AS p50, (PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY lag))::int AS p95, MAX(lag)::int AS max
     FROM (SELECT EXTRACT(EPOCH FROM (started_at::timestamptz - run_at::timestamptz)) * 1000 AS lag FROM jobs
            WHERE started_at >= $1 AND started_at <= $2 AND status IN ('done', 'dead', 'queued', 'running')) x`, w,
)).rows[0];
const lagOthers = (await db.query(
  `SELECT COUNT(*)::int AS n, (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lag))::int AS p50, (PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY lag))::int AS p95, MAX(lag)::int AS max
     FROM (SELECT EXTRACT(EPOCH FROM (started_at::timestamptz - run_at::timestamptz)) * 1000 AS lag FROM jobs
            WHERE started_at >= $1 AND started_at <= $2 AND org_id IS NOT NULL AND org_id <> $3) x`, [...w, NOISY ? biggest : ""],
)).rows[0];
// How many companies had their watchers run during the test (the sweep at the start queues one run per company).
const watchedCompanies = (await db.query(
  "SELECT COUNT(DISTINCT org_id)::int AS n FROM jobs WHERE kind = 'watch.org' AND status = 'done' AND finished_at >= $1 AND finished_at <= $2 AND org_id <> $3", [...w, NOISY ? biggest : ""],
)).rows[0].n;
const lagByOrg = (await db.query(
  `SELECT org_id, COUNT(*)::int AS n, MAX(EXTRACT(EPOCH FROM (started_at::timestamptz - run_at::timestamptz)) * 1000)::int AS max_lag
     FROM jobs WHERE started_at >= $1 AND started_at <= $2 AND org_id IS NOT NULL GROUP BY org_id`, w,
)).rows;
const backlog = (await db.query("SELECT COUNT(*)::int AS n, MIN(run_at) AS oldest FROM jobs WHERE status = 'queued' AND run_at <= $1", [endedAt.toISOString()])).rows[0];
const jobsRan = (await db.query("SELECT COUNT(*)::int AS n FROM jobs WHERE started_at >= $1 AND started_at <= $2", w)).rows[0].n;
const sizes = (await db.query(
  `SELECT relname AS t, n_live_tup::int AS rows FROM pg_stat_user_tables
    WHERE relname IN ('passages','traces','trace_spans','usage_events','chat_messages','jobs','audit_log','conversation_turns') ORDER BY relname`,
)).rows;
const report = {
  label: LABEL, app: APP_DIR, startedAt: w[0], endedAt: w[1], users: USERS, durationS: DURATION_S, claudeMs: CLAUDE_MS, capacity: CAPACITY, noisy: NOISY,
  poolMax: process.env.DATABASE_POOL_MAX || "default", actions, fairness, dbTime,
  queue: { jobsBefore, jobsRan, lagMs: lag, othersLagMs: lagOthers, watchedCompanies, companiesWithJobs: lagByOrg.length, worstCompanyLagMs: Math.max(0, ...lagByOrg.map((r) => r.max_lag ?? 0)), backlogAtEnd: backlog.n, oldestDue: backlog.oldest },
  tables: sizes,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad("Action", 30)}${pad("count", 8)}${pad("errors", 8)}${pad("p50 ms", 9)}${pad("p95 ms", 9)}${pad("p99 ms", 9)}max ms`);
for (const a of actions) console.log(`${pad(a.action, 30)}${pad(a.count, 8)}${pad(a.errors, 8)}${pad(a.p50, 9)}${pad(a.p95, 9)}${pad(a.p99, 9)}${a.max}`);
if (fairness) console.log(`\nFairness: other companies' Ask p50 ${fairness.othersAskP50} ms, p95 ${fairness.othersAskP95} ms (${fairness.othersAskCount} questions)`);
console.log(`\nDatabase time per request (from traces; top 10):`);
for (const d of dbTime.slice(0, 10)) console.log(`  ${pad(d.name, 40)} n=${pad(d.n, 6)} queries≈${pad(d.queries, 5)} db avg ${pad(d.db_ms_avg, 5)} ms, p95 ${pad(d.db_ms_p95, 5)} ms (whole request avg ${d.total_ms_avg} ms)`);
console.log(`\nJob queue: ${jobsRan} jobs ran; wait before a worker took them p50 ${lag.p50 ?? 0} ms, p95 ${lag.p95 ?? 0} ms, max ${lag.max ?? 0} ms; backlog at the end ${backlog.n}.`);
console.log(`  Companies whose watchers ran: ${watchedCompanies}${NOISY ? " (not counting the noisy one)" : ""}; their jobs' wait p50 ${lagOthers.p50 ?? 0} ms, p95 ${lagOthers.p95 ?? 0} ms.`);
console.log(`\nSaved: ${OUT}`);

if (server) {
  server.kill("SIGTERM");
  await sleep(2000);
}
connector.close();
await db.end();
process.exit(0);
