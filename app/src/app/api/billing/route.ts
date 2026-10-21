/**
 * GET/POST /api/billing: the organization's plan and subscription (lib/billing.ts), and changing it.
 * GET (Org Owners, Org Admins, Billing Admins, like Usage & billing): the subscription, what it allows
 * right now, seats and workspaces used, every limit with its use (`limits`, lib/limits.ts, incl. the AI
 * credit), every self-service plan, test mode, and whether this person may change it.
 * POST (Org Owners and Billing Admins): { action, plan? }
 *   - "pay": pay for `plan` (test mode: no money moves, no payment details) → active
 *   - "change": switch to `plan` now (refused if the organization has outgrown it)
 *   - "cancel": cancel; full use until the end of what was paid for, then read-only
 *   - "fail": test mode only, pretend the last payment failed → past_due (grace period)
 * Every change is in the audit log. Works while the organization is read-only, so it can be fixed.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { BILLING_ROLES, billingSummary, cancel, changePlan, pay, requirePlan, simulatePaymentFailed } from "@/lib/billing";
import { PLANS } from "@/lib/plans";
import { creditStatus } from "@/lib/credit";
import { limitReport } from "@/lib/limits";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin", "Billing Admin"]);
  const credit = await creditStatus(user.org_id);
  return { ...(await billingSummary(user.org_id)), limits: (await limitReport(user.org_id, credit.usedUsd)).lines, plans: PLANS, canManage: BILLING_ROLES.includes(user.role) };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser(BILLING_ROLES);
  const { action, plan } = await readJson<{ action?: string; plan?: unknown }>(req);
  if (action === "pay") await pay(user, requirePlan(plan));
  else if (action === "change") await changePlan(user, requirePlan(plan));
  else if (action === "cancel") await cancel(user);
  else if (action === "fail") await simulatePaymentFailed(user);
  else throw new HttpError(400, "Unknown billing action.");
  return billingSummary(user.org_id);
});
