/**
 * /api/guardrails/rules: custom guardrail rules (see lib/guardrails.ts). Every write is for Org Owners and
 * Org Admins only, is checked so it can only add restrictions (422 with the reason otherwise), keeps a
 * version in the rule's history, and is written to the audit log as a policy change.
 *
 * GET    ?id=<rule id>  Who: Org Owners/Admins. The rule's history: every version, newest first.
 * POST   { text, ws?: string | null }  Adds a rule, org-wide (no `ws`) or for one workspace (checked
 *        against the workspace wall). 409 when that scope already has the maximum number of rules.
 * PUT    { id, text }  Rewrites a rule as a new version.
 * DELETE ?id=<rule id>  Removes a rule (its history is kept).
 * Rules of another organization are never found (404).
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { addRule, editRule, removeRule, ruleHistory } from "@/lib/guardrails";

const ADMINS = ["Org Owner", "Org Admin"] as const;
const idFrom = (req: Request) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw new HttpError(400, "Which rule? Pass its id.");
  return id;
};

export const GET = handle(async (req: Request) => {
  const user = await requireUser(ADMINS);
  return { versions: await ruleHistory(user.org_id, idFrom(req)) };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser(ADMINS);
  const body = await readJson<{ text?: unknown; ws?: unknown }>(req);
  const ws = body.ws ? await requireWorkspace(user, typeof body.ws === "string" ? body.ws : null) : null;
  const rule = await addRule(user.org_id, ws, user.name, body.text);
  await audit(user, `Guardrails: added the rule “${rule.text}”${ws ? " for this workspace" : " for the whole organization"}`, "Policy change", ws);
  return { ok: true, rule };
});

export const PUT = handle(async (req: Request) => {
  const user = await requireUser(ADMINS);
  const body = await readJson<{ id?: unknown; text?: unknown }>(req);
  if (typeof body.id !== "string" || !body.id) throw new HttpError(400, "Which rule? Pass its id.");
  const { before, after } = await editRule(user.org_id, body.id, user.name, body.text);
  await audit(user, `Guardrails: changed the rule “${before.text}” to “${after.text}” (version ${after.version})`, "Policy change", before.workspace_id);
  return { ok: true, version: after.version };
});

export const DELETE = handle(async (req: Request) => {
  const user = await requireUser(ADMINS);
  const removed = await removeRule(user.org_id, idFrom(req), user.name);
  await audit(user, `Guardrails: removed the rule “${removed.text}”`, "Policy change", removed.workspace_id);
  return { ok: true };
});
