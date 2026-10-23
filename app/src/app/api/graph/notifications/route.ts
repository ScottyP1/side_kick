/**
 * POST /api/graph/notifications: Microsoft Graph tells Sidekick that a Teams meeting transcript is ready
 * (lib/meetings-graph.ts). Two kinds of request:
 * - **Validation**: when a subscription is made, Graph calls with `?validationToken=…` and must get it back as
 *   plain text (200) within 10 seconds.
 * - **Notifications**: a JSON batch. Each item must name a subscription Sidekick made and carry its secret client
 *   state, or it's ignored. Matching transcripts are recorded and their fetch job queued; the answer is 202 at
 *   once (Graph wants a reply within 3 seconds; the real work runs on the job queue).
 *
 * Who: Microsoft Graph, without a session (no cookies, no Origin, so the cross-site check passes). Nothing is ever
 * returned about the organization; unknown or forged notifications change nothing.
 */
// Registers the job kinds this route enqueues (meetings.fetch, meetings.poll.org, meetings.subscription).
import "@/lib/job-kinds";
import { handle } from "@/lib/api";
import { handleNotifications, validationResponse } from "@/lib/meetings-graph";
import { spanAttrs } from "@/lib/trace";

export const POST = handle(async (req: Request) => {
  const validation = validationResponse(req);
  if (validation) return validation;
  const body = await req.json().catch(() => null);
  const counts = await handleNotifications(body);
  spanAttrs(counts);
  return new Response(null, { status: 202 });
});
