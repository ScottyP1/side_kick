/**
 * @file One-time messages handed from a server redirect to the page it lands on ("flash" messages).
 *
 * Why: the Microsoft sign-in callback used to put its error text in the address (`/login?error=…`), so anyone
 * could send a link that shows their own words on Sidekick's real sign-in page ("call this number to unlock
 * your account"). Now the server puts the text in a short-lived cookie (URL-encoded by Next.js), which another website can't set, and
 * the address only says *that* there is a message (`?error=1`). The page reads the cookie once and deletes it.
 * Security review L4, Oct 2026. Used by the Microsoft callback and admin-consent routes, /login, /settings and /users. No secrets go in here.
 */

/** The cookie holding the message (readable by the page, 2 minutes, whole site). */
export const FLASH_COOKIE = "sk_flash";
/** How long the message waits for the page, in seconds. */
export const FLASH_SECONDS = 120;

/**
 * In the browser: returns the waiting message and deletes it, or `fallback` when there's none (an old or
 * hand-made link with `?error=…` never shows its own text).
 */
export function takeFlash(fallback: string): string {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${FLASH_COOKIE}=`))?.slice(FLASH_COOKIE.length + 1);
  document.cookie = `${FLASH_COOKIE}=; Max-Age=0; path=/`;
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw);
  } catch {
    return fallback;
  }
}
