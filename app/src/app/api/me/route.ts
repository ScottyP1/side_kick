/**
 * GET /api/me: the signed-in user, their organization, branding, and the workspaces they can open.
 * The portal loads this first to build its menus and workspace picker. `user.admin` = Org Owner/Admin;
 * `user.lead` = Team Lead (manages people and Teams links in their own workspaces only). `billing` is what the
 * organization's plan allows right now (`mode` full | read_only) and the notice to show everyone, if any.
 * `ai.working` is plain-language status (no model or provider names: those are for the Owner Console).
 * `credit` (Org Owners, Org Admins and Billing Admins only) is this month's AI credit: level ok | warn
 * (80%+, the portal shows a banner) | essentials (used up) | unlimited, with the percent used.
 * `plan` is the plan's name, the connectors it includes (for the Connectors page) and its plan `features`
 * (`FeatureKey`s, lib/plans.ts; every feature for managed organizations), so pages can say "not in your plan"
 * next to a switch before anyone tries it (the server refuses with `assertFeature` either way).
 * `user.needsTwoStep`: the org requires two-step sign-in and this password session has none yet (the portal
 * then shows only the setup screen; lib/auth.ts). Works while a password change or that setup is pending.
 * `setupPending` (Org Owners and Admins only) is true while the setup wizard was opened but not finished.
 */
import { handle } from "@/lib/api";
import { isAdmin, isLead, requireUser, workspaceIdsFor } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { claudeConfigured } from "@/lib/claude";
import { orgAccess } from "@/lib/billing";
import { creditStatus } from "@/lib/credit";
import { orgPlan } from "@/lib/limits";
import { featuresOf } from "@/lib/plans";
import { setupPending } from "@/lib/setup";

const CREDIT_ROLES = ["Org Owner", "Org Admin", "Billing Admin"];

export const GET = handle(async () => {
  const user = await requireUser(undefined, { allowPendingPassword: true, allowPendingTwoStep: true });
  const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", user.org_id);
  const ids = await workspaceIdsFor(user);
  const workspaces = ids.length
    ? await all(`SELECT id, name, code, color FROM workspaces WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY name`, ...ids)
    : [];
  const settings = await get<{ json: string }>("SELECT json FROM settings WHERE org_id = ?", user.org_id);
  const [{ plan, limits }, credit] = await Promise.all([orgPlan(user.org_id), CREDIT_ROLES.includes(user.role) ? creditStatus(user.org_id) : null]);
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: Boolean(user.must_change_password), needsTwoStep: Boolean(user.needs_two_step), admin: isAdmin(user), lead: isLead(user) },
    org: { name: org?.name ?? "" },
    workspaces,
    ai: { working: claudeConfigured() },
    credit: credit && { level: credit.level, pct: Math.round(credit.pct) },
    plan: { name: plan?.name ?? null, connectors: limits.connectors, features: featuresOf(plan) },
    branding: settings ? JSON.parse(settings.json) : {},
    billing: await orgAccess(user.org_id),
    setupPending: isAdmin(user) ? await setupPending(user.org_id) : false,
  };
});
