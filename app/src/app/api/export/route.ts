/**
 * GET /api/export: download the whole organization's data as one zip (lib/export.ts): every group in its
 * own folder, everyone in the organization, and the audit log. For when the company leaves (it keeps
 * working while the organization is read-only, during the roll-off grace period).
 * Who: Org Owners and Org Admins only. Audited.
 */
import { handle } from "@/lib/api";
import { audit, requireUser } from "@/lib/auth";
import { exportOrganization, zipResponse } from "@/lib/export";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const { filename, zip } = await exportOrganization(user.org_id);
  await audit(user, `Exported the organization's data (${filename})`, "Data");
  return zipResponse(filename, zip);
});
