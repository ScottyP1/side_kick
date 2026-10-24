/**
 * `npm --prefix app run load:world`: builds the **load-test world** straight into a LOCAL Postgres database, for the
 * scale tests in docs/SCALE.md (roadmap item 6, "Scale readiness"). Not the demo world (scripts/seed-demo.mjs builds
 * that one through the app's API, ~120 people); this one is ~400 times bigger and written with bulk INSERTs, because
 * going through the API would take hours.
 *
 * What it makes (default size, `--scale 1`; `--scale 0.1` for a quick try), all made-up:
 * - 100 organizations of very different sizes (one with ~1,000 groups, a handful with hundreds, a long tail of small
 *   ones), 10,000 groups, ~50,000 people in every role, ~150,000 group memberships;
 * - per group: documents with passages, imported meetings (transcript + notes passages, decisions, action items),
 *   questions asked, tracked Teams chat messages, one linked Teams group chat, findings; connector work items for a
 *   third of the organizations;
 * - history that grows every day: ~40 days of traces and spans (some older than the 30-day retention, so pruning has
 *   something to do), AI usage rows, audit entries, guardrail events, finished jobs, Ask/Teams conversations;
 * - signed-in sessions for ~20 people per organization (owner, admins, Team Leads, members, viewers) whose cookie is
 *   `sk_session=lt-<user id>`, so the load test (scripts/load-test.mjs) can act as them without passwords. Nobody can
 *   sign in with a password (every password hash is a random one nobody knows).
 * The Teams chats use tenant `tenant-1` (the single-tenant test setup) and the conversation id `lt-chat-<group id>`.
 *
 * Usage: node scripts/load-world.mjs [--db postgres:///sidekick_load] [--scale 1] [--seed 7]
 * The database is dropped and created again first. It must be on this Mac (postgres:/// or localhost): the script
 * refuses anything else, and refuses NODE_ENV=production. Nothing here calls Claude, Microsoft or Azure.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const APP = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DB = opt("--db", "postgres:///sidekick_load");
const SCALE = Number(opt("--scale", "1"));
const SEED = Number(opt("--seed", "7"));

if (process.env.NODE_ENV === "production") throw new Error("The load world never runs in production.");
const local = /^postgres(ql)?:\/\/\//.test(DB) || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB).hostname);
if (!local) throw new Error(`Refusing ${DB}: the load world only goes into a Postgres database on this Mac.`);

/* ---------- deterministic randomness (the same world every run with the same seed) ---------- */
let state = SEED >>> 0 || 1;
/** A number in [0, 1) from a small seeded generator (mulberry32). */
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const id = () => crypto.randomUUID();
const DAY = 86400_000;
const NOW = Date.now();
/** An ISO time `maxDays` or fewer days ago (and at least `minDays`). */
const ago = (maxDays, minDays = 0) => new Date(NOW - (minDays + rand() * (maxDays - minDays)) * DAY).toISOString();

/* ---------- made-up vocabulary ---------- */
const TOPICS = ["cutover", "migration", "payroll", "invoice", "onboarding", "datacenter", "firewall", "budget", "timeline", "vendor", "contract", "training", "testing", "rollout", "security", "backup", "license", "reporting", "dashboard", "integration", "interface", "warehouse", "forecast", "staffing", "workshop", "requirements", "approval", "compliance", "audit", "pricing"];
const WORDS = ["team", "client", "plan", "wave", "phase", "review", "owner", "risk", "date", "scope", "change", "update", "status", "decision", "issue", "deadline", "meeting", "report", "draft", "sign-off", "estimate", "hours", "cost", "server", "network", "users", "data", "system", "process", "policy"];
const FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Rowan", "Skyler", "Drew", "Reese", "Parker", "Emerson", "Hayden", "Kai", "Logan", "Peyton"];
const LAST = ["Rivera", "Chen", "Okafor", "Novak", "Larsen", "Haddad", "Silva", "Kowalski", "Ito", "Moreau", "Brennan", "Adeyemi", "Fischer", "Lindqvist", "Patel", "Romero", "Sato", "Varga", "Walsh", "Young"];
const COMPANY_A = ["Northwind", "Contoso", "Fabrikam", "Tailspin", "Litware", "Adatum", "Proseware", "Woodgrove", "Wingtip", "Lucerne", "Margie", "Alpine", "Bluefin", "Cedar", "Driftwood", "Evergreen", "Foxglove", "Granite", "Harbor", "Ironwood"];
const COMPANY_B = ["Consulting", "Advisory", "Partners", "Group", "Solutions"];
const COLORS = ["#4f46e5", "#0ea5e9", "#16a34a", "#d97706", "#db2777", "#7c3aed"];

