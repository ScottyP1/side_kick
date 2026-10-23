/**
 * GET /api/connectors: the organization's connected tools (Azure DevOps, Jira) with their health (status, last
 * sync, last success, problem in plain words) and the projects linked to groups, plus which tools this server
 * has set up (`configured`). Everyone signed in may look: Org Owners/Admins see every group's linked projects,
 * everyone else only their own groups'. Never includes tokens. See lib/connectors.ts.
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { connectorsFor } from "@/lib/connectors";

export const GET = handle(async () => connectorsFor(await requireUser()));
