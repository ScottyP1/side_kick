/**
 * POST /api/memory/refresh: rebuild a workspace's knowledge map (topics, coverage, gaps) with Claude.
 * Who: workspace members who can edit content (not Viewers or Billing Admins), because every refresh is a
 * paid Claude call. The portal hides the button for those roles; this check enforces it on the server.
 */
import { handle, readJson } from "@/lib/api";
import { canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { refreshInsights } from "@/lib/sidekick";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't refresh the knowledge map. Ask a Member or an Org Admin.");
  const { ws } = await readJson<{ ws?: string }>(req);
  const id = requireWorkspace(user, ws);
  const out = await refreshInsights(user, id);
  if (!out) throw new HttpError(400, "Add documents or import a meeting first, so Sidekick has something to map.");
  return { ok: true };
});
