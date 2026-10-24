/**
 * GET /api/connectors: the organization's connected tools (Azure DevOps, Jira, GitHub, Confluence, Microsoft 365) with their health (status, last
 * sync, last success, problem in plain words) and the projects linked to groups, plus which tools this server
 * has set up (`configured`), the requests to turn tools on that the person may see (`requests`: Org Owners/Admins
 * all, Team Leads their groups') and what they may do (`canToggle`, `canReconnect`, `canRequest`).
 * Who: Org Owners/Admins (every group's linked projects) and Team Leads (their own groups'); Members and Viewers get
 * 403 and see a group's sources on its page instead (/api/workspaces/:id/sources). Never includes tokens. See
 * lib/connectors.ts (`connectorsFor`) and lib/connector-requests.ts.
 */
import { handle } from "@/lib/api";
import { HttpError, isAdmin, isLead, requireUser } from "@/lib/auth";
import { connectorsFor } from "@/lib/connectors";

export const GET = handle(async () => {
  const user = await requireUser();
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and Team Leads can open Connectors. Your group's page shows which tools feed it.");
  return connectorsFor(user);
});
