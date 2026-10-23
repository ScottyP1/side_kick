/**
 * POST /api/jobs/tick: the job queue's heartbeat (lib/job-kinds.ts `heartbeat`). Enqueues the recurring jobs whose
 * time has come (reminders, leaving unassigned Teams chats, roll-off deletions, the watchers, clean-up), then runs
 * due jobs (lib/jobs.ts `runWorker`), each exactly once even when several app copies tick at the same time.
 * Body `{ "sweep": true }` runs every recurring job now; `"kinds": [...]` limits the beat to those job kinds.
 *
 * Who: only the app's own timer (src/instrumentation.ts, every 30 seconds) with a random token made at start, or,
 * if SIDEKICK_TICK_SECRET is set, anything that sends that secret (an external scheduler, see docs/HOSTING.md).
 * Everyone else gets 404, so the route doesn't reveal itself.
 */
import { handle } from "@/lib/api";
import { heartbeat } from "@/lib/job-kinds";

export const POST = handle(heartbeat);
