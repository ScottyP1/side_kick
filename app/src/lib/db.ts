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
 * - **Org scope and row-level security** (the second lock): every query runs for one org (`withOrg`, or the
 *   request's org set by `setScopeOrg` from `currentUser`) or as named system work (`asSystem`). On Postgres the
 *   scope goes onto the connection (`app.org_id`, `app.bypass`, role `sidekick_app`) and the policies in
 *   `db/schema.postgres.sql` hide every other org's rows, even from a query without `WHERE org_id = ?`.
 *   Design: docs/security/2026-10-row-level-security.md.
 */
import "server-only";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { countDbQuery } from "./trace";
import { BRAND } from "./brand";

/** Which engine this server uses: Postgres when DATABASE_URL is set, otherwise the local SQLite file. */
export const DIALECT: "postgres" | "sqlite" = process.env.DATABASE_URL ? "postgres" : "sqlite";

// SIDEKICK_DATA_DIR lets a test copy run against its own database (tests and Agents Playground use this
// so the real data in app/data is never touched).
const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "sidekick.db");

/** The per-group `connectors` table (also used by `migrate` to rebuild the old per-organization one). */
const CONNECTORS_TABLE = `CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
  account TEXT NOT NULL, account_name TEXT, api_base TEXT NOT NULL, web_base TEXT NOT NULL,
  access_token TEXT, refresh_token TEXT, token_expires_at TEXT,
  connected_by TEXT, connected_at TEXT NOT NULL, last_error TEXT, last_error_at TEXT, updated_at TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'shared', access_mode_by TEXT, access_mode_at TEXT
);`;

/**
 * Moves connectors from one per organization (before Oct 24, 2026) into groups, on both engines (the same SQL runs
 * from `migrate` and db/schema.postgres.sql; each statement is harmless to run again):
 * every tool an organization had connected becomes an **allowed** tool type (connector_kinds); the connector goes to
 * the group of its first linked project, keeping its sign-in; every other group with linked projects gets its own
 * connection marked expired (so its Team Lead signs in for that group; its items stay until then), and its links
 * move to it; a connector with no linked project is removed (the type stays allowed); organization-wide health rows go.
 */
export const CONNECTOR_GROUP_MIGRATION = [
  `INSERT INTO connector_kinds (org_id, kind, allowed_by, allowed_at)
     SELECT org_id, kind, by_name, at_time FROM (SELECT org_id, kind, MAX(connected_by) AS by_name, MIN(connected_at) AS at_time FROM connectors WHERE workspace_id IS NULL GROUP BY org_id, kind) m
     WHERE true ON CONFLICT (org_id, kind) DO NOTHING`,
  `UPDATE connectors SET workspace_id = (SELECT l.workspace_id FROM connector_links l WHERE l.connector_id = connectors.id ORDER BY l.created_at, l.id LIMIT 1) WHERE workspace_id IS NULL`,
  `INSERT INTO connectors (id, org_id, workspace_id, kind, status, account, account_name, api_base, web_base, connected_by, connected_at, last_error, last_error_at, updated_at)
     SELECT DISTINCT c.id || '-' || l.workspace_id, c.org_id, l.workspace_id, c.kind, 'expired', c.account, c.account_name, c.api_base, c.web_base, c.connected_by, c.connected_at,
            'Connections are per group now: sign in again for this group on Connectors.', c.updated_at, c.updated_at
       FROM connector_links l JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
      WHERE l.workspace_id <> c.workspace_id ON CONFLICT (id) DO NOTHING`,
  `UPDATE connector_links SET connector_id = connector_id || '-' || workspace_id WHERE workspace_id <> (SELECT c.workspace_id FROM connectors c WHERE c.id = connector_links.connector_id)`,
  `DELETE FROM connectors WHERE workspace_id IS NULL`,
  `DELETE FROM connector_health WHERE workspace_id = '' AND connector IN ('azure-devops', 'jira', 'github', 'confluence', 'microsoft-365-files')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connectors_group_kind ON connectors(org_id, workspace_id, kind)`,
];

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
-- extra_groups: extra groups bought on top of the plan (lib/plans.ts EXTRA_GROUP).
-- Organizations without a row are managed by the Sidekick team (no self-service plan) and keep full use.
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), plan TEXT NOT NULL, status TEXT NOT NULL,
  provider TEXT NOT NULL, provider_ref TEXT, trial_ends_at TEXT, current_period_end TEXT,
  past_due_since TEXT, canceled_at TEXT, access_until TEXT,
  updated_by TEXT, updated_at TEXT NOT NULL, created_at TEXT NOT NULL, extra_groups INTEGER NOT NULL DEFAULT 0
);
-- Roll-offs (lib/rolloff.ts): a group (scope 'group') or a whole organization (scope 'org') scheduled for
-- deletion when an engagement ends or a company leaves. status = scheduled | running | canceled | done.
-- read_only_from: when the organization turns read-only (org scope); delete_on: when everything is deleted.
-- chats_json: the Teams chats unlinked when a group started ending (relinked if it's cancelled).
-- certificate_json: the deletion certificate (kinds and counts only, never content). No foreign key to
-- orgs on purpose: this row (and org_name) is the minimum record kept after an organization is deleted.
CREATE TABLE IF NOT EXISTS rolloffs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, org_name TEXT NOT NULL, workspace_id TEXT, workspace_name TEXT,
  scope TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, read_only_from TEXT, delete_on TEXT NOT NULL,
  requested_by TEXT NOT NULL, created_at TEXT NOT NULL, chats_json TEXT, closed_by TEXT, closed_at TEXT,
  certificate_json TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS rolloffs_org ON rolloffs(org_id, status);
CREATE INDEX IF NOT EXISTS rolloffs_due ON rolloffs(status, delete_on);
-- Plan terms the Sidekick team sets per organization in the Owner Console (lib/limits.ts, lib/credit.ts):
-- custom limits (JSON, Enterprise or managed clients), an AI credit override, the contract price per month
-- (Enterprise / managed), the partner or referrer who brought the client, and a per-person questions-per-hour
-- limit. Missing row = the plan's own numbers.
CREATE TABLE IF NOT EXISTS org_terms (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), limits_json TEXT, ai_credit_usd REAL, monthly_price_usd REAL,
  partner TEXT, ask_per_hour INTEGER, updated_by TEXT, updated_at TEXT NOT NULL
);
-- One-off AI credit top-ups granted by the Sidekick team, for one calendar month (YYYY-MM, UTC).
CREATE TABLE IF NOT EXISTS credit_topups (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), month TEXT NOT NULL, amount_usd REAL NOT NULL,
  note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_topups_org ON credit_topups(org_id, month);
