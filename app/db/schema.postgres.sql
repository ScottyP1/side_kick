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
-- Failed portal sign-ins (wrong password or unknown email), for the sign-in rate limit in
-- lib/login-limit.ts. Kept one day.
CREATE TABLE IF NOT EXISTS login_failures (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures(email, created_at);
CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures(ip, created_at);
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
-- Per-organization feature switches set in the Owner Console (a restriction for one client). Missing row = on.
CREATE TABLE IF NOT EXISTS org_flags (
  org_id TEXT NOT NULL, flag_key TEXT NOT NULL, enabled INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, flag_key)
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
-- Reminders: due dates as real dates (YYYY-MM-DD).
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS due_on TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS due_on TEXT;
-- Setup wizard progress per organization (lib/setup.ts): which steps are done or skipped, and when it finished.
CREATE TABLE IF NOT EXISTS org_setup (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), json TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL
);
-- Multi-tenant Teams (lib/tenants.ts, lib/directory.ts): who added Sidekick to a chat, and when the org's
-- Microsoft admin approved the directory permission.
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS added_by TEXT;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS added_by_oid TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS graph_consent_at TEXT;
CREATE INDEX IF NOT EXISTS teams_conversations_tenant ON teams_conversations(tenant_id);
-- Unassigned chats (lib/teams/install.ts): waiting since, the team's Microsoft 365 group id, pending departure.
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS waiting_since TEXT;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS team_aad_id TEXT;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS leaving TEXT;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS leave_tried_at TEXT;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS leave_error TEXT;
-- Self-service sign-up attempts (lib/signup.ts), for the per-IP sign-up limit. Kept one day.
CREATE TABLE IF NOT EXISTS signup_attempts (
  id TEXT PRIMARY KEY, ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_attempts_ip ON signup_attempts(ip, created_at);
-- One subscription per organization (lib/billing.ts); no row = managed by the Sidekick team.
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), plan TEXT NOT NULL, status TEXT NOT NULL,
  provider TEXT NOT NULL, provider_ref TEXT, trial_ends_at TEXT, current_period_end TEXT,
  past_due_since TEXT, canceled_at TEXT, access_until TEXT,
  updated_by TEXT, updated_at TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Groups: the client a workspace (group) is for, e.g. "Northwind Bank".
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS client TEXT;
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
-- Group pricing: extra groups bought on top of the plan (lib/plans.ts EXTRA_GROUP).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS extra_groups INTEGER NOT NULL DEFAULT 0;
-- Plan terms the Sidekick team sets per organization in the Owner Console (lib/limits.ts, lib/credit.ts):
-- custom limits (JSON, Enterprise or managed clients), an AI credit override, the contract price per month
-- (Enterprise / managed), the partner or referrer who brought the client, and a per-person questions-per-hour
-- limit. Missing row = the plan's own numbers.
CREATE TABLE IF NOT EXISTS org_terms (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), limits_json TEXT, ai_credit_usd DOUBLE PRECISION, monthly_price_usd DOUBLE PRECISION,
  partner TEXT, ask_per_hour INTEGER, updated_by TEXT, updated_at TEXT NOT NULL
);
-- One-off AI credit top-ups granted by the Sidekick team, for one calendar month (YYYY-MM, UTC).
CREATE TABLE IF NOT EXISTS credit_topups (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), month TEXT NOT NULL, amount_usd DOUBLE PRECISION NOT NULL,
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
-- Plan limits: each meeting's length in minutes (meeting hours per month).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS duration_min INTEGER;
-- Owner Console: a temporary password from scripts/reset-password.mjs must be changed at next sign-in.
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0;
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
-- Where each session was started (shown on Settings → Where you're signed in), and when it was last used.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;

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
-- kind = assist (portal in-app assistant) | support (support assistant) | helpbot (public website). Owned by
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
-- Who pays for an AI call (lib/claude.ts `payer`): null = the organization's AI credit, support / helpbot = Sidekick.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS payer TEXT;
-- Required two-step sign-in (lib/auth.ts): the Org Owner's switch, and how each session started (password | microsoft).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS mfa_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS via TEXT;
-- Firm library (lib/firm.ts): org-wide documents every group's answers can use (see the SQLite schema in
-- lib/db.ts for the columns). Passages are indexed once per org under workspace id "firm".
CREATE TABLE IF NOT EXISTS firm_docs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), title TEXT NOT NULL, name TEXT NOT NULL, mime TEXT,
  size INTEGER NOT NULL, audience TEXT NOT NULL DEFAULT 'internal', status TEXT NOT NULL, error TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0, effective_on TEXT, superseded_by TEXT, content_hash TEXT,
  uploaded_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS firm_docs_org ON firm_docs(org_id, created_at);
