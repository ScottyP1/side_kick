/**
 * @file Sign-in rate limit: slows down password guessing on the client portal's email + password sign-in.
 *
 * Concepts
 * - **Failed sign-in**: a wrong password or an unknown email. Each one is a row in `login_failures`
 *   (email, the caller's IP address, time). Stored in the database, not in memory, so the limit holds
 *   when Sidekick runs as several copies (Azure Container Apps) and survives restarts.
 * - **Per-email limit**: after `EMAIL_LIMIT` failures for one email within `WINDOW_MINUTES`, that email
 *   can't sign in with a password until the window has passed, *even with the right password*. Unknown
 *   emails are counted the same way, so the limit never reveals which accounts exist.
 * - **Per-IP limit**: after `IP_LIMIT` failures from one IP address (any emails) within the window, that
 *   address is refused too. Stops one machine trying many accounts.
 * - A successful sign-in clears that email's failures. Microsoft sign-in isn't limited here (Microsoft
 *   protects its own sign-in).
 */
import "server-only";
import { headers } from "next/headers";
import { get, newId, now, run } from "./db";

/** Failures allowed per email within the window before password sign-in is refused for it. */
export const EMAIL_LIMIT = 5;
/** Failures allowed per IP address within the window. */
export const IP_LIMIT = 20;
/** How long failures count, and so how long a locked email or address waits. */
export const WINDOW_MINUTES = 15;

/** Shown when a sign-in is refused because of too many failures. */
export const LOCKED_MESSAGE = `Too many sign-in attempts. Wait ${WINDOW_MINUTES} minutes and try again, or ask an Org Admin to check your account.`;

const since = () => new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();

/**
 * The caller's IP address. Behind Azure's front door the real address is the last entry of
 * `X-Forwarded-For` (each proxy appends the address it saw, so earlier entries can be faked by the
 * caller). Next.js fills the header with the socket address when there's no proxy (local runs). Returns
 * "" if there's no address at all (then only the per-email limit applies).
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return (forwarded.at(-1) ?? h.get("x-real-ip") ?? "").slice(0, 64);
}

const count = async (column: "email" | "ip", value: string) =>
  Number((await get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM login_failures WHERE ${column} = ? AND created_at > ?`, value, since()))?.n ?? 0);

/** True if this email or IP address has used up its failures for now. Called before checking the password. */
export async function signInLocked(email: string, ip: string): Promise<boolean> {
  if ((await count("email", email)) >= EMAIL_LIMIT) return true;
  return Boolean(ip) && (await count("ip", ip)) >= IP_LIMIT;
}

/**
 * Records a failed sign-in and returns true if this failure just locked the email (so the caller can
 * write it to the audit log once). Also drops failures older than a day, so the table stays small.
 */
export async function recordSignInFailure(email: string, ip: string): Promise<boolean> {
  await run("DELETE FROM login_failures WHERE created_at < ?", new Date(Date.now() - 86400_000).toISOString());
  await run("INSERT INTO login_failures (id, email, ip, created_at) VALUES (?, ?, ?, ?)", newId(), email, ip || null, now());
  return (await count("email", email)) === EMAIL_LIMIT;
}

/** Clears an email's failures after a successful sign-in. */
export async function clearSignInFailures(email: string) {
  await run("DELETE FROM login_failures WHERE email = ?", email);
}
