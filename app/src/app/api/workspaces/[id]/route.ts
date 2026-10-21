/**
 * GET/PATCH/DELETE /api/workspaces/:id: what a workspace holds (for the delete confirmation), rename it or
 * change its engagement code, or delete it with everything in it (see lib/workspaces.ts).
 * Who: Org Owners and Org Admins only (the role is checked before the workspace is looked up, so other
 * roles always get a plain 403). Workspaces of another organization are 404. Every change is audited.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { audit, HttpError, isAdmin, requireUser, requireWorkspace, type User } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { assertUniqueName, deleteWorkspace, MAX_CODE, MAX_NAME, workspaceContents } from "@/lib/workspaces";

type Ctx = { params: Promise<{ id: string }> };

/** The workspace, after the role check and the workspace wall. */
async function load(id: string, action: string): Promise<{ user: User; ws: { id: string; name: string; code: string | null } }> {
  const user = await requireUser();
  if (!isAdmin(user)) throw new HttpError(403, `Only Org Owners and Org Admins can ${action} workspaces.`);
  await requireWorkspace(user, id);
  const ws = await get<{ id: string; name: string; code: string | null }>("SELECT id, name, code FROM workspaces WHERE id = ? AND org_id = ?", id, user.org_id);
  if (!ws) throw new HttpError(404, "Workspace not found, or you're not a member of it.");
  return { user, ws };
}

/** Counts of what deleting the workspace would remove. */
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { user, ws } = await load((await params).id, "delete");
  return { name: ws.name, contents: await workspaceContents(user.org_id, ws.id) };
});

/** Rename and/or change the engagement code ({ name?, code? }; an empty code clears it). */
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { user, ws } = await load((await params).id, "rename");
  const body = await readJson<{ name?: string; code?: string | null }>(req);
  const name = body.name === undefined ? ws.name : requireText(body.name, "Workspace name", MAX_NAME);
  let code = ws.code;
  if (body.code !== undefined) {
    if (body.code !== null && typeof body.code !== "string") throw new HttpError(400, "Engagement code must be text.");
    code = body.code?.trim() || null;
    if (code && code.length > MAX_CODE) throw new HttpError(400, `Engagement code is too long (max ${MAX_CODE} characters).`);
  }
  if (name !== ws.name) await assertUniqueName(user.org_id, name, ws.id);
  await run("UPDATE workspaces SET name = ?, code = ? WHERE id = ? AND org_id = ?", name, code, ws.id, user.org_id);
  if (name !== ws.name) await audit(user, `Renamed workspace “${ws.name}” to “${name}”`, "Access", ws.id);
  if (code !== ws.code) await audit(user, `Changed the engagement code of “${name}” from ${ws.code ?? "none"} to ${code ?? "none"}`, "Access", ws.id);
  return { id: ws.id, name, code };
});

/** Delete the workspace and everything in it. Can't be undone. */
export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { user, ws } = await load((await params).id, "delete");
  const contents = await workspaceContents(user.org_id, ws.id);
  const { unlinked } = await deleteWorkspace(user.org_id, ws.id);
  await audit(
    user,
    `Deleted workspace “${ws.name}” with ${contents.documents} document(s), ${contents.meetings} meeting(s) and everything else in it${unlinked ? `; unlinked ${unlinked} Teams chat(s)` : ""}`,
    "Access",
    null,
  );
  return { ok: true };
});
