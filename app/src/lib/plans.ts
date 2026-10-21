/**
 * @file Sidekick's plans: the one place that says what each plan is called, what it costs and what it
 * includes. Pure data and small helpers with no I/O, so the public pricing page, the sign-up and checkout
 * pages, the portal's Usage & billing page, the Owner Console and the server (lib/billing.ts) all read the
 * same list.
 *
 * Concepts
 * - **Plan**: what an organization pays for. Priced **per seat per month**: a seat is one person with a
 *   portal account in the organization (any role). Each plan has **limits** (`PlanLimits`): people, groups
 *   (workspaces), tracked Teams chats, meeting hours per month, documents, connectors and a **monthly AI
 *   credit** in US dollars. Limits are enforced where each thing is created (lib/limits.ts) and the AI
 *   credit before every Claude call (lib/credit.ts). A plan that shrinks never deletes anything: new things
 *   are refused and the portal shows "over limit".
 * - **Enterprise**: not self-service. Its limits and price are set per organization by the Sidekick team in
 *   the Owner Console (`org_terms`); until they are, it gets the Business limits. Organizations with no
 *   subscription at all ("managed", set up by the Sidekick team) have no limits unless the team sets some.
 * - **Made-up prices**: Sidekick's pricing isn't decided yet (see docs/BLUEPRINT.md). These numbers are
 *   placeholders for the test-mode checkout and will change before anyone pays real money.
 * - **Trial**: every self-service sign-up starts with `TRIAL_DAYS` of free use before the first payment.
 * - **Grace period**: when a payment fails, the organization keeps full use for `GRACE_DAYS` while someone
 *   fixes it; after that the portal turns read-only (see `accessFor` in lib/billing.ts).
 */

/** The plan ids stored in `subscriptions.plan`. */
export const PLAN_IDS = ["starter", "team", "business", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/**
 * What a plan allows. `null` means no limit. `connectors`: 0 = none, 1 = one tool, null = all of them.
 * `meetingHours` and `aiCreditUsd` are per calendar month (UTC); the others are totals at any moment.
 */
export type PlanLimits = {
  seats: number | null;
  workspaces: number | null;
  chats: number | null;
  meetingHours: number | null;
  documents: number | null;
  connectors: number | null;
  aiCreditUsd: number | null;
};
export type LimitKey = keyof PlanLimits;
export const LIMIT_KEYS: readonly LimitKey[] = ["seats", "workspaces", "chats", "meetingHours", "documents", "connectors", "aiCreditUsd"];

/** Plain names for the limits, as shown to people ("2 of 2 groups"). */
export const LIMIT_LABEL: Record<LimitKey, { one: string; many: string }> = {
  seats: { one: "person", many: "people" },
  workspaces: { one: "group", many: "groups" },
  chats: { one: "tracked Teams chat", many: "tracked Teams chats" },
  meetingHours: { one: "meeting hour this month", many: "meeting hours this month" },
  documents: { one: "document", many: "documents" },
  connectors: { one: "connector", many: "connectors" },
  aiCreditUsd: { one: "AI credit this month", many: "AI credit this month" },
};

/** One plan as shown to buyers. `seats`/`workspaces` (and the other limits) are `null` for no limit. */
export type Plan = PlanLimits & {
  id: PlanId;
  name: string;
  /** US dollars per seat per month (made up, test mode only). 0 for Enterprise (priced per contract). */
  pricePerSeat: number;
  /** False for Enterprise: set up by the Sidekick team, never bought or picked at checkout. */
  selfService: boolean;
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
    selfService: true,
    seats: 10,
    workspaces: 2,
    chats: 5,
    meetingHours: 20,
    documents: 200,
    connectors: 0,
    aiCreditUsd: 20,
    blurb: "For a small team trying Sidekick on one or two projects.",
    features: ["Up to 10 people", "2 workspaces", "Answers with sources in Teams and the portal", "Meeting notes and action items", "Guardrails and audit log"],
  },
  {
    id: "team",
    name: "Team",
    pricePerSeat: 15,
    selfService: true,
    seats: 50,
    workspaces: 10,
    chats: 30,
    meetingHours: 100,
    documents: 2000,
    connectors: 1,
    aiCreditUsd: 150,
    blurb: "For a delivery team running several client engagements.",
    features: ["Up to 50 people", "10 workspaces", "Everything in Starter", "Reminders in Teams chats", "Team Leads and custom guardrail rules"],
  },
  {
    id: "business",
    name: "Business",
    pricePerSeat: 25,
    selfService: true,
    seats: 500,
    workspaces: null,
    chats: 200,
    meetingHours: 500,
    documents: 20000,
    connectors: null,
    aiCreditUsd: 1000,
    blurb: "For a whole practice, with Microsoft sign-in for everyone.",
    features: ["Up to 500 people", "Unlimited workspaces", "Everything in Team", "Require Microsoft sign-in", "Priority support"],
  },
];

