/**
 * @file Two-step sign-in: a second check after the password, for portal users and Owner Console owners.
 *
 * Concepts
 * - **Account**: either a portal user (`kind: "user"`, table `users`) or an owner (`kind: "owner"`, table
 *   `platform_admins`). Both use the same tables here, told apart by `account_kind`.
 * - **Factors** (`mfa_factors`): what someone can use as their second step.
 *   - **Authenticator app** (`totp`): a 6-digit code that changes every 30 seconds (RFC 6238, the standard
 *     every authenticator app supports). Sidekick keeps the shared secret; each code works only once
 *     (`last_step`), and codes from 30 seconds either side are accepted for clock drift.
 *   - **Passkey** (`passkey`): Face ID, Touch ID, Windows Hello or a security key (WebAuthn, via
 *     @simplewebauthn/server). Sidekick keeps only the public key; passkeys only work on Sidekick's own
 *     address, so a look-alike phishing site can't use them.
 *   A factor is `enabled = 0` until it has been proven once (a correct code, or a completed passkey).
 * - **Backup codes** (`mfa_backup_codes`): 10 one-time codes shown once when the first factor is added (or
 *   on request), for a lost phone. Only their hashes are stored.
 * - **Second step at sign-in**: when the password is right and the account has a factor, no session starts.
 *   Instead `startSecondStep` makes a short-lived (5 minute) challenge, kept in an httpOnly cookie, and
 *   `finishSecondStep` checks the code or passkey. Five wrong codes end the challenge; wrong codes also count
 *   towards the sign-in limit (lib/login-limit.ts), so guessing stays slow.
 * - Signing in with Microsoft skips this: Microsoft runs its own checks (MFA, Conditional Access).
 *
 * Who calls it: the two-step routes (`/api/auth/mfa/*`, `/api/owner/auth/mfa/*`, built by lib/mfa-routes.ts)
 * and the sign-in routes. Removing a factor or making new backup codes needs the password again there.
 */
import "server-only";
import crypto from "node:crypto";
import QRCode from "qrcode";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { HttpError } from "./auth";
import { all, get, newId, now, run, tx } from "./db";
import { span, spanAttrs } from "./trace";

/** Whose account: a portal user or an Owner Console owner. */
export type AccountKind = "user" | "owner";
/** The account a factor belongs to. `email`/`name` label it in authenticator apps and passkey prompts. */
export type Account = { kind: AccountKind; id: string; email: string; name: string };
/** One factor as shown on the security panel. */
export type FactorInfo = { id: string; kind: "totp" | "passkey"; label: string; added: string; lastUsed: string | null };
/** How a second step was passed, for the audit log. */
export type SecondStepMethod = "authenticator code" | "passkey" | "backup code";

const SIGNIN_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const BACKUP_CODES = 10;
const STEP_SECONDS = 30;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const expiresIn = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/* ---------- authenticator-app codes (TOTP, RFC 6238) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Base32 (RFC 4648, no padding): the format authenticator apps expect for the secret. */
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** The 6-digit code for a base32 secret at time step `step` (seconds since 1970 / 30). */
export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
/** The time step a code matches (now, or 30 seconds either side) that is newer than `lastStep`, or null. */
function matchTotp(secret: string, code: string, lastStep: number | null): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const nowStep = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (const step of [nowStep, nowStep - 1, nowStep + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(clean))) return step;
  }
  return null;
}

/* ---------- passkeys (WebAuthn) ---------- */
/**
 * Sidekick's identity for passkeys: its host name and web origin. In production it's SIDEKICK_PUBLIC_URL
 * (so it can't be steered by a forged Host header); locally the address the browser used.
 */
export function relyingParty(req: Request) {
  const base = process.env.NODE_ENV === "production" && process.env.SIDEKICK_PUBLIC_URL ? process.env.SIDEKICK_PUBLIC_URL : new URL(req.url).origin;
  const u = new URL(base);
  return { rpID: u.hostname, origin: u.origin, rpName: "Sidekick" };
}
const registerKey = (a: Pick<Account, "kind" | "id">) => `register:${a.kind}:${a.id}`;

/* ---------- reading factors ---------- */
type FactorRow = {
  id: string; kind: "totp" | "passkey"; label: string; secret: string | null; last_step: number | null; credential_id: string | null;
  public_key: string | null; counter: number; transports: string | null; created_at: string; last_used: string | null;
};
const enabledFactors = (kind: AccountKind, id: string) =>
  all<FactorRow>("SELECT * FROM mfa_factors WHERE account_kind = ? AND account_id = ? AND enabled = 1 ORDER BY created_at", kind, id);

