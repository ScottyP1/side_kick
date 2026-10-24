/**
 * GET /api/connectors: the organization's connected tools (Azure DevOps, Jira, GitHub, Confluence, Microsoft 365) with their health (status, last
 * sync, last success, problem in plain words) and the projects linked to groups, plus which tools this server
 * has set up (`configured`), the requests to turn tools on that the person may see (`requests`: Org Owners/Admins
 * all, Team Leads their groups', others none) and what they may do (`canToggle`, `canReconnect`, `canRequest`).
 * Everyone signed in may look: Org Owners/Admins see every group's linked projects, everyone else only their own
 * groups'. Never includes tokens. See lib/connectors.ts (`connectorsFor`) and lib/connector-requests.ts.
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { connectorsFor } from "@/lib/connectors";

export const GET = handle(async () => connectorsFor(await requireUser()));
