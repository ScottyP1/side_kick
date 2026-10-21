/**
 * POST /api/owner/auth/login: sign in to the Owner Console (separate from client sign-in).
 * Rate limited like the portal sign-in (lib/login-limit.ts), counted under `owner:<email>`: after too many
 * failures for one email or from one IP address it answers 429 for a while, even with the right password.
 * Failures and the lockout go to the operator log. Answers `{ ok, mustChange }`: with `mustChange` the owner
 * has a temporary password (scripts/reset-password.mjs) and must pick a new one (POST /api/owner/auth/password)
 * before anything else in the console works.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { clearSignInFailures, clientIp, LOCKED_MESSAGE, recordSignInFailure, signInLocked, WINDOW_MINUTES } from "@/lib/login-limit";
import { checkOwnerPassword, platformLog, startOwnerSession } from "@/lib/owner";

export const POST = handle(async (req: Request) => {
  const { email, password } = await readJson<{ email?: string; password?: string }>(req);
  const key = `owner:${String(email ?? "").trim().toLowerCase().slice(0, 200)}`;
  const ip = await clientIp();
  if (await signInLocked(key, ip)) throw new HttpError(429, LOCKED_MESSAGE);
  const owner = await checkOwnerPassword(String(email ?? ""), String(password ?? ""));
  if (!owner) {
    const lockedNow = await recordSignInFailure(key, ip);
    await platformLog("System", `Failed Owner Console sign-in${ip ? ` from ${ip}` : ""}`);
    if (lockedNow) await platformLog("System", `Owner Console sign-in paused for ${WINDOW_MINUTES} minutes for that email after too many wrong passwords`);
    throw new HttpError(401, "That email and password don't match an owner account.");
  }
  await clearSignInFailures(key);
  await startOwnerSession(owner.id);
  await platformLog(owner.name, "Signed in to the Owner Console");
  return { ok: true, mustChange: owner.must_change_password === 1 };
});
