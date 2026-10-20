/**
 * POST /api/auth/logout: sign out of the client portal on this browser. Anyone may call it (signed in or
 * not, and also while their organization is paused or their temporary password is still pending).
 * Recorded as "Signed out" in the audit log when there was a session.
 */
import { handle } from "@/lib/api";
import { audit, endSession, sessionUser } from "@/lib/auth";

export const POST = handle(async () => {
  const user = await sessionUser();
  await endSession();
  if (user) await audit(user, "Signed out", "Sign-in");
  return { ok: true };
});
