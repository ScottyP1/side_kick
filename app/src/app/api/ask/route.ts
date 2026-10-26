/**
 * /api/ask: Ask Sidekick in one group (the Knowledge page). Who: any member of the group (`requireWorkspace`).
 *
 * POST { ws, question (max 1,000 chars), guests?, conversation?, newQuestion?, types?, since?, until? } → the answer,
 *   whether it was found, the cited sources (group and firm library, with origin, date and outdated flag),
 *   `conflict`, `questionId` (for 👍/👎), `conversation` (send it back with the next question so a follow-up builds
 *   on this one), `followUp` (the earlier question it built on) and `access` (notes such as "Connect your Jira to
 *   include its tickets" when a connection in "each person signs in" mode had relevant items this person can't be
 *   shown: lib/connector-access.ts). `types` filters the sources ("documents",
 *   "meetings", "chats", "decisions", "firm"); `since`/`until` are YYYY-MM-DD days. See ask() in lib/sidekick.ts.
 * GET ?ws=&guests=1&conversation=id → { conversation, turns } to show the conversation again after a page change.
 * DELETE ?ws=&guests=1&conversation=id → { ended } ("New question": forgets the conversation).
 * Conversations are per person, per group and per guests setting; anyone else's id is simply not found.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { parseDay } from "@/lib/firm";
import { FILTER_TYPES, type SourceFilter } from "@/lib/search";
import { ask, askConversation, endAskConversation } from "@/lib/sidekick";

/** The type filters asked for, refusing unknown ones (400). */
function typeFilters(value: unknown): SourceFilter[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((t) => typeof t !== "string" || !(t in FILTER_TYPES))) {
    throw new HttpError(400, `Filter by any of: ${Object.keys(FILTER_TYPES).join(", ")}.`);
  }
  return value as SourceFilter[];
}

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ ws?: string; question?: string; guests?: boolean; conversation?: unknown; newQuestion?: boolean; types?: unknown; since?: unknown; until?: unknown }>(req);
  const ws = await requireWorkspace(user, body.ws);
  const question = requireText(body.question, "Question", 1000);
  const since = parseDay(body.since, "From date");
  const until = parseDay(body.until, "To date");
  if (since && until && since > until) throw new HttpError(400, "The From date must be before the To date.");
  return ask(user, ws, question, Boolean(body.guests), "portal", { conversation: body.conversation, newQuestion: Boolean(body.newQuestion), types: typeFilters(body.types), since, until });
});

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const q = new URL(req.url).searchParams;
  const ws = await requireWorkspace(user, q.get("ws"));
  return askConversation(user, ws, q.get("guests") === "1", q.get("conversation"));
});

export const DELETE = handle(async (req: Request) => {
  const user = await requireUser();
  const q = new URL(req.url).searchParams;
  const ws = await requireWorkspace(user, q.get("ws"));
  return { ended: await endAskConversation(user, ws, q.get("guests") === "1", { conversation: q.get("conversation") }) };
});
