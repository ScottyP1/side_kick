/**
 * The in-app assistant (the chat on the home page and behind the bottom-left assistant button).
 * Who: anyone signed in. What Claude may suggest depends on the person's role (see lib/assistant.ts);
 * suggestions are never run here: the browser shows a confirm card and, on Confirm, calls the regular
 * API route for that action, which checks the role again and writes the audit log.
 *
 * POST { message: string (max 1,000 chars), conversation?: id } → { reply, action: ReadyAction | null,
 *   conversation, followUp: earlier question this one built on | null }. The conversation's turns are kept on
 *   the server for 24 hours (lib/conversations.ts); a `history` sent by older pages is ignored.
 * GET ?conversation=id → { conversation: id | null, turns } to show the conversation again on another page.
 * DELETE ?conversation=id → forgets it ("New conversation").
 */
import { handle, readJson, requireText } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { assist } from "@/lib/assistant";
import { endConversation, findConversation, turnsForBrowser } from "@/lib/conversations";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ message?: string; conversation?: unknown }>(req);
  const message = requireText(body.message, "Message", 1000);
  return assist(user, message, body.conversation);
});

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const conv = await findConversation("assist", { orgId: user.org_id, userId: user.id }, new URL(req.url).searchParams.get("conversation"));
  return { conversation: conv?.id ?? null, turns: turnsForBrowser(conv) };
});

export const DELETE = handle(async (req: Request) => {
  const user = await requireUser();
  return { ended: await endConversation("assist", { orgId: user.org_id, userId: user.id }, new URL(req.url).searchParams.get("conversation")) };
});
