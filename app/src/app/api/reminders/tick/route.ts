/**
 * POST /api/reminders/tick: the reminder scheduler's heartbeat. Posts every daily reminder that is due
 * (lib/reminders.ts → runDueReminders) and clears expired chat messages, then leaves Teams chats nobody assigned
 * within 7 days and retries removals Microsoft refused earlier (lib/teams/install.ts → leaveStaleChats).
 *
 * Who: only the app's own timer (src/instrumentation.ts), which sends a random token made when the server
 * started; or, if SIDEKICK_TICK_SECRET is set, anything that sends that secret (e.g. a scheduled Azure
 * Container Apps job, see docs/HOSTING.md). Everyone else gets 404, so the route doesn't reveal itself.
 */
import crypto from "node:crypto";
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { runDueReminders } from "@/lib/reminders";
import { leaveStaleChats } from "@/lib/teams/install";

/** Compares two secrets without leaking their length or content through timing. */
const same = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

export const POST = handle(async (req: Request) => {
  const sent = req.headers.get("x-sidekick-tick") ?? "";
  const allowed = [process.env.__SIDEKICK_TICK_TOKEN, process.env.SIDEKICK_TICK_SECRET].filter((t): t is string => !!t && t.length >= 24);
  if (!sent || !allowed.some((t) => same(sent, t))) throw new HttpError(404, "Not found.");
  return { posted: await runDueReminders(), leftChats: await leaveStaleChats() };
});
