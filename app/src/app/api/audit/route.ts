/**
 * GET /api/audit: the organization's audit log (who did what, when), newest first.
 * Who: Org Owners and Org Admins.
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { all } from "@/lib/db";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const rows = await all(
    `SELECT a.id, a.actor, a.action, a.kind, a.created_at, w.name AS workspace
       FROM audit_log a LEFT JOIN workspaces w ON w.id = a.workspace_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 300`,
    user.org_id,
  );
  return { rows };
});
