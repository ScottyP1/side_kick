/**
 * POST /api/live/events/:provider (`attendee` = Sidekick's own meeting bot, `recall` = Recall.ai): the live-meeting
 * provider's webhooks (lib/live-meetings/sessions.ts `handleLiveWebhook`):
 * transcript lines, meeting chat messages, participants joining, and the bot's status (in the lobby, admitted, meeting
 * ended, failed). Every request must carry that provider's signature over the raw body (Sidekick's own bot: the session's key over
 * timestamp and body, `x-sidekick-bot-*`, lib/live-meetings/signature.ts `verifyBotEvent`; Recall.ai: Standard Webhooks,
 * `SIDEKICK_LIVE_WEBHOOK_SECRET`) or it's refused with 401
 * before anything is read; only that provider's bots are looked up. The reply is 202 at once; answers
 * and chat posts run right after it (`after`), each in its session's organization.
 *
 * Who: the meeting-bot provider, without a session. Unknown bots are ignored; nothing about any
 * organization is ever returned. 404 when live meetings aren't set up on this copy.
 */
// Registers the job kinds this route enqueues (live.extract, live.handoff).
import "@/lib/job-kinds";
import { after } from "next/server";
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { handleLiveWebhook } from "@/lib/live-meetings/sessions";
import { spanAttrs } from "@/lib/trace";

/** Largest webhook body accepted (a transcript line or a status change is a few kilobytes). */
const MAX_BODY = 1_000_000;

type Ctx = { params: Promise<{ provider: string }> };

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, "Too large.");
  const { accepted, ignored, work } = await handleLiveWebhook((await params).provider, req.headers, raw);
  spanAttrs({ accepted, ignored, followUps: work.length });
  if (work.length) {
    after(async () => {
      for (const w of work) await w().catch((e) => console.error("Live meeting follow-up failed", e));
    });
  }
  return new Response(null, { status: 202 });
}, { system: "Live meeting webhooks" });
