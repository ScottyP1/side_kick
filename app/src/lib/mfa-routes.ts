/**
 * @file The two-step sign-in API, shared by the portal (`/api/auth/mfa/:action`) and the Owner Console
 * (`/api/owner/auth/mfa/:action`). Each route file is just `mfaRoutes("user")` or `mfaRoutes("owner")`.
 *
 * Actions (all POST except `status`):
 * - Managing your own two-step sign-in (signed in; never anyone else's):
 *   - GET `status`: your factors and how many backup codes are left.
 *   - `totp-start` → `{ id, secret, uri, qr }`; `totp-confirm { id, code }` → `{ backupCodes }`.
 *   - `passkey-options` → WebAuthn options; `passkey-add { response, label }` → `{ backupCodes }`.
 *   - `remove { id, password }` and `backup-codes { password }` (new codes) need your password again.
 *     While the organization requires two-step sign-in (lib/auth.ts), your last method can't be removed.
 *   These all work while a required second step is still waiting to be set up (`allowPendingTwoStep`).
 *   `backupCodes` is the list of new one-time codes when this was your first factor (show once), else null.
 * - The second step at sign-in (no session yet; the challenge is in an httpOnly cookie set by the sign-in):
 *   - `signin-options` → passkey options (or null); `verify { code } | { passkey }` → `{ ok, mustChange? }`
 *     and starts the session. Wrong answers count towards the sign-in limit (lib/login-limit.ts).
 * Everything that changes is recorded: the portal's audit log for users, the operator log for owners.
 */
import "server-only";
import { cookies } from "next/headers";
import { handle, readJson } from "./api";
import { audit, HttpError, requireUser, startSession, verifyPassword } from "./auth";
import { asSystem, get } from "./db";
import { clearSignInFailures, clientIp, recordSignInFailure, signInLocked, LOCKED_MESSAGE } from "./login-limit";
import {
  confirmTotpSetup, finishPasskeySetup, finishSecondStep, newBackupCodes, passkeySetupOptions, pendingSecondStep, removeFactor,
  secondFactorStatus, secondStepPasskeyOptions, startTotpSetup, type Account, type AccountKind,
} from "./mfa";
import { platformLog, requireOwner, startOwnerSession } from "./owner";

/** The cookie that carries a sign-in waiting for its second step, and the path it's sent to. */
export const SECOND_STEP_COOKIE: Record<AccountKind, { name: string; path: string }> = {
  user: { name: "sk_mfa", path: "/api/auth/mfa" },
  owner: { name: "sk_owner_mfa", path: "/api/owner/auth/mfa" },
};

/** Puts a second-step token in its cookie (httpOnly, strict, 5 minutes, only sent to the two-step routes). */
export async function setSecondStepCookie(kind: AccountKind, token: string) {
  const c = SECOND_STEP_COOKIE[kind];
  (await cookies()).set(c.name, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: c.path, maxAge: 300 });
}

