/**
 * GET /api/owner/rolloffs: every roll-off across all clients (pending first): groups ending, organizations
 * in their grace period, done ones with their certificate, and any error from the scheduled deletion.
 * Who: platform operators only.
 */
import { handle } from "@/lib/api";
import { requireOwner } from "@/lib/owner";
import { listAllRolloffs } from "@/lib/rolloff";

export const GET = handle(async () => {
  await requireOwner();
  return { rolloffs: await listAllRolloffs() };
});
