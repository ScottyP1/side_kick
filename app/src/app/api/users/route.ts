/**
 * GET/POST /api/users: list the organization's people, or add one with a temporary password.
 * Who: Org Owners and Org Admins. Audited.
 */
import crypto from "node:crypto";
import { handle, readJson, requireText } from "@/lib/api";
import { audit, createUser, HttpError, requireUser, ROLES, type Role } from "@/lib/auth";
import { all, get, run } from "@/lib/db";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const users = all("SELECT id, name, email, role, last_active, must_change_password, created_at FROM users WHERE org_id = ? ORDER BY created_at", user.org_id);
  const members = all<{ user_id: string; workspace_id: string }>(
    "SELECT wm.user_id, wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.org_id = ?",
    user.org_id,
  );
  return { users: users.map((u) => ({ ...u, workspaces: members.filter((m) => m.user_id === u.id).map((m) => m.workspace_id) })) };
});

// Adds a person with a one-time temporary password (shown once to the admin). Step 2 replaces this with Microsoft sign-in.
export const POST = handle(async (req: Request) => {
  const admin = await requireUser(["Org Owner", "Org Admin"]);
  const body = await readJson<{ name?: string; email?: string; role?: string; workspaces?: string[] }>(req);
  const name = requireText(body.name, "Name", 120);
  const email = requireText(body.email, "Email", 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  const role = (body.role ?? "Member") as Role;
  if (!ROLES.includes(role) || role === "Org Owner") throw new HttpError(400, "Pick a role other than Org Owner.");
  if (get("SELECT id FROM users WHERE email = ?", email)) throw new HttpError(409, "Someone with that email already has an account.");
  const temp = crypto.randomBytes(9).toString("base64url");
  const id = createUser(admin.org_id, name, email, role, temp, true);
  const allowed = new Set(all<{ id: string }>("SELECT id FROM workspaces WHERE org_id = ?", admin.org_id).map((w) => w.id));
  for (const ws of body.workspaces ?? []) if (allowed.has(ws)) run("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id) VALUES (?, ?)", ws, id);
  audit(admin, `Added ${name} (${email}) as ${role}`, "Access");
  return { id, tempPassword: temp };
});