/** The signed-in account for this kind, how to log for it, and its stored password hash (for re-checks). */
async function signedIn(kind: AccountKind) {
  if (kind === "user") {
    // Setting up two-step sign-in must work while the organization requires it and it isn't set up yet.
    const u = await requireUser(undefined, { allowPendingTwoStep: true });
    return {
      account: { kind, id: u.id, email: u.email, name: u.name } satisfies Account,
      orgId: u.org_id as string | null,
      log: (action: string) => audit(u, action, "Sign-in"),
      passwordHash: async () => (await get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", u.id))!.password_hash,
    };
  }
  const o = await requireOwner();
  return {
    account: { kind, id: o.id, email: o.email, name: o.name } satisfies Account,
    orgId: null as string | null,
    log: (action: string) => platformLog(o.name, action),
    passwordHash: async () => (await get<{ password_hash: string }>("SELECT password_hash FROM platform_admins WHERE id = ?", o.id))!.password_hash,
  };
}

/** Throws 400 unless `password` is the account's current password (asked again before weakening sign-in). */
async function recheckPassword(hash: string, password: unknown) {
  if (!verifyPassword(String(password ?? ""), hash)) throw new HttpError(400, "That password is incorrect.");
}

/** Builds the GET and POST handlers for one kind of account. */
export function mfaRoutes(kind: AccountKind) {
  type Ctx = { params: Promise<{ action: string }> };
  const cookie = SECOND_STEP_COOKIE[kind];

  const GET = handle(async (_req: Request, { params }: Ctx) => {
    const { action } = await params;
    if (action !== "status") throw new HttpError(404, "Not found.");
    const me = await signedIn(kind);
    return secondFactorStatus(me.account);
  });

  const POST = handle(async (req: Request, { params }: Ctx) => {
    const { action } = await params;
    // The second step of signing in comes before the session (and so the org) exists: system work (lib/db.ts).
    if (action === "signin-options") return asSystem("two-step sign-in", async () => ({ options: await secondStepPasskeyOptions(kind, (await cookies()).get(cookie.name)?.value, req) }));
    if (action === "verify") return asSystem("two-step sign-in", () => verify(req));

    const me = await signedIn(kind);
    const body = await readJson<{ id?: string; code?: string; password?: string; label?: string; response?: never }>(req);
    switch (action) {
      case "totp-start":
        return startTotpSetup(me.account);
      case "totp-confirm": {
        const r = await confirmTotpSetup(me.account, String(body.id ?? ""), String(body.code ?? ""));
        await me.log(r.backupCodes ? "Turned on two-step sign-in (authenticator app)" : "Added an authenticator app for two-step sign-in");
        return r;
      }
      case "passkey-options":
        return passkeySetupOptions(me.account, req);
      case "passkey-add": {
        if (!body.response) throw new HttpError(400, "No passkey was sent.");
        const label = String(body.label ?? "").trim() || "Passkey";
        const r = await finishPasskeySetup(me.account, req, body.response, label);
        await me.log(r.backupCodes ? `Turned on two-step sign-in (passkey “${label}”)` : `Added a passkey (“${label}”) for two-step sign-in`);
        return r;
      }
      case "remove": {
        await recheckPassword(await me.passwordHash(), body.password);
        // While the organization requires two-step sign-in, the last method can't be removed (add another first).
        if (me.orgId && (await secondFactorStatus(me.account)).factors.length <= 1
          && Number((await get<{ mfa_required: number }>("SELECT mfa_required FROM orgs WHERE id = ?", me.orgId))?.mfa_required) === 1) {
          throw new HttpError(400, "Your organization requires two-step sign-in, so you can't remove your last method. Add another one first, then remove this one.");
        }
        const r = await removeFactor(me.account, String(body.id ?? ""));
        await me.log(r.twoStepOff ? `Turned off two-step sign-in (removed “${r.label}”)` : `Removed “${r.label}” from two-step sign-in`);
        return { ok: true, twoStepOff: r.twoStepOff };
      }
      case "backup-codes": {
        await recheckPassword(await me.passwordHash(), body.password);
        if (!(await secondFactorStatus(me.account)).factors.length) throw new HttpError(400, "Turn on two-step sign-in first.");
        const backupCodes = await newBackupCodes(me.account);
        await me.log("Made new backup codes for two-step sign-in (the old ones stopped working)");
        return { backupCodes };
      }
      default:
        throw new HttpError(404, "Not found.");
    }
  });

  /** The second step: checks the answer, then starts the real session (portal or Owner Console). */
  async function verify(req: Request) {
    const jar = await cookies();
    const token = jar.get(cookie.name)?.value;
    const { id } = await pendingSecondStep(kind, token);
    const who = kind === "user"
      ? await get<{ id: string; org_id: string; name: string; email: string }>("SELECT id, org_id, name, email FROM users WHERE id = ?", id)
      : await get<{ id: string; name: string; email: string; must_change_password: number }>("SELECT id, name, email, must_change_password FROM platform_admins WHERE id = ?", id);
    if (!who) throw new HttpError(401, "That sign-in has expired. Sign in again with your password.");
    const limitKey = kind === "owner" ? `owner:${who.email}` : who.email;
    const ip = await clientIp();
    if (await signInLocked(limitKey, ip)) throw new HttpError(429, LOCKED_MESSAGE);
    const body = await readJson<{ code?: string; passkey?: never }>(req);
    let method;
    try {
      ({ method } = await finishSecondStep(kind, token, { code: body.code, passkey: body.passkey }, req));
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 401)) {
        await recordSignInFailure(limitKey, ip);
        if (kind === "user") await audit(who as { org_id: string; name: string }, "Failed sign-in (wrong two-step code)", "Sign-in");
        else await platformLog("System", `Failed Owner Console sign-in (wrong two-step code)${ip ? ` from ${ip}` : ""}`);
      }
      throw e;
    }
    jar.delete({ name: cookie.name, path: cookie.path });
    await clearSignInFailures(limitKey);
    if (kind === "user") {
      await startSession(who.id);
      await audit(who as { org_id: string; name: string }, `Signed in (password + ${method})`, "Sign-in");
      return { ok: true };
    }
    await startOwnerSession(who.id);
    // The first step was a password or Microsoft sign-in (that callback logged which), so only the second is named.
    await platformLog(who.name, `Signed in to the Owner Console (second step: ${method})`);
    return { ok: true, mustChange: Number((who as { must_change_password: number }).must_change_password) === 1 };
  }

  return { GET, POST };
}
