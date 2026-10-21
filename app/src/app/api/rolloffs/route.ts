/**
 * GET /api/rolloffs: the organization's roll-offs, newest first: groups that are ending, a pending deletion
 * of the whole organization, and done ones with their deletion certificate's id and counts (lib/rolloff.ts).
 * Who: Org Owners and Org Admins. Only their own organization's.
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listRolloffs } from "@/lib/rolloff";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  return { rolloffs: await listRolloffs(user.org_id) };
});