-- AI credit notices already given (level warn = 80%, essentials = 100%), so each is audited once a month.
CREATE TABLE IF NOT EXISTS credit_notices (
  org_id TEXT NOT NULL, month TEXT NOT NULL, level TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, month, level)
);
-- Rate-limit hits (lib/rate-limit.ts), e.g. bucket "ask:<user id>". Kept two hours.
CREATE TABLE IF NOT EXISTS rate_events (
  id TEXT PRIMARY KEY, bucket TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_bucket ON rate_events(bucket, created_at);
-- Claude work queued for the Batch API (lib/claude.ts queueStructured / runBatches), e.g. daily reminder
-- digests. request_json (instructions + content) is cleared once the result is handled; rows go after a day.
CREATE TABLE IF NOT EXISTS ai_batch_items (
  id TEXT PRIMARY KEY, batch_id TEXT, org_id TEXT NOT NULL, workspace_id TEXT, feature TEXT NOT NULL, model TEXT NOT NULL,
  handler TEXT NOT NULL, ref TEXT NOT NULL, request_json TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_batch_items_status ON ai_batch_items(status, batch_id);
-- Versions of the app seen running (lib/ops.ts): commit and release time set by the deploy, first seen.
CREATE TABLE IF NOT EXISTS app_releases (
  release_key TEXT PRIMARY KEY, commit_sha TEXT, released_at TEXT, first_seen_at TEXT NOT NULL
);
-- Azure AI Search capacity (lib/search-capacity.ts): one row ('azure'), the latest service usage read hourly (json:
-- storage and index use with their limits, counts only), its level (ok / warn / full; a rise alerts the operator),
-- and the last check's error. Nothing per organization.
CREATE TABLE IF NOT EXISTS search_capacity (
  id TEXT PRIMARY KEY, json TEXT, level TEXT NOT NULL, checked_at TEXT NOT NULL, error TEXT
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
-- Two-step sign-in (lib/mfa.ts), for portal users (account_kind 'user') and Owner Console owners ('owner').
-- A factor is an authenticator app (kind 'totp': secret, last_step stops a code being used twice) or a
-- passkey (kind 'passkey': credential_id, public_key, counter). enabled = 0 while still being set up.
CREATE TABLE IF NOT EXISTS mfa_factors (
  id TEXT PRIMARY KEY, account_kind TEXT NOT NULL, account_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  secret TEXT, last_step INTEGER, credential_id TEXT, public_key TEXT, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_used TEXT
);
CREATE INDEX IF NOT EXISTS mfa_factors_account ON mfa_factors(account_kind, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS mfa_factors_credential ON mfa_factors(credential_id);
-- One-time backup codes (only their hashes), for when the phone or passkey is lost.
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id TEXT PRIMARY KEY, account_kind TEXT NOT NULL, account_id TEXT NOT NULL, code_hash TEXT NOT NULL,
  used_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mfa_backup_codes_account ON mfa_backup_codes(account_kind, account_id);
-- Short-lived challenges: a sign-in waiting for its second step ('signin', keyed by a hashed cookie token),
-- or a passkey being added ('register'). challenge = the WebAuthn challenge, attempts = wrong codes so far.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash TEXT PRIMARY KEY, account_kind TEXT NOT NULL, account_id TEXT NOT NULL, purpose TEXT NOT NULL,
  challenge TEXT, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL
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
-- Which linked Teams chats get a group's meeting notes (lib/notes-chats.ts). Only used when the group's
-- workspaces.notes_choice is 'chosen'; 'none' = notes stay in the portal; NULL = no choice yet (one default chat).
CREATE TABLE IF NOT EXISTS notes_chats (
  workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL, org_id TEXT NOT NULL, PRIMARY KEY (workspace_id, conversation_id)
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
-- Support (lib/support.ts). One row per ticket: from the portal (org_id + user_id), the public /support form
-- or the help bot's "talk to a human" (no org). ref is the short code people quote (SUP-7K3Q). status = open |
-- waiting (on the customer) | resolved; a reply from the customer reopens it. customer_unread / staff_unread
-- drive the dot on the assistant button and the inbox counts. checks = what the support assistant checked
-- (JSON, when the ticket came from a conversation).
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, org_id TEXT, user_id TEXT,
  name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, subject TEXT NOT NULL, category TEXT NOT NULL,
  priority TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, page TEXT, checks TEXT, assigned_to TEXT,
  customer_unread INTEGER NOT NULL DEFAULT 0, staff_unread INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS support_tickets_org ON support_tickets(org_id, updated_at);
CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets(status, updated_at);
-- The thread of a ticket: the customer's messages, the Sidekick team's replies, and internal notes
-- (internal = 1: only the Sidekick team ever sees them). author_kind = customer | staff | system.
CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE, org_id TEXT,
  author_kind TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_messages_ticket ON support_messages(ticket_id, created_at);
-- Files attached to a ticket message (screenshots, logs, PDFs): type and size checked when added, stored
-- base64 in the database (the same on both engines), always downloaded as an attachment, never shown inline.
CREATE TABLE IF NOT EXISTS support_attachments (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE, message_id TEXT,
  org_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_attachments_ticket ON support_attachments(ticket_id);
-- Support articles (lib/support-articles.ts), managed in the Owner Console. level = public (help center and
-- help bot) | customer (signed-in support assistant, when relevant) | internal (Sidekick team only).
-- status = draft | published; source_ticket_id = the resolved ticket a draft was written from.
CREATE TABLE IF NOT EXISTS support_articles (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL,
  status TEXT NOT NULL, tags TEXT, source_ticket_id TEXT, seed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
-- Each time an assistant cited an article (help bot or support assistant), and the ticket the conversation
-- became, if any, so the Owner Console can show which articles help and whether those tickets got resolved.
CREATE TABLE IF NOT EXISTS support_article_uses (
  id TEXT PRIMARY KEY, article_id TEXT NOT NULL, assistant TEXT NOT NULL, conversation_id TEXT, org_id TEXT,
  ticket_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_article_uses_article ON support_article_uses(article_id);
CREATE INDEX IF NOT EXISTS support_article_uses_conv ON support_article_uses(conversation_id);
-- Assistant conversations (lib/conversations.ts): the last few turns, so a follow-up builds on what was said.
-- kind = assist (portal in-app assistant) | support (support assistant) | helpbot (public website) | ask (Ask in
-- the portal, per group) | teams (Teams answers, per group and Teams thread/chat: scope_key). Owned by
-- one person in one org (org_id + user_id), or one browser on the website (visitor_id, a random cookie id);
-- never shared. Expire 24 hours after the last turn. Visitor text is masked (contact details) before saving.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, org_id TEXT, user_id TEXT, visitor_id TEXT,
  created_at TEXT NOT NULL, last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_last ON conversations(last_at);
CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, org_id TEXT,
  role TEXT NOT NULL, text TEXT NOT NULL, question TEXT, refused INTEGER NOT NULL DEFAULT 0, meta TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_turns_conv ON conversation_turns(conversation_id, created_at);
-- The public help bot (lib/helpbot.ts): questions it couldn't answer (masked, kept 30 days) for the Owner
-- Console to turn into FAQ or help articles (status open | done), and one row per reply by outcome
-- (answered, dont_know, refused, limited, budget) with the rule that fired: counts only, no text, 90 days.
CREATE TABLE IF NOT EXISTS helpbot_questions (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS helpbot_events (
  id TEXT PRIMARY KEY, outcome TEXT NOT NULL, rule TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS helpbot_events_time ON helpbot_events(created_at);
-- Firm library (lib/firm.ts): org-wide documents (policies, standards, templates, methods, rate-card rules)
-- that every group's answers can use. Managed by Org Owners/Admins. audience = internal | shareable (client
-- guests only ever see shareable ones). effective_on = the day it applies from (YYYY-MM-DD); superseded_by =
-- the firm document that replaces it (answers down-rank and flag the old one). content_hash = SHA-256 of the
-- extracted text, to spot the same file uploaded twice. Its passages are indexed once per org, under the
-- workspace id "firm" (lib/search.ts FIRM_SCOPE), never per group. Counts toward the plan's document limit.
CREATE TABLE IF NOT EXISTS firm_docs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), title TEXT NOT NULL, name TEXT NOT NULL, mime TEXT,
  size INTEGER NOT NULL, audience TEXT NOT NULL DEFAULT 'internal', status TEXT NOT NULL, error TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0, effective_on TEXT, superseded_by TEXT, content_hash TEXT,
  uploaded_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS firm_docs_org ON firm_docs(org_id, created_at);
-- Upload guard (lib/upload-guard.ts): the groups a firm document is limited to when its applies_to is 'some'
-- (firm_docs.applies_to 'all' = every group, the default). Only these groups' answers use it.
CREATE TABLE IF NOT EXISTS firm_doc_groups (
  firm_doc_id TEXT NOT NULL REFERENCES firm_docs(id) ON DELETE CASCADE, org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, PRIMARY KEY (firm_doc_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS firm_doc_groups_ws ON firm_doc_groups(org_id, workspace_id);
-- Thumbs up/down on an answer (lib/feedback.ts), one per person per answer (a second click changes it).
-- question_id = the questions row the answer was saved as; channel = portal | teams. No question or answer
-- text is stored here: admins and the Owner Console see counts and trends only.
CREATE TABLE IF NOT EXISTS answer_feedback (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, question_id TEXT NOT NULL, user_id TEXT NOT NULL,
  vote INTEGER NOT NULL, channel TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (question_id, user_id)
);
CREATE INDEX IF NOT EXISTS answer_feedback_org ON answer_feedback(org_id, created_at);
-- Connectors to outside tools (lib/connectors.ts): Azure DevOps Boards, Jira, GitHub Issues, Confluence and Microsoft 365 files, read-only.
-- connector_kinds: the tool types an organization allows (kind = ado | jira | github | confluence | m365), switched on
-- and off by the Org Owner; no sign-in at this level. The plan's connectors limit counts these rows.
CREATE TABLE IF NOT EXISTS connector_kinds (
  org_id TEXT NOT NULL REFERENCES orgs(id), kind TEXT NOT NULL, allowed_by TEXT, allowed_at TEXT NOT NULL,
  PRIMARY KEY (org_id, kind)
);
-- connectors: one per group and allowed tool (unique org + workspace + kind: connectors_group_kind, made in
-- migrate), connected by the group's Team Lead (or an admin) with the account the client gave them, through the
-- tool's own sign-in (OAuth; no passwords). access_token / refresh_token are sealed (lib/secret-box.ts, context
-- "connectors.<column>:<id>") and refreshed before they run out. status = connected | expired (the sign-in ran
-- out or was revoked: someone must reconnect). account = the ADO organization, the Atlassian site (cloud id), the GitHub user id or the Microsoft tenant id;
-- api_base / web_base = where its API and its web pages are. last_error = the last connector-wide problem.
-- (Before Oct 24, 2026 connectors were one per organization: migrate moves them into groups, CONNECTOR_GROUP_MIGRATION.)
${CONNECTORS_TABLE}
-- One project (ADO), project key (Jira), repository (GitHub, "owner/name"), space key (Confluence) or SharePoint library / folder (Microsoft 365, "<drive id>[/<folder id>]") feeding one group's knowledge, set by an Org Owner/Admin or the
-- group's Team Lead. audience = internal | shareable (like documents). sync_cursor = the latest "changed" time
-- seen (Microsoft 365: the Graph delta link), so each sync only fetches what changed since. Health: last_sync_at (last try), last_ok_at (last
-- success), last_error (plain reason, null when fine). sync_started_at = claimed by a running sync.
CREATE TABLE IF NOT EXISTS connector_links (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, project TEXT NOT NULL, project_name TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'internal',
  sync_cursor TEXT, item_count INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT, last_ok_at TEXT, last_error TEXT,
  sync_started_at TEXT, created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE (connector_id, workspace_id, project)
);
CREATE INDEX IF NOT EXISTS connector_links_ws ON connector_links(org_id, workspace_id);
-- The work items read from a linked project (title, state, assignee, due date, link...). Their text is in
-- passages (source_type "workitem", or "page" for Confluence pages and Microsoft 365 files; source_id = this id). text_hash skips re-indexing unchanged items.
CREATE TABLE IF NOT EXISTS connector_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  link_id TEXT NOT NULL REFERENCES connector_links(id) ON DELETE CASCADE, external_id TEXT NOT NULL,
  item_type TEXT, title TEXT NOT NULL, state TEXT, assignee TEXT, due_on TEXT, url TEXT NOT NULL, changed_at TEXT,
  blocked_by TEXT, comment_count INTEGER NOT NULL DEFAULT 0, text_hash TEXT, synced_at TEXT NOT NULL,
  UNIQUE (link_id, external_id)
);
CREATE INDEX IF NOT EXISTS connector_items_ws ON connector_items(org_id, workspace_id);
-- A connector sign-in in progress (OAuth state + PKCE verifier), used once, kept 10 minutes.
CREATE TABLE IF NOT EXISTS connector_states (
  state TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, verifier TEXT NOT NULL,
  site TEXT, expires_at TEXT NOT NULL, workspace_id TEXT, connector_id TEXT
);
-- Per-person sign-in to a group's connection in "each person signs in" mode (connectors.access_mode = 'personal';
-- lib/connector-access.ts, docs/ARCHITECTURE.md → Connectors): one row per connection and person. Tokens are
-- sealed (lib/secret-box.ts, context connector_user_tokens.<column>:<id>). status = connected | expired (a refused
-- refresh: the person reconnects). account_name = who they are in the tool (shown to them and the group's managers).
CREATE TABLE IF NOT EXISTS connector_user_tokens (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, account_name TEXT,
  access_token TEXT, refresh_token TEXT, token_expires_at TEXT, connected_at TEXT NOT NULL, last_used_at TEXT,
  last_error TEXT, last_error_at TEXT, updated_at TEXT NOT NULL,
  UNIQUE (connector_id, user_id)
);
CREATE INDEX IF NOT EXISTS connector_user_tokens_user ON connector_user_tokens(org_id, user_id);
CREATE INDEX IF NOT EXISTS connector_user_tokens_ws ON connector_user_tokens(org_id, workspace_id);
-- A request to turn a tool on for the organization (lib/connector-requests.ts): a Team Lead or Org Admin asks for
-- one of their groups, the Org Owner approves (turning the tool on) or declines with a note. status = pending |
-- approved | declined | cancelled; at most one pending request per tool and group (connector_requests_open).
-- requested_by = the person's id (requester_name kept for the page after they leave); decided_by = a name.
CREATE TABLE IF NOT EXISTS connector_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), kind TEXT NOT NULL, workspace_id TEXT NOT NULL,
  requested_by TEXT NOT NULL, requester_name TEXT NOT NULL, reason TEXT, status TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_requests_org ON connector_requests(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS connector_requests_open ON connector_requests(org_id, kind, workspace_id) WHERE status = 'pending';
-- Background jobs (lib/jobs.ts): the database-backed job queue (every background task runs on it). kind = what to run
-- (registered in lib/job-kinds.ts); payload = small JSON of ids (never document text); org_id/workspace_id = whose
-- work it is (NULL for system sweeps). status = queued | running | done | dead (gave up after max_attempts, the
-- dead-letter list) | canceled. A worker claims a job by setting locked_by + locked_until (a lease); a lease that
-- runs out means the worker stopped, and another one takes the job over. idempotency_key: enqueueing the same
-- key twice keeps one job (recurring jobs use "every:<kind>:<slot>"). result = small JSON of counts.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, org_id TEXT, workspace_id TEXT, payload TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT, status TEXT NOT NULL, run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5, locked_by TEXT, locked_until TEXT, last_error TEXT, result TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS jobs_org ON jobs(org_id, status);
-- Watcher findings (lib/watchers.ts): something that needs a person, found by a cheap check on the queue.
-- One row per problem (dedupe_key = kind + group + subject, unique per org), kept up to date on every run and
-- resolved automatically when the check no longer finds it. workspace_id NULL = organization-wide.
-- audience = members (everyone in the group) | managers (Team Leads of the group and admins) | admins | owners (Org Owners only).
-- status = open | snoozed (until snoozed_until) | resolved. data_json = counts and ids for the page.
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT, kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL, audience TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, next_step TEXT NOT NULL, action_href TEXT, action_label TEXT, data_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT, snoozed_until TEXT, snoozed_by TEXT,
  updated_at TEXT NOT NULL, UNIQUE (org_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS findings_scope ON findings(org_id, status, workspace_id);
-- The stale-document watcher's AI checks, so each (document, decision) pair is judged once. verdict =
-- contradicts | fine. reason = Claude's one-line reason (shown on the finding).
CREATE TABLE IF NOT EXISTS watch_checks (
  org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, pair_key TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT,
  checked_at TEXT NOT NULL, PRIMARY KEY (org_id, pair_key)
);
-- Connector health (lib/connector-health.ts): the latest state each connector (Azure DevOps, Jira, GitHub, Confluence, Microsoft 365) reported
-- for an organization (and group, when it's per group; '' = organization-wide). status = ok | broken.
-- The broken-connector watcher turns broken rows into findings.
CREATE TABLE IF NOT EXISTS connector_health (
  org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT NOT NULL DEFAULT '', connector TEXT NOT NULL,
  label TEXT NOT NULL, status TEXT NOT NULL, message TEXT, fix_href TEXT, checked_at TEXT NOT NULL, broken_since TEXT,
  PRIMARY KEY (org_id, workspace_id, connector)
);
-- Teams posts that failed (an answer, meeting notes, a reminder): which chat, what, Microsoft's error (no
-- message text). The failed-replies watcher reports chats whose latest post failed; kept 30 days.
CREATE TABLE IF NOT EXISTS teams_post_failures (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT, conversation_id TEXT NOT NULL, what TEXT NOT NULL,
  error TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS teams_post_failures_conv ON teams_post_failures(conversation_id, created_at);
-- Automatic meeting notes from Microsoft Graph (lib/meetings-graph.ts). One row per organization: the switch an
-- Org Owner/Admin turns on (enabled), who changed it, and how the last check went (no meeting content).
CREATE TABLE IF NOT EXISTS auto_meetings (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), enabled INTEGER NOT NULL DEFAULT 0, changed_by TEXT, changed_at TEXT,
  last_poll_at TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT
);
-- Microsoft Graph change-notification subscriptions for an organization's meeting transcripts. id = Graph's
-- subscription id; client_state = the random secret Graph sends back with every notification (checked).
CREATE TABLE IF NOT EXISTS graph_subscriptions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), tenant_id TEXT NOT NULL, resource TEXT NOT NULL,
  client_state TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, renewed_at TEXT
);
-- Teams meetings Sidekick heard about (a transcript became available), one row per transcript: Graph ids,
-- how it was found (via: notification | poll), status queued | captured | done | skipped | waiting | failed,
-- the plain reason for skipped/waiting, the group it went to and the meetings row it became. candidates = JSON
-- list of group ids when several groups match (status waiting, an admin picks one).
CREATE TABLE IF NOT EXISTS graph_meetings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), online_meeting_id TEXT NOT NULL, transcript_id TEXT NOT NULL,
  organizer_oid TEXT NOT NULL, via TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, title TEXT, started_at TEXT,
  ended_at TEXT, workspace_id TEXT, candidates TEXT, meeting_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (org_id, transcript_id)
);
CREATE INDEX IF NOT EXISTS graph_meetings_org ON graph_meetings(org_id, status, created_at);
-- The polling fallback's position per meeting organizer: transcripts created before polled_until were checked.
CREATE TABLE IF NOT EXISTS graph_poll_cursors (
  org_id TEXT NOT NULL REFERENCES orgs(id), organizer_oid TEXT NOT NULL, polled_until TEXT NOT NULL,
  PRIMARY KEY (org_id, organizer_oid)
);
-- "Turn on transcription" reminder (lib/call-nudge.ts): calls seen in a group's Teams chats, one row per chat and
-- call id, status watching | nudged | transcribing | ended | quiet | skipped | failed (one nudge per call).
CREATE TABLE IF NOT EXISTS call_nudges (
  conversation_id TEXT NOT NULL, call_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT,
  started_at TEXT, status TEXT NOT NULL, nudged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, call_id)
);
CREATE INDEX IF NOT EXISTS call_nudges_ws ON call_nudges(org_id, workspace_id, status);
-- When each watched chat was last read for call events, and why Graph refused it (null = it was read).
CREATE TABLE IF NOT EXISTS call_watch (
  conversation_id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT, checked_at TEXT NOT NULL, error TEXT
);
-- Meetings that record and transcribe by themselves (lib/auto-record.ts): one row per organization and Teams meeting
-- (join_key = hash of its join link; a recurring series is one row). status set | already | skipped | failed | checking
-- (one scan's claim while it looks at the meeting); a set
-- meeting is never changed again. title only for set, already and failed rows (the group's own meetings).
CREATE TABLE IF NOT EXISTS meeting_autorecord (
  org_id TEXT NOT NULL REFERENCES orgs(id), join_key TEXT NOT NULL, online_meeting_id TEXT, organizer_oid TEXT NOT NULL,
  workspace_id TEXT, status TEXT NOT NULL, reason TEXT, title TEXT, starts_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, join_key)
);
CREATE INDEX IF NOT EXISTS meeting_autorecord_org ON meeting_autorecord(org_id, status, starts_at);
-- "Is this meeting being transcribed?" for scheduled Teams meetings (lib/meeting-nudge.ts): one row per organization,
-- meeting (join_key = hash of its join link, as in meeting_autorecord) and start time (each occurrence of a series).
-- status planned | skipped | records | off | chat | nudged | transcribing | ended | quiet | nowhere | failed | late | gone;
-- title only for a group's meetings (planned and after); posted_to = 'meeting' (its own chat) or 'notes' (the group's notes chat).
CREATE TABLE IF NOT EXISTS meeting_nudges (
  org_id TEXT NOT NULL REFERENCES orgs(id), join_key TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT, organizer_oid TEXT NOT NULL,
  online_meeting_id TEXT, chat_id TEXT, workspace_id TEXT, title TEXT, status TEXT NOT NULL, reason TEXT, posted_to TEXT, nudged_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, join_key, starts_at)
);
CREATE INDEX IF NOT EXISTS meeting_nudges_due ON meeting_nudges(org_id, status, starts_at);
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

/* ---------------- Org scope (the second lock) ---------------- */

/**
 * Who the database is working for right now, carried through every `await` with AsyncLocalStorage:
 * - `org`: the organization whose rows this work may touch. On Postgres it becomes `app.org_id` on the connection,
 *   and row-level security (db/schema.postgres.sql, docs/ARCHITECTURE.md → "Row-level security") hides every
 *   other org's rows, even from a query that forgot its `WHERE org_id = ?`.
 * - `system`: set (to a short reason, e.g. "job queue") only by `asSystem`, for named work that spans orgs or
 *   runs before anyone is known (sign-in, Teams bot lookups, the job queue, Owner Console). It sets `app.bypass`.
 * A request (`openRequestScope`, from `handle()`) starts with neither; `currentUser` (so `requireUser`) fills in `org`.
 */
type DbScope = { org: string | null; system: string | null };

declare global {
  var __sidekickDbScope: AsyncLocalStorage<DbScope> | undefined;
  var __sidekickDbFallback: string | undefined;
  var __sidekickDbUnscoped: Set<string> | undefined;
}
// One store per process, shared by every copy of this module after a development reload.
const scopeStore = (globalThis.__sidekickDbScope ??= new AsyncLocalStorage<DbScope>());

/**
 * Runs `fn` as work for one organization: every query inside it (and anything it awaits) can only see and write
 * that org's rows on Postgres. For background work done for one org (a job, a Teams message once its org is known).
 */
export function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  if (!orgId) throw new Error("withOrg needs an organization id");
  return scopeStore.run({ org: orgId, system: null }, fn);
}

/**
 * Runs `fn` as system work that may read and write every organization's rows (sets `app.bypass` on Postgres).
 * Only for named code paths that must span orgs or run before the org is known: session and sign-in lookups,
 * sign-up, the job queue and its watchers, retention, the Owner Console, Teams bot lookups by tenant or
 * conversation, Microsoft Graph notifications, error and trace logging. `reason` names the path (it shows in
 * the strict-mode report). Never use it to make a failing user-facing query "work": give it the user's org instead.
 */
export function asSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  const org = scopeStore.getStore()?.org ?? null;
  return scopeStore.run({ org, system: reason || "system" }, fn);
}

/** Runs `fn` as an API request with no org yet; `setScopeOrg` (from `currentUser`) fills it in. Called by `handle()`. */
export function openRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return scopeStore.run({ org: null, system: null }, fn);
}

