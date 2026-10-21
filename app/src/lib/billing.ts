/**
 * @file Subscriptions and payment: each organization's plan and billing state, behind a billing provider.
 *
 * Concepts
 * - **Subscription**: one row per organization in `subscriptions` (plan from lib/plans.ts, status
 *   trialing | active | past_due | canceled, dates). Organizations set up by first-run Setup or by the
 *   Sidekick team (Owner Console → Add client) have no row: they're "managed" and keep full use.
 * - **Billing provider**: the outside service that takes the money. Every state change goes through
 *   `provider()` first and is then written here, so swapping providers doesn't touch any caller.
 *   - `mock` (today, **test mode**): no money moves and **no payment details are ever collected** (no card
 *     fields anywhere). "Pay (test mode)" on the checkout page simply marks the plan paid. It can also
 *     simulate a failed payment, for testing what customers see.
 *   - `stripe` (later): set `BILLING_PROVIDER=stripe`. `checkoutUrl` would create a Stripe Checkout
 *     Session and return its URL (Stripe collects the card on its own page, never here);
 *     `completeCheckout` isn't called from the browser: a webhook route (e.g. `/api/billing/webhook`,
 *     verifying Stripe's signature) would call `recordPayment` / `recordPaymentFailed` / `recordCanceled`
 *     with the Stripe subscription id kept in `provider_ref`. Until then asking for it fails loudly.
 * - **Access** (`accessFor` in lib/plans.ts): what a non-active subscription allows. Read-only is enforced
 *   in two places: `handle()` (lib/api.ts) refuses portal changes via `readOnlyRefusal`, and
 *   `assertEnabled` (lib/owner.ts) refuses new AI work (portal, Teams, reminders) via `orgAccess`.
 * - **Extra groups**: `extra_groups` on the subscription, bought on top of any self-service plan
 *   (`EXTRA_GROUP` in lib/plans.ts); the monthly price is the plan's plus $129 per extra group
 *   (`monthlyPrice`). Changed at checkout, with a plan change, or on its own (`setExtraGroups`).
 * - **Leaving**: canceling starts the organization's roll-off (lib/rolloff.ts): full use until the end of
 *   what was paid for, then `ORG_GRACE_DAYS` read-only with export, then everything is deleted. Paying
 *   again before then stops it (`recordPayment`).
 * - **Who**: Org Owners and Billing Admins manage the plan (`BILLING_ROLES`); the Sidekick team can set any
 *   plan or status from the Owner Console (`setByOwner`). Every change is in the client's audit log.
 */
import "server-only";
import { audit, HttpError, sessionUser, type Role, type User } from "./auth";
import { get, now, run } from "./db";
import { accessFor, EXTRA_GROUP, limitsWithExtras, MAX_EXTRA_GROUPS, monthlyPrice, PERIOD_DAYS, planById, planWithExtras, TRIAL_DAYS, STATUS_LABEL, usd, withRolloff, type Access, type PlanId, type SubStatus } from "./plans";
import { cancelOrgRolloff, scheduleOrgRolloff, ORG_GRACE_DAYS } from "./rolloff";

/** Roles that may pay, change the plan or cancel (others may still see the plan on Usage & billing). */
export const BILLING_ROLES: readonly Role[] = ["Org Owner", "Billing Admin"];

/** A subscription row. Dates are ISO strings; null when they don't apply to the status. */
export type Subscription = {
  org_id: string;
  plan: PlanId;
  status: SubStatus;
  provider: string;
  provider_ref: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  past_due_since: string | null;
  canceled_at: string | null;
  access_until: string | null;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
  /** Extra groups bought on top of the plan (0 for none). */
  extra_groups: number;
};

/* ---------- Providers ---------- */

/** What a billing provider must do. See the file header for how Stripe would fill it in. */
export type BillingProvider = {
  id: "mock" | "stripe";
  /** True when no real money moves; the UI shows a test-mode banner everywhere billing appears. */
  testMode: boolean;
  /** Where to send the buyer to pay for `plan`: the in-app checkout page (mock) or the provider's page. */
  checkoutUrl(orgId: string, plan: PlanId): Promise<string>;
  /** Confirms the payment; returns the provider's id for the subscription. Mock only (Stripe uses a webhook). */
  completeCheckout(orgId: string, plan: PlanId): Promise<{ ref: string }>;
  /** Tells the provider about a plan change or a cancellation (mock: nothing to tell). */
  changePlan(sub: Subscription, plan: PlanId): Promise<void>;
  cancel(sub: Subscription): Promise<void>;
};

