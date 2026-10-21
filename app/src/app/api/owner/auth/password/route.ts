/**
 * POST /api/owner/auth/password: an owner changes their own Owner Console password ({ current, next },
 * the rules in lib/passwords.ts: 12+ characters, not breached; different from the current one). Works while the password is temporary (that's
 * what it's for) and clears the temporary flag. Signs the owner's other browsers out. In the operator log.
 */
import { handle, readJson } from "@/lib/api";
import { hashPassword, HttpError, verifyPassword } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { platformLog, requireOwner, startOwnerSession } from "@/lib/owner";
import { assertGoodPassword } from "@/lib/passwords";

export const POST = handle(async (req: Request) => {
  const owner = await requireOwner({ allowPendingPassword: true });
  const { current, next } = await readJson<{ current?: string; next?: string }>(req);
  const row = (await get<{ password_hash: string }>("SELECT password_hash FROM platform_admins WHERE id = ?", owner.id))!;
  if (!verifyPassword(String(current ?? ""), row.password_hash)) throw new HttpError(400, "Your current password is incorrect.");
  const nextPassword = String(next ?? "");
  if (nextPassword === String(current)) throw new HttpError(400, "Pick a password different from the current one.");
  await assertGoodPassword(nextPassword, { email: owner.email });
  await run("UPDATE platform_admins SET password_hash = ?, must_change_password = 0 WHERE id = ?", hashPassword(nextPassword), owner.id);
  // Everywhere else is signed out; this browser gets a fresh session.
  await run("DELETE FROM owner_sessions WHERE admin_id = ?", owner.id);
  await startOwnerSession(owner.id);
  await platformLog(owner.name, "Changed the Owner Console password");
  return { ok: true };
});
