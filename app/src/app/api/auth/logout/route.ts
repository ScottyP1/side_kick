/**
 * POST /api/auth/logout: sign out of the client portal on this browser.
 */
import { handle } from "@/lib/api";
import { endSession } from "@/lib/auth";

export const POST = handle(async () => {
  await endSession();
  return { ok: true };
});
