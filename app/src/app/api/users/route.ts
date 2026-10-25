/**
 * GET/POST /api/users: list the organization's people (with whether each is linked to Microsoft sign-in, and
 * whether their password sign-in is locked after too many wrong passwords),
 * or add one with a temporary password (if the org uses Microsoft sign-in, they can use that instead).
 * Who: Org Owners and Org Admins for the whole organization; a Team Lead only for the workspaces they lead
 * (they see the people in those workspaces and add people to them as Member or Viewer). Audited.
 */
import crypto from "node:crypto";
import { assertCanAdd, assertFeature } from "@/lib/limits";
import { handle, readJson, requireText } from "@/lib/api";
import { audit, createUser, HttpError, isAdmin, isLead, LEAD_ASSIGNABLE_ROLES, managedWorkspaceIds, requireUser, ROLES, type Role, type User } from "@/lib/auth";
import { all, asSystem, get, run } from "@/lib/db";
import { lockedEmails } from "@/lib/login-limit";

/** Signed-in Org Owner, Org Admin or Team Lead, or 403. */
async function requireManager(): Promise<User> {
  const user = await requireUser();
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and Team Leads can manage people.");
  return user;
}

export const GET = handle(async () => {
  const user = await requireManager();
  const users = await all<{ id: string; email: string; workspaces?: string[] }>("SELECT id, name, email, role, last_active, must_change_password, CASE WHEN entra_oid IS NULL THEN 0 ELSE 1 END AS microsoft, created_at FROM users WHERE org_id = ? ORDER BY created_at", user.org_id);
  const members = await all<{ user_id: string; workspace_id: string }>(
    "SELECT wm.user_id, wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.org_id = ?",
    user.org_id,
  );
  const locked = await lockedEmails(users.map((u) => u.email));
  const withWs = users.map((u) => ({
    ...u,
    workspaces: members.filter((m) => m.user_id === u.id).map((m) => m.workspace_id),
    // Too many wrong passwords lately (lib/login-limit.ts); admins can unlock it.
    signin_locked: locked.has(u.email),
  }));
  if (isAdmin(user)) return { users: withWs };
  // A Team Lead sees only the people in their workspaces, and only those workspaces in each person's list.
  const mine = new Set(await managedWorkspaceIds(user));
  return {
    users: withWs
      .map((u) => ({ ...u, workspaces: u.workspaces.filter((w) => mine.has(w)) }))
      .filter((u) => u.id === user.id || u.workspaces.length),
  };
});

/**
 * Adds a person with a one-time temporary password (shown once to whoever added them).
 * A Team Lead must pick at least one of their workspaces and a Member or Viewer role. If the email
 * already belongs to a Member or Viewer of the same organization, a Team Lead adds that person to the
 * chosen workspaces instead (returns `{ id, existing: true }`, no password).
 * A new person counts against the plan's people limit (402 with `kind: "limit"` when it's reached), and
 * adding someone as Team Lead needs a plan with Team Leads (Team and up, same 402).
 */
export const POST = handle(async (req: Request) => {
  const admin = await requireManager();
  const body = await readJson<{ name?: string; email?: string; role?: string; workspaces?: string[] }>(req);
  const name = requireText(body.name, "Name", 120);
  const email = requireText(body.email, "Email", 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  const role = (body.role ?? "Member") as Role;
  if (role === "Org Owner") throw new HttpError(400, "Nobody can be added as Org Owner. Pick another role.");
  if (!ROLES.includes(role)) throw new HttpError(400, `“${String(body.role).slice(0, 40)}” isn't a role. Pick one of: ${ROLES.filter((r) => r !== "Org Owner").join(", ")}.`);
  const allowed = new Set(await managedWorkspaceIds(admin));
  const workspaces = (body.workspaces ?? []).filter((ws) => allowed.has(ws));
  if (isLead(admin)) {
    if (!LEAD_ASSIGNABLE_ROLES.includes(role)) throw new HttpError(403, "Team Leads can add people as Member or Viewer. Ask an Org Admin for other roles.");
    if (!workspaces.length) throw new HttpError(400, "Pick at least one of your workspaces for this person.");
  }
  // Emails are unique across every org, so this check looks across orgs (system work, lib/db.ts asSystem).
  const existing = await asSystem("email is unique across orgs", () => get<{ id: string; org_id: string; name: string; role: Role }>("SELECT id, org_id, name, role FROM users WHERE email = ?", email));
  if (existing && isLead(admin) && existing.org_id === admin.org_id && LEAD_ASSIGNABLE_ROLES.includes(existing.role)) {
    for (const ws of workspaces) await run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", ws, existing.id);
    await audit(admin, `Added ${existing.name} (${email}) to ${workspaces.length} of their workspaces`, "Access");
    return { id: existing.id, existing: true };
  }
  if (existing) throw new HttpError(409, "Someone with that email already has an account.");
  await assertCanAdd(admin.org_id, "seats");
  if (role === "Team Lead") await assertFeature(admin.org_id, "teamLeads");
  const temp = crypto.randomBytes(9).toString("base64url");
  const id = await createUser(admin.org_id, name, email, role, temp, true);
  for (const ws of workspaces) await run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", ws, id);
  await audit(admin, `Added ${name} (${email}) as ${role}`, "Access");
  return { id, tempPassword: temp };
});
