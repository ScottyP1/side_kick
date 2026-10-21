/**
 * @file Sidekick's database layer: one small API (`all`, `get`, `run`, `tx`) over two engines.
 *
 * Concepts
 * - **Organization (org)**: one client company using Sidekick. Every row that holds client data has an
 *   `org_id`, and every query filters on it, so one org can never see another's data.
 * - **Workspace**: one client engagement inside an org (e.g. "Contoso – Cloud Migration"). Documents,
 *   meetings, questions and action items all belong to exactly one workspace. Users only see the
 *   workspaces they're members of (see `requireWorkspace` in auth.ts).
 * - **Passages**: documents and transcripts are split into short passages and stored in a keyword index
 *   (`passages`) so Sidekick can find the few that answer a question (see search.ts).
 * - **Two engines, same SQL**:
 *   - **SQLite** (one file, built into Node) when `DATABASE_URL` is not set: the laptop/demo setup.
 *   - **PostgreSQL** when `DATABASE_URL` is set: production (Azure Database for PostgreSQL). Its schema
 *     is in `db/schema.postgres.sql` and mirrors the SQLite one, so the app's queries run unchanged.
 *   Queries use `?` placeholders (converted to `$1, $2…` for Postgres) and never string-built values,
 *   which keeps them injection-safe on both.
 * - **Async**: every call returns a Promise (`await all(...)`), because Postgres is a network service.
 */
import "server-only";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { countDbQuery } from "./trace";

/** Which engine this server uses: Postgres when DATABASE_URL is set, otherwise the local SQLite file. */
export const DIALECT: "postgres" | "sqlite" = process.env.DATABASE_URL ? "postgres" : "sqlite";

// SIDEKICK_DATA_DIR lets a test copy run against its own database (tests and Agents Playground use this
// so the real data in app/data is never touched).
const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "sidekick.db");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Client organizations. status = Active | Suspended (the owner can pause an org in the Owner Console).
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Portal users. role is one of ROLES in auth.ts; passwords are stored only as scrypt hashes.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_active TEXT
);
-- Signed-in browser sessions. Only a SHA-256 hash of the cookie token is stored, never the token itself.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
-- Failed portal sign-ins (wrong password or unknown email), for the sign-in rate limit in
-- lib/login-limit.ts. Kept one day.
CREATE TABLE IF NOT EXISTS login_failures (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures(email, created_at);
CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures(ip, created_at);
-- Setup wizard progress per organization (lib/setup.ts): which steps are done or skipped, and when it finished.
CREATE TABLE IF NOT EXISTS org_setup (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), json TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL
);
-- Self-service sign-up attempts (lib/signup.ts), for the per-IP sign-up limit. Kept one day.
CREATE TABLE IF NOT EXISTS signup_attempts (
  id TEXT PRIMARY KEY, ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_attempts_ip ON signup_attempts(ip, created_at);
-- One subscription per organization (lib/billing.ts): plan (lib/plans.ts), status = trialing | active |
-- past_due | canceled, and which billing provider holds it (mock today; stripe later, provider_ref = its id).
-- Organizations without a row are managed by the Sidekick team (no self-service plan) and keep full use.
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), plan TEXT NOT NULL, status TEXT NOT NULL,
  provider TEXT NOT NULL, provider_ref TEXT, trial_ends_at TEXT, current_period_end TEXT,
  past_due_since TEXT, canceled_at TEXT, access_until TEXT,
  updated_by TEXT, updated_at TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Microsoft sign-in in progress: one row per "Sign in with Microsoft" click, kept 10 minutes. state is
