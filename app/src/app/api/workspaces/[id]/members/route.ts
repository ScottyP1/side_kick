/**
 * GET/POST/DELETE /api/workspaces/:id/members: who is in a group (workspace), add people already in the
 * organization to it, or take someone off it.
 * Who: anyone in the group can see its people (emails only for those who manage it); Org Owners and Org
 * Admins, and the group's Team Lead, add and remove, and may ask for `?candidates=1`: the organization's
 * people who aren't in the group yet and whom the caller may add (for a Team Lead, Members and Viewers only). A Team Lead may only add or remove Members and
 * Viewers, and can't take themselves off. Groups of another organization, or ones the caller can't see,
 * are 404. Every change is audited.
 *
 * New people (not yet in the organization) are added with POST /api/users; importing them from the
 * Microsoft 365 directory comes with the directory import.
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, isAdmin, isLead, LEAD_ASSIGNABLE_ROLES, requireManage, requireUser, requireWorkspace, type Role, type User } from "@/lib/auth";
import { all, get, run } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };
type Person = { id: string; name: string; email: string; role: Role; microsoft: number };

/** The group's name, scoped to the caller's organization. */
async function groupName(user: User, id: string): Promise<string> {
  return (await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ? AND org_id = ?", id, user.org_id))!.name;
}

/**
 * The group's people, Team Leads first. `canManage` says whether the caller may add or remove people.
 * With `?candidates=1` (managers only, else 403): `{ candidates }`, the people of the caller's organization
 * not in the group yet that the caller may add. Org Owners and Org Admins get everyone else; a Team Lead gets
 * only Members and Viewers (the roles they can add), never admins or other Team Leads.
 * This is the "Add people" picker's list: GET /api/users only shows a Team Lead the people already in their
 * groups, so it can't offer anyone new to the group.
 */
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  if (new URL(req.url).searchParams.get("candidates")) {
    const ws = await requireManage(user, (await params).id);
    const roles = isAdmin(user) ? null : LEAD_ASSIGNABLE_ROLES;
    const candidates = await all<Person>(
      `SELECT u.id, u.name, u.email, u.role, CASE WHEN u.entra_oid IS NULL THEN 0 ELSE 1 END AS microsoft
         FROM users u
        WHERE u.org_id = ? AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = ? AND wm.user_id = u.id)
          ${roles ? `AND u.role IN (${roles.map(() => "?").join(",")})` : ""}
        ORDER BY u.name`,
      user.org_id, ws, ...(roles ?? []),
    );
    return { candidates };
  }
  const ws = await requireWorkspace(user, (await params).id);
  const canManage = isAdmin(user) || isLead(user);
  const people = await all<Person>(
    `SELECT u.id, u.name, u.email, u.role, CASE WHEN u.entra_oid IS NULL THEN 0 ELSE 1 END AS microsoft
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? AND u.org_id = ?
      ORDER BY CASE u.role WHEN 'Team Lead' THEN 0 WHEN 'Org Owner' THEN 1 WHEN 'Org Admin' THEN 2 ELSE 3 END, u.name`,
    ws, user.org_id,
  );
  return { canManage, members: people.map((p) => (canManage ? p : { ...p, email: undefined })) };
});

/** Adds people already in the organization: `{ users: [userId, ...] }`. Returns how many were added. */
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const ws = await requireManage(user, (await params).id);
  const body = await readJson<{ users?: unknown }>(req);
  const ids = Array.isArray(body.users) ? [...new Set(body.users.filter((u): u is string => typeof u === "string"))] : [];
  if (!ids.length) throw new HttpError(400, "Pick at least one person.");
  if (ids.length > 500) throw new HttpError(400, "Add at most 500 people at once.");
  const people = await all<{ id: string; name: string; role: Role }>(`SELECT id, name, role FROM users WHERE org_id = ? AND id IN (${ids.map(() => "?").join(",")})`, user.org_id, ...ids);
  if (people.length !== ids.length) throw new HttpError(404, "Person not found.");
  if (isLead(user) && people.some((p) => !LEAD_ASSIGNABLE_ROLES.includes(p.role))) {
    throw new HttpError(403, "Team Leads can add Members and Viewers. Ask an Org Admin to add other roles.");
  }
  let added = 0;
  for (const p of people) added += (await run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", ws, p.id)).changes;
  const name = await groupName(user, ws);
  if (added) await audit(user, `Added ${people.length === 1 ? people[0].name : `${added} people`} to “${name}”`, "Access", ws);
  return { added };
});

/** Takes one person off the group: `?user=<id>`. Their account and other groups stay as they are. */
export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const ws = await requireManage(user, (await params).id);
  const id = new URL(req.url).searchParams.get("user");
  const target = id
    ? await get<{ id: string; name: string; role: Role }>(
        "SELECT u.id, u.name, u.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND u.id = ? AND u.org_id = ?",
        ws, id, user.org_id,
      )
    : undefined;
  if (!target) throw new HttpError(404, "That person isn't in this group.");
  if (isLead(user) && target.id === user.id) throw new HttpError(403, "You can't take yourself off a group you lead. Ask an Org Admin.");
  if (isLead(user) && !LEAD_ASSIGNABLE_ROLES.includes(target.role)) throw new HttpError(403, "Team Leads can take Members and Viewers off their group. Ask an Org Admin for anyone else.");
  await run("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?", ws, target.id);
  // Their own sign-ins to this group's tools go too (lib/connector-access.ts; the watcher also tidies other removals).
  await run("DELETE FROM connector_user_tokens WHERE workspace_id = ? AND user_id = ? AND org_id = ?", ws, target.id, user.org_id);
  await audit(user, `Took ${target.name} off “${await groupName(user, ws)}”`, "Access", ws);
  return { ok: true };
});
