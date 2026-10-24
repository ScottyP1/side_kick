/**
 * POST /api/connectors/requests { kind, ws, reason? }: asks the Org Owner to turn a tool (Azure DevOps, Jira,
 * GitHub, Confluence, Microsoft 365 files) on for one group. Team Leads for groups they belong to, Org Admins for
 * any group (`requireManage`). 409 when the tool is already on or the group already has a pending request for it;
 * 402 on a plan without connectors. The Org Owner sees it on Home and Connectors (and in Teams). Audited.
 * Returns the request. See lib/connector-requests.ts (`createRequest`).
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { createRequest } from "@/lib/connector-requests";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  return { request: await createRequest(user, await readJson(req)) };
});
