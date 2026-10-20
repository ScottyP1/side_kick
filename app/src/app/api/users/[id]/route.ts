/**
 * PATCH/DELETE /api/users/:id: change a person's role or workspaces, or remove them.
 * Who: Org Owners and Org Admins. Nobody can be made Org Owner here. A Team Lead may only change which of
 * *their* workspaces a Member or Viewer is in (their other workspaces stay as they are); changing roles
 * and removing people from the organization stay with admins. Nobody changes their own role or removes
 * themselves (so an Org Admin can't lock themselves out by accident; the Org Owner or another Org Admin
 * does it). Audited.
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, isAdmin, isLead, LEAD_ASSIGNABLE_ROLES, managedWorkspaceIds, requireUser, ROLES, type Role } from "@/lib/auth";
import { all, get, run, tx } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/** The signed-in admin or Team Lead and the person they're changing (404 if not visible to them). */
async function load(id: string) {
  const admin = await requireUser();
  if (!isAdmin(admin) && !isLead(admin)) throw new HttpError(403, "Only Org Owners, Org Admins and Team Leads can manage people.");
  const target = await get<{ id: string; name: string; role: Role }>("SELECT id, name, role FROM users WHERE id = ? AND org_id = ?", id, admin.org_id);
  if (!target) throw new HttpError(404, "Person not found.");
  if (isLead(admin)) {
    // Team Leads only see people in their own workspaces (same rule as GET /api/users).
    const mine = await managedWorkspaceIds(admin);
    const shared = mine.length
      ? await get(`SELECT 1 AS x FROM workspace_members WHERE user_id = ? AND workspace_id IN (${mine.map(() => "?").join(",")})`, target.id, ...mine)
      : undefined;
    if (!shared) throw new HttpError(404, "Person not found.");
  }
  if (target.role === "Org Owner") throw new HttpError(403, "The Org Owner can't be changed here.");
  return { admin, target };
}

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { admin, target } = await load((await params).id);
  const body = await readJson<{ role?: string; workspaces?: string[] }>(req);
  const lead = isLead(admin);
  if (lead && (body.role !== undefined || !LEAD_ASSIGNABLE_ROLES.includes(target.role))) {
    throw new HttpError(403, "Team Leads can change which of their workspaces a Member or Viewer is in. Ask an Org Admin to change roles.");
  }
  if (body.role !== undefined) {
    if (target.id === admin.id && body.role !== target.role) throw new HttpError(403, "You can't change your own role. Ask the Org Owner or another Org Admin.");
    if (!ROLES.includes(body.role as Role) || body.role === "Org Owner") throw new HttpError(400, "Pick a valid role.");
    await run("UPDATE users SET role = ? WHERE id = ?", body.role, target.id);
    await audit(admin, `Changed ${target.name}'s role to ${body.role}`, "Access");
  }
  if (body.workspaces !== undefined) {
    const allowed = new Set(await managedWorkspaceIds(admin));
    await tx(async () => {
      // Only the workspaces this person manages are replaced; a Team Lead never touches the others.
      const current = (await all<{ workspace_id: string }>("SELECT workspace_id FROM workspace_members WHERE user_id = ?", target.id)).map((r) => r.workspace_id);
      for (const ws of current) if (allowed.has(ws)) await run("DELETE FROM workspace_members WHERE user_id = ? AND workspace_id = ?", target.id, ws);
      for (const ws of body.workspaces!) if (allowed.has(ws)) await run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", ws, target.id);
    });
    await audit(admin, `Updated ${target.name}'s workspaces`, "Access");
  }
  return { ok: true };
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  // Role first (before looking the person up), like every other route.
  const me = await requireUser();
  if (!isAdmin(me)) {
    throw new HttpError(403, isLead(me)
      ? "Only Org Owners and Org Admins can remove people from the organization. You can take them off your workspaces instead."
      : "Only Org Owners and Org Admins can remove people from the organization.");
  }
  const { admin, target } = await load((await params).id);
  if (target.id === admin.id) throw new HttpError(403, "You can't remove yourself. Ask the Org Owner or another Org Admin.");
  await run("DELETE FROM users WHERE id = ?", target.id);
  await audit(admin, `Removed ${target.name}`, "Access");
  return { ok: true };
});