/**
 * Enterprise: limits and price agreed per organization and set by the Sidekick team (Owner Console →
 * client → Plan terms). These defaults (the Business limits) apply until the team sets its own.
 */
export const ENTERPRISE: Plan = {
  id: "enterprise",
  name: "Enterprise",
  pricePerSeat: 0,
  selfService: false,
  seats: 500,
  workspaces: null,
  chats: 200,
  meetingHours: 500,
  documents: 20000,
  connectors: null,
  aiCreditUsd: 1000,
  blurb: "Custom limits and price, set up with the Sidekick team.",
  features: ["Custom limits and price", "Everything in Business"],
};

/** Every plan including Enterprise (for the server and the Owner Console). Buyers only see `PLANS`. */
export const ALL_PLANS: readonly Plan[] = [...PLANS, ENTERPRISE];

/** No limits at all: organizations managed by the Sidekick team with no plan and no custom terms. */
export const UNLIMITED: PlanLimits = { seats: null, workspaces: null, chats: null, meetingHours: null, documents: null, connectors: null, aiCreditUsd: null };

/** Just the limits of a plan (drops price and wording). */
export const limitsOf = (p: Plan): PlanLimits => Object.fromEntries(LIMIT_KEYS.map((k) => [k, p[k]])) as PlanLimits;

/**
 * Checks custom limits typed by an operator: each known key must be null (no limit) or a whole number ≥ 0
 * (the AI credit may have cents). Returns only the valid keys, or a message for the first bad one.
 */
export function parseCustomLimits(raw: unknown): { limits: Partial<PlanLimits> } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Limits must be an object like { \"seats\": 100 }." };
  const out: Partial<PlanLimits> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!LIMIT_KEYS.includes(k as LimitKey)) return { error: `“${k.slice(0, 40)}” isn't a limit. Use: ${LIMIT_KEYS.join(", ")}.` };
    if (v === null) out[k as LimitKey] = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 && (k === "aiCreditUsd" || Number.isInteger(v))) out[k as LimitKey] = v;
    else return { error: `${LIMIT_LABEL[k as LimitKey].many} must be a number of 0 or more, or empty for no limit.` };
  }
  return { limits: out };
}

/**
 * How full one limit is: `pct` (0-100+, 0 when unlimited), `over` when more is used than allowed (a plan
 * that shrank), `full` when nothing more fits, and `near` from 80%. Pure, unit-tested.
 */
export function limitState(used: number, limit: number | null) {
  if (limit === null) return { used, limit, pct: 0, over: false, full: false, near: false };
  const pct = limit === 0 ? (used > 0 ? 100 : 0) : (used / limit) * 100;
  return { used, limit, pct, over: used > limit, full: used >= limit, near: pct >= 80 };
}

/**
 * About how many minutes a transcript covers: from its first to its last timestamp ("00:12:05", "[12:05]",
 * or WebVTT "00:12:05.120 --> …"), or, without timestamps, from its length at about 150 spoken words a
 * minute. At least 1 minute. Used for meeting hours.
 */
export function transcriptMinutes(text: string): number {
  const stamps = [...text.matchAll(/(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?(?![\d:])/g)]
    .map(([, h, m, s]) => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s))
    .filter((n) => Number.isFinite(n));
  if (stamps.length >= 2) {
    const span = (Math.max(...stamps) - Math.min(...stamps)) / 60;
    if (span >= 1) return Math.ceil(span);
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 150));
}

/** Free days before the first payment for a new self-service organization. */
export const TRIAL_DAYS = 14;
/** Days of full use after a failed payment, before the portal turns read-only. */
export const GRACE_DAYS = 7;
/** Length of one billing period (the mock provider bills every 30 days). */
export const PERIOD_DAYS = 30;

/** The plan with this id, or undefined for anything else (e.g. text from a request). */
export function planById(id: unknown): Plan | undefined {
  return ALL_PLANS.find((p) => p.id === id);
}

/** "Unlimited" or the number, for limits shown to people. */
export const limitText = (n: number | null) => (n === null ? "Unlimited" : String(n));

/** "$15 per person / month" */
export const priceText = (p: Plan) => (p.selfService ? `$${p.pricePerSeat} per person / month` : "Custom price");

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