-- Thumbs up/down on answers (lib/feedback.ts): counts only, no text.
CREATE TABLE IF NOT EXISTS answer_feedback (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, question_id TEXT NOT NULL, user_id TEXT NOT NULL,
  vote INTEGER NOT NULL, channel TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (question_id, user_id)
);
CREATE INDEX IF NOT EXISTS answer_feedback_org ON answer_feedback(org_id, created_at);
-- Answer quality: hash of each document's text (duplicate uploads).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT;
-- Follow-ups in Ask and Teams: the group a conversation belongs to, and the Teams thread or chat (scope_key).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS scope_key TEXT;
CREATE INDEX IF NOT EXISTS conversations_scope ON conversations(org_id, user_id, kind, workspace_id, scope_key);
-- Connectors to outside tools (lib/connectors.ts: Azure DevOps Boards, Jira, GitHub Issues, Confluence, Microsoft 365 files): see the SQLite schema in lib/db.ts
-- for what each column means.
CREATE TABLE IF NOT EXISTS connector_kinds (
  org_id TEXT NOT NULL REFERENCES orgs(id), kind TEXT NOT NULL, allowed_by TEXT, allowed_at TEXT NOT NULL,
  PRIMARY KEY (org_id, kind)
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
  account TEXT NOT NULL, account_name TEXT, api_base TEXT NOT NULL, web_base TEXT NOT NULL,
  access_token TEXT, refresh_token TEXT, token_expires_at TEXT,
  connected_by TEXT, connected_at TEXT NOT NULL, last_error TEXT, last_error_at TEXT, updated_at TEXT NOT NULL
);
-- Connectors per group (Oct 24, 2026): databases made before then had one per organization (UNIQUE (org_id, kind)).
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_org_id_kind_key;
CREATE TABLE IF NOT EXISTS connector_links (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, project TEXT NOT NULL, project_name TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'internal',
  sync_cursor TEXT, item_count INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT, last_ok_at TEXT, last_error TEXT,
  sync_started_at TEXT, created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE (connector_id, workspace_id, project)
);
CREATE INDEX IF NOT EXISTS connector_links_ws ON connector_links(org_id, workspace_id);
CREATE TABLE IF NOT EXISTS connector_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  link_id TEXT NOT NULL REFERENCES connector_links(id) ON DELETE CASCADE, external_id TEXT NOT NULL,
  item_type TEXT, title TEXT NOT NULL, state TEXT, assignee TEXT, due_on TEXT, url TEXT NOT NULL, changed_at TEXT,
  blocked_by TEXT, comment_count INTEGER NOT NULL DEFAULT 0, text_hash TEXT, synced_at TEXT NOT NULL,
  UNIQUE (link_id, external_id)
);
CREATE INDEX IF NOT EXISTS connector_items_ws ON connector_items(org_id, workspace_id);
CREATE TABLE IF NOT EXISTS connector_states (
  state TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, verifier TEXT NOT NULL,
  site TEXT, expires_at TEXT NOT NULL, workspace_id TEXT
);
ALTER TABLE connector_states ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Requests to turn a tool on (lib/connector-requests.ts): see the SQLite schema in lib/db.ts for the columns.
CREATE TABLE IF NOT EXISTS connector_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), kind TEXT NOT NULL, workspace_id TEXT NOT NULL,
  requested_by TEXT NOT NULL, requester_name TEXT NOT NULL, reason TEXT, status TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_requests_org ON connector_requests(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS connector_requests_open ON connector_requests(org_id, kind, workspace_id) WHERE status = 'pending';

-- Background jobs (lib/jobs.ts), watcher findings (lib/watchers.ts), the stale-document AI checks, connector
-- health (lib/connector-health.ts) and failed Teams posts: see the SQLite schema in lib/db.ts for the columns.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, org_id TEXT, workspace_id TEXT, payload TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT, status TEXT NOT NULL, run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5, locked_by TEXT, locked_until TEXT, last_error TEXT, result TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS jobs_org ON jobs(org_id, status);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT, kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL, audience TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, next_step TEXT NOT NULL, action_href TEXT, action_label TEXT, data_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT, snoozed_until TEXT, snoozed_by TEXT,
  updated_at TEXT NOT NULL, UNIQUE (org_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS findings_scope ON findings(org_id, status, workspace_id);
CREATE TABLE IF NOT EXISTS watch_checks (
  org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, pair_key TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT,
  checked_at TEXT NOT NULL, PRIMARY KEY (org_id, pair_key)
);
CREATE TABLE IF NOT EXISTS connector_health (
  org_id TEXT NOT NULL REFERENCES orgs(id), workspace_id TEXT NOT NULL DEFAULT '', connector TEXT NOT NULL,
  label TEXT NOT NULL, status TEXT NOT NULL, message TEXT, fix_href TEXT, checked_at TEXT NOT NULL, broken_since TEXT,
  PRIMARY KEY (org_id, workspace_id, connector)
);
CREATE TABLE IF NOT EXISTS teams_post_failures (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT, conversation_id TEXT NOT NULL, what TEXT NOT NULL,
  error TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS teams_post_failures_conv ON teams_post_failures(conversation_id, created_at);
-- Watchers: Sidekick removed from a chat in Teams (when, by whom), and the last post that reached the chat.
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS removed_at TEXT;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS removed_by TEXT;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS last_post_ok_at TEXT;
-- Scale readiness (docs/SCALE.md): indexes for per-group lists and counts, per-person lookups, and the retention
-- clean-up (lib/retention.ts), found with the load test (scripts/load-test.mjs) on 10,000 groups.
CREATE INDEX IF NOT EXISTS workspaces_org ON workspaces(org_id, name);
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS users_org ON users(org_id, role);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS documents_ws ON documents(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS documents_org ON documents(org_id, created_at);
CREATE INDEX IF NOT EXISTS meetings_ws ON meetings(workspace_id, held_at);
CREATE INDEX IF NOT EXISTS meetings_org ON meetings(org_id, created_at);
CREATE INDEX IF NOT EXISTS items_meeting ON items(meeting_id, kind);
CREATE INDEX IF NOT EXISTS items_org_kind ON items(org_id, kind, created_at);
CREATE INDEX IF NOT EXISTS items_ws ON items(workspace_id, kind);
CREATE INDEX IF NOT EXISTS action_items_meeting ON action_items(meeting_id);
CREATE INDEX IF NOT EXISTS action_items_ws ON action_items(workspace_id, status);
CREATE INDEX IF NOT EXISTS action_items_org ON action_items(org_id, status, due_on);
CREATE INDEX IF NOT EXISTS questions_ws ON questions(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS questions_org ON questions(org_id, created_at);
CREATE INDEX IF NOT EXISTS audit_log_org_time ON audit_log(org_id, created_at);
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS traces_time ON traces(started_at);
CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS chat_messages_time ON chat_messages(sent_at);
CREATE INDEX IF NOT EXISTS app_errors_time ON app_errors(created_at);
CREATE INDEX IF NOT EXISTS guard_events_time ON guard_events(created_at);
CREATE INDEX IF NOT EXISTS teams_conversations_org ON teams_conversations(org_id, workspace_id);
-- Meetings wave (lib/meetings-graph.ts): automatic meeting notes from Microsoft Graph, its subscriptions, the
-- meetings it heard about and the polling cursors (see the SQLite schema in lib/db.ts for the columns); where a
-- meeting came from, its notes post, and items saved to knowledge.
CREATE TABLE IF NOT EXISTS auto_meetings (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id), enabled INTEGER NOT NULL DEFAULT 0, changed_by TEXT, changed_at TEXT,
  last_poll_at TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT
);
CREATE TABLE IF NOT EXISTS graph_subscriptions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), tenant_id TEXT NOT NULL, resource TEXT NOT NULL,
  client_state TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, renewed_at TEXT
);
CREATE TABLE IF NOT EXISTS graph_meetings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), online_meeting_id TEXT NOT NULL, transcript_id TEXT NOT NULL,
  organizer_oid TEXT NOT NULL, via TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, title TEXT, started_at TEXT,
  ended_at TEXT, workspace_id TEXT, candidates TEXT, meeting_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (org_id, transcript_id)
);
CREATE INDEX IF NOT EXISTS graph_meetings_org ON graph_meetings(org_id, status, created_at);
CREATE TABLE IF NOT EXISTS graph_poll_cursors (
  org_id TEXT NOT NULL REFERENCES orgs(id), organizer_oid TEXT NOT NULL, polled_until TEXT NOT NULL,
  PRIMARY KEY (org_id, organizer_oid)
);
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS graph_meeting_id TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS notes_posted_at TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS saved_by TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS saved_at TEXT;
-- "Meeting notes go to" (lib/notes-chats.ts): the group's choice, who made it and when; where a meeting's notes went.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS notes_choice TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS notes_choice_by TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS notes_choice_at TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS notes_posted_to TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS notes_sent_at TEXT;
-- Notes picker polish: how many people a linked chat has (from the Teams roster, checked at most daily) and when.
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS member_count INTEGER;
ALTER TABLE teams_conversations ADD COLUMN IF NOT EXISTS members_checked_at TEXT;
-- Meet now (ad hoc calls): which kind of Teams call a captured transcript came from ('meeting' scheduled, 'adhoc').
ALTER TABLE graph_meetings ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'meeting';
-- Which group a meeting belongs to (lib/meeting-group.ts): why it waits ('tie' | 'unclear'), who picked its group,
-- the title-hint note, and its people not in the picked group yet (JSON, only after someone picked).
ALTER TABLE graph_meetings ADD COLUMN IF NOT EXISTS waiting_kind TEXT;
ALTER TABLE graph_meetings ADD COLUMN IF NOT EXISTS picked_by TEXT;
ALTER TABLE graph_meetings ADD COLUMN IF NOT EXISTS pick_note TEXT;
ALTER TABLE graph_meetings ADD COLUMN IF NOT EXISTS newcomers TEXT;
-- Scale readiness: Graph subscriptions are looked up per organization (renewals, notes status).
CREATE INDEX IF NOT EXISTS graph_subscriptions_org ON graph_subscriptions(org_id, expires_at);
-- Upload guard (lib/upload-guard.ts): held documents (status 'Held', text in held_text until kept or moved), what
-- matched (guard_json), flagged-and-kept state (guard_status), and firm documents limited to chosen groups.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS guard_status TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS guard_json TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS held_text TEXT;
ALTER TABLE firm_docs ADD COLUMN IF NOT EXISTS guard_status TEXT;
ALTER TABLE firm_docs ADD COLUMN IF NOT EXISTS guard_json TEXT;
ALTER TABLE firm_docs ADD COLUMN IF NOT EXISTS held_text TEXT;
ALTER TABLE firm_docs ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'all';
CREATE TABLE IF NOT EXISTS firm_doc_groups (
  firm_doc_id TEXT NOT NULL REFERENCES firm_docs(id) ON DELETE CASCADE, org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, PRIMARY KEY (firm_doc_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS firm_doc_groups_ws ON firm_doc_groups(org_id, workspace_id);

-- Connectors per group: move one-per-organization connectors into groups (same statements as lib/db.ts
-- CONNECTOR_GROUP_MIGRATION, which explains them; keep both in step). Each is harmless to run again.
INSERT INTO connector_kinds (org_id, kind, allowed_by, allowed_at)
     SELECT org_id, kind, by_name, at_time FROM (SELECT org_id, kind, MAX(connected_by) AS by_name, MIN(connected_at) AS at_time FROM connectors WHERE workspace_id IS NULL GROUP BY org_id, kind) m
     WHERE true ON CONFLICT (org_id, kind) DO NOTHING;
UPDATE connectors SET workspace_id = (SELECT l.workspace_id FROM connector_links l WHERE l.connector_id = connectors.id ORDER BY l.created_at, l.id LIMIT 1) WHERE workspace_id IS NULL;
INSERT INTO connectors (id, org_id, workspace_id, kind, status, account, account_name, api_base, web_base, connected_by, connected_at, last_error, last_error_at, updated_at)
     SELECT DISTINCT c.id || '-' || l.workspace_id, c.org_id, l.workspace_id, c.kind, 'expired', c.account, c.account_name, c.api_base, c.web_base, c.connected_by, c.connected_at,
            'Connections are per group now: sign in again for this group on Connectors.', c.updated_at, c.updated_at
       FROM connector_links l JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
      WHERE l.workspace_id <> c.workspace_id ON CONFLICT (id) DO NOTHING;
UPDATE connector_links SET connector_id = connector_id || '-' || workspace_id WHERE workspace_id <> (SELECT c.workspace_id FROM connectors c WHERE c.id = connector_links.connector_id);
DELETE FROM connectors WHERE workspace_id IS NULL;
DELETE FROM connector_health WHERE workspace_id = '' AND connector IN ('azure-devops', 'jira', 'github', 'confluence', 'microsoft-365-files');
CREATE UNIQUE INDEX IF NOT EXISTS connectors_group_kind ON connectors(org_id, workspace_id, kind);

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
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS call_nudge INTEGER;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS call_nudge_by TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS call_nudge_at TEXT;
-- ---------------------------------------------------------------------------------------------------------
-- Row-level security: the second lock behind the app's org checks (docs/ARCHITECTURE.md → "Row-level
-- security", docs/security/2026-10-row-level-security.md). Every table with an org_id column, plus orgs and
-- workspace_members, only shows and accepts rows of the org in the connection's app.org_id setting, unless
-- app.bypass = 'on' (named system work: lib/db.ts asSystem). lib/db.ts sets both on every connection it hands
-- out and runs app queries as the role sidekick_app, which has no way around the policies.
-- Idempotent and cheap to re-run: each step checks first, so a normal start changes nothing.
-- Rollback: start the app with SIDEKICK_RLS=off; this block then turns row-level security off on every table
-- (lib/db.ts passes the switch in the sidekick.rls setting). See docs/RUNBOOKS.md → "Row-level security".
-- ---------------------------------------------------------------------------------------------------------
DO $rls$
DECLARE
  on_ BOOLEAN := coalesce(current_setting('sidekick.rls', true), 'on') <> 'off';
  t RECORD;
  old_ RECORD;
  check_ TEXT;
  -- Each setting is read in a sub-select, so Postgres reads it once per query instead of once per row.
  pass CONSTANT TEXT := '(SELECT current_setting(''app.bypass'', true)) = ''on''';
BEGIN
  -- The app role: no login, no BYPASSRLS, row access only. Roles are shared by every database on the server.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidekick_app') THEN
    BEGIN
      CREATE ROLE sidekick_app NOLOGIN NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; -- another database or app copy created it at the same moment
    WHEN insufficient_privilege THEN RAISE NOTICE 'Row-level security: may not create role sidekick_app; the owner role is used (FORCE).';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidekick_app') THEN
    IF NOT pg_has_role(current_user, 'sidekick_app', 'MEMBER') THEN
      BEGIN
        EXECUTE format('GRANT sidekick_app TO %I', current_user); -- lets this login SET ROLE sidekick_app
      EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Row-level security: may not join role sidekick_app.';
      END;
    END IF;
    GRANT USAGE ON SCHEMA public TO sidekick_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sidekick_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO sidekick_app;
  END IF;

  FOR t IN
    SELECT c.relname AS tbl,
           CASE WHEN c.relname = 'orgs' THEN 'id'
                WHEN c.relname = 'workspace_members' THEN NULL
                ELSE 'org_id' END AS col,
           c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND (c.relname IN ('orgs', 'workspace_members')
            OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped))
  LOOP
    IF NOT on_ THEN
      IF t.enabled OR t.forced THEN
        EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY', t.tbl);
      END IF;
      CONTINUE;
    END IF;
    -- workspace_members has no org_id: a membership is visible when its workspace is (workspaces has the policy).
    check_ := CASE WHEN t.col IS NULL
      THEN format('%s OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_members.workspace_id)', pass)
      ELSE format('%s OR %I = (SELECT current_setting(''app.org_id'', true))', pass, t.col) END;
    -- Older app versions (still answering during a deploy, or after a rollback) never set app.org_id and connect as
    -- the owner: they keep working. The current app sets it on every connection before its first query, and its
    -- org work runs as sidekick_app, which this clause never lets through.
    check_ := check_ || ' OR ((SELECT current_setting(''app.org_id'', true)) IS NULL AND (SELECT current_user) <> ''sidekick_app'')';
    -- The policy's name carries a version: a changed rule gets a new name, and older versions are dropped.
    FOR old_ IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t.tbl AND policyname LIKE 'sidekick_org_v%' AND policyname <> 'sidekick_org_v3' LOOP
      EXECUTE format('DROP POLICY %I ON %I', old_.policyname, t.tbl);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t.tbl AND policyname = 'sidekick_org_v3') THEN
      EXECUTE format('CREATE POLICY sidekick_org_v3 ON %I USING (%s) WITH CHECK (%s)', t.tbl, check_, check_);
    END IF;
    -- The policy filters on org_id; an index starting with org_id keeps that cheap on queries without one.
    IF t.col = 'org_id' AND NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = format('%I', t.tbl)::regclass AND a.attname = 'org_id') THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (org_id)', t.tbl || '_org_rls', t.tbl);
    END IF;
    IF NOT t.enabled THEN EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl); END IF;
    IF NOT t.forced THEN EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tbl); END IF;
  END LOOP;
END
$rls$;
