/**
 * PUT /api/owner/live/cap `{ kind: "usd" | "hours", amount }`: the Sidekick team sets the platform-wide monthly cap on
 * what live meeting bots cost (lib/live-meetings/spend.ts `setLiveCap`; $50 a month until set). Once it's reached
 * Sidekick joins no new meetings. 400 for a bad value. Who: platform operators only. Written to the operator log.
 */
import { handle, readJson } from "@/lib/api";
import { requireOwner } from "@/lib/owner";
import { setLiveCap } from "@/lib/live-meetings/spend";

export const PUT = handle(async (req: Request) => {
  const owner = await requireOwner();
  return setLiveCap(owner.name, (await readJson<{ kind?: unknown; amount?: unknown } | null>(req)) ?? {});
});
