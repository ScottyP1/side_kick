/**
 * GET/POST /api/billing: the organization's plan and subscription (lib/billing.ts), and changing it.
 * GET (Org Owners, Org Admins, Billing Admins, like Usage & billing): the subscription, what it allows
 * right now, seats and workspaces used, every limit with its use (`limits`, lib/limits.ts, incl. the AI
 * credit), every plan feature with whether it's included and what's in use (`features`, lib/limits.ts
 * `featureReport`), every self-service plan, test mode, and whether this person may change it.
 * POST (Org Owners and Billing Admins): { action, plan?, extraGroups? }
 *   - "pay": pay for `plan` with `extraGroups` extra groups (test mode: no money moves, no payment details) → active
 *   - "change": switch to `plan` now, optionally with `extraGroups` (refused if the organization has outgrown it)
 *   - "extras": set how many extra groups the organization pays for ($129 each a month, lib/plans.ts)
 *   - "cancel": cancel; full use until the end of what was paid for, then read-only
 *   - "fail": test mode only, pretend the last payment failed → past_due (grace period)
 * Every change is in the audit log. Works while the organization is read-only, so it can be fixed.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { BILLING_ROLES, billingSummary, cancel, changePlan, pay, requireExtras, requirePlan, setExtraGroups, simulatePaymentFailed } from "@/lib/billing";
import { PLANS } from "@/lib/plans";
import { creditStatus } from "@/lib/credit";
import { featureReport, limitReport } from "@/lib/limits";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin", "Billing Admin"]);
  const credit = await creditStatus(user.org_id);
  return {
    ...(await billingSummary(user.org_id)),
    limits: (await limitReport(user.org_id, credit.usedUsd)).lines,
    features: await featureReport(user.org_id),
    plans: PLANS,
    canManage: BILLING_ROLES.includes(user.role),
  };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser(BILLING_ROLES);
  const { action, plan, extraGroups } = await readJson<{ action?: string; plan?: unknown; extraGroups?: unknown }>(req);
  const extras = extraGroups === undefined ? undefined : requireExtras(extraGroups);
  if (action === "pay") await pay(user, requirePlan(plan), extras);
  else if (action === "change") await changePlan(user, requirePlan(plan), extras);
  else if (action === "extras") await setExtraGroups(user, requireExtras(extraGroups));
  else if (action === "cancel") await cancel(user);
  else if (action === "fail") await simulatePaymentFailed(user);
  else throw new HttpError(400, "Unknown billing action.");
  return billingSummary(user.org_id);
});
