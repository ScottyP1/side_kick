/**
 * GET /api/me: the signed-in user, their organization, branding, and the workspaces they can open.
 * The portal loads this first to build its menus and workspace picker. `user.admin` = Org Owner/Admin;
 * `user.lead` = Team Lead (manages people and Teams links in their own workspaces only).
 */
import { handle } from "@/lib/api";
import { isAdmin, isLead, requireUser, workspaceIdsFor } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { claudeConfigured, MODELS } from "@/lib/claude";

export const GET = handle(async () => {
  const user = await requireUser();
  const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", user.org_id);
  const ids = await workspaceIdsFor(user);
  const workspaces = ids.length
    ? await all(`SELECT id, name, code, color FROM workspaces WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY name`, ...ids)
    : [];
  const settings = await get<{ json: string }>("SELECT json FROM settings WHERE org_id = ?", user.org_id);
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: Boolean(user.must_change_password), admin: isAdmin(user), lead: isLead(user) },
    org: { name: org?.name ?? "" },
    workspaces,
    claude: { configured: claudeConfigured(), models: MODELS },
    branding: settings ? JSON.parse(settings.json) : {},
  };
});