const mockProvider: BillingProvider = {
  id: "mock",
  testMode: true,
  checkoutUrl: async (_orgId, plan) => `/checkout?plan=${plan}`,
  completeCheckout: async (orgId) => ({ ref: `mock_${orgId.slice(0, 8)}` }),
  changePlan: async () => {},
  cancel: async () => {},
};

/** The configured provider (`BILLING_PROVIDER`, default `mock`). Stripe isn't built yet, so it refuses. */
export function provider(): BillingProvider {
  const id = process.env.BILLING_PROVIDER || "mock";
  if (id === "mock") return mockProvider;
  throw new HttpError(501, "Card payments aren't set up yet (only test mode). Contact the Sidekick team.");
}

/* ---------- Reading ---------- */

/** The organization's subscription, or null when the Sidekick team manages it (no self-service plan). */
export async function getSubscription(orgId: string): Promise<Subscription | null> {
  return (await get<Subscription>("SELECT * FROM subscriptions WHERE org_id = ?", orgId)) ?? null;
}

/** The organization's pending roll-off (being deleted), or null. See lib/rolloff.ts. */
export async function pendingOrgRolloff(orgId: string) {
  return (await get<{ read_only_from: string | null; delete_on: string; reason: string | null }>(
    "SELECT read_only_from, delete_on, reason FROM rolloffs WHERE org_id = ? AND scope = 'org' AND status IN ('scheduled', 'running')", orgId,
  )) ?? null;
}

/**
 * What the organization may do right now: the subscription's rules (`accessFor` in lib/plans.ts), with a
 * pending roll-off on top (`withRolloff`: read-only from its date, and the deletion date in the banner).
 */
export async function orgAccess(orgId: string): Promise<Access> {
  const [sub, roll] = await Promise.all([getSubscription(orgId), pendingOrgRolloff(orgId)]);
  return withRolloff(accessFor(sub), roll, { selfService: !!sub && sub.provider !== "manual" });
}

/**
 * SQL condition for "this group isn't ending": groups scheduled for deletion (lib/rolloff.ts) are read-only
 * and don't count toward the group limit. Use with the workspaces table aliased as `w`.
 */
export const NOT_ENDING = "NOT EXISTS (SELECT 1 FROM rolloffs r WHERE r.workspace_id = w.id AND r.scope = 'group' AND r.status IN ('scheduled', 'running'))";

