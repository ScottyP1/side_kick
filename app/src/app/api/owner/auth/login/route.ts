/**
 * POST /api/owner/auth/login: sign in to the Owner Console (separate from client sign-in).
 * Rate limited like client sign-in (lib/login-limit.ts), under the key "owner:<email>" so a locked owner
 * email doesn't lock a client account of the same address: after too many failures for one owner email or
 * from one IP address, sign-in is refused with 429 for a while, even with the right password. Failed
 * sign-ins on a real owner account and the lockout go to the operator log (Releases & switches).
 * Answers `{ ok, mustChange }`: with `mustChange` the owner has a temporary password
 * (scripts/reset-password.mjs) and must pick a new one (POST /api/owner/auth/password) before anything else
 * in the console works. With two-step sign-in on (lib/mfa.ts), a correct password answers
 * `{ ok, secondStep: { methods } }` instead and the page finishes with POST /api/owner/auth/mfa/verify.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { clearSignInFailures, clientIp, LOCKED_MESSAGE, recordSignInFailure, signInLocked, WINDOW_MINUTES } from "@/lib/login-limit";
import { secondFactorMethods, startSecondStep } from "@/lib/mfa";
import { setSecondStepCookie } from "@/lib/mfa-routes";
import { checkOwnerPassword, platformLog, startOwnerSession } from "@/lib/owner";

export const POST = handle(async (req: Request) => {
  const { email: rawEmail, password } = await readJson<{ email?: string; password?: string }>(req);
  const email = String(rawEmail ?? "").trim().toLowerCase().slice(0, 200);
  const key = `owner:${email}`;
  const ip = await clientIp();
  if (await signInLocked(key, ip)) throw new HttpError(429, LOCKED_MESSAGE.replace(", or ask an Org Admin to check your account", ""));
  const { owner, exists } = await checkOwnerPassword(email, String(password ?? ""));
  if (!owner) {
    const lockedNow = await recordSignInFailure(key, ip);
    // Only real owner accounts are logged, so strangers can't fill the operator log with made-up emails.
    if (exists) {
      await platformLog("System", `Failed Owner Console sign-in for ${email}`);
      if (lockedNow) await platformLog("System", `Owner Console sign-in paused for ${email} for ${WINDOW_MINUTES} minutes after too many wrong passwords`);
    }
    throw new HttpError(401, "That email and password don't match an owner account.");
  }
  const methods = await secondFactorMethods("owner", owner.id);
  if (methods.length) {
    // The failure count is cleared only once the second step passes, so code guessing stays limited too.
    await setSecondStepCookie("owner", await startSecondStep("owner", owner.id));
    return { ok: true, secondStep: { methods } };
  }
  await clearSignInFailures(key);
  await startOwnerSession(owner.id);
  await platformLog(owner.name, "Signed in to the Owner Console");
  return { ok: true, mustChange: owner.must_change_password === 1 };
});
