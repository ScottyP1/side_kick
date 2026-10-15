/**
 * POST /api/owner/auth/logout: sign out of the Owner Console on this browser.
 */
import { handle } from "@/lib/api";
import { endOwnerSession } from "@/lib/owner";

export const POST = handle(async () => {
  await endOwnerSession();
  return { ok: true };
});
