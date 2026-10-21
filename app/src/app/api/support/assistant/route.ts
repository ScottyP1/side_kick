/**
 * The support assistant ("Help" chat: bottom-left button → I need help). Who: anyone signed in; what it checks
 * and the fixes it offers depend on the person's role (lib/support-assistant.ts). Fixes are never run here:
 * Confirm in the browser calls the regular route for that fix.
 *
 * POST { message (max 1,000 chars), conversation?: id, page?: the portal path they're on } →
 *   { conversation, reply, sources, action, checks, followUp, refused }
 * GET ?conversation=id → { conversation: id | null, turns } (to show it again after a page change).
 * DELETE ?conversation=id → forgets it ("New conversation").
 */
import { handle, readJson, requireText } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { supportAnswer } from "@/lib/support-assistant";
import { endConversation, findConversation, turnsForBrowser } from "@/lib/conversations";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ message?: string; conversation?: unknown; page?: unknown }>(req);
  const message = requireText(body.message, "Message", 1000);
  const page = typeof body.page === "string" && /^\/[\w\-/]*$/.test(body.page) ? body.page.slice(0, 120) : null;
  return supportAnswer(user, message, body.conversation, page);
});

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const conv = await findConversation("support", { orgId: user.org_id, userId: user.id }, new URL(req.url).searchParams.get("conversation"));
  return { conversation: conv?.id ?? null, turns: turnsForBrowser(conv) };
});

export const DELETE = handle(async (req: Request) => {
  const user = await requireUser();
  return { ended: await endConversation("support", { orgId: user.org_id, userId: user.id }, new URL(req.url).searchParams.get("conversation")) };
});
