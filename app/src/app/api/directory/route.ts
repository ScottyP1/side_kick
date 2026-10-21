/**
 * GET /api/directory: the organization's Microsoft 365 directory, for "Import from Microsoft 365" on Users & access.
 * - Without `?q`: status only: whether Microsoft is set up, the org is connected to its tenant, a Microsoft
 *   admin approved Sidekick (and when), whether the caller may start that approval (Org Owners/Admins), and the
 *   plain-language list of permissions.
 * - With `?q=<name or email>` (`?q=` lists the first 25): people found in the directory, each marked
 *   `inSidekick` if they already have an account in this org. Answers 409 with `consent: "needed"` until a
 *   Microsoft admin has approved Sidekick (lib/directory.ts).
 * Who: Org Owners, Org Admins and Team Leads (who import into the workspaces they lead).
 */
import { handle } from "@/lib/api";
import { requireUser, isAdmin, isLead, HttpError } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { entraConfigured } from "@/lib/entra";
import { PERMISSIONS_EXPLAINED, requireDirectoryTenant, searchDirectory } from "@/lib/directory";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and Team Leads can import people.");
  const q = new URL(req.url).searchParams.get("q");
  if (q === null) {
    const org = await get<{ entra_tenant_id: string | null; graph_consent_at: string | null }>("SELECT entra_tenant_id, graph_consent_at FROM orgs WHERE id = ?", user.org_id);
    return {
      configured: entraConfigured(),
      connected: Boolean(org?.entra_tenant_id),
      approvedAt: org?.graph_consent_at ?? null,
      canApprove: isAdmin(user),
      permissions: PERMISSIONS_EXPLAINED,
    };
  }
  const tenant = await requireDirectoryTenant(user);
  const people = await searchDirectory(tenant, q);
  const known = await all<{ entra_oid: string | null; email: string }>("SELECT entra_oid, email FROM users WHERE org_id = ?", user.org_id);
  const oids = new Set(known.map((k) => k.entra_oid).filter(Boolean));
  const emails = new Set(known.map((k) => k.email.toLowerCase()));
  return { people: people.map((p) => ({ ...p, inSidekick: oids.has(p.id) || emails.has(p.email) })) };
});