/** A made-up sentence about the group's topics, so keyword search finds realistic matches. */
const sentence = (topics) => {
  const n = int(8, 16);
  const out = [];
  for (let i = 0; i < n; i++) out.push(rand() < 0.35 ? pick(topics) : pick(WORDS));
  out[0] = out[0][0].toUpperCase() + out[0].slice(1);
  return `${out.join(" ")}.`;
};
const paragraph = (topics, sentences) => Array.from({ length: sentences }, () => sentence(topics)).join(" ");

/* ---------- bulk writer ---------- */
const pool = new pg.Pool({ connectionString: DB, max: 4 });
const counts = {};
/**
 * Inserts `rows` (arrays in `cols` order) into `table` in batches (Postgres allows 65,535 parameters per statement).
 * Generated columns (passages.tsv) and BIGSERIAL ids are left to Postgres.
 */
async function insert(table, cols, rows) {
  if (!rows.length) return;
  const per = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const params = [];
    const values = part.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(",")})`);
    await pool.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")}`, params);
  }
  counts[table] = (counts[table] ?? 0) + rows.length;
}
/** Collects rows for a table and flushes them every `size` rows, so memory stays small. */
function sink(table, cols, size = 20000) {
  let rows = [];
  return {
    /** Adds a row; true when the batch is full (the caller then flushes every table, parents first). */
    push(r) {
      rows.push(r);
      return rows.length >= size;
    },
    async flush() {
      const r = rows;
      rows = [];
      await insert(table, cols, r);
    },
  };
}

