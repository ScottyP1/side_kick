/**
 * POST /api/reminders/tick: the old name of the job queue's heartbeat, kept so an external scheduler set up before
 * the queue (docs/HOSTING.md) keeps working. Does exactly what POST /api/jobs/tick does (lib/job-kinds.ts
 * `heartbeat`): runs the due background jobs, reminders included, and answers their counts (`posted`, `leftChats`,
 * `deleted`, `opened`, `resolved`, `ran`, `failed`).
 *
 * Who: the app's own timer token or SIDEKICK_TICK_SECRET; everyone else gets 404.
 */
import { handle } from "@/lib/api";
import { heartbeat } from "@/lib/job-kinds";

export const POST = handle(heartbeat);
