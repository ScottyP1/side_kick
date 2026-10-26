/**
 * Settings → Microsoft permissions (lib/graph-permissions.ts).
 * - GET: the checklist: every Microsoft permission Sidekick asks for, what it unlocks and whether the
 *   organization's Microsoft admin approved it (from the last Check now and refusals features recorded; never
 *   calls Microsoft). Org Owners, Org Admins and Team Leads (read-only, `canAct: false`); others 403.
 * - POST: "Check now": asks Microsoft once which permissions are granted (the app token's `roles` claim), keeps
 *   and audits the answer, and returns the checklist. Org Owners and Org Admins only.
 * Approving is the admin-consent round trip: GET /api/auth/microsoft/consent?from=settings.
 */
import { handle } from "@/lib/api";
import { HttpError, isAdmin, isLead, requireUser } from "@/lib/auth";
import { checkPermissions, permissionsStatus } from "@/lib/graph-permissions";

export const GET = handle(async () => {
  const user = await requireUser();
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and Team Leads can see the Microsoft permissions.");
  return permissionsStatus(user, { canAct: isAdmin(user) });
});

export const POST = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const result = await checkPermissions(user.org_id, user);
  return { ...result, status: await permissionsStatus(user, { canAct: true }) };
});
