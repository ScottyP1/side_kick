/**
 * GET /api/live/bot/commands?wait=<seconds>: Sidekick's own meeting bot (the shim in its Container Apps job, meetbot/)
 * fetches what to do next: post in the chat, speak (an MP3), raise or lower its hand, switch how it hears, leave
 * (lib/live-meetings/attendee.ts `queueCommand`). A long poll: it waits up to `wait` seconds (at most 20) for a command,
 * then answers `{ commands: [...] }` (each `{ id, kind, data }`, oldest first, each given once) and `stop: true` once
 * the session is over (the container then exits).
 *
 * Who: only the bot of that session. Headers `x-sidekick-bot-session` and `Authorization: Bearer <the session's key>`
 * (an HMAC of the session id, lib/live-meetings/launcher.ts `botKey`); anything else is 401 and says nothing.
 */
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { takeCommands } from "@/lib/live-meetings/sessions";
import { spanAttrs } from "@/lib/trace";

export const GET = handle(async (req: Request) => {
  const session = req.headers.get("x-sidekick-bot-session") ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const wait = Math.min(20, Math.max(0, Number(new URL(req.url).searchParams.get("wait")) || 0));
  const out = await takeCommands(session, token, wait * 1000);
  if (!out) throw new HttpError(401, "Not allowed.");
  spanAttrs({ commands: out.commands.length });
  return out;
}, { system: "Live meeting bot commands" });
