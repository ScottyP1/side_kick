/**
 * POST /api/auth/login: sign in to the client portal with email and password; sets the session cookie.
 * Wrong email and wrong password give the same message, so it doesn't reveal which accounts exist.
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, startSession, verifyPassword } from "@/lib/auth";
import { get } from "@/lib/db";

export const POST = handle(async (req: Request) => {
  const { email, password } = await readJson<{ email?: string; password?: string }>(req);
  const user = get<{ id: string; org_id: string; name: string; password_hash: string }>(
    "SELECT id, org_id, name, password_hash FROM users WHERE email = ?",
    String(email ?? "").trim().toLowerCase(),
  );
  if (!user || !verifyPassword(String(password ?? ""), user.password_hash)) {
    throw new HttpError(401, "That email and password don't match. Check them and try again.");
  }
  await startSession(user.id);
  audit(user, "Signed in", "Sign-in");
  return { ok: true };
});
