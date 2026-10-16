/**
 * POST /api/ask: ask Sidekick a question in one workspace ({ ws, question, guests }).
 * Who: any member of the workspace. Returns the answer, whether it was found, and the cited sources (see ask() in sidekick.ts).
 */
import { handle, readJson, requireText } from "@/lib/api";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { ask } from "@/lib/sidekick";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ ws?: string; question?: string; guests?: boolean }>(req);
  const ws = await requireWorkspace(user, body.ws);
  const question = requireText(body.question, "Question", 1000);
  return ask(user, ws, question, Boolean(body.guests));
});
