/**
 * @file The job queue: background work kept in the database (`jobs` table), so it survives restarts, runs once
 * even with several copies of the app, retries on failure and shows up on the Activity page.
 *
 * Concepts
 * - **Job**: one piece of background work, e.g. "run the watchers for Northwind" or "post the reminders that are
 *   due". It has a **kind** (what to run; each kind is registered once with `defineJob`, see lib/job-kinds.ts), a
 *   small JSON **payload** (ids only, never document text), and the org/workspace it belongs to (none for a
 *   system sweep).
 * - **Lease**: a worker claims a job by writing its own id (`locked_by`) and a deadline (`locked_until`). While the
 *   lease holds, no other worker can take the job. If the worker stops (crash, deploy), the lease runs out and the
 *   next worker takes the job over (counted as an attempt). Finishing checks the lease is still ours, so a worker
 *   that lost its lease can't overwrite the new owner's result.
 * - **Exactly once**: claiming is a single compare-and-set `UPDATE … WHERE id = ? AND <still claimable>`; only one
 *   worker's update changes the row. On Postgres the candidates are first picked with `FOR UPDATE SKIP LOCKED`
 *   so workers don't queue up behind each other's rows; on SQLite (one writer at a time) each claim is one
 *   statement. A job therefore runs once per attempt; if a worker dies mid-job the job runs again after its lease,
 *   so handlers must be safe to repeat (they claim their own work with unique rows, like reminders do).
 * - **Retries with backoff**: a failed attempt goes back to `queued` with `run_at` pushed out (30 s, 1 min, 2 min…
 *   up to an hour, with jitter), or later if the error says how long to wait (`retryAfterMs`, e.g. a 429 from
 *   Microsoft Graph with Retry-After). After `max_attempts` the job is **dead** (the dead-letter list in the Owner
 *   Console, where it can be retried or canceled).
 * - **Idempotency key**: enqueueing with a key that's already in the table keeps the existing job, so the same
 *   work can be requested twice (two app copies, a double click) and still runs once.
 * - **Recurring jobs**: a kind with `everyMs` is enqueued once per time slot by `enqueueRecurring`, with the key
 *   `every:<kind>:<slot>`, so every app copy can try and only one job per slot exists.
 * - **Heartbeat**: `runWorker` is called by the in-app timer (src/instrumentation.ts → POST /api/jobs/tick every
 *   30 s) or by an external scheduler. It enqueues due recurring jobs, then claims and runs due jobs until it runs
 *   out of jobs or time, several at once (`SIDEKICK_JOB_CONCURRENCY` lanes, default 4), so one slow job (a watcher
 *   run waiting on Claude) doesn't hold up the rest.
 * - **Fairness between companies** (docs/SCALE.md): a worker looks only at the oldest one or two due jobs of each
 *   organization, and skips organizations that already have `SIDEKICK_JOB_ORG_CONCURRENCY` jobs running (default 2).
 *   So a company with a thousand queued jobs gets its turn like everyone else instead of filling every lane. The
 *   cap is checked when claiming, so with several app copies it can be passed briefly by a job or two (soft cap).
 *   System sweeps (no organization) are not capped.
 * - **Tracing**: every job run is its own trace (channel "system", kind "job") under the job's organization, so it
 *   shows on that organization's Activity page and the home orb. System sweeps without an org aren't saved as
 *   traces (Activity is per organization); their per-org work opens its own traces.
 *
 * Adding a kind of work (e.g. meetings from Microsoft Graph): `defineJob("meetings.fetch", { label, run })` in
 * lib/job-kinds.ts, then `enqueue("meetings.fetch", { orgId, payload, key })` wherever it should start.
 */
import "server-only";
import crypto from "node:crypto";
import os from "node:os";
import { all, asSystem, DIALECT, get, newId, now, run, tx, withOrg } from "./db";
import { failureReason, withTrace } from "./trace";

/** A job as stored. */
export type Job = {
  id: string;
  kind: string;
  org_id: string | null;
  workspace_id: string | null;
  payload: string;
  idempotency_key: string | null;
  status: JobStatus;
  run_at: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
  result: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};
