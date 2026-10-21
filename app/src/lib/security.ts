/**
 * @file Small security checks with no I/O, kept apart so they can be unit-tested directly
 * (tests/db.test.mjs) and reused. Each one came from the October 2026 application security review
 * (docs/security/2026-10-app-security-review.md):
 * - `setupRefusal`: whether a one-time setup (first owner account, first organization) may run (M6).
 * - `crossSiteRefusal`: refuses changes sent from another website (CSRF, M4); used by `handle()` in api.ts.
 * - `docxUnpackedBytes`: how big a Word file unpacks to, to refuse "zip bombs" before opening them (M3).
 * - `tagSafe`: keeps document text from faking the tags around it in Claude prompts (I6).
 */
import crypto from "node:crypto";

/** Shortest setup code accepted in `SIDEKICK_SETUP_CODE`, so it can't be guessed. */
export const MIN_SETUP_CODE = 16;

const sameSecret = (a: string, b: string) =>
  crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

/**
 * Why a one-time setup (the first owner account, or first-run setup of the first organization) is refused,
 * or null if it may go ahead. No I/O, so it can be unit-tested.
 * - When `SIDEKICK_SETUP_CODE` is set, the request must carry that code (`setupCode` in the body), from any
 *   address. This is how the live site's Owner Console is set up: put a long random code in the Container
 *   App's secrets, create the account, then remove the secret.
 * - Without a code, production refuses setup outright: the `Host` header is chosen by the caller, so
 *   "it came to localhost" can't be trusted there (security review M6, Oct 2026).
 * - Outside production, setup only works when the request was made to localhost (laptop and tests).
 *
 * @param o.production whether this is a production build; o.code the configured code (or empty);
 *   o.sent the code the request sent; o.host the request's Host header; o.message the localhost refusal
 */
export function setupRefusal(o: { production: boolean; code: string; sent: unknown; host: string; message: string }): string | null {
  if (o.code) {
    if (o.code.length < MIN_SETUP_CODE) return `The setup code configured on the server is too short (at least ${MIN_SETUP_CODE} characters). Set a longer SIDEKICK_SETUP_CODE.`;
    return typeof o.sent === "string" && o.sent && sameSecret(o.sent.trim(), o.code) ? null : "That setup code is wrong. Use the code set in SIDEKICK_SETUP_CODE on the server.";
  }
  if (o.production) return "Setup is turned off on this server. Set a one-time SIDEKICK_SETUP_CODE secret, use it here, then remove it.";
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o.host) ? null : o.message;
}

/**
 * Cross-site request check (CSRF). Browsers send `Origin` (and `Sec-Fetch-Site`) with every POST, PUT, PATCH
 * and DELETE, including the plain HTML form posts another site could use to ride on someone's session
 * cookie. A change is refused when the browser says it came from another site (`Sec-Fetch-Site` other than
 * same-origin/none) or its `Origin` host isn't Sidekick's own (the request's `Host`/`X-Forwarded-Host`, or
 * `SIDEKICK_PUBLIC_URL`). Requests without these headers (server-to-server: tests, the reminder timer,
 * curl) carry no browser cookies by accident and pass. Returns the refusal message, or null if allowed.
 * GET and HEAD never change anything, so they're not checked. The Teams endpoint doesn't use `handle()`.
 */
export function crossSiteRefusal(req: Request): string | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const h = req.headers;
  const fetchSite = h.get("sec-fetch-site");
  const blocked = "This request came from another website, so Sidekick refused it. Open Sidekick directly and try again.";
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return blocked;
  const origin = h.get("origin");
  if (!origin) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return blocked; // "null" (sandboxed frames, file pages) or garbage
  }
  const own = [h.get("x-forwarded-host")?.split(",")[0].trim(), h.get("host"), process.env.SIDEKICK_PUBLIC_URL ? new URL(process.env.SIDEKICK_PUBLIC_URL).host : null]
    .filter((x): x is string => Boolean(x))
    .map((x) => x.toLowerCase());
  return own.includes(originHost) ? null : blocked;
}

/**
 * How many bytes a Word file's text parts (its `.xml` entries) unpack to, read from the zip's central
 * directory without unpacking anything. Images and other media don't count (they don't compress, so they
 * can't be a "bomb"). A Zip64 size (too big for 32 bits) or a broken directory counts as too big.
 * A file that isn't a zip at all returns 0 and is left for mammoth to refuse with its own message.
 */
export function docxUnpackedBytes(buf: Buffer): number {
  // End of central directory record: signature 0x06054b50 within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 0;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return Infinity;
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).toLowerCase();
    if (name.endsWith(".xml") || name.endsWith(".rels")) total += size === 0xffffffff ? Infinity : size;
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}

/**
 * Keeps document text and questions from closing or faking the `<source>` tags around them in the prompt (a
 * document containing "</source><source id=…>" could otherwise pose as another source or as instructions).
 * Only the prompt copy changes; excerpts shown to people come from the stored text.
 */
export const tagSafe = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
