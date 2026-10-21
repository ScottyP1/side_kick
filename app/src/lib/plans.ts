/**
 * @file Sidekick's plans: the one place that says what each plan is called, what it costs and what it
 * includes. Pure data and small helpers with no I/O, so the public pricing page, the sign-up and checkout
 * pages, the portal's Usage & billing page, the Owner Console and the server (lib/billing.ts) all read the
 * same list.
 *
 * Concepts
 * - **Plan**: what an organization pays for. Priced **per seat per month**: a seat is one person with a
 *   portal account in the organization (any role). Each plan also has a seat limit and a workspace limit.
 * - **Made-up prices**: Sidekick's pricing isn't decided yet (see docs/BLUEPRINT.md). These numbers are
 *   placeholders for the test-mode checkout and will change before anyone pays real money.
 * - **Trial**: every self-service sign-up starts with `TRIAL_DAYS` of free use before the first payment.
 * - **Grace period**: when a payment fails, the organization keeps full use for `GRACE_DAYS` while someone
 *   fixes it; after that the portal turns read-only (see `accessFor` in lib/billing.ts).
 */

/** The plan ids stored in `subscriptions.plan`. */
export const PLAN_IDS = ["starter", "team", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** One plan as shown to buyers. `seats`/`workspaces` are limits; `null` means no limit. */
export type Plan = {
  id: PlanId;
  name: string;
  /** US dollars per seat per month (made up, test mode only). */
  pricePerSeat: number;
  seats: number | null;
  workspaces: number | null;
  /** One line for the pricing card. */
  blurb: string;
  /** What's included, in plain words, for the pricing card. */
  features: string[];
};

/** Every plan, cheapest first. Change prices and limits here only. */
export const PLANS: readonly Plan[] = [
  {
    id: "starter",
    name: "Starter",
    pricePerSeat: 8,
    seats: 10,
    workspaces: 2,
    blurb: "For a small team trying Sidekick on one or two projects.",
    features: ["Up to 10 people", "2 workspaces", "Answers with sources in Teams and the portal", "Meeting notes and action items", "Guardrails and audit log"],
  },
  {
    id: "team",
    name: "Team",
    pricePerSeat: 15,
    seats: 50,
    workspaces: 10,
    blurb: "For a delivery team running several client engagements.",
    features: ["Up to 50 people", "10 workspaces", "Everything in Starter", "Reminders in Teams chats", "Team Leads and custom guardrail rules"],
  },
  {
    id: "business",
    name: "Business",
    pricePerSeat: 25,
    seats: 500,
    workspaces: null,
    blurb: "For a whole practice, with Microsoft sign-in for everyone.",
    features: ["Up to 500 people", "Unlimited workspaces", "Everything in Team", "Require Microsoft sign-in", "Priority support"],
  },
];

/** Free days before the first payment for a new self-service organization. */
export const TRIAL_DAYS = 14;
/** Days of full use after a failed payment, before the portal turns read-only. */
export const GRACE_DAYS = 7;
/** Length of one billing period (the mock provider bills every 30 days). */
export const PERIOD_DAYS = 30;

/** The plan with this id, or undefined for anything else (e.g. text from a request). */
export function planById(id: unknown): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** "Unlimited" or the number, for limits shown to people. */
export const limitText = (n: number | null) => (n === null ? "Unlimited" : String(n));

/** "$15 per person / month" */
export const priceText = (p: Plan) => `$${p.pricePerSeat} per person / month`;

/* ---------- What a subscription allows (pure, unit-tested in tests/db.test.mjs) ---------- */

/** Subscription states, as stored in `subscriptions.status`. */
export const SUB_STATUSES = ["trialing", "active", "past_due", "canceled"] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

/** The parts of a subscription row that decide access (see lib/billing.ts for the whole row). */
export type SubTimes = {
  status: SubStatus;
  trial_ends_at: string | null;
  past_due_since: string | null;
  access_until: string | null;
};

/**
 * What an organization may do right now:
 * - `full`: everything its roles allow.
 * - `read_only`: people can still sign in and see everything already there, and Org Owners/Billing Admins
 *   can fix billing; nothing new is added or changed, and Sidekick does no new AI work (answers in the
 *   portal and Teams, meeting notes, knowledge map, assistant, reminders).
 * `notice` is the banner text for the portal (null = nothing to say); `reason` says why it's read-only.
 */
export type Access = { mode: "full" | "read_only"; notice: string | null; reason: string | null };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The rules for a non-active subscription, in one place:
 * - no subscription row (set up by the Sidekick team): full use, no notice.
 * - **trialing**: full use until the trial ends, then read-only until someone pays.
 * - **active**: full use.
 * - **past_due** (a payment failed): full use with a warning for `GRACE_DAYS`, then read-only.
 * - **canceled**: full use until the end of what was paid for (`access_until`), then read-only.
 * Nothing is ever deleted because of billing: paying again restores full use straight away.
 */
export function accessFor(sub: SubTimes | null | undefined, at: number = Date.now()): Access {
  if (!sub) return { mode: "full", notice: null, reason: null };
  const until = (iso: string | null) => (iso ? Date.parse(iso) : 0);
  if (sub.status === "active") return { mode: "full", notice: null, reason: null };
  if (sub.status === "trialing") {
    const end = until(sub.trial_ends_at);
    if (end > at) {
      const left = Math.max(1, Math.ceil((end - at) / 86400_000));
      return { mode: "full", notice: `Free trial: ${left} day${left === 1 ? "" : "s"} left. Pay for your plan on Usage & billing to keep using Sidekick after ${day(sub.trial_ends_at!)}.`, reason: null };
    }
    return readOnly("the free trial has ended");
  }
  if (sub.status === "past_due") {
    const end = until(sub.past_due_since) + GRACE_DAYS * 86400_000;
    if (end > at) return { mode: "full", notice: `The last payment failed. Fix it on Usage & billing by ${day(new Date(end).toISOString())}, or Sidekick turns read-only.`, reason: null };
    return readOnly("the last payment failed and wasn't fixed in time");
  }
  const end = until(sub.access_until);
  if (end > at) return { mode: "full", notice: `Your plan is canceled. Sidekick stays fully usable until ${day(sub.access_until!)}, then turns read-only.`, reason: null };
  return readOnly("the plan is canceled");
}

function readOnly(why: string): Access {
  const reason = `Sidekick is read-only for your organization because ${why}. You can still see everything; an Org Owner or Billing Admin can pay on Usage & billing to turn everything back on.`;
  return { mode: "read_only", notice: reason, reason };
}

/** Plain names for the statuses, as shown in the portal and the Owner Console. */
export const STATUS_LABEL: Record<SubStatus, string> = { trialing: "Free trial", active: "Active", past_due: "Payment failed", canceled: "Canceled" };
