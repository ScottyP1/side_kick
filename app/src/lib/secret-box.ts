/**
 * @file Encryption at rest for small secrets Sidekick must be able to read back (today: the shared secret of
 * each authenticator app in `mfa_factors.secret`). A leaked database or backup then doesn't reveal them.
 *
 * Concepts
 * - **Envelope encryption**: each secret gets its own random 256-bit *data key*. The secret is encrypted with
 *   the data key, and the data key is encrypted ("wrapped") with the *master key*. Both use AES-256-GCM, which
 *   also detects any tampering. Only the master key needs protecting, and moving it later (e.g. into Azure
 *   Key Vault, which would then do the wrapping) doesn't change how secrets are stored.
 * - **Master key**: `SIDEKICK_ENCRYPTION_KEY`, 32 random bytes in base64 (`openssl rand -base64 32`). In
 *   production it's a Container App secret (docs/HOSTING.md → Settings and secrets). Never in the repo.
 * - **Stored form**: `enc1.<key id>.<wrap iv>.<wrapped data key>.<iv>.<ciphertext>` (base64url pieces). The key
 *   id is a short fingerprint of the master key, so a wrong or rotated key gives a clear error instead of
 *   garbage. Each secret is tied to a *context* (e.g. the factor's id), so a sealed value copied onto another
 *   row won't open.
 * - **Without a key**: production refuses to seal (`SecretKeyMissingError`, so authenticator setup is off and
 *   says why). On a laptop or in tests without the key, values are stored as they are, and plain values from
 *   before encryption still open; `isSealed` tells them apart.
 *
 * Who calls it: lib/mfa.ts. Anything new that stores a secret Sidekick must read back should use it too.
 */
import "server-only";
import crypto from "node:crypto";
import { HttpError } from "./http-error";
import { BRAND } from "./brand";

const PREFIX = "enc1";

/** Thrown when a secret must be sealed or opened but no usable master key is configured. Answers 503. */
export class SecretKeyMissingError extends HttpError {
  constructor(message = `This needs SIDEKICK_ENCRYPTION_KEY, which isn't set on this server yet. The ${BRAND.name} team adds it (see docs/HOSTING.md).`) {
    super(503, message);
  }
}

/** The master key from SIDEKICK_ENCRYPTION_KEY, or null if unset. Throws if it's set but not 32 bytes of base64. */
function masterKey(): Buffer | null {
  const raw = process.env.SIDEKICK_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new SecretKeyMissingError("SIDEKICK_ENCRYPTION_KEY must be 32 random bytes in base64 (make one with: openssl rand -base64 32).");
  return key;
}
const keyId = (key: Buffer) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);

/** True when secrets can be sealed here: a master key is set, or this isn't production (plain storage allowed). */
export function canSealSecrets(): boolean {
  try {
    return Boolean(masterKey()) || process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

/** True if `stored` is an encrypted value (as opposed to a plain one from a laptop or from before encryption). */
export const isSealed = (stored: string) => stored.startsWith(`${PREFIX}.`);

function gcm(key: Buffer, data: Buffer, aad: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const out = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  return { iv, out };
}
function ungcm(key: Buffer, iv: Buffer, data: Buffer, aad: string) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}

/**
 * Encrypts `plain` for storage, tied to `context` (e.g. "mfa_factors.secret:<factor id>"). Without a master key
 * it returns `plain` unchanged outside production and throws `SecretKeyMissingError` in production.
 */
export function sealSecret(plain: string, context: string): string {
  const key = masterKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") throw new SecretKeyMissingError();
    return plain;
  }
  const dataKey = crypto.randomBytes(32);
  const wrapped = gcm(key, dataKey, `wrap:${context}`);
  const body = gcm(dataKey, Buffer.from(plain, "utf8"), context);
  const b = (x: Buffer) => x.toString("base64url");
  return [PREFIX, keyId(key), b(wrapped.iv), b(wrapped.out), b(body.iv), b(body.out)].join(".");
}

/**
 * Reads back a stored value: decrypts a sealed one (same `context` as when sealed), or returns a plain one as
 * it is. Throws `SecretKeyMissingError` if it's sealed and there's no key or a different key, and a plain
 * Error if it was tampered with or belongs to another context.
 */
export function openSecret(stored: string, context: string): string {
  if (!isSealed(stored)) return stored;
  const [, kid, wrapIv, wrapped, iv, body] = stored.split(".");
  const key = masterKey();
  if (!key) throw new SecretKeyMissingError();
  if (kid !== keyId(key)) throw new SecretKeyMissingError("This secret was encrypted with a different SIDEKICK_ENCRYPTION_KEY than the one set now.");
  const d = (x: string) => Buffer.from(x, "base64url");
  const dataKey = ungcm(key, d(wrapIv), d(wrapped), `wrap:${context}`);
  return ungcm(dataKey, d(iv), d(body), context).toString("utf8");
}
