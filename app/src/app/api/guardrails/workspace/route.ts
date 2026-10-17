/**
 * /api/guardrails/workspace: one workspace's extra guardrail switches (see lib/guardrails.ts).
 *
 * PUT  { ws: string, [switch]: boolean, ... } Who: Org Owners and Org Admins. Turns switches on (or back
 *      off) for this workspace only, on top of the organization's. It can never switch off something the
 *      organization has on: what's in force is always the org's setting OR the workspace's. The workspace
 *      must be in the caller's org (404 otherwise). Each change is audited as a policy change against the
 *      workspace. Unknown switch names are ignored.
 */
import { handle, readJson } from "@/lib/api";
import { audit, requireUser, requireWorkspace } from "@/lib/auth";
import { saveWorkspaceExtras, SWITCHES } from "@/lib/guardrails";

export const PUT = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const body = await readJson<Record<string, unknown>>(req);
  const ws = await requireWorkspace(user, typeof body.ws === "string" ? body.ws : null);
  const { extras, changed } = await saveWorkspaceExtras(user.org_id, ws, user.name, body);
  for (const k of changed) {
    await audit(user, `Guardrails: turned ${extras[k] ? "on" : "off"} “${SWITCHES[k].label}” for this workspace`, "Policy change", ws);
  }
  return { ok: true, changed };
});
