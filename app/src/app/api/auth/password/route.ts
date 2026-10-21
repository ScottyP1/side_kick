/**
 * POST /api/auth/password: change your own password ({ current, next }, at least 10 characters).
 * Also clears the "must change password" flag set on accounts created with a temporary password, and signs
 * this person out everywhere else (other browsers and devices), so a stolen session stops working.
 * The new password must differ from the current one (so a temporary password can't simply be kept).
 */
import { handle, readJson } from "@/lib/api";
import { audit, endOtherSessions, hashPassword, HttpError, requireUser, verifyPassword } from "@/lib/auth";
import { get, run } from "@/lib/db";

export const POST = handle(async (req: Request) => {
  const user = await requireUser(undefined, { allowPendingPassword: true });
  const { current, next } = await readJson<{ current?: string; next?: string }>(req);
  const row = (await get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id))!;
  if (!verifyPassword(String(current ?? ""), row.password_hash)) throw new HttpError(400, "Your current password is incorrect.");
  if (String(next ?? "").length < 10) throw new HttpError(400, "Use a new password with at least 10 characters.");
  if (String(next) === String(current)) throw new HttpError(400, "Pick a new password that's different from your current one.");
  await run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", hashPassword(String(next)), user.id);
  const ended = await endOtherSessions(user.id);
  await audit(user, ended ? `Changed password (signed out ${ended} other session${ended === 1 ? "" : "s"})` : "Changed password", "Sign-in");
  return { ok: true };
});
