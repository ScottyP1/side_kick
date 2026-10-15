/**
 * @file Sidekick's database: one SQLite file holding every organization's data.
 *
 * Concepts
 * - **Organization (org)**: one client company using Sidekick. Every row that holds client data has an
 *   `org_id`, and every query filters on it, so one org can never see another's data.
 * - **Workspace**: one client engagement inside an org (e.g. "Contoso – Cloud Migration"). Documents,
 *   meetings, questions and action items all belong to exactly one workspace. Users only see the
 *   workspaces they're members of (see `requireWorkspace` in auth.ts).
 * - **Passages**: documents and transcripts are split into short passages and stored in a full-text
 *   index (`passages`) so Sidekick can find the few that answer a question.
 *
 * Step 1 uses SQLite (built into Node) so the demo runs on a laptop with no setup. Production moves to
 * Azure Database for PostgreSQL + Azure AI Search (see docs/BLUEPRINT.md 4.4, 4.6). Keep queries in plain
 * SQL with `?` parameters (never string-built values) so that move stays simple and injection-safe.
 */
import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, workspace_id TEXT, feature TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS platform_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
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
-- Full-text index over document and transcript passages. workspace_id and audience are
-- stored alongside every passage and filtered on every search (workspace walls, guest rules).
CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
  text, title, loc UNINDEXED, source_type UNINDEXED, source_id UNINDEXED,
  workspace_id UNINDEXED, org_id UNINDEXED, audience UNINDEXED,
  tokenize = 'porter unicode61'
);
`;

declare global {
  var __sidekickDb: DatabaseSync | undefined;
}

/**
 * Returns the shared database connection, creating the file and tables on first use.
 * The connection is kept on `globalThis` so Next.js hot reloads in development reuse it instead of
 * opening a new one on every code change.
 */
export function db(): DatabaseSync {
  if (!globalThis.__sidekickDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const conn = new DatabaseSync(DB_PATH);
    conn.exec(SCHEMA);
    migrate(conn);
    globalThis.__sidekickDb = conn;
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
}

/** New random id for a row (UUID v4). */
export const newId = () => crypto.randomUUID();
/** Current time as an ISO 8601 string, the format every `*_at` column uses. */
export const now = () => new Date().toISOString();

/** A database row with unknown columns. Pass a type to `all`/`get` to describe the columns instead. */
export type Row = Record<string, unknown>;

/** Runs a SELECT and returns every matching row. Values go in `params`, matched to `?` in order. */
export function all<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}
/** Runs a SELECT and returns the first row, or `undefined` if nothing matched. */
export function get<T = Row>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}
/** Runs an INSERT, UPDATE or DELETE. Returns the change count and last inserted rowid. */
export function run(sql: string, ...params: (string | number | null)[]) {
  return db().prepare(sql).run(...params);
}
/**
 * Runs `fn` as one transaction: either every write inside it is saved, or (if it throws) none are.
 * Use it when several rows must change together, like saving all notes from one meeting.
 */
export function tx<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}