/**
 * Records that the current request works for `orgId`: called by `currentUser` (so `requireUser`) once the session
 * is checked, by the Teams tab once its Microsoft tenant's org is known, and by the connector sign-in callback once
 * its saved state names the org. The scope is shared by everything the request awaits from then on.
 * Refuses to switch a request from one org to another, which would be a bug.
 */
export function setScopeOrg(orgId: string): void {
  const s = scopeStore.getStore();
  if (!s || !orgId) return;
  if (s.org && s.org !== orgId && !s.system) throw new Error("This request already works for another organization");
  s.org = orgId;
}

/** The org the current work is scoped to, or null (system work, or before sign-in). For tests and diagnostics. */
export function scopeOrg(): string | null {
  return scopeStore.getStore()?.org ?? null;
}

/**
 * Makes this whole process system work when nothing more specific is set. Only for command-line scripts
 * (`npm run seed:demo`, data copies) and the direct database-layer tests, never the web server.
 */
export function useSystemScopeForProcess(reason: string): void {
  globalThis.__sidekickDbFallback = reason;
}

/**
 * Strict mode (SIDEKICK_DB_STRICT, set by the automated tests): a query with no org and no system reason fails
 * with an error naming the fix. `report` writes each such call site once to SIDEKICK_DB_SCOPE_LOG instead.
 * Off (the default, and in production), such a query logs a warning once per statement and runs as system work,
 * so a path the tests don't cover keeps working; signed-in request code always has its org by then.
 */
