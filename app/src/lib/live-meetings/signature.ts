/**
 * @file Webhook signatures for the live-meeting providers (lib/live-meetings/provider.ts): the Standard Webhooks scheme
 * that Recall.ai and Svix use, and Attendee's HMAC over canonical JSON. Pure apart from the clock, no imports from the app, so the tests' fake provider and the
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

/**
 * JSON as Python writes it with `json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":"))`: keys sorted
 * at every level, no spaces, non-ASCII kept. What Attendee signs. (Floats like 1.0 print as "1" in JavaScript but
 * "1.0" in Python; Attendee's webhook payloads use whole-number milliseconds, but check on the first real run.)
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Checks an Attendee webhook (https://docs.attendee.dev, "Verifying Webhooks"), the way the shim inside the meeting
 * bot's container checks what its local Attendee sends it (meetbot/shim keeps the same rule): header `X-Webhook-Signature` = base64
 * HMAC-SHA256 of the canonical JSON of the body (`canonicalJson`) with the base64-decoded secret, compared in constant
 * time. False on anything missing or unreadable. Pure; exported for the tests.
 */
export function verifyAttendeeWebhook(secret: string | undefined, headers: Headers, rawBody: string): boolean {
  const sig = headers.get("x-webhook-signature");
  if (!secret || !sig) return false;
  let body: unknown;
  let key: Buffer;
  try {
    body = JSON.parse(rawBody);
    key = Buffer.from(secret, "base64");
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = crypto.createHmac("sha256", key).update(canonicalJson(body)).digest();
  const got = Buffer.from(sig, "base64");
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/**
 * Checks an event from Sidekick's own meeting bot (the shim in its container, meetbot/shim): headers
 * `x-sidekick-bot-session`, `x-sidekick-bot-timestamp` (seconds), `x-sidekick-bot-signature: v1,<base64 HMAC-SHA256 of
 * "<timestamp>.<raw body>" with that session's key>`, within 5 minutes; and the body's `bot_id` must be that session,
 * so a container can only speak for its own meeting. `keyFor` derives the session's key. Pure apart from the clock.
 */
export function verifyBotEvent(keyFor: (session: string) => string, headers: Headers, rawBody: string, at = Date.now()): boolean {
  const session = headers.get("x-sidekick-bot-session");
  const ts = headers.get("x-sidekick-bot-timestamp");
  const sig = headers.get("x-sidekick-bot-signature");
  if (!session || !ts || !sig || !/^\d{1,12}$/.test(ts) || !/^[\w-]{1,80}$/.test(session)) return false;
  if (Math.abs(at / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const expected = crypto.createHmac("sha256", keyFor(session)).update(`${ts}.${rawBody}`).digest();
  const [version, value] = sig.split(",");
  const got = Buffer.from(value ?? "", "base64");
  if (version !== "v1" || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return false;
  try {
    const body = JSON.parse(rawBody) as unknown;
    const items = Array.isArray(body) ? body : [body];
    return items.every((i) => i && typeof i === "object" && (i as { bot_id?: unknown }).bot_id === session);
  } catch {
    return false;
  }
}

/** Whether `token` is `key` (constant time): the bot's command fetches send their session key as a bearer token. */
export function sameKey(token: string | null | undefined, key: string): boolean {
  const a = Buffer.from(token ?? "");
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