/** The account's working factors and how many unused backup codes it has left. */
export async function secondFactorStatus(a: Pick<Account, "kind" | "id">): Promise<{ factors: FactorInfo[]; backupCodesLeft: number }> {
  const factors = (await enabledFactors(a.kind, a.id)).map((f) => ({ id: f.id, kind: f.kind, label: f.label, added: f.created_at, lastUsed: f.last_used }));
  const left = await get<{ n: number | string }>("SELECT COUNT(*) AS n FROM mfa_backup_codes WHERE account_kind = ? AND account_id = ? AND used_at IS NULL", a.kind, a.id);
  return { factors, backupCodesLeft: Number(left?.n ?? 0) };
}

/** Which second steps this account can use at sign-in (empty = no two-step sign-in). */
export async function secondFactorMethods(kind: AccountKind, id: string): Promise<("totp" | "passkey")[]> {
  return [...new Set((await enabledFactors(kind, id)).map((f) => f.kind))];
}

/* ---------- adding and removing factors ---------- */
/**
 * Starts adding an authenticator app: makes a new secret (kept unconfirmed until `confirmTotpSetup`) and
 * returns it with the `otpauth://` link and a QR code (PNG data URL) for the app to scan. Replaces any
 * earlier unconfirmed one.
 */
export async function startTotpSetup(a: Account) {
  const secret = base32Encode(crypto.randomBytes(20));
  const id = newId();
  await run("DELETE FROM mfa_factors WHERE account_kind = ? AND account_id = ? AND kind = 'totp' AND enabled = 0", a.kind, a.id);
  await run(
    "INSERT INTO mfa_factors (id, account_kind, account_id, kind, label, secret, enabled, created_at) VALUES (?, ?, ?, 'totp', ?, ?, 0, ?)",
    id, a.kind, a.id, "Authenticator app", secret, now(),
  );
  const issuer = a.kind === "owner" ? "Sidekick Owner Console" : "Sidekick";
  const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${a.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { id, secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

/**
 * Finishes adding an authenticator app once the person types a code from it. Returns new backup codes if
 * this is the account's first factor (shown once), otherwise null. Throws 400 for a wrong code.
 */
export async function confirmTotpSetup(a: Account, id: string, code: string): Promise<{ backupCodes: string[] | null }> {
  return span("auth", "Add authenticator app", async () => {
    const f = await get<FactorRow>("SELECT * FROM mfa_factors WHERE id = ? AND account_kind = ? AND account_id = ? AND kind = 'totp' AND enabled = 0", id, a.kind, a.id);
    if (!f?.secret) throw new HttpError(404, "That setup has expired. Start again.");
    const step = matchTotp(f.secret, code, null);
    if (step === null) throw new HttpError(400, "That code doesn't match. Check the time on your phone is right, and type the newest code.");
    const first = (await enabledFactors(a.kind, a.id)).length === 0;
    await run("UPDATE mfa_factors SET enabled = 1, last_step = ? WHERE id = ?", step, f.id);
    return { backupCodes: first ? await newBackupCodes(a) : null };
  });
}

/** Options for the browser to create a passkey for this account (the challenge is remembered for 5 minutes). */
export async function passkeySetupOptions(a: Account, req: Request) {
  const { rpID, rpName } = relyingParty(req);
  const existing = await enabledFactors(a.kind, a.id);
  const options = await generateRegistrationOptions({
    rpName: a.kind === "owner" ? "Sidekick Owner Console" : rpName,
    rpID,
    userName: a.email,
    userDisplayName: a.name,
    userID: new TextEncoder().encode(`${a.kind}:${a.id}`),
    attestationType: "none",
    excludeCredentials: existing.filter((f) => f.credential_id).map((f) => ({ id: f.credential_id!, transports: transportsOf(f) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await run("DELETE FROM mfa_challenges WHERE token_hash = ?", registerKey(a));
  await run(
    "INSERT INTO mfa_challenges (token_hash, account_kind, account_id, purpose, challenge, attempts, expires_at) VALUES (?, ?, ?, 'register', ?, 0, ?)",
    registerKey(a), a.kind, a.id, options.challenge, expiresIn(SIGNIN_MINUTES),
  );
  return options;
}
const transportsOf = (f: FactorRow) => (f.transports ? (JSON.parse(f.transports) as AuthenticatorTransportFuture[]) : undefined);

/**
 * Saves the passkey the browser just made, after checking it answers this account's challenge on Sidekick's
 * own address. Returns new backup codes if this is the account's first factor, otherwise null.
 */
export async function finishPasskeySetup(a: Account, req: Request, response: RegistrationResponseJSON, label: string): Promise<{ backupCodes: string[] | null }> {
  return span("auth", "Add passkey", async () => {
    const c = await get<{ challenge: string; expires_at: string }>("SELECT challenge, expires_at FROM mfa_challenges WHERE token_hash = ?", registerKey(a));
    await run("DELETE FROM mfa_challenges WHERE token_hash = ?", registerKey(a));
    if (!c || new Date(c.expires_at) < new Date()) throw new HttpError(400, "That took too long. Try adding the passkey again.");
    const { rpID, origin } = relyingParty(req);
    let result;
    try {
      result = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
    } catch {
      throw new HttpError(400, "That passkey couldn't be checked. Try again.");
    }
    if (!result.verified) throw new HttpError(400, "That passkey couldn't be checked. Try again.");
    const cred = result.registrationInfo.credential;
    if (await get("SELECT id FROM mfa_factors WHERE credential_id = ?", cred.id)) throw new HttpError(409, "That passkey is already added.");
    const first = (await enabledFactors(a.kind, a.id)).length === 0;
    await run(
      "INSERT INTO mfa_factors (id, account_kind, account_id, kind, label, credential_id, public_key, counter, transports, enabled, created_at) VALUES (?, ?, ?, 'passkey', ?, ?, ?, ?, ?, 1, ?)",
      newId(), a.kind, a.id, label.trim().slice(0, 60) || "Passkey", cred.id, Buffer.from(cred.publicKey).toString("base64url"), cred.counter,
      cred.transports?.length ? JSON.stringify(cred.transports) : null, now(),
    );
    return { backupCodes: first ? await newBackupCodes(a) : null };
  });
}

/**
 * Removes one factor (the caller checks the password first). Removing the last one also deletes the
 * backup codes, which turns two-step sign-in off. Returns the removed factor's label, or throws 404.
 */
export async function removeFactor(a: Pick<Account, "kind" | "id">, id: string): Promise<{ label: string; twoStepOff: boolean }> {
  const f = await get<{ label: string }>("SELECT label FROM mfa_factors WHERE id = ? AND account_kind = ? AND account_id = ? AND enabled = 1", id, a.kind, a.id);
  if (!f) throw new HttpError(404, "That sign-in method isn't on your account.");
  return tx(async () => {
    await run("DELETE FROM mfa_factors WHERE id = ?", id);
    const twoStepOff = (await enabledFactors(a.kind, a.id)).length === 0;
    if (twoStepOff) await run("DELETE FROM mfa_backup_codes WHERE account_kind = ? AND account_id = ?", a.kind, a.id);
    return { label: f.label, twoStepOff };
  });
}

/** Replaces the account's backup codes with 10 new ones and returns them (shown once; only hashes are kept). */
export async function newBackupCodes(a: Pick<Account, "kind" | "id">): Promise<string[]> {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: BACKUP_CODES }, () => {
    const s = Array.from({ length: 10 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  await tx(async () => {
    await run("DELETE FROM mfa_backup_codes WHERE account_kind = ? AND account_id = ?", a.kind, a.id);
    for (const code of codes) {
      await run("INSERT INTO mfa_backup_codes (id, account_kind, account_id, code_hash, created_at) VALUES (?, ?, ?, ?, ?)", newId(), a.kind, a.id, sha256(normaliseBackup(code)), now());
    }
  });
  return codes;
}
const normaliseBackup = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Deletes everything two-step for an account (when the account is deleted, or by the operator's reset). */
export async function forgetSecondFactors(kind: AccountKind, id: string) {
  await run("DELETE FROM mfa_factors WHERE account_kind = ? AND account_id = ?", kind, id);
  await run("DELETE FROM mfa_backup_codes WHERE account_kind = ? AND account_id = ?", kind, id);
  await run("DELETE FROM mfa_challenges WHERE account_kind = ? AND account_id = ?", kind, id);
}

/* ---------- the second step at sign-in ---------- */
/**
 * Starts the second step after a correct password: a 5-minute challenge for this account. Returns the
 * token for the caller to put in an httpOnly cookie (only its hash is stored). Also tidies expired ones.
 */
export async function startSecondStep(kind: AccountKind, id: string): Promise<string> {
  await run("DELETE FROM mfa_challenges WHERE expires_at < ?", now());
  const token = crypto.randomBytes(32).toString("base64url");
  await run(
    "INSERT INTO mfa_challenges (token_hash, account_kind, account_id, purpose, challenge, attempts, expires_at) VALUES (?, ?, ?, 'signin', NULL, 0, ?)",
    sha256(token), kind, id, expiresIn(SIGNIN_MINUTES),
  );
  return token;
}

/** The account waiting for its second step under this token, or throws 401 if it expired or doesn't exist. */
export async function pendingSecondStep(kind: AccountKind, token: string | undefined): Promise<{ id: string }> {
  const row = token
    ? await get<{ account_id: string; expires_at: string }>("SELECT account_id, expires_at FROM mfa_challenges WHERE token_hash = ? AND purpose = 'signin' AND account_kind = ?", sha256(token), kind)
    : undefined;
  if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(401, "That sign-in has expired. Sign in again with your password.");
  return { id: row.account_id };
}

/** Passkey options for the second step (the account's own passkeys only), or null if it has none. */
export async function secondStepPasskeyOptions(kind: AccountKind, token: string | undefined, req: Request) {
  const { id } = await pendingSecondStep(kind, token);
  const passkeys = (await enabledFactors(kind, id)).filter((f) => f.kind === "passkey");
  if (!passkeys.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(req).rpID,
    allowCredentials: passkeys.map((f) => ({ id: f.credential_id!, transports: transportsOf(f) })),
    userVerification: "preferred",
  });
  await run("UPDATE mfa_challenges SET challenge = ? WHERE token_hash = ?", options.challenge, sha256(token!));
  return options;
}

/**
 * Checks the second step: an authenticator code, a backup code (`code`) or a passkey answer (`passkey`).
 * On success the challenge is used up and the account id and method are returned; the caller then starts
 * the session. A wrong answer throws 400 (and after 5, 401: sign in again).
 */
export async function finishSecondStep(
  kind: AccountKind,
  token: string | undefined,
  proof: { code?: string; passkey?: AuthenticationResponseJSON },
  req: Request,
): Promise<{ id: string; method: SecondStepMethod }> {
  return span("auth", "Second sign-in step", async () => {
    const { id } = await pendingSecondStep(kind, token);
    const hash = sha256(token!);
    const method = await checkProof(kind, id, hash, proof, req);
    spanAttrs({ method: method ?? "wrong", account: kind });
    if (method) {
      await run("DELETE FROM mfa_challenges WHERE token_hash = ?", hash);
      return { id, method };
    }
    await run("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?", hash);
    const left = await get<{ attempts: number }>("SELECT attempts FROM mfa_challenges WHERE token_hash = ?", hash);
    if (Number(left?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS) {
      await run("DELETE FROM mfa_challenges WHERE token_hash = ?", hash);
      throw new HttpError(401, "Too many wrong codes. Sign in again with your password.");
    }
    throw new HttpError(400, proof.passkey ? "That passkey didn't work. Try again, or use a code." : "That code doesn't match. Type the newest code from your app, or a backup code.");
  });
}

/** Which method passed (and records its use), or null if none did. */
async function checkProof(kind: AccountKind, id: string, hash: string, proof: { code?: string; passkey?: AuthenticationResponseJSON }, req: Request): Promise<SecondStepMethod | null> {
  const factors = await enabledFactors(kind, id);
  if (proof.passkey) {
    const f = factors.find((x) => x.kind === "passkey" && x.credential_id === proof.passkey!.id);
    const c = await get<{ challenge: string | null }>("SELECT challenge FROM mfa_challenges WHERE token_hash = ?", hash);
    if (!f || !c?.challenge) return null;
    const { rpID, origin } = relyingParty(req);
    try {
      const r = await verifyAuthenticationResponse({
        response: proof.passkey, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
        credential: { id: f.credential_id!, publicKey: Buffer.from(f.public_key!, "base64url"), counter: Number(f.counter), transports: transportsOf(f) },
      });
      if (!r.verified) return null;
      await run("UPDATE mfa_factors SET counter = ?, last_used = ? WHERE id = ?", r.authenticationInfo.newCounter, now(), f.id);
      return "passkey";
    } catch {
      return null;
    }
  }
  const code = String(proof.code ?? "").trim();
  if (/^\d{3}\s?\d{3}$/.test(code)) {
    for (const f of factors.filter((x) => x.kind === "totp" && x.secret)) {
      const step = matchTotp(f.secret!, code, f.last_step === null ? null : Number(f.last_step));
      if (step !== null) {
        await run("UPDATE mfa_factors SET last_step = ?, last_used = ? WHERE id = ?", step, now(), f.id);
        return "authenticator code";
      }
    }
    return null;
  }
  const backup = normaliseBackup(code);
  if (backup.length !== 10) return null;
  const row = await get<{ id: string }>(
    "SELECT id FROM mfa_backup_codes WHERE account_kind = ? AND account_id = ? AND code_hash = ? AND used_at IS NULL",
    kind, id, sha256(backup),
  );
  if (!row) return null;
  const used = await run("UPDATE mfa_backup_codes SET used_at = ? WHERE id = ? AND used_at IS NULL", now(), row.id);
  return used.changes === 1 ? "backup code" : null;
}