/* ---------- build ---------- */
const started = Date.now();
const dbName = new URL(DB.replace(/^postgres(ql)?:\/\/\//, "postgres://localhost/")).pathname.slice(1);
console.log(`Load world → ${DB} (scale ${SCALE}, seed ${SEED})`);
spawnSync("dropdb", ["--if-exists", dbName], { stdio: "inherit" });
const created = spawnSync("createdb", [dbName], { stdio: "inherit" });
if (created.status !== 0) throw new Error(`Couldn't create the database ${dbName}. Is Postgres running (brew services start postgresql@17)?`);
await pool.query(fs.readFileSync(path.join(APP, "db", "schema.postgres.sql"), "utf8"));
// Bulk loading only: the world can be rebuilt any time, so a crash mid-load losing the last writes doesn't matter.
await pool.query("SET synchronous_commit = off");

// Organization sizes: one big firm, a few large, a long tail (sum ≈ 10,000 groups at scale 1).
const ORGS = 100;
const weights = Array.from({ length: ORGS }, (_, i) => 1 / (i + 1) ** 0.9);
const totalGroups = Math.round(10000 * SCALE);
const wsum = weights.reduce((a, b) => a + b, 0);
const groupsPer = weights.map((w) => Math.max(1, Math.round((w / wsum) * totalGroups)));
const RANDOM_HASH = `scrypt$${crypto.randomBytes(16).toString("hex")}$${crypto.randomBytes(64).toString("hex")}`;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const S = {
  orgs: sink("orgs", ["id", "name", "created_at", "status"]),
  users: sink("users", ["id", "org_id", "name", "email", "role", "password_hash", "must_change_password", "created_at", "last_active"]),
  sessions: sink("sessions", ["token_hash", "user_id", "expires_at", "created_at", "last_seen", "user_agent", "via"]),
  workspaces: sink("workspaces", ["id", "org_id", "name", "code", "color", "client", "created_at"]),
  members: sink("workspace_members", ["workspace_id", "user_id"]),
  documents: sink("documents", ["id", "org_id", "workspace_id", "name", "mime", "size", "audience", "status", "chunk_count", "uploaded_by", "created_at", "content_hash"]),
  passages: sink("passages", ["text", "title", "loc", "source_type", "source_id", "workspace_id", "org_id", "audience"], 5000),
  meetings: sink("meetings", ["id", "org_id", "workspace_id", "title", "held_at", "external_guests", "status", "transcript", "summary", "imported_by", "created_at", "duration_min"], 5000),
  items: sink("items", ["id", "org_id", "workspace_id", "meeting_id", "kind", "text", "who", "created_at"]),
  actions: sink("action_items", ["id", "org_id", "workspace_id", "meeting_id", "text", "owner", "due", "due_on", "status", "created_at"]),
  questions: sink("questions", ["id", "org_id", "workspace_id", "user_id", "question", "answer", "found", "created_at", "asked_by", "channel"]),
  chats: sink("teams_conversations", ["id", "service_url", "tenant_id", "kind", "name", "org_id", "workspace_id", "guests", "linked_by", "linked_at", "created_at", "last_seen_at"]),
  chatSettings: sink("teams_chat_settings", ["conversation_id", "org_id", "workspace_id", "json", "updated_by", "updated_at"]),
  chatMessages: sink("chat_messages", ["id", "org_id", "workspace_id", "conversation_id", "author", "text", "audience", "sent_at"]),
  findings: sink("findings", ["id", "org_id", "workspace_id", "kind", "dedupe_key", "audience", "severity", "status", "title", "detail", "next_step", "first_seen_at", "last_seen_at", "updated_at"]),
  connectors: sink("connectors", ["id", "org_id", "kind", "status", "account", "account_name", "api_base", "web_base", "connected_at", "updated_at"]),
  links: sink("connector_links", ["id", "org_id", "connector_id", "workspace_id", "project", "project_name", "audience", "item_count", "last_sync_at", "last_ok_at", "created_at"]),
  workItems: sink("connector_items", ["id", "org_id", "workspace_id", "link_id", "external_id", "item_type", "title", "state", "assignee", "url", "changed_at", "synced_at"]),
  traces: sink("traces", ["id", "org_id", "workspace_id", "channel", "name", "actor", "status", "http_status", "duration_ms", "span_count", "db_queries", "db_ms", "started_at"]),
  spans: sink("trace_spans", ["trace_id", "span_id", "parent_id", "kind", "name", "start_ms", "duration_ms", "status", "attrs"], 30000),
  usage: sink("usage_events", ["org_id", "workspace_id", "user_id", "feature", "model", "input_tokens", "output_tokens", "cost_usd", "latency_ms", "ok", "created_at"]),
  audit: sink("audit_log", ["org_id", "actor", "action", "kind", "workspace_id", "created_at"]),
  guard: sink("guard_events", ["org_id", "workspace_id", "channel", "stage", "rule", "action", "created_at"]),
  jobs: sink("jobs", ["id", "kind", "org_id", "workspace_id", "payload", "idempotency_key", "status", "run_at", "attempts", "max_attempts", "result", "created_at", "started_at", "finished_at", "updated_at"]),
  convs: sink("conversations", ["id", "kind", "org_id", "user_id", "workspace_id", "scope_key", "created_at", "last_at"]),
  turns: sink("conversation_turns", ["id", "conversation_id", "org_id", "role", "text", "question", "created_at"]),
};
const flushAll = async () => {
  for (const s of Object.values(S)) await s.flush();
};
// When one table's batch is full, every table is written in the order above (parents before children), so foreign
// keys always find their row.
const p = async (s, row) => {
  if (s.push(row)) await flushAll();
};

let userNo = 0;
for (let o = 0; o < ORGS; o++) {
  const orgId = id();
  const orgName = `${COMPANY_A[o % COMPANY_A.length]} ${COMPANY_B[Math.floor(o / COMPANY_A.length) % COMPANY_B.length]} ${o + 1}`;
  const domain = `org${o + 1}.load.test`;
  await p(S.orgs, [orgId, orgName, ago(400, 200), "Active"]);
  const nGroups = groupsPer[o];
  const nPeople = Math.max(8, Math.round(nGroups * 5));
  const people = [];
  for (let u = 0; u < nPeople; u++) {
    const role = u === 0 ? "Org Owner" : u < 4 ? "Org Admin" : u % 9 === 0 ? "Team Lead" : u % 7 === 0 ? "Viewer" : "Member";
    const uid = id();
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    people.push({ id: uid, role, name });
    userNo++;
    await p(S.users, [uid, orgId, name, `person${userNo}@${domain}`, role, RANDOM_HASH, 0, ago(300, 100), ago(14)]);
  }
  // Sessions for the load test: owner, admins, a few Team Leads, members and viewers.
  const signedIn = [...people.slice(0, 3), ...people.filter((x) => x.role === "Team Lead").slice(0, 4), ...people.filter((x) => x.role === "Member").slice(0, 10), ...people.filter((x) => x.role === "Viewer").slice(0, 3)];
  for (const u of signedIn) await p(S.sessions, [sha256(`lt-${u.id}`), u.id, new Date(NOW + 30 * DAY).toISOString(), ago(5), ago(1), "load-test", "password"]);

  const groups = [];
  for (let g = 0; g < nGroups; g++) {
    const wsId = id();
    const topics = [pick(TOPICS), pick(TOPICS), pick(TOPICS)];
    groups.push({ id: wsId, topics });
    await p(S.workspaces, [wsId, orgId, `${pick(COMPANY_A)} ${topics[0]} ${g + 1}`, `LT-${o + 1}-${g + 1}`, pick(COLORS), `${pick(COMPANY_A)} Ltd`, ago(200, 60)]);
  }
  // Memberships: everyone except owner/admins/billing is in 1-4 groups; signed-in ones always include group 0..3.
  const nonAdmins = people.filter((x) => !["Org Owner", "Org Admin"].includes(x.role));
  for (const [i, u] of nonAdmins.entries()) {
    const set = new Set();
    set.add(groups[i % groups.length].id);
    for (let k = int(0, 3); k > 0; k--) set.add(pick(groups).id);
    for (const w of set) await p(S.members, [w, u.id]);
  }

  // Connectors for a third of the organizations.
  let connectorId = null;
  if (o % 3 === 0) {
    connectorId = id();
    await p(S.connectors, [connectorId, orgId, o % 2 ? "jira" : "ado", "connected", `acct-${o}`, `${orgName} board`, "http://127.0.0.1:9/api", "http://127.0.0.1:9", ago(90, 30), ago(1)]);
  }

  for (const [gi, g] of groups.entries()) {
    const author = pick(people);
    const shareable = () => (rand() < 0.3 ? "shareable" : "internal");
    // Documents with passages.
    for (let d = 0, nd = int(2, 6); d < nd; d++) {
      const docId = id();
      const audience = shareable();
      const chunks = int(2, 4);
      const title = `${g.topics[d % 3]} ${pick(WORDS)} plan v${d + 1}.docx`;
      await p(S.documents, [docId, orgId, g.id, title, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", int(20, 900) * 1024, audience, "Ready", chunks, author.id, ago(120), sha256(docId)]);
      for (let c = 0; c < chunks; c++) await p(S.passages, [paragraph(g.topics, int(6, 10)), title, `Page ${c + 1}`, "document", docId, g.id, orgId, audience]);
    }
    // Meetings: transcript passages, notes passages, decisions/facts and action items.
    for (let m = 0, nm = int(2, 6); m < nm; m++) {
      const mId = id();
      const held = ago(90);
      const title = `${g.topics[m % 3]} weekly ${m + 1}`;
      const transcript = Array.from({ length: 6 }, (_, k) => `[00:0${k}:00] ${pick(FIRST)}: ${sentence(g.topics)}`).join("\n");
      await p(S.meetings, [mId, orgId, g.id, title, held, rand() < 0.2 ? 1 : 0, "Ready", transcript, paragraph(g.topics, 3), author.id, held, int(25, 60)]);
      await p(S.passages, [transcript, title, "00:00:00", "meeting", mId, g.id, orgId, "internal"]);
      await p(S.passages, [paragraph(g.topics, 4), `${title} (notes)`, "Notes", "notes", `${mId}:notes`, g.id, orgId, "internal"]);
      for (let k = 0, nk = int(2, 5); k < nk; k++) await p(S.items, [id(), orgId, g.id, mId, pick(["decision", "fact", "risk", "requirement", "question"]), sentence(g.topics), pick(FIRST), held]);
      for (let k = 0, nk = int(1, 3); k < nk; k++) {
        const due = new Date(NOW + int(-20, 30) * DAY).toISOString().slice(0, 10);
        await p(S.actions, [id(), orgId, g.id, mId, sentence(g.topics), pick(FIRST), due, due, pick(["Open", "Open", "In progress", "Done"]), held]);
      }
    }
    // Questions people asked.
    for (let q = 0, nq = int(4, 12); q < nq; q++) {
      const found = rand() < 0.8 ? 1 : 0;
      await p(S.questions, [id(), orgId, g.id, author.id, `What is the ${pick(g.topics)} ${pick(WORDS)}?`, found ? sentence(g.topics) : null, found, ago(60), author.name, rand() < 0.4 ? "teams" : "portal"]);
    }
    // One linked, tracked Teams group chat with messages.
    const chatId = `lt-chat-${g.id}`;
    await p(S.chats, [chatId, "http://127.0.0.1:9", "tenant-1", "groupChat", `${g.topics[0]} chat`, orgId, g.id, 0, people[0].name, ago(60, 30), ago(60, 30), ago(2)]);
    await p(S.chatSettings, [chatId, orgId, g.id, JSON.stringify({ track: true }), people[0].id, ago(30)]);
    for (let c = 0, nc = int(8, 22); c < nc; c++) {
      const msgId = id();
      const text = sentence(g.topics);
      await p(S.chatMessages, [msgId, orgId, g.id, chatId, pick(FIRST), text, "internal", ago(100)]);
      await p(S.passages, [text, `${g.topics[0]} chat`, "", "chat", msgId, g.id, orgId, "internal"]);
    }
    // Findings (about one in three groups).
    if (rand() < 0.35) {
      const kind = pick(["unanswered", "overdue_actions", "stale_doc", "no_lead"]);
      await p(S.findings, [id(), orgId, g.id, kind, `${kind}:${g.id}`, "managers", "warn", rand() < 0.8 ? "open" : "resolved", "Something needs a look", "Made-up finding for the load world.", "Open the group", ago(20, 5), ago(1), ago(1)]);
    }
    // Connector work items.
    if (connectorId && gi % 2 === 0) {
      const linkId = id();
      const n = int(2, 6);
      await p(S.links, [linkId, orgId, connectorId, g.id, `P${gi}`, `${g.topics[0]} board`, "internal", n, ago(1), ago(1), ago(60, 20)]);
      for (let k = 0; k < n; k++) {
        const itemId = id();
        const title = `${g.topics[k % 3]} ${pick(WORDS)} task ${k + 1}`;
        await p(S.workItems, [itemId, orgId, g.id, linkId, String(1000 + k), "Task", title, pick(["New", "Active", "Done"]), pick(FIRST), `http://127.0.0.1:9/item/${k}`, ago(20), ago(1)]);
        await p(S.passages, [`${title}. ${sentence(g.topics)}`, title, "", "workitem", itemId, g.id, orgId, "internal"]);
      }
    }
    // History: traces (with spans), AI usage, audit, guardrail events, finished jobs, conversations.
    for (let t = 0, nt = int(20, 40); t < nt; t++) {
      const traceId = id();
      const spans = int(3, 6);
      const dur = int(40, 4000);
      await p(S.traces, [traceId, orgId, g.id, pick(["portal", "teams", "system"]), pick(["POST /api/ask", "GET /api/docs", "Teams message", "Job: Run the watchers"]), author.name, rand() < 0.03 ? "error" : "ok", 200, dur, spans, int(3, 40), int(1, 80), ago(42)]);
      for (let s = 0; s < spans; s++) await p(S.spans, [traceId, `${traceId.slice(0, 8)}-${s}`, s ? `${traceId.slice(0, 8)}-0` : null, pick(["request", "search", "ai", "guard"]), "step", s * 10, int(1, dur), "ok", "{}"]);
    }
    for (let u = 0, nu = int(10, 30); u < nu; u++) await p(S.usage, [orgId, g.id, author.id, pick(["ask", "guard", "extract", "followup"]), "fake-claude", int(500, 8000), int(50, 900), rand() * 0.05, int(400, 9000), 1, ago(75)]);
    for (let a = 0, na = int(5, 15); a < na; a++) await p(S.audit, [orgId, author.name, pick(["Uploaded a document", "Imported a meeting", "Asked a question", "Changed a setting"]), pick(["Data", "Access", "Agent action"]), g.id, ago(120)]);
    for (let e = 0, ne = int(0, 4); e < ne; e++) await p(S.guard, [orgId, g.id, "portal", "question", "injection", "refused", ago(60)]);
    for (let j = 0, nj = int(2, 6); j < nj; j++) {
      const at = ago(14);
      await p(S.jobs, [id(), "watch.org", orgId, null, "{}", `lt-job-${id()}`, "done", at, 1, 3, '{"opened":0}', at, at, at, at]);
    }
    if (rand() < 0.4) {
      const convId = id();
      const at = ago(4);
      await p(S.convs, [convId, "ask", orgId, author.id, g.id, null, at, at]);
      await p(S.turns, [id(), convId, orgId, "user", `What is the ${g.topics[0]} date?`, `What is the ${g.topics[0]} date?`, at]);
      await p(S.turns, [id(), convId, orgId, "assistant", sentence(g.topics), null, at]);
    }
  }
  if ((o + 1) % 10 === 0) console.log(`  ${o + 1}/${ORGS} organizations (${Math.round((Date.now() - started) / 1000)} s)`);
}
await flushAll();
await pool.query("ANALYZE");
console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s:`);
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(22)} ${n.toLocaleString("en-US")}`);
await pool.end();
