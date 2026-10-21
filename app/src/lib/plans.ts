/**
 * @file Sidekick's plans: the one place that says what each plan is called, what it costs and what it
 * includes. Pure data and small helpers with no I/O, so the public pricing page, the sign-up and checkout
 * pages, the portal's Usage & billing page, the Owner Console and the server (lib/billing.ts) all read the
 * same list.
 *
 * Concepts
 * - **Plan**: what an organization pays for. Priced **per organization per month**, by the number of
 *   **groups** (workspaces, one per client engagement) it includes; people are a limit, not a price. Extra
 *   groups (`EXTRA_GROUP`) can be added to any self-service plan. Each plan has **limits** (`PlanLimits`): people, groups
 *   (workspaces), tracked Teams chats, meeting hours per month, documents, connectors and a **monthly AI
 *   credit** in US dollars. Limits are enforced where each thing is created (lib/limits.ts) and the AI
 *   credit before every Claude call (lib/credit.ts). A plan that shrinks never deletes anything: new things
 *   are refused and the portal shows "over limit".
 * - **Enterprise**: not self-service. Its limits and price are set per organization by the Sidekick team in
 *   the Owner Console (`org_terms`); until they are, it gets the `ENTERPRISE` defaults. Organizations with no
 *   subscription at all ("managed", set up by the Sidekick team) have no limits unless the team sets some.
 * - **Made-up prices**: Sidekick's pricing isn't final (see docs/BLUEPRINT.md). These numbers are
 *   placeholders Cody approved for the test-mode checkout and will change before anyone pays real money.
 * - **Plans from before group pricing** (per-person prices, Oct 2026) kept their ids (starter, team,
 *   business, enterprise), so existing subscriptions simply get the new limits. Nothing is deleted when an
 *   organization has more groups than its plan now includes: its groups keep working, "over limit" shows,
 *   and only new groups are refused until it adds extra groups or upgrades.
 * - **Trial**: every self-service sign-up starts with `TRIAL_DAYS` of free use before the first payment.
 * - **Grace period**: when a payment fails, the organization keeps full use for `GRACE_DAYS` while someone
 *   fixes it; after that the portal turns read-only (see `accessFor` in lib/billing.ts).
 */