const STRICT = process.env.SIDEKICK_DB_STRICT || "";

/**
 * Marks the current request as system work from here on (for the Owner Console once the operator's session is
 * checked: its pages span every org by design). Like `setScopeOrg`, it changes the request's shared scope.
 */
export function markRequestSystem(reason: string): void {
  const s = scopeStore.getStore();
  if (s) s.system = reason || "system";
}

/**
 * The tables that hold an organization's data: every table with an `org_id` column (read from the schema above,
 * so a new table is covered automatically), plus `orgs` and `workspace_members`. Postgres guards exactly these
 * with row-level security, and only a query that names one of them needs an org or system scope.
 */
export const RLS_TABLES: ReadonlySet<string> = new Set([
  "orgs",
  "workspace_members",
  ...[...SCHEMA.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)\s*(?:USING \w+)?\s*\(([\s\S]*?)\n\);/g)]
    .filter((m) => /\borg_id\b/.test(m[2]))
    .map((m) => m[1]),
]);
const orgDataCache = new Map<string, boolean>();
/** True when `sql` names one of `RLS_TABLES` (a word match on the statement text, remembered per statement). */
export function touchesOrgData(sql: string): boolean {
  let hit = orgDataCache.get(sql);
  if (hit === undefined) {
    hit = (sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []).some((w) => RLS_TABLES.has(w));
    if (orgDataCache.size < 5000) orgDataCache.set(sql, hit);
  }
  return hit;
}

