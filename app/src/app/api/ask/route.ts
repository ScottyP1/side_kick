import { handle, readJson, requireText } from "@/lib/api";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { ask } from "@/lib/sidekick";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ ws?: string; question?: string; guests?: boolean }>(req);
  const ws = requireWorkspace(user, body.ws);
  const question = requireText(body.question, "Question", 1000);
  return ask(user, ws, question, Boolean(body.guests));
});