/** The plan ids stored in `subscriptions.plan`. */
import { BRAND } from "./brand";
export const PLAN_IDS = ["starter", "team", "business", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/**
 * What a plan allows. `null` means no limit. `connectors`: 0 = none, 1 = one tool, null = all of them.
 * `meetingHours`, `liveMeetingHours` and `aiCreditUsd` are per calendar month (UTC); the others are totals
 * at any moment. `liveMeetingHours` is Sidekick joining calls live (product step 3, not built yet): only
 * Enterprise includes it.
 */
export type PlanLimits = {
  seats: number | null;
  workspaces: number | null;
  chats: number | null;
  meetingHours: number | null;
  liveMeetingHours: number | null;
  documents: number | null;
  connectors: number | null;
  aiCreditUsd: number | null;
};
export type LimitKey = keyof PlanLimits;
export const LIMIT_KEYS: readonly LimitKey[] = ["seats", "workspaces", "chats", "meetingHours", "liveMeetingHours", "documents", "connectors", "aiCreditUsd"];

/** Plain names for the limits, as shown to people ("2 of 2 groups"). */
export const LIMIT_LABEL: Record<LimitKey, { one: string; many: string }> = {
  seats: { one: "person", many: "people" },
  workspaces: { one: "group", many: "groups" },
  chats: { one: "tracked Teams chat", many: "tracked Teams chats" },
  meetingHours: { one: "meeting hour this month", many: "meeting hours this month" },
  liveMeetingHours: { one: "live meeting hour this month", many: "live meeting hours this month" },
  documents: { one: "document", many: "documents" },
  connectors: { one: "connector", many: "connectors" },
  aiCreditUsd: { one: "AI credit this month", many: "AI credit this month" },
};

/** One plan as shown to buyers. `seats`/`workspaces` (and the other limits) are `null` for no limit. */
export type Plan = PlanLimits & {
  id: PlanId;
  name: string;
  /**
   * US dollars per **organization** per month (made up, test mode only), whatever the number of people:
   * people are a limit, not what's charged. For Enterprise it's the usual starting point ("from"); the real
   * price is set per contract in the Owner Console.
   */
  priceUsd: number;
  /** False for Enterprise: set up by the Sidekick team, never bought or picked at checkout. */
  selfService: boolean;
  /** One line for the pricing card. */
  blurb: string;
  /** What's included, in plain words, for the pricing card. */
  features: string[];
};

/**
 * Every self-service plan, cheapest first. Change prices and limits here only. Plans are priced per
 * **group** (one group per client engagement), because what Sidekick costs to run follows the activity in
 * each group, and consultancies bill per engagement. Each plan includes some groups; more can be added as
 * `EXTRA_GROUP`s on any self-service plan.
 */
export const PLANS: readonly Plan[] = [
  {
    id: "starter",
    name: "Starter",
    priceUsd: 199,
    selfService: true,
    seats: 15,
    workspaces: 1,
    chats: 5,
    meetingHours: 30,
    liveMeetingHours: 0,
    documents: 500,
    connectors: 0,
    aiCreditUsd: 40,
    blurb: "One client engagement with its whole team.",
    features: ["1 group, up to 15 people", "30 meeting hours a month", "Answers with sources in Teams and the portal", "Meeting notes and action items", "Guardrails and audit log"],
  },
  {
    id: "team",
    name: "Team",
    priceUsd: 699,
    selfService: true,
    seats: 75,
    workspaces: 5,
    chats: 25,
    meetingHours: 150,
    liveMeetingHours: 0,
    documents: 2500,
    connectors: 1,
    aiCreditUsd: 200,
    blurb: "A delivery team running several client engagements.",
    features: ["5 groups, up to 75 people", "150 meeting hours a month", "Everything in Starter", "Reminders in Teams chats", "Team Leads and custom guardrail rules", "1 connector"],
  },
  {
    id: "business",
    name: "Business",
    priceUsd: 1999,
    selfService: true,
    seats: 300,
    workspaces: 20,
    chats: 100,
    meetingHours: 600,
    liveMeetingHours: 0,
    documents: 10000,
    connectors: null,
    aiCreditUsd: 800,
    blurb: "A whole practice, with Microsoft sign-in for everyone.",
    features: ["20 groups, up to 300 people", "600 meeting hours a month", "Everything in Team", "Require Microsoft sign-in", "All connectors", "Priority support"],
  },
];

/**
 * Enterprise: limits and price agreed per organization and set by the Sidekick team (Owner Console →
 * client → Plan terms). These defaults apply until the team sets its own: unlimited groups, room for a big
 * practice, and live meeting hours (the only plan that has them). `priceUsd` is the usual starting point.
 */
export const ENTERPRISE: Plan = {
  id: "enterprise",
  name: "Enterprise",
  priceUsd: 5000,
  selfService: false,
  seats: 1000,
  workspaces: null,
  chats: 400,
  meetingHours: 2400,
  liveMeetingHours: 100,
  documents: 40000,
  connectors: null,
  aiCreditUsd: 3200,
  blurb: `Custom limits and price, set up with the ${BRAND.name} team.`,
  features: ["Unlimited groups, custom limits", "Live in meetings (when available)", "Dedicated database option", "Everything in Business"],
};

/**
 * One **extra group**, added to any self-service plan for a monthly price. Each one raises the group limit
 * by one and brings that group's share of the other limits (people, meeting hours, AI credit, tracked chats
 * and documents) with it, so a plan with extras behaves like a slightly bigger plan.
 */
export const EXTRA_GROUP = {
  priceUsd: 129,
  adds: { workspaces: 1, seats: 15, meetingHours: 30, aiCreditUsd: 40, chats: 5, documents: 500 } satisfies Partial<PlanLimits>,
} as const;
/** Most extra groups bought through the portal; past this, the Sidekick team sets up Enterprise. */
export const MAX_EXTRA_GROUPS = 50;

/** The monthly price of a plan with `extras` extra groups, in US dollars (per organization). */
export const monthlyPrice = (p: Plan, extras = 0) => p.priceUsd + (p.selfService ? Math.max(0, extras) * EXTRA_GROUP.priceUsd : 0);

/**
 * A plan's limits with `extras` extra groups on top (`EXTRA_GROUP.adds` once per extra group). Limits that
 * are unlimited stay unlimited; extras only count on self-service plans.
 */
export function limitsWithExtras(p: Plan, extras = 0): PlanLimits {
  const out = limitsOf(p);
  const n = p.selfService ? Math.max(0, Math.floor(extras)) : 0;
  for (const [k, v] of Object.entries(EXTRA_GROUP.adds) as [LimitKey, number][]) if (out[k] !== null) out[k] = (out[k] as number) + v * n;
  return out;
}

/** One way to get room for more groups: a plan, how many extra groups on it, and what it costs a month. */
export type GroupOption = { plan: PlanId; planName: string; extras: number; priceUsd: number; groups: number };

/**
 * The ways to make room for `groupsNeeded` groups, starting from `current` with `extras` extra groups:
 * - `extra`: stay on the current plan and buy just enough extra groups;
 * - `upgrade`: the cheapest bigger self-service plan that fits (with extra groups only if even Business is
 *   too small), or null when there's no bigger plan;
 * - `cheaper`: which of the two costs less a month (the upgrade wins a tie, since it raises other limits too).
 * Pure, so the server's limit message and the portal's buttons always agree. Example: 3 groups on Starter →
 * extra = Starter + 2 extra groups, $457; upgrade = Team, $699; cheaper = "extra".
 */
export function groupOptions(current: Plan, extras: number, groupsNeeded: number): { extra: GroupOption; upgrade: GroupOption | null; cheaper: "extra" | "upgrade" } {
  const option = (p: Plan): GroupOption => {
    const n = p.workspaces === null ? 0 : Math.max(0, groupsNeeded - p.workspaces);
    return { plan: p.id, planName: p.name, extras: n, priceUsd: monthlyPrice(p, n), groups: p.workspaces === null ? groupsNeeded : p.workspaces + n };
  };
  const extra = option(current);
  // Never suggest fewer extras than the organization already pays for on its own plan.
  if (extra.extras < extras) Object.assign(extra, { extras, priceUsd: monthlyPrice(current, extras), groups: (current.workspaces ?? 0) + extras });
  const idx = PLANS.findIndex((p) => p.id === current.id);
  const bigger = PLANS.slice(idx + 1).map(option).sort((a, b) => a.priceUsd - b.priceUsd);
  const upgrade = bigger[0] ?? null;
  return { extra, upgrade, cheaper: upgrade && upgrade.priceUsd <= extra.priceUsd ? "upgrade" : "extra" };
}

/** "$457 a month" */
export const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Every plan including Enterprise (for the server and the Owner Console). Buyers only see `PLANS`. */
export const ALL_PLANS: readonly Plan[] = [...PLANS, ENTERPRISE];

/** No limits at all: organizations managed by the Sidekick team with no plan and no custom terms. */
export const UNLIMITED: PlanLimits = { seats: null, workspaces: null, chats: null, meetingHours: null, liveMeetingHours: null, documents: null, connectors: null, aiCreditUsd: null };

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

/** "$699 / month" for self-service plans, "From $5,000 / month" for Enterprise. */
export const priceText = (p: Plan) => (p.selfService ? `${usd(p.priceUsd)} / month` : `From ${usd(p.priceUsd)} / month`);

/** "Starter + 2 extra groups" (or just "Starter"). */
export const planWithExtras = (p: Plan, extras = 0) => (extras > 0 ? `${p.name} + ${extras} extra group${extras === 1 ? "" : "s"}` : p.name);

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
      return { mode: "full", notice: `Free trial: ${left} day${left === 1 ? "" : "s"} left. Pay for your plan on Usage & billing to keep using ${BRAND.name} after ${day(sub.trial_ends_at!)}.`, reason: null };
    }
    return readOnly("the free trial has ended");
  }
  if (sub.status === "past_due") {
    const end = until(sub.past_due_since) + GRACE_DAYS * 86400_000;
    if (end > at) return { mode: "full", notice: `The last payment failed. Fix it on Usage & billing by ${day(new Date(end).toISOString())}, or ${BRAND.name} turns read-only.`, reason: null };
    return readOnly("the last payment failed and wasn't fixed in time");
  }
  const end = until(sub.access_until);
  if (end > at) return { mode: "full", notice: `Your plan is canceled. ${BRAND.name} stays fully usable until ${day(sub.access_until!)}, then turns read-only.`, reason: null };
  return readOnly("the plan is canceled");
}

