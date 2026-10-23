/**
 * /api/owner/queue: the job queue's health for the Owner Console (lib/jobs.ts `queueHealth`).
 * - GET: backlog, running, stuck, failures and done in the last day, dead letters, the oldest wait, counts per kind and
 *   per company, the latest dead jobs (kind, company, attempts, error reason) and open watcher findings per kind.
 *   Never payloads or client content.
 * - POST `{ action: "retry" | "cancel", id }`: put a dead job back in the queue with fresh attempts, or cancel a
 *   queued/dead one. POST `{ action: "sweep" }`: enqueue every recurring job now (the next heartbeat runs them).
 *   Logged in the operator log.
 * Who: platform operators only.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { platformLog, requireOwner } from "@/lib/owner";
import { cancelJob, enqueueRecurring, queueHealth, retryJob } from "@/lib/jobs";
import { findingCounts } from "@/lib/watchers";
import "@/lib/job-kinds";

export const GET = handle(async () => {
  await requireOwner();
  return { ...(await queueHealth()), findings: await findingCounts() };
});

export const POST = handle(async (req: Request) => {
  const owner = await requireOwner();
  const body = await readJson<{ action?: unknown; id?: unknown }>(req);
  if (body.action === "sweep") {
    const added = await enqueueRecurring(new Date(), { force: true });
    await platformLog(owner.name, `Asked the job queue to run every recurring job now (${added} queued)`);
    return { ok: true, queued: added };
  }
  if (typeof body.id !== "string" || !body.id) throw new HttpError(400, "Which job?");
  if (body.action === "retry") {
    if (!(await retryJob(body.id))) throw new HttpError(409, "Only dead or canceled jobs can be retried.");
    await platformLog(owner.name, `Retried dead job ${body.id}`);
    return { ok: true };
  }
  if (body.action === "cancel") {
    if (!(await cancelJob(body.id))) throw new HttpError(409, "Only queued or dead jobs can be canceled.");
    await platformLog(owner.name, `Canceled job ${body.id}`);
    return { ok: true };
  }
  throw new HttpError(400, "Unknown action.");
});
