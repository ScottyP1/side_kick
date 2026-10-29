/**
 * Plain sentences for why a Teams post failed, for anything people read (the failed-posts finding on Home and a
 * group's Overview, lib/watchers.ts). `teams_post_failures.error` keeps Microsoft's raw error for support
 * (e.g. "AxiosError: Request failed with status code 403"); people never see library names or status codes.
 * Pure, no imports: safe anywhere and unit-tested in tests/db.test.mjs.
 */

/**
 * Turns a stored Teams error into one plain sentence. Reads the HTTP status when the error has one; network
 * failures and timeouts read as "couldn't be reached"; anything else gets a general sentence.
 */
export function teamsErrorText(error: string | null | undefined): string {
  const e = error ?? "";
  const status = Number(/status(?: code)?\s*:?\s*(\d{3})\b/i.exec(e)?.[1] ?? /\b([45]\d{2})\b/.exec(e)?.[1] ?? 0);
  if (status === 401) return "Teams didn't accept Sidekick's sign-in";
  if (status === 403) return "Teams refused the post (Sidekick may have been removed from the chat, or isn't allowed to post there)";
  if (status === 404) return "Teams couldn't find the chat any more";
  if (status === 429) return "Teams asked Sidekick to slow down";
  if (status >= 500) return "Teams was unavailable at the time";
  if (/timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(e)) return "Teams couldn't be reached";
  return "Teams didn't accept the post";
}
