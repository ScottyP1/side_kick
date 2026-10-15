import { handle, readJson } from "@/lib/api";
import { audit, HttpError, requireUser, ROLES, type Role } from "@/lib/auth";
import { all, get, run, tx } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

async function load(id: string) {
  const admin = await requireUser(["Org Owner", "Org Admin"]);
  const target = get<{ id: string; name: string; role: Role }>("SELECT id, name, role FROM users WHERE id = ? AND org_id = ?", id, admin.org_id);
  if (!target) throw new HttpError(404, "Person not found.");
  if (target.role === "Org Owner") throw new HttpError(403, "The Org Owner can't be changed here.");
  return { admin, target };
}

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { admin, target } = await load((await params).id);
  const body = await readJson<{ role?: string; workspaces?: string[] }>(req);
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role as Role) || body.role === "Org Owner") throw new HttpError(400, "Pick a valid role.");
    run("UPDATE users SET role = ? WHERE id = ?", body.role, target.id);
    audit(admin, `Changed ${target.name}'s role to ${body.role}`, "Access");
  }
  if (body.workspaces !== undefined) {
    const allowed = new Set(all<{ id: string }>("SELECT id FROM workspaces WHERE org_id = ?", admin.org_id).map((w) => w.id));
    tx(() => {
      run("DELETE FROM workspace_members WHERE user_id = ?", target.id);
      for (const ws of body.workspaces!) if (allowed.has(ws)) run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?)", ws, target.id);
    });
    audit(admin, `Updated ${target.name}'s workspaces`, "Access");
  }
  return { ok: true };
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const { admin, target } = await load((await params).id);
  run("DELETE FROM users WHERE id = ?", target.id);
  audit(admin, `Removed ${target.name}`, "Access");
  return { ok: true };
});
