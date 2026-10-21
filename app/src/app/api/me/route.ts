/**
 * GET /api/me: the signed-in user, their organization, branding, and the workspaces they can open.
 * The portal loads this first to build its menus and workspace picker. `user.admin` = Org Owner/Admin;
 * `user.lead` = Team Lead (manages people and Teams links in their own workspaces only). `billing` is what the
 * organization's plan allows right now (`mode` full | read_only) and the notice to show everyone, if any.
 * `setupPending` (Org Owners and Admins only) is true while the setup wizard was opened but not finished.
 */
import { handle } from "@/lib/api";
import { isAdmin, isLead, requireUser, workspaceIdsFor } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { claudeConfigured, MODELS } from "@/lib/claude";
import { orgAccess } from "@/lib/billing";
import { setupPending } from "@/lib/setup";

export const GET = handle(async () => {
  const user = await requireUser(undefined, { allowPendingPassword: true });
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
    billing: await orgAccess(user.org_id),
    setupPending: isAdmin(user) ? await setupPending(user.org_id) : false,
  };
});