/** The context a query runs in: org id ('' for none) and whether row-level security is bypassed. */
type QueryCtx = { org: string; bypass: boolean };

function queryCtx(sql: string): QueryCtx {
  const s = scopeStore.getStore();
  if (s?.system) return { org: s.org ?? "", bypass: true };
  if (s?.org) return { org: s.org, bypass: false };
  // No org tables involved (sign-in limits, platform switches, the operator's own tables): nothing to guard.
  if (globalThis.__sidekickDbFallback || !touchesOrgData(sql)) return { org: "", bypass: true };
  const where = s ? "a request before its organization is known" : "no request or job";
  const message = `Database query outside any org scope (${where}). Wrap the work in withOrg(orgId, ...) or asSystem("why", ...) from lib/db.ts. SQL: ${sql.replace(/\s+/g, " ").trim().slice(0, 160)}`;
  if (STRICT === "report") {
    const site = (new Error().stack ?? "").split("\n").slice(2).filter((l) => !l.includes("/lib/db.ts") && !l.includes("node:")).slice(0, 4).join(" | ");
    const seen = (globalThis.__sidekickDbUnscoped ??= new Set());
    if (!seen.has(site)) {
      seen.add(site);
      fs.appendFileSync(process.env.SIDEKICK_DB_SCOPE_LOG || "db-scope.log", `${message}\n   at ${site}\n`);
    }
  } else if (STRICT) {
    throw new Error(message);
  } else {
    const seen = (globalThis.__sidekickDbUnscoped ??= new Set());
    const key = sql.slice(0, 200);
    if (!seen.has(key)) {
      seen.add(key);
      console.warn(`[db] ${message}`);
    }
  }
  return { org: "", bypass: true };
}

