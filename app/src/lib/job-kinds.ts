/**
 * @file Every kind of background job Sidekick runs, registered with the job queue (lib/jobs.ts). Importing this
 * file registers them; the heartbeat (`heartbeat`, used by POST /api/jobs/tick) imports it before running the queue.
 *
 * Recurring (system sweeps, one job per time slot whatever the number of app copies):
 * - `reminders.daily` (5 min): posts each Teams chat's daily reminder when it's due and sends/collects the AI batch
 *   (lib/reminders.ts `runDueReminders`). Counts: `posted`.
 * - `teams.leave` (5 min): leaves chats nobody assigned within 7 days, retries refused removals
 *   (lib/teams/install.ts `leaveStaleChats`). Counts: `leftChats`.
 * - `rolloffs.run` (5 min): deletes groups and organizations whose roll-off date passed (lib/rolloff.ts). Counts: `deleted`.
 * - `watch.all` (15 min): enqueues one `watch.org` job per active organization (key `watch:<org>:<slot>`; a forced
 *   sweep enqueues fresh ones).
 * - `jobs.prune` (6 h): clears finished jobs (7 days), dead ones (30 days) and old failed-post records (30 days).
 *
 * Per organization:
 * - `watch.org` (payload `{}`; the job's org): runs every watcher for that organization (lib/watchers.ts). Counts:
 *   `opened`, `resolved`, `open`. Traced under the organization, so it shows on its Activity page.
 *
 * Adding one (e.g. item 4's meeting transcripts from Microsoft Graph): `defineJob("meetings.fetch", { label, run })`
 * here, then `enqueue("meetings.fetch", { orgId, payload: { meetingId }, key: \`meeting:${id}\` })` where it starts.
 * Keep payloads to ids, make `run` safe to repeat, and return a few counts.
 */
import "server-only";
import crypto from "node:crypto";
import { all, run } from "./db";
import { defineJob, enqueue, pruneJobs, runWorker, type WorkerReport } from "./jobs";
import { runDueReminders } from "./reminders";
import { leaveStaleChats } from "./teams/install";
import { runDueRolloffs } from "./rolloff";
import { runWatchers } from "./watchers";
import { dueConnectorLinks, syncDueLink } from "./connectors";
import { HttpError } from "./auth";

const MIN = 60_000;
/** How often the watchers run for each organization. */
export const WATCH_EVERY_MS = 15 * MIN;

defineJob("reminders.daily", { label: "Post due reminders", everyMs: 5 * MIN, maxAttempts: 3, run: async () => ({ posted: await runDueReminders() }) });
defineJob("teams.leave", { label: "Leave unassigned Teams chats", everyMs: 5 * MIN, maxAttempts: 3, run: async () => ({ leftChats: await leaveStaleChats() }) });
defineJob("rolloffs.run", { label: "Delete ended groups and organizations", everyMs: 5 * MIN, maxAttempts: 3, leaseMs: 30 * MIN, run: async () => ({ deleted: await runDueRolloffs() }) });
// Connectors (lib/connectors.ts): every 5 minutes, one sync job per linked project that is due (each project syncs
// every 15 minutes). A tool problem is recorded in the project's health, not retried here.
defineJob("connectors.schedule", {
  label: "Schedule Azure DevOps / Jira syncs",
  everyMs: 5 * MIN,
  maxAttempts: 3,
  run: async () => {
    let queued = 0;
    for (const l of await dueConnectorLinks()) {
      if ((await enqueue("connector.sync", { orgId: l.org_id, workspaceId: l.workspace_id, payload: { link: l.id }, key: `connector:${l.id}:${Math.floor(Date.now() / (5 * MIN))}` })).created) queued++;
    }
    return { syncQueued: queued };
  },
});
defineJob("connector.sync", {
  label: "Sync a linked Azure DevOps / Jira project",
  maxAttempts: 1,
  run: async ({ job, payload }) => (job.org_id && typeof payload.link === "string" ? syncDueLink(job.org_id, payload.link) : undefined),
});
defineJob("jobs.prune", {
  label: "Clear out old jobs",
  everyMs: 6 * 60 * MIN,
  run: async () => {
    const failures = await run("DELETE FROM teams_post_failures WHERE created_at < ?", new Date(Date.now() - 30 * 86400_000).toISOString());
    return { pruned: (await pruneJobs()) + failures.changes };
  },
});
defineJob("watch.all", {
  label: "Schedule the watchers",
  everyMs: WATCH_EVERY_MS,
  run: async ({ job, payload }) => {
    // One run per organization per slot; a forced sweep ("Run all now") runs them all again now.
    const slot = payload.sweep ? `sweep:${job.id}` : String(Math.floor(Date.now() / WATCH_EVERY_MS));
    const orgs = await all<{ id: string }>("SELECT id FROM orgs WHERE status <> 'Suspended'");
    let queued = 0;
    for (const o of orgs) if ((await enqueue("watch.org", { orgId: o.id, key: `watch:${o.id}:${slot}` })).created) queued++;
    return { watchQueued: queued };
  },
});
defineJob("watch.org", {
  label: "Run the watchers",
  maxAttempts: 3,
  run: async ({ job }) => {
    if (!job.org_id) return;
    const r = await runWatchers(job.org_id);
    return { opened: r.opened, resolved: r.resolved, open: r.open };
  },
});

/**
 * Asks for a watcher run for one organization soon (the next heartbeat, within 30 seconds), e.g. after an admin
 * pressed "Check again". At most one waiting request per organization per minute.
 */
export async function requestWatch(orgId: string) {
  return enqueue("watch.org", { orgId, key: `watch:${orgId}:now:${Math.floor(Date.now() / MIN)}` });
}

/** Compares two secrets without leaking their length or content through timing. */
const same = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

/**
 * The heartbeat behind POST /api/jobs/tick (and the older /api/reminders/tick): checks the caller's secret, then runs
 * the job queue (`runWorker`). Body `{ "sweep": true }` runs every recurring job now instead of waiting for its slot
 * (tests, an operator's "run now"); `"kinds": ["watch.all", "watch.org"]` limits a beat to those kinds (the demo seed
 * runs only the watchers). Answers the counts the jobs reported (`posted`, `leftChats`, `deleted`,
 * `opened`, `resolved`… each 0 when nothing happened) plus `ran` and `failed`.
 *
 * Who: the app's own timer (src/instrumentation.ts) with the random token it made at start, or anything holding
 * SIDEKICK_TICK_SECRET (an external scheduler, see docs/HOSTING.md). Anyone else gets 404.
 */
export async function heartbeat(req: Request) {
  const sent = req.headers.get("x-sidekick-tick") ?? "";
  const allowed = [process.env.__SIDEKICK_TICK_TOKEN, process.env.SIDEKICK_TICK_SECRET].filter((t): t is string => !!t && t.length >= 24);
  if (!sent || !allowed.some((t) => same(sent, t))) throw new HttpError(404, "Not found.");
  const body = (await req.json().catch(() => ({}))) as { sweep?: unknown; kinds?: unknown };
  const only = Array.isArray(body?.kinds) ? body.kinds.filter((k): k is string => typeof k === "string").slice(0, 20) : undefined;
  const r: WorkerReport = await runWorker({ sweep: body?.sweep === true, kinds: only?.length ? only : undefined });
  return { posted: 0, leftChats: 0, deleted: 0, opened: 0, resolved: 0, ...r.counts, ran: r.ran, failed: r.failed };
}
