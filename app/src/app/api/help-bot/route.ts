/**
 * "Ask about Sidekick", the public help bot (website, no sign-in). Every rule it follows is listed in
 * lib/helpbot.ts. The visitor's conversation is tied to a random browser cookie (`sk_visitor`).
 *
 * POST { message (max 500 chars), conversation?: id } → { conversation, mode: "answer" | "faq", reply,
 *   sources, faq?, followUp, dontKnow }. Limits, the daily budget and a paused switch come back as a calm
 *   reply or FAQ mode, never as an error.
 * GET ?conversation=id → { conversation: id | null, turns } (to show it again on the next page).
 * DELETE ?conversation=id → forgets it ("New conversation").
 */
import { handle, readJson } from "@/lib/api";
import { endConversation, turnsForBrowser } from "@/lib/conversations";
import { helpbotAnswer, visitorConversation, visitorId } from "@/lib/helpbot";

export const POST = handle(async (req: Request) => {
  const body = await readJson<{ message?: unknown; conversation?: unknown }>(req);
  return helpbotAnswer(body.message, body.conversation);
}, { system: "public help bot" });

export const GET = handle(async (req: Request) => {
  const conv = await visitorConversation(new URL(req.url).searchParams.get("conversation"));
  return { conversation: conv?.id ?? null, turns: turnsForBrowser(conv) };
}, { system: "public help bot" });

export const DELETE = handle(async (req: Request) => {
  const visitor = await visitorId(false);
  return { ended: visitor ? await endConversation("helpbot", { visitorId: visitor }, new URL(req.url).searchParams.get("conversation")) : false };
}, { system: "public help bot" });
