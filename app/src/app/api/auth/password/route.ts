/**
 * POST /api/auth/password: change your own password ({ current, next }, at least 10 characters).
 * Also clears the "must change password" flag set on accounts created with a temporary password.
 */
import { handle, readJson } from "@/lib/api";
import { audit, hashPassword, HttpError, requireUser, verifyPassword } from "@/lib/auth";
import { get, run } from "@/lib/db";

export const POST = handle(async (req: Request) => {
  const user = await requireUser(undefined, { allowPendingPassword: true });
  const { current, next } = await readJson<{ current?: string; next?: string }>(req);
  const row = (await get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id))!;
  if (!verifyPassword(String(current ?? ""), row.password_hash)) throw new HttpError(400, "Your current password is incorrect.");
  if (String(next ?? "").length < 10) throw new HttpError(400, "Use a new password with at least 10 characters.");
  await run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", hashPassword(String(next)), user.id);
  await audit(user, "Changed password", "Sign-in");
  return { ok: true };
});