/** How many groups count toward the limit: every group in the organization except those ending. */
export async function activeGroupCount(orgId: string) {
  return Number((await get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM workspaces w WHERE w.org_id = ? AND ${NOT_ENDING}`, orgId))?.n ?? 0);
}

/**
 * Seats (people with an account) and groups the organization uses, to compare with its plan: `workspaces`
 * counts toward the limit (ending groups left out), `ending` is how many are ending.
 */
export async function usage(orgId: string) {
  const seats = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE org_id = ?", orgId))?.n ?? 0);
  const all = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ?", orgId))?.n ?? 0);
  const workspaces = await activeGroupCount(orgId);
  return { seats, workspaces, ending: all - workspaces };
}

// Routes that keep working while an organization is read-only: signing in and out, the password change,
// billing itself (so it can be fixed), the Owner Console, sign-up, health, and the Teams endpoints
// (their AI work is refused by assertEnabled instead).
const ALWAYS_OPEN = ["/api/auth/", "/api/billing", "/api/owner/", "/api/signup", "/api/health", "/api/messages", "/api/reminders/tick"];

/**
 * Called by `handle()` before every API route: when the signed-in person's organization is read-only and
 * this request would change something (anything but GET/HEAD), returns the message to refuse it with (as a
 * 402). Returns null when the request may go ahead. Never throws for a missing session (the route itself
 * answers 401).
 */
export async function readOnlyRefusal(req: Request): Promise<string | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/") || ALWAYS_OPEN.some((p) => path.startsWith(p))) return null;
  const who = await sessionUser();
  if (!who) return null;
  const access = await orgAccess(who.org_id);
  return access.mode === "read_only" ? access.reason : null;
}

/* ---------- Changing (each writes the row and the client's audit log) ---------- */

const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
const planName = (id: PlanId) => planById(id)!.name;

/**
 * Throws 400 unless `plan` is one of the self-service plans (Starter, Team, Business). Returns it typed.
 * With `operator` (the Owner Console), Enterprise is allowed too; customers can't pick it themselves.
 */
export function requirePlan(plan: unknown, opts: { operator?: boolean } = {}): PlanId {
  const p = planById(plan);
  if (p && !p.selfService && !opts.operator) throw new HttpError(400, "Enterprise is set up with the Sidekick team. Contact them, or pick Starter, Team or Business.");
  if (!p) throw new HttpError(400, opts.operator ? "Pick a plan: Starter, Team, Business or Enterprise." : "Pick one of the plans: Starter, Team or Business.");
  return p.id;
}

/**
 * Starts a new organization's free trial (sign-up). The row records the provider so a later Stripe
 * subscription can be matched to it. Caller: lib/signup.ts, inside its transaction.
 */
export async function startTrial(orgId: string, plan: PlanId, actor: string) {
  const t = now();
  await run(
    `INSERT INTO subscriptions (org_id, plan, status, provider, trial_ends_at, updated_by, updated_at, created_at)
     VALUES (?, ?, 'trialing', ?, ?, ?, ?, ?)`,
    orgId, plan, provider().id, inDays(TRIAL_DAYS), actor, t, t,
  );
}

/**
 * Refuses a plan (with `extras` extra groups) the organization has outgrown: more people or groups than it
 * allows, with the numbers. Ending groups don't count. Nothing is ever deleted to make a plan fit.
 */
async function assertFits(orgId: string, plan: PlanId, extras: number) {
  const p = planById(plan)!;
  const l = limitsWithExtras(p, extras);
  const used = await usage(orgId);
  const name = planWithExtras(p, extras);
  if (l.seats !== null && used.seats > l.seats) {
    throw new HttpError(409, `${name} allows ${l.seats} people and your organization has ${used.seats}. Pick a bigger plan, add extra groups (each adds ${EXTRA_GROUP.adds.seats} people) or remove people first.`);
  }
  if (l.workspaces !== null && used.workspaces > l.workspaces) {
    throw new HttpError(409, `${name} allows ${l.workspaces} group${l.workspaces === 1 ? "" : "s"} and your organization has ${used.workspaces}. Pick a bigger plan, add extra groups, or end or delete groups first.`);
  }
}

/** Throws 400 unless `n` is a whole number of extra groups from 0 to `MAX_EXTRA_GROUPS`. Returns it. */
export function requireExtras(n: unknown): number {
  if (n === undefined || n === null) return 0;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_EXTRA_GROUPS) {
    throw new HttpError(400, `Extra groups must be a whole number from 0 to ${MAX_EXTRA_GROUPS}. For more, the Sidekick team sets up Enterprise.`);
  }
  return n;
}

/** The subscription, or 404 when the organization has none (managed by the Sidekick team). */
async function requireSubscription(orgId: string): Promise<Subscription> {
  const sub = await getSubscription(orgId);
  if (!sub) throw new HttpError(404, "Your organization's plan is managed by the Sidekick team. Contact them to change it.");
  return sub;
}

/**
 * Records a successful payment: status active for one period, any failure or cancellation cleared, the
 * plan switched to `plan` and the extra groups to `extras` (if given). A pending roll-off of the whole
 * organization (after a cancellation) is stopped: paying again keeps everything. Mock checkout calls it
 * directly; a Stripe webhook would too.
 */
export async function recordPayment(orgId: string, plan: PlanId, ref: string | null, actor: string, extras?: number) {
  await run(
    `UPDATE subscriptions SET plan = ?, status = 'active', provider_ref = COALESCE(?, provider_ref), current_period_end = ?,
       past_due_since = NULL, canceled_at = NULL, access_until = NULL, extra_groups = COALESCE(?, extra_groups), updated_by = ?, updated_at = ? WHERE org_id = ?`,
    plan, ref, inDays(PERIOD_DAYS), extras ?? null, actor, now(), orgId,
  );
  await cancelOrgRolloff(orgId, actor, "paid again");
}

const priceLine = (plan: PlanId, extras: number) => `${planWithExtras(planById(plan)!, extras)}, ${usd(monthlyPrice(planById(plan)!, extras))} a month`;

/**
 * "Pay (test mode)" on the checkout page: pays for `plan` (and `extras` extra groups, if given; otherwise
 * the ones already on the subscription) through the provider. Org Owners and Billing Admins only (checked
 * by the route). Refuses a plan the organization has outgrown.
 */
export async function pay(user: User, plan: PlanId, extras?: number) {
  const sub = await requireSubscription(user.org_id);
  const n = extras ?? sub.extra_groups ?? 0;
  await assertFits(user.org_id, plan, n);
  const p = provider();
  const { ref } = await p.completeCheckout(user.org_id, plan);
  await recordPayment(user.org_id, plan, ref, user.name, n);
  await audit(user, `Paid for the ${priceLine(plan, n)}${p.testMode ? " (test mode, no money moved)" : ""}`, "Billing");
}

/**
 * Switches to another plan (from Usage & billing), optionally setting the extra groups at the same time
 * (`extras`; otherwise they stay). Takes effect now; the paid-until date stays the same.
 */
export async function changePlan(user: User, plan: PlanId, extras?: number) {
  const sub = await requireSubscription(user.org_id);
  const n = extras ?? sub.extra_groups ?? 0;
  if (sub.plan === plan && n === sub.extra_groups) throw new HttpError(400, `You're already on the ${planName(plan)} plan.`);
  await assertFits(user.org_id, plan, n);
  await provider().changePlan(sub, plan);
  await run("UPDATE subscriptions SET plan = ?, extra_groups = ?, updated_by = ?, updated_at = ? WHERE org_id = ?", plan, n, user.name, now(), user.org_id);
  await audit(user, sub.plan === plan ? `Changed extra groups from ${sub.extra_groups} to ${n} (${priceLine(plan, n)})` : `Changed the plan from ${planWithExtras(planById(sub.plan)!, sub.extra_groups)} to ${priceLine(plan, n)}`, "Billing");
}

/**
 * Sets how many extra groups the organization pays for on its plan (from Usage & billing or the group-limit
 * prompt). Fewer than its groups need is refused (nothing is deleted). Test mode: takes effect at once.
 */
export async function setExtraGroups(user: User, extras: number) {
  const sub = await requireSubscription(user.org_id);
  if (!planById(sub.plan)?.selfService) throw new HttpError(400, "Extra groups are for the self-service plans. On Enterprise, the Sidekick team sets your limits.");
  if (extras === sub.extra_groups) throw new HttpError(400, `You already have ${extras} extra group${extras === 1 ? "" : "s"}.`);
  await changePlan(user, sub.plan, extras);
}

/**
 * Cancels the plan. Sidekick stays fully usable until the end of what was paid for (or the trial), then
 * turns read-only; nothing is deleted. Paying again undoes it.
 */
export async function cancel(user: User) {
  const sub = await requireSubscription(user.org_id);
  if (sub.status === "canceled") throw new HttpError(400, "The plan is already canceled.");
  await provider().cancel(sub);
  const until = (sub.status === "trialing" ? sub.trial_ends_at : sub.status === "active" ? sub.current_period_end : null) ?? now();
  await run(
    "UPDATE subscriptions SET status = 'canceled', canceled_at = ?, access_until = ?, updated_by = ?, updated_at = ? WHERE org_id = ?",
    now(), until, user.name, now(), user.org_id,
  );
  await audit(user, `Canceled the ${planName(sub.plan)} plan (usable until ${until.slice(0, 10)})`, "Billing");
  // Then read-only for the grace period, then everything is deleted (lib/rolloff.ts), unless they pay again.
  const deleteOn = new Date(Date.parse(until) + ORG_GRACE_DAYS * 86400_000).toISOString();
  await scheduleOrgRolloff(user.org_id, { readOnlyFrom: until, deleteOn, reason: "the plan was canceled", by: user.name });
}

/**
 * Test mode only: pretends the last payment failed (status past_due), so people can see the warning and
 * the grace period. Refused with a real provider.
 */
export async function simulatePaymentFailed(user: User) {
  const sub = await requireSubscription(user.org_id);
  if (!provider().testMode) throw new HttpError(400, "Simulating a failed payment only works in test mode.");
  if (sub.status === "canceled") throw new HttpError(400, "The plan is canceled, so there's no payment to fail.");
  await run("UPDATE subscriptions SET status = 'past_due', past_due_since = ?, updated_by = ?, updated_at = ? WHERE org_id = ?", now(), user.name, now(), user.org_id);
  await audit(user, "Simulated a failed payment (test mode)", "Billing");
}

/**
 * The Sidekick team sets a client's plan, extra groups and/or status from the Owner Console (creating the
 * subscription if the client had none). Status dates follow the status: active → paid for a new period;
 * trialing → a new trial; past_due → the grace period starts now; canceled → read-only straight away and
 * the organization's roll-off starts (deleted after `ORG_GRACE_DAYS`). Any other status stops a pending
 * roll-off. Audited in the client's log as "Sidekick team"; the route also writes the operator log.
 * Returns a summary for it.
 */
export async function setByOwner(orgId: string, change: { plan?: PlanId; status?: SubStatus; extras?: number }, ownerName: string): Promise<string> {
  const sub = await getSubscription(orgId);
  const plan = change.plan ?? sub?.plan ?? "team";
  const status = change.status ?? sub?.status ?? "active";
  const t = now();
  const dates =
    status === "active" ? { trial: null, period: change.status || !sub ? inDays(PERIOD_DAYS) : (sub.current_period_end ?? inDays(PERIOD_DAYS)), due: null, canceled: null, until: null }
    : status === "trialing" ? { trial: change.status || !sub ? inDays(TRIAL_DAYS) : sub.trial_ends_at, period: null, due: null, canceled: null, until: null }
    : status === "past_due" ? { trial: null, period: sub?.current_period_end ?? null, due: change.status || !sub ? t : sub.past_due_since, canceled: null, until: null }
    : { trial: null, period: sub?.current_period_end ?? null, due: null, canceled: change.status || !sub ? t : sub.canceled_at, until: change.status || !sub ? t : sub.access_until };
  await run(
    `INSERT INTO subscriptions (org_id, plan, status, provider, trial_ends_at, current_period_end, past_due_since, canceled_at, access_until, updated_by, updated_at, created_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, trial_ends_at = excluded.trial_ends_at,
       current_period_end = excluded.current_period_end, past_due_since = excluded.past_due_since, canceled_at = excluded.canceled_at,
       access_until = excluded.access_until, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    orgId, plan, status, dates.trial, dates.period, dates.due, dates.canceled, dates.until, ownerName, t, t,
  );
  const extras = change.extras ?? sub?.extra_groups ?? 0;
  if (change.extras !== undefined) await run("UPDATE subscriptions SET extra_groups = ? WHERE org_id = ?", extras, orgId);
  const summary = `${planWithExtras(planById(plan)!, planById(plan)!.selfService ? extras : 0)} plan, ${STATUS_LABEL[status]}`;
  await audit({ org_id: orgId, name: "Sidekick team" }, `Set the plan to ${summary}`, "Billing");
  if (status === "canceled" && change.status) {
    await scheduleOrgRolloff(orgId, { readOnlyFrom: t, deleteOn: inDays(ORG_GRACE_DAYS), reason: "the plan was canceled", by: ownerName });
  } else if (status !== "canceled") {
    await cancelOrgRolloff(orgId, ownerName, `plan set to ${STATUS_LABEL[status]}`);
  }
  return summary;
}

/**
 * Everything Usage & billing shows about the plan: the subscription, access (incl. a pending roll-off),
 * seats/groups, the monthly price with extra groups (`priceUsd`, null when managed), the extra-group offer
 * and test mode.
 */
export async function billingSummary(orgId: string) {
  const sub = await getSubscription(orgId);
  const plan = sub ? planById(sub.plan) : undefined;
  return {
    subscription: sub, access: await orgAccess(orgId), usage: await usage(orgId), testMode: provider().testMode, provider: provider().id,
    priceUsd: plan ? monthlyPrice(plan, sub!.extra_groups ?? 0) : null, extraGroup: EXTRA_GROUP, maxExtraGroups: MAX_EXTRA_GROUPS,
  };
}