/** What each engine must provide. `tx` runs `fn` with every query inside it in one transaction. */
type Driver = {
  query(sql: string, params: Param[], ctx: QueryCtx): Promise<Record<string, unknown>[]>;
  exec(sql: string, params: Param[], ctx: QueryCtx): Promise<{ changes: number }>;
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
    // Wait up to 5 s for a lock held by another process on the same file (scripts such as reset-password, or a
    // test changing a row), instead of failing at once with "database is locked".
    globalThis.__sidekickDb = new DatabaseSync(DB_PATH, { timeout: 5000 });
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
  // Multi-tenant Teams (lib/tenants.ts): who added Sidekick to a chat (shown on "Waiting to be assigned"),
  // and when the org's Microsoft admin approved Sidekick's directory permission (lib/directory.ts).
  if (!has("teams_conversations", "added_by")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN added_by TEXT");
  if (!has("teams_conversations", "added_by_oid")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN added_by_oid TEXT");
  if (!has("orgs", "graph_consent_at")) conn.exec("ALTER TABLE orgs ADD COLUMN graph_consent_at TEXT");
  // Settings → Microsoft permissions (lib/graph-permissions.ts): the last "Check now" (granted application
  // permissions as JSON, or "[]" when Microsoft refused the app token), when and by whom.
  for (const col of ["graph_roles", "graph_roles_at", "graph_roles_by"]) if (!has("orgs", col)) conn.exec(`ALTER TABLE orgs ADD COLUMN ${col} TEXT`);
  conn.exec("CREATE INDEX IF NOT EXISTS teams_conversations_tenant ON teams_conversations(tenant_id)");
  // Unassigned chats (lib/teams/install.ts): since when a chat waits (Sidekick leaves after 7 days), the team's
  // Microsoft 365 group id (to remove Sidekick from a channel's team), and a pending departure.
  if (!has("teams_conversations", "waiting_since")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN waiting_since TEXT");
  if (!has("teams_conversations", "team_aad_id")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN team_aad_id TEXT");
  if (!has("teams_conversations", "leaving")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN leaving TEXT");
  if (!has("teams_conversations", "leave_tried_at")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN leave_tried_at TEXT");
  if (!has("teams_conversations", "leave_error")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN leave_error TEXT");
  // Groups: the client a workspace (group) is for, e.g. "Northwind Bank".
  if (!has("workspaces", "client")) conn.exec("ALTER TABLE workspaces ADD COLUMN client TEXT");
  // Plan limits: each meeting's length, for meeting hours per month.
  if (!has("meetings", "duration_min")) conn.exec("ALTER TABLE meetings ADD COLUMN duration_min INTEGER");
  // Owner Console: a temporary password from scripts/reset-password.mjs must be changed at next sign-in.
  // Where each session was started and when it was last used (Settings → Where you're signed in).
  for (const col of ["created_at", "last_seen", "user_agent", "ip"]) if (!has("sessions", col)) conn.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
  // Who pays for an AI call: null = the organization (counts toward its AI credit), "support" = the support
  // assistant and "helpbot" = the public help bot, both paid by Sidekick (lib/claude.ts `payer`).
  if (!has("usage_events", "payer")) conn.exec("ALTER TABLE usage_events ADD COLUMN payer TEXT");
  // Group pricing: extra groups bought on top of the plan.
  if (!has("subscriptions", "extra_groups")) conn.exec("ALTER TABLE subscriptions ADD COLUMN extra_groups INTEGER NOT NULL DEFAULT 0");
  if (!has("platform_admins", "must_change_password")) conn.exec("ALTER TABLE platform_admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  // Required two-step sign-in (lib/auth.ts): the Org Owner's switch, and how each session was started
  // (password | microsoft; Microsoft sign-in is exempt). Older sessions have none and count as password.
  if (!has("orgs", "mfa_required")) conn.exec("ALTER TABLE orgs ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0");
  if (!has("sessions", "via")) conn.exec("ALTER TABLE sessions ADD COLUMN via TEXT");
  // Answer quality: a hash of each document's text (spots the same file uploaded twice).
  if (!has("documents", "content_hash")) conn.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT");
  // Follow-ups in Ask and Teams: a conversation is tied to one group, and in Teams to one thread or chat (scope_key).
  if (!has("conversations", "workspace_id")) conn.exec("ALTER TABLE conversations ADD COLUMN workspace_id TEXT");
  if (!has("conversations", "scope_key")) conn.exec("ALTER TABLE conversations ADD COLUMN scope_key TEXT");
  conn.exec("CREATE INDEX IF NOT EXISTS conversations_scope ON conversations(org_id, user_id, kind, workspace_id, scope_key)");
  // Watchers: when someone removed Sidekick from a chat in Teams (and who), and the last post that reached it.
  for (const col of ["removed_at", "removed_by", "last_post_ok_at"]) if (!has("teams_conversations", col)) conn.exec(`ALTER TABLE teams_conversations ADD COLUMN ${col} TEXT`);
  // Meetings wave: where a meeting came from (source "teams" = captured from Microsoft Graph, else imported), its
  // graph_meetings row, when its notes went to Teams (posted once), and who saved an item to knowledge.
  for (const col of ["source", "graph_meeting_id", "notes_posted_at"]) if (!has("meetings", col)) conn.exec(`ALTER TABLE meetings ADD COLUMN ${col} TEXT`);
  for (const col of ["saved_by", "saved_at"]) if (!has("items", col)) conn.exec(`ALTER TABLE items ADD COLUMN ${col} TEXT`);
  // "Meeting notes go to" (lib/notes-chats.ts): the group's choice, who made it and when; where a meeting's notes went.
  for (const col of ["notes_choice", "notes_choice_by", "notes_choice_at"]) if (!has("workspaces", col)) conn.exec(`ALTER TABLE workspaces ADD COLUMN ${col} TEXT`);
  for (const col of ["notes_posted_to", "notes_sent_at"]) if (!has("meetings", col)) conn.exec(`ALTER TABLE meetings ADD COLUMN ${col} TEXT`);
  // Notes picker polish: how many people a linked chat has (from the Teams roster, checked at most daily) and when.
  if (!has("teams_conversations", "member_count")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN member_count INTEGER");
  if (!has("teams_conversations", "members_checked_at")) conn.exec("ALTER TABLE teams_conversations ADD COLUMN members_checked_at TEXT");
  // Meet now (ad hoc calls): which kind of Teams call a captured transcript came from ('meeting' scheduled, 'adhoc').
  if (!has("graph_meetings", "kind")) conn.exec("ALTER TABLE graph_meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting'");
  // Which group a meeting belongs to (lib/meeting-group.ts): why a meeting waits ('tie' | 'unclear'), who picked
  // its group, the note for the notes when the title decided ("Picked Litware from the meeting title."), and the
  // meeting's people who aren't in the picked group yet (JSON [{oid, name, email}], only after someone picked).
  for (const col of ["waiting_kind", "picked_by", "pick_note", "newcomers"]) if (!has("graph_meetings", col)) conn.exec(`ALTER TABLE graph_meetings ADD COLUMN ${col} TEXT`);
  // Upload guard (lib/upload-guard.ts): a document or firm document that looks like it belongs to another client is
  // saved Held (status 'Held', text kept in held_text, not indexed) until the uploader keeps or moves it.
  // guard_status: null = never flagged, 'kept' = flagged and kept (a Needs attention finding), 'reviewed' = a
  // manager confirmed it; guard_json = what matched. firm_docs.applies_to: 'all' groups or 'some' (firm_doc_groups).
  for (const t of ["documents", "firm_docs"]) for (const col of ["guard_status", "guard_json", "held_text"]) if (!has(t, col)) conn.exec(`ALTER TABLE ${t} ADD COLUMN ${col} TEXT`);
  if (!has("firm_docs", "applies_to")) conn.exec("ALTER TABLE firm_docs ADD COLUMN applies_to TEXT NOT NULL DEFAULT 'all'");
  // "Turn on transcription" reminder (lib/call-nudge.ts): the group's switch (NULL or 1 = on, 0 = off), who and when.
  if (!has("workspaces", "call_nudge")) conn.exec("ALTER TABLE workspaces ADD COLUMN call_nudge INTEGER");
  for (const col of ["call_nudge_by", "call_nudge_at"]) if (!has("workspaces", col)) conn.exec(`ALTER TABLE workspaces ADD COLUMN ${col} TEXT`);
  // Meetings that record by themselves (lib/auto-record.ts): the organization's switch (0/1), who and when, and the last scan.
  if (!has("auto_meetings", "auto_record")) conn.exec("ALTER TABLE auto_meetings ADD COLUMN auto_record INTEGER NOT NULL DEFAULT 0");
  for (const col of ["auto_record_by", "auto_record_at", "record_checked_at", "record_error"]) if (!has("auto_meetings", col)) conn.exec(`ALTER TABLE auto_meetings ADD COLUMN ${col} TEXT`);
  // Scheduled-meeting transcription reminders (lib/meeting-nudge.ts): when the calendars were last read, and why not.
  for (const col of ["remind_checked_at", "remind_error"]) if (!has("auto_meetings", col)) conn.exec(`ALTER TABLE auto_meetings ADD COLUMN ${col} TEXT`);
  // Meeting matching couldn't read the directory (people added by email can't be recognised): the plain message
  // and since when, shown on the Meetings panel; cleared once a lookup works (lib/meeting-group.ts noteDirectory).
  for (const col of ["directory_error", "directory_error_at"]) if (!has("auto_meetings", col)) conn.exec(`ALTER TABLE auto_meetings ADD COLUMN ${col} TEXT`);
  // Scale readiness (docs/SCALE.md): indexes for per-group lists and counts, per-person lookups and the retention
  // clean-up (lib/retention.ts), found with the load test on 10,000 groups. Same list as db/schema.postgres.sql.
  for (const sql of [
    "CREATE INDEX IF NOT EXISTS workspaces_org ON workspaces(org_id, name)",
    "CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members(user_id)",
    "CREATE INDEX IF NOT EXISTS users_org ON users(org_id, role)",
    "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS documents_ws ON documents(workspace_id, created_at)",
    "CREATE INDEX IF NOT EXISTS documents_org ON documents(org_id, created_at)",
    "CREATE INDEX IF NOT EXISTS meetings_ws ON meetings(workspace_id, held_at)",
    "CREATE INDEX IF NOT EXISTS meetings_org ON meetings(org_id, created_at)",
    "CREATE INDEX IF NOT EXISTS items_meeting ON items(meeting_id, kind)",
    "CREATE INDEX IF NOT EXISTS items_org_kind ON items(org_id, kind, created_at)",
    "CREATE INDEX IF NOT EXISTS items_ws ON items(workspace_id, kind)",
    "CREATE INDEX IF NOT EXISTS action_items_meeting ON action_items(meeting_id)",
    "CREATE INDEX IF NOT EXISTS action_items_ws ON action_items(workspace_id, status)",
    "CREATE INDEX IF NOT EXISTS action_items_org ON action_items(org_id, status, due_on)",
    "CREATE INDEX IF NOT EXISTS questions_ws ON questions(workspace_id, created_at)",
    "CREATE INDEX IF NOT EXISTS questions_org ON questions(org_id, created_at)",
    "CREATE INDEX IF NOT EXISTS audit_log_org_time ON audit_log(org_id, created_at)",
    "CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(created_at)",
    "CREATE INDEX IF NOT EXISTS traces_time ON traces(started_at)",
    "CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events(created_at)",
    "CREATE INDEX IF NOT EXISTS chat_messages_time ON chat_messages(sent_at)",
    "CREATE INDEX IF NOT EXISTS app_errors_time ON app_errors(created_at)",
    "CREATE INDEX IF NOT EXISTS guard_events_time ON guard_events(created_at)",
    "CREATE INDEX IF NOT EXISTS teams_conversations_org ON teams_conversations(org_id, workspace_id)",
    "CREATE INDEX IF NOT EXISTS graph_subscriptions_org ON graph_subscriptions(org_id, expires_at)",
  ]) conn.exec(sql);
  // Connectors per group (Oct 24, 2026): the old table had UNIQUE (org_id, kind), which SQLite can only drop by
  // rebuilding the table (foreign keys off meanwhile, so the linked projects aren't deleted with it).
  const connSql = (conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connectors'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (/UNIQUE \(org_id, kind\)/.test(connSql)) {
    conn.exec("PRAGMA foreign_keys = OFF");
    try {
      conn.exec("BEGIN");
      conn.exec(CONNECTORS_TABLE.replace("CREATE TABLE IF NOT EXISTS connectors", "CREATE TABLE connectors_v2"));
      conn.exec(`INSERT INTO connectors_v2 (id, org_id, workspace_id, kind, status, account, account_name, api_base, web_base, access_token, refresh_token, token_expires_at, connected_by, connected_at, last_error, last_error_at, updated_at)
                 SELECT id, org_id, NULL, kind, status, account, account_name, api_base, web_base, access_token, refresh_token, token_expires_at, connected_by, connected_at, last_error, last_error_at, updated_at FROM connectors`);
      conn.exec("DROP TABLE connectors");
      conn.exec("ALTER TABLE connectors_v2 RENAME TO connectors");
      conn.exec("COMMIT");
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    } finally {
      conn.exec("PRAGMA foreign_keys = ON");
    }
  }
  if (!has("connector_states", "workspace_id")) conn.exec("ALTER TABLE connector_states ADD COLUMN workspace_id TEXT");
  if (!has("connector_states", "connector_id")) conn.exec("ALTER TABLE connector_states ADD COLUMN connector_id TEXT");
  // Per-person sign-in (Oct 25, 2026): each connection's access mode.
  if (!has("connectors", "access_mode")) conn.exec("ALTER TABLE connectors ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'shared'");
  if (!has("connectors", "access_mode_by")) conn.exec("ALTER TABLE connectors ADD COLUMN access_mode_by TEXT");
  if (!has("connectors", "access_mode_at")) conn.exec("ALTER TABLE connectors ADD COLUMN access_mode_at TEXT");
  for (const sql of CONNECTOR_GROUP_MIGRATION) conn.exec(sql);
  // Data migrations (same SQL as Postgres, see `DATA_MIGRATIONS`), all or nothing. A savepoint rather than BEGIN,
  // because a code reload can re-run this while a transaction is open.
  conn.exec("SAVEPOINT data_migrations");
  try {
    for (const m of DATA_MIGRATIONS) conn.prepare(m.sql).run(...m.params());
    conn.exec("RELEASE data_migrations");
  } catch (e) {
    conn.exec("ROLLBACK TO data_migrations");
    conn.exec("RELEASE data_migrations");
    throw e;
  }
}

/**
 * Data migrations: changes to existing rows (not columns), run on both engines with the same SQL after the schema,
 * every time it is applied. Each must be **idempotent**: written so that a second run finds nothing left to change.
 * SQLite runs them in `migrate`; Postgres in `postgresDriver`, inside the schema's advisory lock and one transaction.
 *
 * - **Retiring the Billing Admin role** (October 2026, the `retireBillingAdmins` steps): only Org Owners and Org Admins see
 *   usage and billing now. Everyone who still has the role becomes a **Member** (least privilege) with no groups,
 *   gets one audit entry ("Access", by Sidekick), and the Org Owner gets one notice on Home: a finding of kind
 *   `role_changed` with audience `owners` (lib/watchers.ts keeps it open for a while unless they change the role).
 *   The role change runs last, so a second run matches nobody and changes nothing.
 * - **"Meeting notes go to"** (October 2026, the `notesChoice` steps; lib/notes-chats.ts): which chats get a group's
 *   notes used to be a per-chat switch (`"notes":false` in teams_chat_settings, on by default). It is now one choice per
 *   group. A group where someone had switched notes off in a linked chat keeps that choice: its other linked chats
 *   become the chosen notes chats (`notes_chats`, `notes_choice = 'chosen'`), or `'none'` if every chat was off. Groups
 *   where every chat got notes by default keep no choice (`NULL`): notes then go to one default chat and the group's
 *   Team Lead is asked to pick. Only groups without a choice are touched, so a second run changes nothing.
 * - **Real adder names** (October 2026, the `adderNames` steps; lib/teams/install.ts `adderName`): until then, when
 *   Teams left the adder's name out of the install event, the bot saved the placeholder "Someone in Teams". Such rows
 *   get the name of the Sidekick person whose Microsoft account added the chat (in the org tied to the chat's
 *   tenant), or NULL when there is none (the portal still says "someone in Teams"). The placeholder is gone after the
 *   first run, so a second run changes nothing.
 */
const DATA_MIGRATIONS: { name: string; sql: string; params: () => Param[] }[] = (() => {
  const t = () => new Date().toISOString();
  const retired = "FROM users WHERE role = 'Billing Admin'";
  // A linked chat of this group where someone switched meeting notes off (the old per-chat setting).
  const notesOffIn = (ws: string) => `EXISTS (SELECT 1 FROM teams_conversations c2 JOIN teams_chat_settings s2 ON s2.conversation_id = c2.id AND s2.workspace_id = c2.workspace_id
    WHERE c2.workspace_id = ${ws} AND c2.removed_at IS NULL AND s2.json LIKE '%"notes":false%')`;
  return [
    {
      name: "retireBillingAdmins: audit entry per person",
      sql: `INSERT INTO audit_log (org_id, actor, action, kind, workspace_id, created_at)
            SELECT org_id, ?, 'Changed ' || name || ' from Billing Admin to Member: the Billing Admin role was retired (only Org Owners and Org Admins see billing now)', 'Access', NULL, ?
            ${retired}`,
      params: () => [BRAND.name, t()],
    },
    {
      name: "retireBillingAdmins: one notice to the Org Owner per person",
      sql: `INSERT INTO findings (id, org_id, workspace_id, kind, dedupe_key, audience, severity, status, title, detail, next_step,
                                 action_href, action_label, data_json, first_seen_at, last_seen_at, updated_at)
            SELECT 'role_changed:' || id, org_id, NULL, 'role_changed', 'role_changed:org:' || id, 'owners', 'info', 'open',
                   name || ' was a Billing Admin and is now a Member',
                   'The Billing Admin role was retired: only Org Owners and Org Admins see usage and billing now.',
                   'Make them an Org Admin on Users & access if they should keep seeing billing.',
                   '/users', 'Open Users & access', NULL, ?, ?, ?
            ${retired}
            ON CONFLICT DO NOTHING`,
      params: () => { const now = t(); return [now, now, now]; },
    },
    {
      name: "retireBillingAdmins: no groups",
      sql: `DELETE FROM workspace_members WHERE user_id IN (SELECT id ${retired})`,
      params: () => [],
    },
    {
      name: "notesChoice: keep the chats that still had notes on",
      sql: `INSERT INTO notes_chats (workspace_id, conversation_id, org_id)
            SELECT c.workspace_id, c.id, c.org_id FROM teams_conversations c JOIN workspaces w ON w.id = c.workspace_id AND w.org_id = c.org_id
             WHERE w.notes_choice IS NULL AND c.removed_at IS NULL AND ${notesOffIn("w.id")}
               AND NOT EXISTS (SELECT 1 FROM teams_chat_settings s WHERE s.conversation_id = c.id AND s.workspace_id = c.workspace_id AND s.json LIKE '%"notes":false%')
            ON CONFLICT DO NOTHING`,
      params: () => [],
    },
    {
      name: "notesChoice: record the choice",
      sql: `UPDATE workspaces SET notes_choice = CASE WHEN EXISTS (SELECT 1 FROM notes_chats n WHERE n.workspace_id = workspaces.id) THEN 'chosen' ELSE 'none' END,
                   notes_choice_by = ?, notes_choice_at = ?
             WHERE notes_choice IS NULL AND ${notesOffIn("workspaces.id")}`,
      params: () => [BRAND.name, t()],
    },
    {
      name: "adderNames: the Sidekick person's name instead of the placeholder",
      sql: `UPDATE teams_conversations SET added_by = (SELECT u.name FROM users u JOIN orgs o ON o.id = u.org_id
                     WHERE o.entra_tenant_id = teams_conversations.tenant_id AND u.entra_oid = teams_conversations.added_by_oid)
             WHERE added_by = 'Someone in Teams'`,
      params: () => [],
    },
    {
      name: "retireBillingAdmins: Billing Admin becomes Member",
      sql: "UPDATE users SET role = 'Member' WHERE role = 'Billing Admin'",
      params: () => [],
    },
  ];
})();

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

/** The transaction a query joins: its connection and the context last applied inside it (SET LOCAL). */
const pgTx = new AsyncLocalStorage<{ client: pg.PoolClient; ctx: string }>();

/**
 * The role every app query runs as on Postgres (db/schema.postgres.sql creates it): no BYPASSRLS, only row
 * access, so row-level security applies even when DATABASE_URL's login is a superuser (as on a developer's Mac).
 */
export const RLS_ROLE = "sidekick_app";
/** Rollback switch: SIDEKICK_RLS=off turns row-level security off (policies disabled at the next start). */
const RLS_ON = process.env.SIDEKICK_RLS !== "off";
// The context last applied to a pooled connection at session level (outside any transaction), so an unchanged
// context costs nothing: steady traffic for one org needs no extra round trip.
const SESSION_CTX = Symbol("sidekickCtx");
type CtxClient = pg.PoolClient & { [SESSION_CTX]?: string };

/** How row-level security is working on this server, for the health page and tests. */
export type RlsStatus = { mode: "role" | "forced-owner" | "off" | "sqlite"; detail: string };
let rlsStatus: RlsStatus = DIALECT === "sqlite" ? { mode: "sqlite", detail: "SQLite has no row-level security" } : { mode: "off", detail: "not connected yet" };
/** The row-level security mode found when the server connected to Postgres (see `RlsStatus`). */
export async function rowLevelSecurity(): Promise<RlsStatus> {
  if (DIALECT === "postgres") await driver();
  return rlsStatus;
}

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
    // Connections per app copy. Azure's B1ms allows ~50 in all, so 10 leaves room for 3-4 copies plus admin tools;
    // raise it only together with a bigger database tier (docs/SCALE.md, docs/HOSTING.md → Scaling up).
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    // When every connection is busy, a query waits at most this long for one, then fails with a clear error
    // (a reference code for the person) instead of hanging the request (DATABASE_POOL_WAIT_MS, default 15 s).
    connectionTimeoutMillis: Number(process.env.DATABASE_POOL_WAIT_MS || 15_000),
    idleTimeoutMillis: 30_000, // give idle connections back to the database after 30 s
    allowExitOnIdle: true, // scripts and tests can exit without closing the pool
    // Azure Database for PostgreSQL requires encrypted (TLS) connections, checked against its certificate.
    // A database on this same machine (localhost, or a local socket) is the only exception.
    ssl: isLocalDatabase(url) ? undefined : { rejectUnauthorized: true },
  });
  const schemaPath = path.join(process.cwd(), "db", "schema.postgres.sql");
  let applied = fs.readFileSync(schemaPath, "utf8");
  // Several app copies (or job workers) starting at once would apply the schema together, and its ALTER TABLEs
  // can deadlock each other; a session-level advisory lock lets one copy apply it at a time.
  const applySchema = async (sql: string) => {
    const client: CtxClient = await pool.connect();
    try {
      // The schema and data migrations run as the database owner (not the app role) and span every org. The
      // session settings are put back below, and the connection's cached context is forgotten.
      client[SESSION_CTX] = undefined;
      await client.query("RESET ROLE");
      await client.query("SELECT set_config('app.bypass', 'on', false), set_config('sidekick.rls', $1, false)", [RLS_ON ? "on" : "off"]);
      await client.query("SELECT pg_advisory_lock(727274)");
      await client.query(sql);
      // Data migrations (`DATA_MIGRATIONS`, same SQL as SQLite) in one transaction, still under the lock.
      await client.query("BEGIN");
      try {
        for (const m of DATA_MIGRATIONS) await client.query(toPgPlaceholders(m.sql), m.params());
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
      await client.query("SELECT set_config('app.bypass', 'off', false)").catch(() => {});
      client.release();
    }
  };
  await applySchema(applied);
  // Which way row-level security works here: as the app role (normal), else as the owner with FORCE (when this
  // login may not switch to the role), else not at all (a login that bypasses it, or SIDEKICK_RLS=off).
  const who = (await pool.query(
    `SELECT r.rolsuper OR r.rolbypassrls AS bypasses, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND pg_has_role(current_user, $1, 'MEMBER') AS can_switch
       FROM pg_roles r WHERE r.rolname = current_user`, [RLS_ROLE],
  )).rows[0] as { bypasses: boolean; can_switch: boolean };
  const useRole = RLS_ON && who.can_switch;
  rlsStatus = !RLS_ON ? { mode: "off", detail: "turned off with SIDEKICK_RLS=off" }
    : useRole ? { mode: "role", detail: `queries run as ${RLS_ROLE}` }
    : who.bypasses ? { mode: "off", detail: `the database login bypasses row-level security and can't switch to ${RLS_ROLE}` }
    : { mode: "forced-owner", detail: "queries run as the table owner; FORCE ROW LEVEL SECURITY applies" };
  if (rlsStatus.mode === "off" && RLS_ON) console.warn(`[db] Row-level security is NOT active: ${rlsStatus.detail}.`);
  // The settings that make a context: the role, the org and the bypass flag, as one statement.
  // Turned off (SIDEKICK_RLS=off): one fixed context, so connections never need the settings again.
  const ctxKey = (c: QueryCtx) => (RLS_ON ? `${c.org}|${c.bypass ? "on" : "off"}` : "rls-off");
  const ctxSql = (local: boolean) =>
    `SELECT set_config('role', $1, ${local}), set_config('app.org_id', $2, ${local}), set_config('app.bypass', $3, ${local})`;
  // System work keeps the login's own role (the table owner, which may also change the schema); org work runs as
  // the app role, which can't get around the policies.
  const ctxParams = (c: QueryCtx) => [useRole && !c.bypass ? RLS_ROLE : "none", c.org, c.bypass || !RLS_ON ? "on" : "off"];
  // In development the server outlives schema edits; re-apply the (idempotent) schema when the file changes.
  const ensureSchema = async () => {
    if (process.env.NODE_ENV === "production") return;
    const current = fs.readFileSync(schemaPath, "utf8");
    if (current !== applied) {
      await applySchema(current);
      applied = current;
    }
  };
  /** Runs one statement with `ctx` applied: inside the current transaction (SET LOCAL), or on a pooled connection. */
  const send = async (sql: string, params: Param[], ctx: QueryCtx) => {
    await ensureSchema();
    const want = ctxKey(ctx);
    const inTx = pgTx.getStore();
    if (inTx) {
      if (inTx.ctx !== want) {
        await inTx.client.query(ctxSql(true), ctxParams(ctx));
        inTx.ctx = want;
      }
      return inTx.client.query(toPgPlaceholders(sql), params);
    }
    const client: CtxClient = await pool.connect();
    try {
      if (client[SESSION_CTX] !== want) {
        client[SESSION_CTX] = undefined; // unknown until the settings are confirmed
        await client.query(ctxSql(false), ctxParams(ctx));
        client[SESSION_CTX] = want;
      }
      return await client.query(toPgPlaceholders(sql), params);
    } finally {
      client.release();
    }
  };
  return {
    async query(sql, params, ctx) {
      return (await send(sql, params, ctx)).rows;
    },
    async exec(sql, params, ctx) {
      return { changes: (await send(sql, params, ctx)).rowCount ?? 0 };
    },
    async tx(fn) {
      if (pgTx.getStore()) return fn(); // nested: join the outer transaction
      await ensureSchema();
      const client: CtxClient = await pool.connect();
      try {
        await client.query("BEGIN");
        // Settings made with SET LOCAL end with the transaction, so the connection's own context is unchanged.
        const out = await pgTx.run({ client, ctx: client[SESSION_CTX] ?? "" }, fn);
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

/**
 * Runs the data migrations (`DATA_MIGRATIONS`) again, in one transaction, through the active engine. They already
 * run whenever the schema is applied; this is for tests and scripts that need them on demand. Safe to call any
 * number of times: a second run changes nothing.
 */
export async function runDataMigrations(): Promise<void> {
  await tx(async () => {
    for (const m of DATA_MIGRATIONS) await run(m.sql, ...m.params());
  });
}

/** New random id for a row (UUID v4). */
export const newId = () => crypto.randomUUID();
/** Current time as an ISO 8601 string, the format every `*_at` column uses. */
export const now = () => new Date().toISOString();

/** A database row with unknown columns. Pass a type to `all`/`get` to describe the columns instead. */
export type Row = Record<string, unknown>;

/**
 * Slow-query log (SIDEKICK_SLOW_QUERY_MS, off by default): prints any query that took longer than that many ms, with
 * its SQL text only (values are never printed, so no client data reaches the log). Used by the load test
 * (docs/SCALE.md) and handy in production for a while after a change.
 */
const SLOW_QUERY_MS = Number(process.env.SIDEKICK_SLOW_QUERY_MS || 0);
function timeQuery(sql: string, t0: number) {
  const ms = performance.now() - t0;
  countDbQuery(ms);
  if (SLOW_QUERY_MS > 0 && ms >= SLOW_QUERY_MS) console.warn(`[slow query] ${Math.round(ms)} ms: ${sql.replace(/\s+/g, " ").trim().slice(0, 400)}`);
}

/** Runs a SELECT and returns every matching row. Values go in `params`, matched to `?` in order. */
export async function all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
  const t0 = performance.now();
  try {
    return (await (await driver()).query(sql, params, queryCtx(sql))) as T[];
  } finally {
    timeQuery(sql, t0);
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
    return await (await driver()).exec(sql, params, queryCtx(sql));
  } finally {
    timeQuery(sql, t0);
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
