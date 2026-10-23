/**
 * POST /api/graph/lifecycle: Microsoft Graph's lifecycle notifications for Sidekick's meeting-transcript
 * subscriptions (lib/meetings-graph.ts `handleLifecycle`): `reauthorizationRequired` (renew now),
 * `subscriptionRemoved` (make a new one) and `missed` (poll now). Graph validates this address like the
 * notification address (`?validationToken=…` echoed as plain text).
 *
 * Who: Microsoft Graph, without a session. Items are only acted on when they name one of our subscriptions with
 * its secret client state. Always answers 202 for a batch.
 */
import { handle } from "@/lib/api";
import { handleLifecycle, validationResponse } from "@/lib/meetings-graph";
import { spanAttrs } from "@/lib/trace";

export const POST = handle(async (req: Request) => {
  const validation = validationResponse(req);
  if (validation) return validation;
  const counts = await handleLifecycle(await req.json().catch(() => null));
  spanAttrs(counts);
  return new Response(null, { status: 202 });
});
