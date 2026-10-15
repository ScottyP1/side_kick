import { handle, readJson } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { get, run } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };
const STATUSES = ["Open", "In progress", "Done"];

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't change action items.");
  const a = get<{ id: string; workspace_id: string; text: string }>("SELECT id, workspace_id, text FROM action_items WHERE id = ? AND org_id = ?", (await params).id, user.org_id);
  if (!a) throw new HttpError(404, "Action item not found.");
  requireWorkspace(user, a.workspace_id);
  const body = await readJson<{ status?: string; owner?: string; due?: string }>(req);
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, "Unknown status.");
    run("UPDATE action_items SET status = ? WHERE id = ?", body.status, a.id);
  }
  if (body.owner !== undefined) run("UPDATE action_items SET owner = ? WHERE id = ?", body.owner.trim() || null, a.id);
  if (body.due !== undefined) run("UPDATE action_items SET due = ? WHERE id = ?", body.due.trim() || null, a.id);
  audit(user, `Updated action item “${a.text.slice(0, 60)}”`, "Data", a.workspace_id);
  return { ok: true };
});