export type JobStatus = "queued" | "running" | "done" | "dead" | "canceled";

/** What a kind's handler gets: the parsed payload, plus the job row (org, attempt number). */
export type JobContext = { job: Job; payload: Record<string, unknown> };
/** A handler's result: a few counts, stored on the job and summed by the heartbeat (e.g. `{ posted: 2 }`). */
export type JobResult = Record<string, number> | void;

/** How a kind of job runs. */
export type JobKind = {
  /** Plain name for the trace and the Owner Console, e.g. "Run the watchers". */
  label: string;
  /** The work. Throw to fail the attempt (it's retried). Must be safe to run again after a crash. */
  run: (ctx: JobContext) => Promise<JobResult>;
  /** Attempts before the job is dead (default 5). */
  maxAttempts?: number;
  /** Lease length: how long a run may take before another worker assumes it died (default 5 minutes). */
  leaseMs?: number;
  /** Recurring: enqueued once per slot of this length by `enqueueRecurring` (system job, no org). */
  everyMs?: number;
};

declare global {
  var __sidekickJobKinds: Map<string, JobKind> | undefined;
}
// Shared across module reloads in development, like the trace store.
const kinds = (globalThis.__sidekickJobKinds ??= new Map<string, JobKind>());

/** Registers a kind of job (once per kind; registering again replaces it, which keeps dev reloads working). */
export function defineJob(kind: string, def: JobKind) {
  kinds.set(kind, def);
}

/** The registered kinds (for the Owner Console's labels). */
export function jobKinds(): ReadonlyMap<string, JobKind> {
  return kinds;
}

