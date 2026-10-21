/**
 * POST /api/directory/import: creates Sidekick accounts for people picked from the organization's Microsoft 365
 * directory. Body: `{ ids: string[] (Microsoft account ids, max 50), role, workspaces: string[] }`.
 * They sign in with Microsoft only (no temporary password). People already in Sidekick are added to the chosen
 * workspaces. Returns `{ added, skipped }` with a reason per skipped person.
 * Who: Org Owners/Admins (any role but Org Owner), Team Leads (Member/Viewer, into workspaces they lead).
 * Rules and auditing: `importPeople` in lib/directory.ts.
 */
import { handle, readJson } from "@/lib/api";
import { requireUser, ROLES, HttpError, type Role } from "@/lib/auth";
import { importPeople } from "@/lib/directory";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ ids?: unknown; role?: string; workspaces?: unknown }>(req);
  const role = (body.role ?? "Member") as Role;
  if (!ROLES.includes(role)) throw new HttpError(400, `“${String(body.role).slice(0, 40)}” isn't a role.`);
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
  const workspaces = Array.isArray(body.workspaces) ? body.workspaces.filter((w): w is string => typeof w === "string") : [];
  return importPeople(user, ids, role, workspaces);
});
