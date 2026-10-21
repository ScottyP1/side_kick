/**
 * POST /api/auth/password: change your own password ({ current, next }). The new one must follow
 * lib/passwords.ts (at least 12 characters, not found in known data breaches) and differ from the current one.
 * Also clears the "must change password" flag set on temporary passwords, and signs you out everywhere
 * else (this browser stays signed in), so a stolen session stops working once you change it.
 */
import { handle, readJson } from "@/lib/api";
import { audit, endOtherSessions, hashPassword, HttpError, requireUser, verifyPassword } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { assertGoodPassword } from "@/lib/passwords";

export const POST = handle(async (req: Request) => {
  const user = await requireUser(undefined, { allowPendingPassword: true });
  const { current, next } = await readJson<{ current?: string; next?: string }>(req);
  const row = (await get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id))!;
  if (!verifyPassword(String(current ?? ""), row.password_hash)) throw new HttpError(400, "Your current password is incorrect.");
  const nextPassword = String(next ?? "");
  if (nextPassword === String(current)) throw new HttpError(400, "Pick a new password that's different from your current one.");
  await assertGoodPassword(nextPassword, { email: user.email });
  await run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", hashPassword(nextPassword), user.id);
  const others = await endOtherSessions(user.id);
  await audit(user, others ? `Changed password (signed out ${others} other ${others === 1 ? "session" : "sessions"})` : "Changed password", "Sign-in");
  return { ok: true };
});
