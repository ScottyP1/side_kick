/**
 * POST /api/assistant: one message to the in-app assistant (the chat box on the home page).
 * Who: anyone signed in. What Claude may suggest depends on the person's role (see lib/assistant.ts);
 * suggestions are never run here: the browser shows a confirm card and, on Confirm, calls the regular
 * API route for that action, which checks the role again and writes the audit log.
 *
 * Body: { message: string (max 1,000 chars), history?: { role: "user"|"assistant", text }[] (last 8 used) }
 * Returns: { reply: string, action: ReadyAction | null }
 */
import { handle, readJson, requireText } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { assist, type Turn } from "@/lib/assistant";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ message?: string; history?: unknown }>(req);
  const message = requireText(body.message, "Message", 1000);
  const history: Turn[] = (Array.isArray(body.history) ? body.history : [])
    .filter((t): t is Turn => (t?.role === "user" || t?.role === "assistant") && typeof t?.text === "string")
    .slice(-8)
    .map((t) => ({ role: t.role, text: t.text.slice(0, 1500) }));
  return assist(user, message, history);
});
