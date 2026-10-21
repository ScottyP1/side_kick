/**
 * @file Per-person rate limits, such as questions per hour, so one person (or a stuck script) can't burn
 * through the organization's AI credit.
 *
 * Concepts
 * - **Bucket**: what is being counted, e.g. `ask:<user id>` (portal and Teams count together, since
 *   both go through `ask()` in lib/sidekick.ts).
 * - **Stored in the database** (`rate_events`), like the sign-in limit in lib/login-limit.ts, so the limit
 *   holds when Sidekick runs as several copies and survives restarts. Rows older than two hours are cleared.
 * - **Questions per hour**: `ASK_PER_HOUR` (60, or `SIDEKICK_ASK_PER_HOUR`), or a number the Sidekick team
 *   set for the organization in the Owner Console (`org_terms.ask_per_hour`).
 */
import "server-only";
import { HttpError } from "./auth";
import { get, newId, now, run } from "./db";
import { orgTerms } from "./limits";

/** Default questions per person per hour. */
export const ASK_PER_HOUR = Number(process.env.SIDEKICK_ASK_PER_HOUR) || 60;

/**
 * Counts one hit in `bucket` and refuses (429, with `message`) when there were already `limit` hits in
 * the last `windowMinutes`. A refused hit isn't counted, so waiting always works.
 */
export async function takeHit(bucket: string, limit: number, windowMinutes: number, message: string) {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const n = Number((await get<{ n: number | string }>("SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND created_at > ?", bucket, since))?.n ?? 0);
  if (n >= limit) throw new HttpError(429, message);
  await run("INSERT INTO rate_events (id, bucket, created_at) VALUES (?, ?, ?)", newId(), bucket, now());
  if (Math.random() < 0.02) await run("DELETE FROM rate_events WHERE created_at < ?", new Date(Date.now() - 2 * 3600_000).toISOString());
}

/** One question by this person: refuses with a friendly 429 past the hourly limit. Called by `ask()`. */
export async function takeQuestion(orgId: string, userId: string) {
  const limit = (await orgTerms(orgId)).askPerHour ?? ASK_PER_HOUR;
  await takeHit(`ask:${userId}`, limit, 60, `You've asked ${limit} questions in the last hour, which is the most Sidekick takes from one person. Take a short break and ask again in a few minutes.`);
}
