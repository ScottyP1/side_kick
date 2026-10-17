/**
 * POST /api/auth/login: sign in to the client portal with email and password; sets the session cookie.
 * Wrong email and wrong password give the same message, so it doesn't reveal which accounts exist.
 * Refused (after the password checks out) when the organization requires Microsoft sign-in.
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, startSession, verifyPassword } from "@/lib/auth";
import { get } from "@/lib/db";

export const POST = handle(async (req: Request) => {
  const { email, password } = await readJson<{ email?: string; password?: string }>(req);
  const user = await get<{ id: string; org_id: string; name: string; password_hash: string; sso_required: number }>(
    "SELECT u.id, u.org_id, u.name, u.password_hash, o.sso_required FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = ?",
    String(email ?? "").trim().toLowerCase(),
  );
  if (!user || !verifyPassword(String(password ?? ""), user.password_hash)) {
    throw new HttpError(401, "That email and password don't match. Check them and try again.");
  }
  if (user.sso_required === 1) throw new HttpError(403, "Your organization signs in with Microsoft. Use “Sign in with Microsoft”.");
  await startSession(user.id);
  await audit(user, "Signed in", "Sign-in");
  return { ok: true };
});
