/**
 * POST /api/auth/login: sign in to the client portal with email and password; sets the session cookie.
 * Wrong email and wrong password give the same message and take the same time (an unknown email is checked
 * against a dummy hash), so it doesn't reveal which accounts exist.
 * Refused (after the password checks out) when the organization requires Microsoft sign-in.
 * Rate limited (lib/login-limit.ts): after too many failures for one email or from one IP address, sign-in
 * is refused with 429 for a while, even with the right password. Failed sign-ins on a real account and the
 * lockout itself go to that organization's audit log.
 * Two-step sign-in (lib/mfa.ts): if the account has an authenticator app or passkey, a correct password
 * doesn't start a session yet. It answers `{ ok, secondStep: { methods } }` and sets a 5-minute challenge
 * cookie; the sign-in page then finishes with POST /api/auth/mfa/verify.
 */
import { handle, readJson } from "@/lib/api";
import { audit, DUMMY_HASH, HttpError, startSession, verifyPassword } from "@/lib/auth";
import { get } from "@/lib/db";
import { secondFactorMethods, startSecondStep } from "@/lib/mfa";
import { setSecondStepCookie } from "@/lib/mfa-routes";
import { clearSignInFailures, clientIp, LOCKED_MESSAGE, recordSignInFailure, signInLocked, WINDOW_MINUTES } from "@/lib/login-limit";

export const POST = handle(async (req: Request) => {
  const { email: rawEmail, password } = await readJson<{ email?: string; password?: string }>(req);
  const email = String(rawEmail ?? "").trim().toLowerCase().slice(0, 200);
  const ip = await clientIp();
  if (await signInLocked(email, ip)) throw new HttpError(429, LOCKED_MESSAGE);
  const user = await get<{ id: string; org_id: string; name: string; password_hash: string; sso_required: number }>(
    "SELECT u.id, u.org_id, u.name, u.password_hash, o.sso_required FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = ?",
    email,
  );
  // Always run the slow check, even for an unknown email, so timing can't tell the two apart.
  const passwordOk = verifyPassword(String(password ?? ""), user?.password_hash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    const lockedNow = await recordSignInFailure(email, ip);
    // Unknown emails have no organization to log to; they still count towards the limit.
    if (user) {
      await audit(user, "Failed sign-in (wrong password)", "Sign-in");
      if (lockedNow) await audit(user, `Password sign-in paused for ${WINDOW_MINUTES} minutes after too many wrong passwords`, "Sign-in");
    }
    throw new HttpError(401, "That email and password don't match. Check them and try again.");
  }
  if (user.sso_required === 1) throw new HttpError(403, "Your organization signs in with Microsoft. Use “Sign in with Microsoft”.");
  const methods = await secondFactorMethods("user", user.id);
  if (methods.length) {
    // The failure count is cleared only once the second step passes, so code guessing stays limited too.
    await setSecondStepCookie("user", await startSecondStep("user", user.id));
    return { ok: true, secondStep: { methods } };
  }
  await clearSignInFailures(email);
  await startSession(user.id);
  await audit(user, "Signed in", "Sign-in");
  return { ok: true };
});
