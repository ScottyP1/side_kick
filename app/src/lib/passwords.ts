/**
 * @file Rules for new passwords (portal and Owner Console): long enough, and not one known from data breaches.
 *
 * Concepts
 * - **Length**: at least `MIN_PASSWORD` (12) characters for everyone. Length matters more than symbols;
 *   a password manager or a few random words is the easy way there.
 * - **Breached-password check**: the password is checked against Have I Been Pwned's list of passwords
 *   seen in public data breaches, without ever sending it. Sidekick sends only the first 5 characters of
 *   the password's SHA-1 hash ("k-anonymity") and compares the matching list locally; HIBP never learns the
 *   password or even its full hash. Padding is requested, so the reply size doesn't hint at it either.
 * - **Fails open**: if HIBP can't be reached within 3 seconds (or answers with an error), the password is
 *   accepted (the length rule still applies), the trace step records `breachCheck: "unavailable"`, and the
 *   server log gets one warning line starting `[passwords]` with the reason (never the password or its hash).
 *   Sign-up and password changes never break because a third-party site is down.
 * - Tests point `PWNED_PASSWORDS_URL` at a fake list on localhost; that override is ignored in production.
 *
 * Who calls it: every place a person picks a password (first-run setup, password change, Owner Console
 * setup and password change). Temporary passwords made by Sidekick are random, so they skip it.
 */
import "server-only";
import crypto from "node:crypto";
import { HttpError } from "./http-error";
import { span, spanAttrs } from "./trace";

/** Minimum length for any password a person picks. */
export const MIN_PASSWORD = 12;

const PWNED_URL = () =>
  process.env.NODE_ENV !== "production" && process.env.PWNED_PASSWORDS_URL
    ? process.env.PWNED_PASSWORDS_URL.replace(/\/$/, "")
    : "https://api.pwnedpasswords.com";

/**
 * How many times this password appears in known breaches (0 = not found), or null if the list couldn't
 * be reached. Only a 5-character hash prefix leaves Sidekick.
 */
export async function breachCount(password: string): Promise<number | null> {
  const hash = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetch(`${PWNED_URL()}/range/${prefix}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      console.warn(`[passwords] Breached-password check unavailable (Have I Been Pwned answered ${res.status}); password accepted on length alone.`);
      return null;
    }
    for (const line of (await res.text()).split("\n")) {
      const [s, n] = line.trim().split(":");
      if (s === suffix) return Number(n) || 0;
    }
    return 0;
  } catch (e) {
    const reason = e instanceof Error ? (e.name === "TimeoutError" ? "no answer within 3 seconds" : e.message) : "unknown error";
    console.warn(`[passwords] Breached-password check unavailable (${reason}); password accepted on length alone.`);
    return null;
  }
}

/**
 * Throws a 400 with a plain explanation unless `password` is acceptable as someone's new password:
 * at least `MIN_PASSWORD` characters, not the email itself, and not found in known breaches.
 *
 * @param opts.email the account's email, so "my email as password" is refused
 */
export async function assertGoodPassword(password: string, opts: { email?: string } = {}) {
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `Use a password with at least ${MIN_PASSWORD} characters. A few random words, or one from a password manager, works well.`);
  if (password.length > 200) throw new HttpError(400, "Use a password of at most 200 characters.");
  if (opts.email && password.trim().toLowerCase() === opts.email.trim().toLowerCase()) throw new HttpError(400, "Don't use your email address as your password.");
  const seen = await span("auth", "Breached-password check", async () => {
    const n = await breachCount(password);
    spanAttrs({ breachCheck: n === null ? "unavailable" : n > 0 ? "found" : "clear" });
    return n;
  });
  if (seen) throw new HttpError(400, "That password has appeared in a known data breach, so attackers try it first. Pick a different one.");
}
