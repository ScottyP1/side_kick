/**
 * GET /api/rules?ws=<workspace id> (optional): "Rules Sidekick follows" for the Help & support page, in plain words
 * (lib/guardrails.ts `rulesInForce`): the locked rules, each organization switch as on/off, and how many extra rules
 * the organization and (with `ws`) that group have, without their text.
 * Who: anyone signed in; `ws` is checked against the workspace wall (404 for a group they're not in). The full
 * Guardrails page and GET /api/guardrails stay with Org Owners and Org Admins.
 */
import { handle } from "@/lib/api";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { rulesInForce } from "@/lib/guardrails";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const wsParam = new URL(req.url).searchParams.get("ws");
  const ws = wsParam ? await requireWorkspace(user, wsParam) : null;
  return rulesInForce(user.org_id, ws);
});
