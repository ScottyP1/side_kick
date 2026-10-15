/**
 * GET /api/me: the signed-in user, their organization, branding, and the workspaces they can open.
 * The portal loads this first to build its menus and workspace picker.
 */
import { handle } from "@/lib/api";
import { isAdmin, requireUser, workspaceIdsFor } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { claudeConfigured, MODELS } from "@/lib/claude";

export const GET = handle(async () => {
  const user = await requireUser();
  const org = get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", user.org_id);
  const ids = workspaceIdsFor(user);
  const workspaces = ids.length
    ? all(`SELECT id, name, code, color FROM workspaces WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY name`, ...ids)
    : [];
  const settings = get<{ json: string }>("SELECT json FROM settings WHERE org_id = ?", user.org_id);
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: Boolean(user.must_change_password), admin: isAdmin(user) },
    org: { name: org?.name ?? "" },
    workspaces,
    claude: { configured: claudeConfigured(), models: MODELS },
    branding: settings ? JSON.parse(settings.json) : {},
  };
});
