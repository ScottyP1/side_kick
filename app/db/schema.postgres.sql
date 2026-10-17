-- Sidekick schema for PostgreSQL (production: Azure Database for PostgreSQL).
-- Mirrors the SQLite schema in src/lib/db.ts table for table, so the same SQL runs on both.
-- Differences on purpose:
--   * AUTOINCREMENT ids are BIGSERIAL; REAL is DOUBLE PRECISION.
--   * items, action_items and passages get an explicit "rowid" column (SQLite has one built in), so
--     queries that keep insertion order with ORDER BY rowid work unchanged.
--   * passages is a normal table with a generated full-text column (tsv) instead of an FTS5 table.
-- Every statement is idempotent (IF NOT EXISTS), so this runs safely at every start.

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active'
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_active TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
-- Microsoft sign-in in progress: one row per "Sign in with Microsoft" click, kept 10 minutes. state is
-- the random value sent to Microsoft and back; verifier (PKCE) and nonce prove the reply belongs to it.
-- mode = signin | link (an Org Owner connecting their organization's Microsoft tenant).
CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, mode TEXT NOT NULL,
  user_id TEXT, next_path TEXT, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, code TEXT, color TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL, audience TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL, error TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, held_at TEXT NOT NULL, external_guests INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, error TEXT, transcript TEXT NOT NULL, summary TEXT,
  imported_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  rowid BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL, who TEXT, answered INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_items (
  rowid BIGSERIAL UNIQUE,
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
  text TEXT NOT NULL, owner TEXT, due TEXT, status TEXT NOT NULL DEFAULT 'Open', ticket TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT, question TEXT NOT NULL, answer TEXT, found INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insights (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  json TEXT NOT NULL, refreshed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gap_status (
  workspace_id TEXT NOT NULL, gap_key TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT,
  PRIMARY KEY (workspace_id, gap_key)
);
CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY, org_id TEXT, workspace_id TEXT, user_id TEXT, feature TEXT NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL, latency_ms INTEGER NOT NULL, ok INTEGER NOT NULL, created_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS usage_events_org_time ON usage_events(org_id, created_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY, org_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
  kind TEXT NOT NULL, workspace_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  org_id TEXT PRIMARY KEY, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_admins (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_active TEXT
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_flags (
  key TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_log (
  id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams_conversations (
  id TEXT PRIMARY KEY, service_url TEXT NOT NULL, tenant_id TEXT, kind TEXT NOT NULL, name TEXT,
  link_code TEXT UNIQUE, code_expires_at TEXT,
  org_id TEXT REFERENCES orgs(id), workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  guests INTEGER NOT NULL DEFAULT 0, linked_by TEXT, linked_at TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS teams_conversations_ws ON teams_conversations(workspace_id);
-- Passages for the local keyword search. tsv is computed by Postgres from the title (weight A, counts
-- more) and the text (weight B), with English stemming, and indexed with GIN for fast matching.
CREATE TABLE IF NOT EXISTS passages (
  rowid BIGSERIAL PRIMARY KEY,
  text TEXT NOT NULL, title TEXT NOT NULL, loc TEXT, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, org_id TEXT NOT NULL, audience TEXT NOT NULL,
  tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', text), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS passages_tsv ON passages USING GIN (tsv);
CREATE INDEX IF NOT EXISTS passages_scope ON passages(org_id, workspace_id);
CREATE INDEX IF NOT EXISTS passages_source ON passages(source_id);
-- Unexpected server errors with the reference code the person saw (see handle() in src/lib/api.ts).
CREATE TABLE IF NOT EXISTS app_errors (
  id BIGSERIAL PRIMARY KEY, ref TEXT NOT NULL, status INTEGER NOT NULL, method TEXT, route TEXT,
  message TEXT NOT NULL, stack TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_errors_ref ON app_errors(ref);
-- Traces and their steps (see src/lib/trace.ts). Timings, counts, models and costs only; kept 30 days.
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
-- Columns added after the first release (safe to run on an existing database).
ALTER TABLE questions ADD COLUMN IF NOT EXISTS asked_by TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS channel TEXT;
-- Microsoft (Entra ID) sign-in (see lib/entra.ts).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS entra_tenant_id TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sso_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_oid TEXT;
-- Who each AI call was for (null for system work and Teams guests), so people can see their own usage.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS usage_events_user_time ON usage_events(org_id, user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS orgs_entra_tenant ON orgs(entra_tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_entra_oid ON users(org_id, entra_oid);
-- Guardrails (see src/lib/guardrails.ts): the org's switches, and counts of rules that fired (no text).
CREATE TABLE IF NOT EXISTS guard_rules (
  org_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_events (
  id BIGSERIAL PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT, channel TEXT NOT NULL,
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
