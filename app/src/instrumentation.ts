/**
 * @file Runs once when the server starts (Next.js instrumentation hook): starts the job queue's heartbeat.
 *
 * Every 30 seconds the heartbeat calls POST /api/jobs/tick on this same server with a random token made here, so
 * the work runs inside the normal app (same database, tracing and error handling) and nobody else can trigger it.
 * The tick enqueues recurring jobs that are due and runs queued jobs (lib/jobs.ts, lib/job-kinds.ts). The next
 * beat is scheduled only after the previous one answered, so slow work never piles up. The first beat is 20
 * seconds after start.
 *
 * Several copies of the app: every copy beats, and the queue's leases make sure each job runs once. With
 * scale-to-zero (no copy running), use a scheduled Azure Container Apps job that calls the same route with
 * SIDEKICK_TICK_SECRET instead, and set SIDEKICK_SCHEDULER=off (docs/HOSTING.md).
 *
 * Off when SIDEKICK_SCHEDULER=off (the automated tests do this and call the route themselves) and during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.SIDEKICK_SCHEDULER === "off" || process.env.NEXT_PHASE === "phase-production-build") return;
  const g = globalThis as { __sidekickScheduler?: boolean };
  if (g.__sidekickScheduler) return; // already running (dev hot reload)
  g.__sidekickScheduler = true;
  const { randomBytes } = await import("node:crypto");
  process.env.__SIDEKICK_TICK_TOKEN ??= randomBytes(24).toString("hex");
  const every = Number(process.env.SIDEKICK_TICK_MS || 30_000);
  const beat = async () => {
    try {
      const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/jobs/tick`, { method: "POST", headers: { "x-sidekick-tick": process.env.__SIDEKICK_TICK_TOKEN! } });
      if (!res.ok) console.error(`Job heartbeat: the tick answered ${res.status}`);
    } catch (e) {
      console.error("Job heartbeat: couldn't reach the app", e);
    }
    setTimeout(beat, every).unref?.();
  };
  setTimeout(beat, 20_000).unref?.();
}
