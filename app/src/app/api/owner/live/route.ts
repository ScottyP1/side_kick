/**
 * GET /api/owner/live: the Owner Console's Live meetings page (lib/live-meetings/sessions.ts `ownerLiveReport`):
 * whether the meeting-bot service is set up, each client's live sessions, hours (against its plan) and failures this
 * month, the sessions running now and the latest failures. Never anything said in a meeting.
 * Who: platform operators only.
 */
import { handle } from "@/lib/api";
import { requireOwner } from "@/lib/owner";
import { ownerLiveReport } from "@/lib/live-meetings/sessions";

export const GET = handle(async () => {
  await requireOwner();
  return ownerLiveReport();
});