function readOnly(why: string): Access {
  const reason = `${BRAND.name} is read-only for your organization because ${why}. You can still see everything; an Org Owner or Billing Admin can pay on Usage & billing to turn everything back on.`;
  return { mode: "read_only", notice: reason, reason };
}

/** Plain names for the statuses, as shown in the portal and the Owner Console. */
export const STATUS_LABEL: Record<SubStatus, string> = { trialing: "Free trial", active: "Active", past_due: "Payment failed", canceled: "Canceled" };

/** A pending roll-off of the whole organization (lib/rolloff.ts): read-only from, deleted on, and why. */
export type OrgRolloffTimes = { read_only_from: string | null; delete_on: string; reason: string | null };

/**
 * Adds a pending roll-off to what a subscription allows. From `read_only_from` the organization is
 * read-only (whatever the subscription says) and the banner gives the deletion date and how to keep the
 * data; before that, the current notice gets the deletion date added. `selfService`: whether paying again on
 * Usage & billing stops it (otherwise the Sidekick team does). Pure, unit-tested.
 */
export function withRolloff(access: Access, roll: OrgRolloffTimes | null | undefined, opts: { selfService: boolean }, at: number = Date.now()): Access {
  if (!roll) return access;
  const when = day(roll.delete_on);
  const keep = opts.selfService ? "To keep it, an Org Owner or Billing Admin can pay again on Usage & billing." : `To keep it, contact the ${BRAND.name} team.`;
  if (roll.read_only_from && Date.parse(roll.read_only_from) <= at) {
    const reason = `${BRAND.name} is read-only for your organization${roll.reason ? ` because ${roll.reason}` : ""}, and everything in it will be deleted on ${when}. Org Owners and Org Admins can download everything on Settings → Export your data until then. ${keep}`;
    return { mode: "read_only", notice: reason, reason };
  }
  const base = access.notice ? `${access.notice} ` : "";
  return { ...access, notice: `${base}Your organization's data will be deleted on ${when}. ${keep}` };
}
