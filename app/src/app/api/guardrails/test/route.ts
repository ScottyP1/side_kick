/**
 * /api/guardrails/test: the "Test it" box on the Guardrails page (see lib/guardrails.ts).
 *
 * POST { question, ws?: string | null, draft?: string }  Who: Org Owners and Org Admins.
 *      Runs the same check a real question gets (quick local check, then the Claude check) against the
 *      guardrails in force for that workspace (or org-wide ones without `ws`), plus an unsaved `draft`
 *      rule if given, so a rule can be tried before it's saved. Returns whether it would be refused, by
 *      which rule, which check decided, and the reply people would see.
 *      Nothing is saved: not the question, not a guardrail event, not a knowledge gap. (The Claude check
 *      is metered on the Usage page like any other, and the step shows on Activity without any text.)
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { FLOOR, getGuardPolicy, MAX_RULE_LENGTH, refusalFor, RULE_LABELS, screen, type BuiltinRuleId } from "@/lib/guardrails";

export const POST = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const body = await readJson<{ question?: unknown; ws?: unknown; draft?: unknown }>(req);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) throw new HttpError(400, "Type a question to test.");
  if (question.length > 1000) throw new HttpError(400, "Keep the test question under 1,000 characters.");
  const draft = typeof body.draft === "string" ? body.draft.replace(/\s+/g, " ").trim() : "";
  if (draft.length > MAX_RULE_LENGTH) throw new HttpError(400, `Keep each rule under ${MAX_RULE_LENGTH} characters.`);
  const ws = body.ws ? await requireWorkspace(user, typeof body.ws === "string" ? body.ws : null) : null;
  const policy = await getGuardPolicy(user.org_id, ws);
  if (draft) policy.rules.push({ id: "draft", text: draft, workspaceId: ws });
  const { rule, checker } = await screen({ orgId: user.org_id, workspaceId: ws }, policy, question);
  if (!rule) return { allowed: true, rule: null, label: null, checker, message: null, draft: false };
  const custom = rule.startsWith("custom:") ? policy.rules.find((r) => `custom:${r.id}` === rule) : null;
  return {
    allowed: false,
    rule: custom ? "custom" : rule,
    label: custom ? `Custom rule: “${custom.text}”` : RULE_LABELS[rule as BuiltinRuleId],
    locked: FLOOR.some((f) => f.id === rule),
    draft: custom?.id === "draft",
    checker,
    message: refusalFor(rule),
  };
});
