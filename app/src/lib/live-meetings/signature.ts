/**
 * @file Webhook signatures for the live-meeting provider (lib/live-meetings/provider.ts): the Standard Webhooks scheme
 * that Recall.ai and Svix use. Pure apart from the clock, no imports from the app, so the tests' fake provider and the
 * unit tests can rely on exactly the same rule. Who may call: provider adapters (`verify`) and tests.
 */
import crypto from "node:crypto";

/** How old a signed webhook may be before it's refused (replays). */
const TOLERANCE_S = 5 * 60;

/**
 * Checks a Standard Webhooks signature (https://www.standardwebhooks.com, what Recall.ai and Svix send): headers
 * `webhook-id`, `webhook-timestamp`, `webhook-signature` (or the same with `svix-`), signature = base64 HMAC-SHA256 of
 * "<id>.<timestamp>.<raw body>" with the secret's bytes (`whsec_<base64>`), any of several space-separated `v1,<sig>`
 * entries matching, compared in constant time; the timestamp within 5 minutes of now. False on anything missing.
 * Pure (apart from the clock); exported for the tests.
 */
export function verifyStandardWebhook(secret: string | undefined, headers: Headers, rawBody: string, at = Date.now()): boolean {
  if (!secret || !secret.startsWith("whsec_")) return false;
  const id = headers.get("webhook-id") ?? headers.get("svix-id");
  const ts = headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
  const sigs = headers.get("webhook-signature") ?? headers.get("svix-signature");
  if (!id || !ts || !sigs || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(at / 1000 - Number(ts)) > TOLERANCE_S) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sigs.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}
