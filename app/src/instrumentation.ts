/**
 * @file Runs once when the server starts (Next.js instrumentation hook): starts the in-app reminder timer.
 *
 * Every 5 minutes the timer calls POST /api/reminders/tick on this same server with a random token made
 * here, so the work runs inside the normal app (same database, tracing and error handling) and nobody
 * else can trigger it. The first tick is one minute after start.
 *
 * Why an in-app timer: the Azure app runs exactly one always-on copy (docs/HOSTING.md), so this is the
 * simplest thing that works. Each reminder is claimed with a unique database row first, so even two
 * copies would never post twice. With more copies, or scale-to-zero, switch to a scheduled Azure
 * Container Apps job that calls the same route with SIDEKICK_TICK_SECRET, and set SIDEKICK_SCHEDULER=off.
 *
 * Off when SIDEKICK_SCHEDULER=off (the automated tests do this) and during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.SIDEKICK_SCHEDULER === "off" || process.env.NEXT_PHASE === "phase-production-build") return;
  const g = globalThis as { __sidekickScheduler?: ReturnType<typeof setInterval> };
  if (g.__sidekickScheduler) return; // already running (dev hot reload)
  const { randomBytes } = await import("node:crypto");
  process.env.__SIDEKICK_TICK_TOKEN ??= randomBytes(24).toString("hex");
  const tick = async () => {
    try {
      const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/reminders/tick`, { method: "POST", headers: { "x-sidekick-tick": process.env.__SIDEKICK_TICK_TOKEN! } });
      if (!res.ok) console.error(`Reminder timer: the tick answered ${res.status}`);
    } catch (e) {
      console.error("Reminder timer: couldn't reach the app", e);
    }
  };
  setTimeout(tick, 60_000).unref?.();
  g.__sidekickScheduler = setInterval(tick, 5 * 60_000);
  g.__sidekickScheduler.unref?.();
}
