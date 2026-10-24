/**
 * @file Retention: how long Sidekick keeps the records that grow every day (traces, AI usage rows, audit entries,
 * logs, expired sign-in rows), and the hourly clean-up that deletes older ones, so no table grows forever
 * (docs/SCALE.md). Runs as the job queue's `data.retention` job (lib/job-kinds.ts).
 *
 * Concepts
 * - **Retention policy** (`RETENTION`): one line per table: which time column decides age, how many days to keep,
 *   and why. Client content (documents, meetings, decisions, questions) is NOT here: it stays until the group or
 *   organization is deleted (lib/rolloff.ts). Tracked Teams chat messages have their own 90-day clean-up (with
 *   their search passages) in lib/reminders.ts, and finished jobs theirs in lib/jobs.ts.
 * - **Batches**: rows go in batches of `batch` (default 2,000) with a short statement each, never one huge DELETE,
 *   so the clean-up never locks a busy table for long or fights live writes (a single big DELETE of old traces
 *   deadlocked with trace saving under load). A run stops after `budgetMs` (default 20 s) and the next hourly run
 *   carries on, so a first clean-up of a large backlog spreads over a few hours.
 * - **Same SQL on both engines**: `DELETE … WHERE key IN (SELECT key … LIMIT n)` works on SQLite and Postgres.
 * - **Traced**: each table's clean-up is a step of the job's trace with the number of rows deleted (no content).
 */
import "server-only";
import { all, run } from "./db";
import { span, spanAttrs, TRACE_RETENTION_DAYS } from "./trace";

const DAY = 86400_000;
/** Hours an assistant conversation is kept after its last turn (must match lib/conversations.ts EXPIRE_HOURS). */
const CONVERSATION_HOURS = 24;

/** One table's rule: rows whose `column` is older than `days` (ISO times; "now" for expiry columns) are deleted. */
export type RetentionRule = { table: string; column: string; key: string; days: number; why: string };

/**
 * What is kept how long. `days: 0` means "once it has expired" (the column holds an expiry time, compared with now).
 * The same list is written out in docs/SCALE.md ("How long Sidekick keeps things").
 */
export const RETENTION: RetentionRule[] = [
  { table: "usage_events", column: "created_at", key: "id", days: 400, why: "AI usage per call: 13 months, for monthly bills and a year-on-year view." },
  { table: "audit_log", column: "created_at", key: "id", days: 400, why: "Who did what: 13 months, for security reviews and audits." },
  { table: "guard_events", column: "created_at", key: "id", days: 180, why: "Guardrail counts (no text): 6 months of trends." },
  { table: "app_errors", column: "created_at", key: "id", days: 90, why: "Server errors with reference codes: 90 days for support." },
  { table: "findings", column: "resolved_at", key: "id", days: 90, why: "Watcher findings that were resolved: 90 days (open ones stay)." },
  { table: "rate_events", column: "created_at", key: "id", days: 1, why: "Rate-limit hits: only the last hours matter." },
  { table: "login_failures", column: "created_at", key: "id", days: 1, why: "Failed sign-ins: one day, for the sign-in limit." },
  { table: "signup_attempts", column: "created_at", key: "id", days: 1, why: "Sign-up attempts: one day, for the sign-up limit." },
  { table: "sessions", column: "expires_at", key: "token_hash", days: 0, why: "Signed-in sessions: deleted once expired." },
  { table: "oidc_states", column: "expires_at", key: "state", days: 0, why: "Microsoft sign-ins in progress: deleted once expired." },
  { table: "connector_states", column: "expires_at", key: "state", days: 0, why: "Connector sign-ins in progress: deleted once expired." },
  { table: "mfa_challenges", column: "expires_at", key: "token_hash", days: 0, why: "Two-step sign-in challenges: deleted once expired." },
];

/** What one clean-up run deleted, per table (traces and their steps counted separately). */
export type RetentionReport = Record<string, number>;

/**
 * Deletes rows older than their retention (see `RETENTION`, plus traces after `TRACE_RETENTION_DAYS` and expired
 * assistant conversations), in batches, until done or `budgetMs` ran out. Safe to run on several app copies at once
 * (deleting a row twice is a no-op). Returns the counts.
 */
export async function pruneOldData(at = new Date(), opts: { batch?: number; budgetMs?: number } = {}): Promise<RetentionReport> {
  const batch = opts.batch ?? 2000;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const report: RetentionReport = {};
  const left = () => Date.now() < deadline;

  // Traces first (the biggest): the steps of a batch of old traces, then the traces themselves.
  await span("job", "Clear old traces", async () => {
    const cutoff = new Date(at.getTime() - TRACE_RETENTION_DAYS * DAY).toISOString();
    let traces = 0;
    let spans = 0;
    while (left()) {
      const ids = (await all<{ id: string }>("SELECT id FROM traces WHERE started_at < ? LIMIT ?", cutoff, Math.max(1, Math.floor(batch / 5)))).map((r) => r.id);
      if (!ids.length) break;
      const marks = ids.map(() => "?").join(",");
      spans += (await run(`DELETE FROM trace_spans WHERE trace_id IN (${marks})`, ...ids)).changes;
      traces += (await run(`DELETE FROM traces WHERE id IN (${marks})`, ...ids)).changes;
    }
    report.traces = traces;
    report.trace_spans = spans;
    spanAttrs({ deleted: traces, steps_deleted: spans });
  });

  for (const rule of RETENTION) {
    if (!left()) break;
    report[rule.table] = await span("job", `Clear old ${rule.table}`, async () => {
      const cutoff = rule.days ? new Date(at.getTime() - rule.days * DAY).toISOString() : at.toISOString();
      let n = 0;
      while (left()) {
        const { changes } = await run(
          `DELETE FROM ${rule.table} WHERE ${rule.key} IN (SELECT ${rule.key} FROM ${rule.table} WHERE ${rule.column} < ? LIMIT ?)`,
          cutoff, batch,
        );
        n += changes;
        if (changes < batch) break;
      }
      spanAttrs({ deleted: n });
      return n;
    });
  }

  // Assistant conversations are forgotten 24 hours after their last turn (lib/conversations.ts EXPIRE_HOURS; the
  // same rule, kept here as plain SQL so this file stays free of the sign-in code that module pulls in).
  if (left()) {
    report.conversations = await span("job", "Clear expired conversations", async () => {
      const cutoff = new Date(at.getTime() - CONVERSATION_HOURS * 3600_000).toISOString();
      let n = 0;
      while (left()) {
        const ids = (await all<{ id: string }>("SELECT id FROM conversations WHERE last_at <= ? LIMIT ?", cutoff, batch)).map((r) => r.id);
        if (!ids.length) break;
        const marks = ids.map(() => "?").join(",");
        await run(`DELETE FROM conversation_turns WHERE conversation_id IN (${marks})`, ...ids);
        n += (await run(`DELETE FROM conversations WHERE id IN (${marks})`, ...ids)).changes;
      }
      spanAttrs({ deleted: n });
      return n;
    });
  }
  return report;
}