-- the random value sent to Microsoft and back; verifier (PKCE) and nonce prove the reply belongs to it.
-- mode = signin | link (an Org Owner connecting their organization's Microsoft tenant).
CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, mode TEXT NOT NULL,
  user_id TEXT, next_path TEXT, expires_at TEXT NOT NULL
);
-- One workspace per client engagement. code is an optional engagement code; color tags it in the UI.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, code TEXT, color TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Who can see which workspace. Org Owners/Admins see every workspace without needing a row here.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, user_id)
);
-- Uploaded files. audience: internal (team only) or shareable (OK to use when client guests are present).
-- status: Indexing | Ready | Failed. The text itself lives in passages.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL, audience TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL, error TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT, created_at TEXT NOT NULL
);
-- Imported meeting transcripts. external_guests = 1 means client guests attended (notes may go to guest channels).
-- status: Processing | Ready | Failed; summary is written by Claude.
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, held_at TEXT NOT NULL, external_guests INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, error TEXT, transcript TEXT NOT NULL, summary TEXT,
  imported_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  -- decisions, requirements, facts, glossary, risks and open questions extracted from meetings
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL, who TEXT, answered INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Tasks agreed in meetings. status: Open | In progress | Done. Editable in the portal and from Teams cards.
CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
  text TEXT NOT NULL, owner TEXT, due TEXT, status TEXT NOT NULL DEFAULT 'Open', ticket TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  -- every question asked of Sidekick; unanswered ones become knowledge gaps
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT, question TEXT NOT NULL, answer TEXT, found INTEGER NOT NULL, created_at TEXT NOT NULL
);
-- Cached knowledge map (topics + gaps) per workspace, rebuilt on "Refresh knowledge map".
CREATE TABLE IF NOT EXISTS insights (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  json TEXT NOT NULL, refreshed_at TEXT NOT NULL
);
-- What the team did about each knowledge gap (Open or Resolved, and who it is assigned to).
CREATE TABLE IF NOT EXISTS gap_status (
  workspace_id TEXT NOT NULL, gap_key TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT,
  PRIMARY KEY (workspace_id, gap_key)
);
-- One row per Claude call: tokens, cost in USD, latency and errors. Powers Usage & billing and the Owner Console.
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, workspace_id TEXT, user_id TEXT, feature TEXT NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL, latency_ms INTEGER NOT NULL, ok INTEGER NOT NULL, created_at TEXT NOT NULL
);
-- Who did what, when. kind groups entries (Access, Data, Agent action, Policy change). Shown on Security & audit.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
  kind TEXT NOT NULL, workspace_id TEXT, created_at TEXT NOT NULL
);
-- Per-org settings as one JSON document (today: branding logo + accent color).
CREATE TABLE IF NOT EXISTS settings (
  org_id TEXT PRIMARY KEY, json TEXT NOT NULL
);
-- Owner Console: platform operators (Sidekick's owner), separate from client users.
CREATE TABLE IF NOT EXISTS platform_admins (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_active TEXT
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
-- Global feature switches the owner can flip (kill switches). Missing key = enabled.
CREATE TABLE IF NOT EXISTS platform_flags (
  key TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
-- Per-organization feature switches set in the Owner Console (a restriction for one client). Missing row = on.
CREATE TABLE IF NOT EXISTS org_flags (
  org_id TEXT NOT NULL, flag_key TEXT NOT NULL, enabled INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, flag_key)
);
CREATE TABLE IF NOT EXISTS platform_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Traces: one row per request/Teams message (see trace.ts), and its steps (spans). Timings, counts,
-- models and costs only, never document text. Shown on the client's Activity page; kept 30 days.
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT, channel TEXT NOT NULL, name TEXT NOT NULL,
  actor TEXT, status TEXT NOT NULL, http_status INTEGER, error TEXT, ref TEXT, duration_ms INTEGER NOT NULL,
  span_count INTEGER NOT NULL, db_queries INTEGER NOT NULL DEFAULT 0, db_ms INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_org_time ON traces(org_id, started_at);
CREATE TABLE IF NOT EXISTS trace_spans (
  trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
  start_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, attrs TEXT NOT NULL,
  PRIMARY KEY (trace_id, span_id)
);
-- Unexpected server errors, each with the reference code the person saw (see handle() in api.ts).
-- Listed in the Owner Console; no client document content is stored here, only the error message.
CREATE TABLE IF NOT EXISTS app_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, status INTEGER NOT NULL, method TEXT, route TEXT,
  message TEXT NOT NULL, stack TEXT, created_at TEXT NOT NULL
);
-- Teams conversations (channels, group chats, 1:1 chats) Sidekick has been added to.
-- id is the conversation id without any ";messageid=" thread suffix. A row with no workspace_id is
-- not linked yet: Sidekick shows link_code in Teams and an Org Admin enters it on the Workspaces page.
CREATE TABLE IF NOT EXISTS teams_conversations (
  id TEXT PRIMARY KEY, service_url TEXT NOT NULL, tenant_id TEXT, kind TEXT NOT NULL, name TEXT,
  link_code TEXT UNIQUE, code_expires_at TEXT,
  org_id TEXT REFERENCES orgs(id), workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  guests INTEGER NOT NULL DEFAULT 0, linked_by TEXT, linked_at TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS teams_conversations_ws ON teams_conversations(workspace_id);
-- Guardrails (see guardrails.ts). guard_rules: the org's switches as JSON (missing = defaults).
-- guard_events: one row each time a rule fired (question refused, answer masked/replaced): which rule,
-- where and when, never the question or answer text. Shown as counts to Org Owners/Admins.
CREATE TABLE IF NOT EXISTS guard_rules (
  org_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, workspace_id TEXT, channel TEXT NOT NULL,
  stage TEXT NOT NULL, rule TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guard_events_org_time ON guard_events(org_id, created_at);
-- Per-workspace guardrails (phase 2). guard_workspace_rules: switches a workspace turns on on top of the
-- organization's (only ever stricter). guard_custom_rules: short plain-language rules written by Org
-- Owners/Admins, org-wide (workspace_id NULL) or for one workspace; a removed rule is kept with active = 0.
-- guard_rule_versions: every version of every custom rule (created, edited, removed), for history.
CREATE TABLE IF NOT EXISTS guard_workspace_rules (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, org_id TEXT NOT NULL,
  json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_custom_rules (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  text TEXT NOT NULL, version INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guard_custom_rules_org ON guard_custom_rules(org_id, workspace_id);
CREATE TABLE IF NOT EXISTS guard_rule_versions (
  rule_id TEXT NOT NULL, org_id TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL,
  change TEXT NOT NULL, changed_by TEXT, changed_at TEXT NOT NULL, PRIMARY KEY (rule_id, version)
);
-- Per Teams chat/channel settings (see lib/reminders.ts): whether Sidekick reads every message there,
-- gets meeting notes, and sends reminders (time, time zone, quiet days, kinds). JSON; missing = defaults.
-- workspace_id is the workspace the chat was linked to when saved: a relinked chat starts from defaults.
CREATE TABLE IF NOT EXISTS teams_chat_settings (
  conversation_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
-- Messages Sidekick read in tracked chats (only chats an Org Owner/Admin switched "Track messages" on).
-- audience: shareable when the chat has client guests, internal otherwise. Kept 90 days.
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL, author TEXT, text TEXT NOT NULL, audience TEXT NOT NULL, sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_ws ON chat_messages(workspace_id, sent_at);
CREATE INDEX IF NOT EXISTS chat_messages_conv ON chat_messages(conversation_id);
-- Reminder digests: one row per chat and slot (a local day for the daily one, "meeting:<id>" after a
-- meeting, "manual:<id>" for Send now). The unique slot stops double posts. json = the points shown.
CREATE TABLE IF NOT EXISTS reminder_runs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  slot TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
  json TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_runs_slot ON reminder_runs(conversation_id, slot);
CREATE INDEX IF NOT EXISTS reminder_runs_ws ON reminder_runs(workspace_id, created_at);
-- Items people snoozed or marked "Not relevant" from a reminder card (item_key: action:<id>, item:<id>, gap:<hash>).
CREATE TABLE IF NOT EXISTS reminder_state (
  workspace_id TEXT NOT NULL, item_key TEXT NOT NULL, status TEXT NOT NULL, until_at TEXT,
  updated_by TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, item_key)
);
-- Full-text index over document and transcript passages. workspace_id and audience are
-- stored alongside every passage and filtered on every search (workspace walls, guest rules).
CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
  text, title, loc UNINDEXED, source_type UNINDEXED, source_id UNINDEXED,
  workspace_id UNINDEXED, org_id UNINDEXED, audience UNINDEXED,
  tokenize = 'porter unicode61'
);
`;

/** A value that can be bound to a `?` placeholder. */
export type Param = string | number | null;

/** What each engine must provide. `tx` runs `fn` with every query inside it in one transaction. */
type Driver = {
  query(sql: string, params: Param[]): Promise<Record<string, unknown>[]>;
  exec(sql: string, params: Param[]): Promise<{ changes: number }>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
};

declare global {
  var __sidekickDb: DatabaseSync | undefined;
  var __sidekickDbSchema: string | undefined;
  var __sidekickDriver: Promise<Driver> | undefined;
}

/* ---------------- SQLite (local file) ---------------- */

/** The SQLite connection, creating the file and tables on first use. Kept on globalThis for hot reloads. */
function sqlite(): DatabaseSync {
  if (!globalThis.__sidekickDb) {
    // In production the SQLite file would live inside the container and vanish on every restart or
    // deploy, silently losing client data. Refuse loudly instead (set DATABASE_URL to Postgres), unless
    // someone explicitly opts in (e.g. a single-machine demo with a persistent disk).
    if (process.env.NODE_ENV === "production" && process.env.SIDEKICK_ALLOW_SQLITE !== "1") {
      throw new Error("No database configured: set DATABASE_URL to a PostgreSQL database (or SIDEKICK_ALLOW_SQLITE=1 for a single-machine demo).");
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    globalThis.__sidekickDb = new DatabaseSync(DB_PATH);
  }
  // Apply the schema and migrations on first use, and again whenever they change while the server keeps
  // running (a code reload in development keeps the old connection, which would miss new tables/columns).
  const version = SCHEMA + migrate.toString();
  if (globalThis.__sidekickDbSchema !== version) {
    globalThis.__sidekickDb.exec(SCHEMA);
    migrate(globalThis.__sidekickDb);
    globalThis.__sidekickDbSchema = version;
  }
  return globalThis.__sidekickDb;
}

/**
 * Adds columns introduced after a database was first created. `CREATE TABLE IF NOT EXISTS` only helps
 * for new tables, so new columns on existing tables are added here, each guarded by a "has" check so
 * running it twice is harmless.
 */
function migrate(conn: DatabaseSync) {
  const has = (table: string, col: string) =>
    (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  if (!has("orgs", "status")) conn.exec("ALTER TABLE orgs ADD COLUMN status TEXT NOT NULL DEFAULT 'Active'");
  if (!has("usage_events", "error")) conn.exec("ALTER TABLE usage_events ADD COLUMN error TEXT");
  // Who the AI call was for (null for system work and Teams guests), so people can see their own usage.
  if (!has("usage_events", "user_id")) conn.exec("ALTER TABLE usage_events ADD COLUMN user_id TEXT");
  conn.exec("CREATE INDEX IF NOT EXISTS usage_events_user_time ON usage_events(org_id, user_id, created_at)");
  // Who asked and where (portal or Teams), for the Activity page's Messages view.
  if (!has("questions", "asked_by")) conn.exec("ALTER TABLE questions ADD COLUMN asked_by TEXT");
  if (!has("questions", "channel")) conn.exec("ALTER TABLE questions ADD COLUMN channel TEXT");
  // Microsoft (Entra ID) sign-in: the org's Microsoft tenant, whether passwords are turned off, and each
  // person's Microsoft account id (oid), which also identifies them in Teams.
  if (!has("orgs", "entra_tenant_id")) conn.exec("ALTER TABLE orgs ADD COLUMN entra_tenant_id TEXT");
  if (!has("orgs", "sso_required")) conn.exec("ALTER TABLE orgs ADD COLUMN sso_required INTEGER NOT NULL DEFAULT 0");
  if (!has("users", "entra_oid")) conn.exec("ALTER TABLE users ADD COLUMN entra_oid TEXT");
  conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS orgs_entra_tenant ON orgs(entra_tenant_id)");
  conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_entra_oid ON users(org_id, entra_oid)");
  // Reminders: due dates as real dates (YYYY-MM-DD), worked out from what was said and the meeting date.
  if (!has("action_items", "due_on")) conn.exec("ALTER TABLE action_items ADD COLUMN due_on TEXT");
  if (!has("items", "due_on")) conn.exec("ALTER TABLE items ADD COLUMN due_on TEXT");
  // Groups: the client a workspace (group) is for, e.g. "Northwind Bank".
  if (!has("workspaces", "client")) conn.exec("ALTER TABLE workspaces ADD COLUMN client TEXT");
}

/**
 * SQLite has one connection for the whole server, so a transaction would otherwise see writes from other
 * requests that run while it awaits. This lock makes a transaction exclusive: other queries wait for it.
 */
let sqliteLock: Promise<void> = Promise.resolve();
const inSqliteTx = new AsyncLocalStorage<true>();
const waitForLock = () => (inSqliteTx.getStore() ? Promise.resolve() : sqliteLock);

const sqliteDriver: Driver = {
  async query(sql, params) {
    await waitForLock();
    return sqlite().prepare(sql).all(...params) as Record<string, unknown>[];
  },
  async exec(sql, params) {
    await waitForLock();
    return { changes: Number(sqlite().prepare(sql).run(...params).changes) };
  },
  async tx(fn) {
    if (inSqliteTx.getStore()) return fn(); // nested: join the outer transaction
    const previous = sqliteLock;
    let release!: () => void;
    sqliteLock = new Promise((r) => (release = r));
    await previous;
    const conn = sqlite();
    try {
      conn.exec("BEGIN");
      const out = await inSqliteTx.run(true, fn);
      conn.exec("COMMIT");
      return out;
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    } finally {
      release();
    }
  },
};

/* ---------------- PostgreSQL (DATABASE_URL) ---------------- */

// Postgres returns 64-bit integers (COUNT, SUM of integers) and NUMERIC (AVG) as strings to avoid losing
// precision; Sidekick's numbers are small, so read them as plain JS numbers like SQLite does.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/** Converts `?` placeholders to Postgres's `$1, $2…`, skipping any `?` inside quoted strings. */
export function toPgPlaceholders(sql: string): string {
  let n = 0;
  let quoted = false;
  let out = "";
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === "?" && !quoted ? `$${++n}` : ch;
  }
  return out;
}

const pgTx = new AsyncLocalStorage<pg.PoolClient>();

/** True for a Postgres URL that points at this computer (no network, so no TLS needed). */
export function isLocalDatabase(url: string): boolean {
  if (/^postgres(ql)?:\/\/\//.test(url)) return true; // postgres:///dbname = local socket
  try {
    return ["localhost", "127.0.0.1", "[::1]", ""].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Connects to Postgres and makes sure every table exists (the schema file is idempotent). */
async function postgresDriver(): Promise<Driver> {
  const url = process.env.DATABASE_URL ?? "";
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    allowExitOnIdle: true, // scripts and tests can exit without closing the pool
    // Azure Database for PostgreSQL requires encrypted (TLS) connections, checked against its certificate.
    // A database on this same machine (localhost, or a local socket) is the only exception.
    ssl: isLocalDatabase(url) ? undefined : { rejectUnauthorized: true },
  });
  const schemaPath = path.join(process.cwd(), "db", "schema.postgres.sql");
  let applied = fs.readFileSync(schemaPath, "utf8");
  await pool.query(applied);
  // In development the server outlives schema edits; re-apply the (idempotent) schema when the file changes.
  const ensureSchema = async () => {
    if (process.env.NODE_ENV === "production") return;
    const current = fs.readFileSync(schemaPath, "utf8");
    if (current !== applied) {
      await pool.query(current);
      applied = current;
    }
  };
  const runner = () => pgTx.getStore() ?? pool;
  return {
    async query(sql, params) {
      await ensureSchema();
      return (await runner().query(toPgPlaceholders(sql), params)).rows;
    },
    async exec(sql, params) {
      await ensureSchema();
      return { changes: (await runner().query(toPgPlaceholders(sql), params)).rowCount ?? 0 };
    },
    async tx(fn) {
      if (pgTx.getStore()) return fn(); // nested: join the outer transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await pgTx.run(client, fn);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** The active engine, created once per server process. A failed Postgres connect is retried next call. */
function driver(): Promise<Driver> {
  // SQLite: only the connection is shared across reloads (see sqlite()); always use this module's driver
  // code, so code reloads in development take effect immediately.
  if (DIALECT === "sqlite") return Promise.resolve(sqliteDriver);
  if (!globalThis.__sidekickDriver) {
    const d = postgresDriver();
    d.catch(() => {
      if (globalThis.__sidekickDriver === d) globalThis.__sidekickDriver = undefined;
    });
    globalThis.__sidekickDriver = d;
  }
  return globalThis.__sidekickDriver;
}

/** New random id for a row (UUID v4). */
export const newId = () => crypto.randomUUID();
/** Current time as an ISO 8601 string, the format every `*_at` column uses. */
export const now = () => new Date().toISOString();

/** A database row with unknown columns. Pass a type to `all`/`get` to describe the columns instead. */
export type Row = Record<string, unknown>;

/** Runs a SELECT and returns every matching row. Values go in `params`, matched to `?` in order. */
export async function all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
  const t0 = performance.now();
  try {
    return (await (await driver()).query(sql, params)) as T[];
  } finally {
    countDbQuery(performance.now() - t0);
  }
}
/** Runs a SELECT and returns the first row, or `undefined` if nothing matched. */
export async function get<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined> {
  return (await all<T>(sql, ...params))[0];
}
/** Runs an INSERT, UPDATE or DELETE. Returns how many rows changed. */
export async function run(sql: string, ...params: Param[]): Promise<{ changes: number }> {
  const t0 = performance.now();
  try {
    return await (await driver()).exec(sql, params);
  } finally {
    countDbQuery(performance.now() - t0);
  }
}
/**
 * Runs `fn` as one transaction: either every write inside it is saved, or (if it throws) none are.
 * Use it when several rows must change together, like saving all notes from one meeting. Every
 * `all`/`get`/`run` awaited inside `fn` automatically joins the transaction.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  return (await driver()).tx(fn);
}
