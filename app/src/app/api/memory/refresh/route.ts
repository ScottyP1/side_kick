import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { refreshInsights } from "@/lib/sidekick";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const { ws } = await readJson<{ ws?: string }>(req);
  const id = requireWorkspace(user, ws);
  const out = await refreshInsights(user, id);
  if (!out) throw new HttpError(400, "Add documents or import a meeting first, so Sidekick has something to map.");
  return { ok: true };
});