/** This app copy's worker id: host + process + a random part, so two copies never share one. */
const WORKER_ID = `${os.hostname().slice(0, 40)}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_ATTEMPTS = 5;
/** Jobs one heartbeat runs at the same time (SIDEKICK_JOB_CONCURRENCY, default 4, 1–32). */
export const JOB_CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.SIDEKICK_JOB_CONCURRENCY || 4)));
/** Jobs of one organization that may run at the same time (SIDEKICK_JOB_ORG_CONCURRENCY, default 2). */
export const JOB_ORG_CONCURRENCY = Math.max(1, Number(process.env.SIDEKICK_JOB_ORG_CONCURRENCY || 2));
/** How many of each organization's oldest due jobs a claim looks at (the round-robin window). */
const PER_ORG_CANDIDATES = 2;

/**
 * The wait before attempt `attempts + 1` after a failure: 30 s doubled each time, at most an hour, plus up to
 * 20% random jitter so many failing jobs don't all come back at the same moment.
 */
export function backoffMs(attempts: number, random = Math.random()): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3600_000);
  return Math.round(base * (1 + 0.2 * random));
}

/**
 * Adds a job to the queue. With `key` (idempotency key), a job with the same key that's already there is kept
 * instead and its id returned (`created: false`). `runAt` delays it. Never put document text in `payload`.
 * A job for an organization is only added while that organization exists: a fan-out that read the list of
 * organizations just before one was deleted (`watch.all`, the meetings sweeps) can't leave work behind for it
 * (lib/rolloff.ts deletes the organization's jobs). On Postgres the check waits for a deletion in progress (the
 * deletion holds the organization's row), so it sees the outcome. Such a job returns `created: false`.
 */
export async function enqueue(
  kind: string,
  opts: { orgId?: string | null; workspaceId?: string | null; payload?: Record<string, unknown>; key?: string | null; runAt?: Date; maxAttempts?: number } = {},
): Promise<{ id: string; created: boolean }> {
  if (!kinds.has(kind)) throw new Error(`Unknown job kind ${kind}`);
  // The queue is shared by every org (idempotency keys, jobs with no org): system work, lib/db.ts asSystem. A job
  // for an org still runs as that org (`runClaimed`).
  return asSystem("job queue", () => insertJob(kind, opts));
}

/** `enqueue`'s insert, inside the job queue's system scope. */
async function insertJob(kind: string, opts: Parameters<typeof enqueue>[1] & object): Promise<{ id: string; created: boolean }> {
  const id = newId();
  const t = now();
  const values = [
    id, kind, opts.orgId ?? null, opts.workspaceId ?? null, JSON.stringify(opts.payload ?? {}), opts.key ?? null,
    (opts.runAt ?? new Date()).toISOString(), opts.maxAttempts ?? kinds.get(kind)!.maxAttempts ?? DEFAULT_ATTEMPTS, t, t,
  ];
  const columns = "INSERT INTO jobs (id, kind, org_id, workspace_id, payload, idempotency_key, status, run_at, attempts, max_attempts, created_at, updated_at)";
  const res = opts.orgId
    ? await run(
      `${columns}
       SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, 0, CAST(? AS INTEGER), ?, ?
        WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?${DIALECT === "postgres" ? " FOR KEY SHARE" : ""})
       ON CONFLICT (idempotency_key) DO NOTHING`,
      ...values, opts.orgId,
    )
    : await run(`${columns} VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`, ...values);
  if (res.changes) return { id, created: true };
  const existing = await get<{ id: string }>("SELECT id FROM jobs WHERE idempotency_key = ?", opts.key ?? "");
  return { id: existing?.id ?? id, created: false };
}

/**
 * Enqueues each recurring kind for the current slot (`every:<kind>:<slot number>`), so it runs once per slot
 * however many app copies call this. With `force`, every recurring kind is enqueued now under a one-off key
 * (the tick route's `sweep`, used by tests and the Owner Console's "Run all now"), with payload `{ sweep: true }`.
 * `kinds` limits it to those kinds.
 */
export async function enqueueRecurring(at = new Date(), opts: { force?: boolean; kinds?: string[] } = {}): Promise<number> {
  let added = 0;
  for (const [kind, def] of kinds) {
    if (!def.everyMs || (opts.kinds && !opts.kinds.includes(kind))) continue;
    const key = opts.force ? `now:${kind}:${newId()}` : `every:${kind}:${Math.floor(at.getTime() / def.everyMs)}`;
    // A forced run says so in its payload, so a kind that fans out (watch.all) can skip its own per-slot keys.
    if ((await enqueue(kind, { key, runAt: at, payload: opts.force ? { sweep: true } : {} })).created) added++;
  }
  return added;
}

/** Postgres: one transaction (so FOR UPDATE SKIP LOCKED holds the candidates); SQLite: just runs `fn`. */
const inClaimTx = <T>(fn: () => Promise<T>): Promise<T> => (DIALECT === "postgres" ? tx(fn) : fn());

/** The SQL condition for a job a worker may take at time `?` (twice): due and queued, or running with a lapsed lease. */
const CLAIMABLE = "((status = 'queued' AND run_at <= ?) OR (status = 'running' AND locked_until < ?))";

/**
 * Claims the next due job for `workerId`, or returns null. Fair between organizations: the candidates are each
 * organization's oldest `PER_ORG_CANDIDATES` due jobs (system jobs count as one more "organization"), minus
 * organizations already running `orgCap` jobs, oldest `run_at` first. A running job whose lease ran out is taken
 * over; if it had no attempts left it's marked dead instead. The claim is one compare-and-set update, so two workers
 * can never both get the same job.
 */
export async function claimNext(workerId = WORKER_ID, at = new Date(), opts: { kinds?: string[]; orgCap?: number } = {}): Promise<Job | null> {
  const t = at.toISOString();
  const kindFilter = opts.kinds?.length ? `AND kind IN (${opts.kinds.map(() => "?").join(", ")})` : "";
  const orgCap = opts.orgCap ?? JOB_ORG_CONCURRENCY;
  for (let round = 0; round < 5; round++) {
    // Postgres: lock a few candidates and skip rows another worker is looking at, all in one short transaction.
    // SQLite: one writer at a time, so a plain read followed by the compare-and-set below is enough.
    const claimed = await inClaimTx<Job | null | "retry">(async () => {
      // Window functions work on both engines; FOR UPDATE applies to the outer rows only (Postgres allows that).
      const candidates = await all<Job>(
        `SELECT * FROM jobs WHERE id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(org_id, '') ORDER BY run_at, id) AS rn
                FROM jobs WHERE ${CLAIMABLE} ${kindFilter}
            ) per_org WHERE rn <= ${PER_ORG_CANDIDATES}
          )
          AND (org_id IS NULL OR org_id NOT IN (
            SELECT org_id FROM jobs WHERE status = 'running' AND locked_until >= ? AND org_id IS NOT NULL GROUP BY org_id HAVING COUNT(*) >= ?
          ))
          ORDER BY run_at LIMIT 5${DIALECT === "postgres" ? " FOR UPDATE SKIP LOCKED" : ""}`,
        t, t, ...(opts.kinds ?? []), t, orgCap,
      );
      if (!candidates.length) return null;
      for (const c of candidates) {
        const lease = new Date(at.getTime() + (kinds.get(c.kind)?.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
        if (c.status === "running" && c.attempts >= c.max_attempts) {
          await run(
            `UPDATE jobs SET status = 'dead', locked_by = NULL, locked_until = NULL, finished_at = ?, updated_at = ?, last_error = ? WHERE id = ? AND ${CLAIMABLE}`,
            t, t, "Stopped before finishing (its worker went away) and has no attempts left.", c.id, t, t,
          );
          continue;
        }
        const res = await run(
          `UPDATE jobs SET status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1, started_at = ?, updated_at = ?
            WHERE id = ? AND ${CLAIMABLE}`,
          workerId, lease, t, t, c.id, t, t,
        );
        if (res.changes === 1) return (await get<Job>("SELECT * FROM jobs WHERE id = ?", c.id)) ?? null;
      }
      return "retry";
    });
    if (claimed !== "retry") return claimed;
  }
  return null;
}

/**
 * Marks a claimed job done with its result. Returns false (and changes nothing) if `workerId` no longer holds
 * the lease, e.g. it ran out and another worker took the job over.
 */
export async function completeJob(job: Pick<Job, "id">, workerId: string, result: JobResult): Promise<boolean> {
  const t = now();
  const res = await run(
    "UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL, result = ?, last_error = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND locked_by = ?",
    result ? JSON.stringify(result) : null, t, t, job.id, workerId,
  );
  return res.changes === 1;
}

/**
 * Records a failed attempt: back to the queue after `backoffMs`, or dead when it has used every attempt or the
 * error says trying again can't help (`permanent: true`, e.g. Microsoft Graph refusing a request as invalid).
 * `error` is stored as a short, data-free reason (`failureReason`). Returns the new status, or null if the lease
 * was no longer ours.
 */
export async function failJob(job: Pick<Job, "id" | "attempts" | "max_attempts">, workerId: string, error: unknown, at = new Date()): Promise<"queued" | "dead" | null> {
  const t = at.toISOString();
  const dead = job.attempts >= job.max_attempts || (error as { permanent?: unknown } | null)?.permanent === true;
  const res = await run(
    `UPDATE jobs SET status = ?, run_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND locked_by = ?`,
    dead ? "dead" : "queued", dead ? t : new Date(at.getTime() + Math.max(backoffMs(job.attempts), retryAfterOf(error))).toISOString(), failureReason(error),
    dead ? t : null, t, job.id, workerId,
  );
  return res.changes === 1 ? (dead ? "dead" : "queued") : null;
}

/**
 * How long the failing service asked us to wait (`retryAfterMs` on the error, e.g. Microsoft Graph's 429
 * Retry-After), capped at an hour; 0 when it didn't say. A retry never comes back sooner than this.
 */
const retryAfterOf = (error: unknown): number => {
  const ms = Number((error as { retryAfterMs?: unknown } | null)?.retryAfterMs ?? 0);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3600_000) : 0;
};

/**
 * Runs one claimed job inside its own trace and records the outcome. Never throws: a failure is recorded on the
 * job (and in the trace) and retried later.
 */
export async function runClaimed(job: Job, workerId = WORKER_ID): Promise<{ ok: boolean; result: JobResult }> {
  const def = kinds.get(job.kind);
  const label = def?.label ?? job.kind;
  try {
    const result = await withTrace({ name: `Job: ${label}`, channel: "system", kind: "job", orgId: job.org_id, workspaceId: job.workspace_id, detached: true }, async () => {
      if (!def) throw new Error(`Unknown job kind ${job.kind}`);
      const work = () => def.run({ job, payload: JSON.parse(job.payload || "{}") as Record<string, unknown> });
      // A job for one organization only reaches that org's rows (row-level security, lib/db.ts); jobs for no
      // org (the watchers' fan-out, retention, roll-offs) stay system work.
      return job.org_id ? withOrg(job.org_id, work) : work();
    });
    await completeJob(job, workerId, result);
    return { ok: true, result };
  } catch (e) {
    console.error(`Job ${job.kind} (${job.id}) failed, attempt ${job.attempts} of ${job.max_attempts}`, e);
    await failJob(job, workerId, e).catch((err) => console.error("Couldn't record the job failure", err));
    return { ok: false, result: undefined };
  }
}

/** What one heartbeat did: jobs run and failed, and the handlers' counts added up by name. */
export type WorkerReport = { ran: number; failed: number; counts: Record<string, number> };

/**
 * The heartbeat: enqueues due recurring jobs (all of them now with `sweep`), then claims and runs due jobs in
 * `concurrency` lanes at once (default `JOB_CONCURRENCY`) until none are left, `maxJobs` were claimed or `maxMs`
 * passed (jobs already running then finish). Claims are fair between organizations (see `claimNext`). `kinds`
 * limits both to those kinds. Safe to call from every app copy at once.
 */
export async function runWorker(opts: { maxJobs?: number; maxMs?: number; sweep?: boolean; workerId?: string; kinds?: string[]; concurrency?: number } = {}): Promise<WorkerReport> {
  // The queue itself spans every org (claims, leases, recurring slots): system work. Each job then runs in its org.
  return asSystem("job queue", () => workerLoop(opts));
}

/** `runWorker`'s body, inside the job queue's system scope. */
async function workerLoop(opts: Parameters<typeof runWorker>[0] & object): Promise<WorkerReport> {
  const started = Date.now();
  const report: WorkerReport = { ran: 0, failed: 0, counts: {} };
  await enqueueRecurring(new Date(), { force: opts.sweep, kinds: opts.kinds });
  const maxJobs = opts.maxJobs ?? 200;
  const maxMs = opts.maxMs ?? 50_000;
  let claimed = 0;
  let working = 0; // lanes claiming or running a job right now
  // A lane that finds nothing waits while another lane is still claiming or running (that job may queue more, like
  // the watchers' fan-out, free its organization's turn, or simply hold the rows this lane skipped as locked), and
  // stops once nothing is due and no lane is working.
  const lane = async () => {
    while (claimed < maxJobs && Date.now() - started < maxMs) {
      claimed++;
      working++;
      const job = await claimNext(opts.workerId ?? WORKER_ID, new Date(), { kinds: opts.kinds }).catch((e) => {
        working--;
        throw e;
      });
      if (!job) {
        claimed--;
        working--;
        if (!working) break;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      try {
        const out = await runClaimed(job, opts.workerId ?? WORKER_ID);
        report.ran++;
        if (!out.ok) report.failed++;
        for (const [k, v] of Object.entries(out.result ?? {})) report.counts[k] = (report.counts[k] ?? 0) + v;
      } finally {
        working--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? JOB_CONCURRENCY) }, lane));
  return report;
}

/** Deletes finished jobs after 7 days and dead or canceled ones after 30. Returns how many went. */
export async function pruneJobs(at = new Date()): Promise<number> {
  const week = new Date(at.getTime() - 7 * 86400_000).toISOString();
  const month = new Date(at.getTime() - 30 * 86400_000).toISOString();
  const a = await run("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?", week);
  const b = await run("DELETE FROM jobs WHERE status IN ('dead', 'canceled') AND updated_at < ?", month);
  return a.changes + b.changes;
}

/** Puts a dead (or canceled) job back in the queue with fresh attempts (Owner Console). Returns false if it isn't dead. */
export async function retryJob(id: string): Promise<boolean> {
  const t = now();
  const res = await run(
    "UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, last_error = NULL, finished_at = NULL, updated_at = ? WHERE id = ? AND status IN ('dead', 'canceled')",
    t, t, id,
  );
  return res.changes === 1;
}

/** Cancels a queued or dead job (Owner Console). A running job can't be canceled: it finishes or its lease runs out. */
export async function cancelJob(id: string): Promise<boolean> {
  const t = now();
  const res = await run("UPDATE jobs SET status = 'canceled', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'dead')", t, t, id);
  return res.changes === 1;
}

/**
 * Queue health for the Owner Console: backlog (due now), waiting (later), running, stuck (lease ran out), failed
 * in the last day, dead letters, the oldest due job's wait, per kind and per company counts, and the latest dead
 * jobs (kind, company name, error reason: never payloads or client content).
 */
export async function queueHealth(at = new Date()) {
  const t = at.toISOString();
  const day = new Date(at.getTime() - 86400_000).toISOString();
  const n = async (sql: string, ...p: string[]) => (await get<{ n: number }>(sql, ...p))?.n ?? 0;
  const oldest = await get<{ run_at: string | null }>("SELECT MIN(run_at) AS run_at FROM jobs WHERE status = 'queued' AND run_at <= ?", t);
  const byKind = await all<{ kind: string; status: string; n: number }>("SELECT kind, status, COUNT(*) AS n FROM jobs GROUP BY kind, status ORDER BY kind");
  const byOrg = await all<{ org_id: string; name: string | null; backlog: number; running: number; failed: number; dead: number; done: number }>(
    `SELECT j.org_id, o.name,
            SUM(CASE WHEN j.status = 'queued' AND j.run_at <= ? THEN 1 ELSE 0 END) AS backlog,
            SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN j.last_error IS NOT NULL AND j.updated_at >= ? THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN j.status = 'dead' THEN 1 ELSE 0 END) AS dead,
            SUM(CASE WHEN j.status = 'done' AND j.updated_at >= ? THEN 1 ELSE 0 END) AS done
       FROM jobs j LEFT JOIN orgs o ON o.id = j.org_id
      WHERE j.org_id IS NOT NULL GROUP BY j.org_id, o.name ORDER BY o.name`,
    t, day, day,
  );
  const dead = await all<{ id: string; kind: string; org: string | null; attempts: number; last_error: string | null; updated_at: string }>(
    "SELECT j.id, j.kind, o.name AS org, j.attempts, j.last_error, j.updated_at FROM jobs j LEFT JOIN orgs o ON o.id = j.org_id WHERE j.status = 'dead' ORDER BY j.updated_at DESC LIMIT 50",
  );
  return {
    now: t,
    backlog: await n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND run_at <= ?", t),
    waiting: await n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND run_at > ?", t),
    running: await n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND locked_until >= ?", t),
    stuck: await n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND locked_until < ?", t),
    failedDay: await n("SELECT COUNT(*) AS n FROM jobs WHERE last_error IS NOT NULL AND updated_at >= ?", day),
    doneDay: await n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND updated_at >= ?", day),
    dead: await n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'dead'"),
    oldestWaitMs: oldest?.run_at ? Math.max(0, at.getTime() - Date.parse(oldest.run_at)) : 0,
    lastDone: (await get<{ t: string | null }>("SELECT MAX(finished_at) AS t FROM jobs WHERE status = 'done'"))?.t ?? null,
    kinds: byKind.map((r) => ({ ...r, label: kinds.get(r.kind)?.label ?? r.kind })),
    companies: byOrg.map((r) => ({ ...r, name: r.name ?? "(deleted organization)" })),
    deadJobs: dead.map((d) => ({ ...d, label: kinds.get(d.kind)?.label ?? d.kind })),
  };
}
