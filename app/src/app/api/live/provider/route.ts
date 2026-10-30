/**
 * PUT /api/live/provider `{ provider: "attendee" | "recall" }`: the Org Owner chooses where the organization's meeting
 * bot runs for Sidekick live in Teams meetings (lib/live-meetings/sessions.ts `setOrgProvider`): Sidekick's own
 * (self-hosted, the default: meeting audio stays in Teams and Sidekick's Azure) or the hosted Recall.ai (which then
 * receives the meeting audio and is listed as a sub-processor). Org Owner only (403); 400 for an unknown choice; 503
 * when that bot isn't set up. Audited ("Policy change").
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { setOrgProvider } from "@/lib/live-meetings/sessions";

export const PUT = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ provider?: unknown } | null>(req);
  return setOrgProvider(user, body?.provider);
});
