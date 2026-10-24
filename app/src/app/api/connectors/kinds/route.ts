/**
 * PUT /api/connectors/kinds { kind, allowed: true | false }: the Org Owner switches a tool type (Azure DevOps, Jira,
 * GitHub, Confluence, Microsoft 365 files) on or off for the organization. No sign-in here: each group connects an
 * allowed tool with its own client's account. On: within the plan's connectors limit (402 with the upgrade message),
 * approving every pending request for it. Off: disconnects every group's connection of that type and removes what
 * they imported; returns the groups affected. Audited. See lib/connectors.ts (`setKindAllowed`).
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { setKindAllowed } from "@/lib/connectors";

export const PUT = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner"]);
  const body = await readJson<{ kind?: unknown; allowed?: unknown }>(req);
  return setKindAllowed(user, body.kind, body.allowed);
});
