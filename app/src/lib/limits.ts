/**
 * @file Plan limits: what an organization's plan allows (lib/plans.ts) against what it uses, and the
 * checks that refuse new things once a limit is reached.
 *
 * Concepts
 * - **Effective limits**: the plan's limits (lib/plans.ts), overlaid with any custom limits the Sidekick
 *   team set for this organization (`org_terms.limits_json`, Owner Console → client → Plan terms). An
 *   organization with no subscription ("managed", added by the Sidekick team) has no limits unless the
 *   team sets some. Enterprise starts from the Business numbers.
 * - **Enforced where created**: each route that creates something counted here calls `assertCanAdd` first
 *   (people: POST /api/users; groups: POST /api/workspaces; tracked chats: POST /api/teams-links; meeting
 *   hours: POST /api/meetings; documents: POST /api/docs; connectors: when connectors exist). The refusal is
 *   a 402 whose message names the limit and how to get more, with `kind: "limit"` and `limit` in the body.
 * - **Never deletes**: when a plan shrinks (or the team lowers a limit) nothing is removed; new things are
 *   refused and Usage & billing and the Owner Console show "over limit".
 * - **Tracked chats**: Teams chats and channels assigned to a group (Sidekick reads every message there).
 * - **Meeting hours**: the length of meetings imported this calendar month (UTC), worked out from the
 *   transcript's timestamps (`transcriptMinutes` in lib/plans.ts).
 * The monthly AI credit is a limit too, but it's checked before each Claude call in lib/credit.ts.
 */
import "server-only";
import { audit, HttpError } from "./auth";
import { get, now, run } from "./db";
import { getSubscription } from "./billing";
import { withErrorDetails } from "./api";
import { ENTERPRISE, LIMIT_KEYS, LIMIT_LABEL, limitsOf, limitState, parseCustomLimits, planById, UNLIMITED, type LimitKey, type Plan, type PlanLimits } from "./plans";

/** The custom terms the Sidekick team set for one organization (Owner Console). */
export type OrgTerms = {
  limits: Partial<PlanLimits>;
  aiCreditUsd: number | null;
  monthlyPriceUsd: number | null;
  partner: string | null;
  askPerHour: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** The organization's custom terms (all empty when the team never set any). */
export async function orgTerms(orgId: string): Promise<OrgTerms> {
  const row = await get<{ limits_json: string | null; ai_credit_usd: number | null; monthly_price_usd: number | null; partner: string | null; ask_per_hour: number | null; updated_by: string | null; updated_at: string }>(
    "SELECT limits_json, ai_credit_usd, monthly_price_usd, partner, ask_per_hour, updated_by, updated_at FROM org_terms WHERE org_id = ?", orgId,
  );
  return {
    limits: row?.limits_json ? (JSON.parse(row.limits_json) as Partial<PlanLimits>) : {},
    aiCreditUsd: row?.ai_credit_usd ?? null,
    monthlyPriceUsd: row?.monthly_price_usd ?? null,
    partner: row?.partner ?? null,
    askPerHour: row?.ask_per_hour ?? null,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * The organization's plan (null = managed by the Sidekick team, no subscription) and its effective limits:
 * the plan's (Enterprise: Business numbers), or none for a managed client, overlaid with the team's custom
 * limits, and the AI credit override (`org_terms.ai_credit_usd`) on top.
 */
export async function orgPlan(orgId: string): Promise<{ plan: Plan | null; limits: PlanLimits; terms: OrgTerms }> {
  const [sub, terms] = await Promise.all([getSubscription(orgId), orgTerms(orgId)]);
  const plan = sub ? (planById(sub.plan) ?? ENTERPRISE) : null;
  const limits: PlanLimits = { ...(plan ? limitsOf(plan) : UNLIMITED), ...terms.limits };
  if (terms.aiCreditUsd !== null) limits.aiCreditUsd = terms.aiCreditUsd;
  return { plan, limits, terms };
}

/** Start of this calendar month in UTC, as an ISO string (meeting hours and the AI credit reset then). */
export function monthStart(at = new Date()) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}
/** This calendar month as "YYYY-MM" (UTC). */
export const monthKey = (at = new Date()) => monthStart(at).slice(0, 7);

const count = async (sql: string, ...p: string[]) => Number((await get<{ n: number | string | null }>(sql, ...p))?.n ?? 0);

/**
 * How much of each limit the organization uses now. Meeting hours are this month's; the AI credit's use
 * is filled in by lib/credit.ts (here it's 0, so limits stay cheap to count). Connectors are 0 until
 * connectors to outside tools exist.
 */
export async function usageCounts(orgId: string): Promise<Record<LimitKey, number>> {
  const [seats, workspaces, chats, minutes, documents] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM users WHERE org_id = ?", orgId),
    count("SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ?", orgId),
    count("SELECT COUNT(*) AS n FROM teams_conversations WHERE org_id = ? AND workspace_id IS NOT NULL", orgId),
    count("SELECT COALESCE(SUM(duration_min), 0) AS n FROM meetings WHERE org_id = ? AND created_at >= ?", orgId, monthStart()),
    count("SELECT COUNT(*) AS n FROM documents WHERE org_id = ?", orgId),
  ]);
  return { seats, workspaces, chats, meetingHours: minutes / 60, documents, connectors: 0, aiCreditUsd: 0 };
}

/** One line of the limits report: label, used, limit and how full it is. */
export type LimitLine = ReturnType<typeof limitState> & { key: LimitKey; label: string };

/**
 * Every limit with its use, for Usage & billing and the Owner Console (`near` from 80%, `over` when a plan
 * shrank below what's used). Pass `aiUsedUsd` (from lib/credit.ts) to fill in the AI credit line.
 */
export async function limitReport(orgId: string, aiUsedUsd = 0): Promise<{ plan: Plan | null; lines: LimitLine[] }> {
  const [{ plan, limits }, used] = await Promise.all([orgPlan(orgId), usageCounts(orgId)]);
  used.aiCreditUsd = aiUsedUsd;
  return { plan, lines: LIMIT_KEYS.map((key) => ({ key, label: LIMIT_LABEL[key].many, ...limitState(used[key], limits[key]) })) };
}

/** A limit was reached: 402 with `kind: "limit"` and the limit's key, so the page can show an upgrade note. */
export class LimitError extends HttpError {
  constructor(public limit: LimitKey, message: string) {
    super(402, message);
    withErrorDetails(this, { kind: "limit", limit });
  }
}

const fmt = (key: LimitKey, n: number) => (key === "meetingHours" ? `${Math.round(n * 10) / 10}` : String(n));

/**
 * Refuses (LimitError, 402) adding `amount` more of `key` when that would go past the organization's
 * limit. Call it before creating the thing. The message says which limit, the numbers, and who can raise it:
 * self-service plans upgrade on Usage & billing; Enterprise and managed clients ask the Sidekick team.
 * Not for the AI credit (see lib/credit.ts).
 */
export async function assertCanAdd(orgId: string, key: Exclude<LimitKey, "aiCreditUsd">, amount = 1) {
  const { plan, limits } = await orgPlan(orgId);
  const limit = limits[key];
  if (limit === null) return;
  const used = (await usageCounts(orgId))[key];
  if (used + amount <= limit + 1e-9) return;
  const label = LIMIT_LABEL[key];
  const planName = plan ? `Your ${plan.name} plan` : "Your organization's plan";
  const allows = limit === 0 ? `doesn't include ${label.many}` : `allows ${fmt(key, limit)} ${limit === 1 ? label.one : label.many}`;
  const now = key === "meetingHours"
    ? ` and ${fmt(key, used)} ${used === 1 ? "hour is" : "hours are"} used; this one is about ${fmt(key, amount)} ${amount === 1 ? "hour" : "hours"}`
    : used ? ` and you have ${used}` : "";
  const how = plan?.selfService
    ? "An Org Owner or Billing Admin can move to a bigger plan on Usage & billing."
    : "Contact the Sidekick team to raise it.";
  const keep = key === "meetingHours" ? " Meeting hours start again on the 1st of next month." : "";
  throw new LimitError(key, `${planName} ${allows}${now}. ${how}${keep}`);
}

/**
 * The Sidekick team changes an organization's terms (Owner Console → client → Plan terms). Only the fields
 * given change; `null` clears one (back to the plan's number). `limits` is merged key by key (a null limit
 * means "no limit"; pass `limits: null` to drop all custom limits). Audited in the client's log; the route
 * also writes the operator log. Returns a short summary of what changed (no secrets involved).
 */
export async function saveTerms(orgId: string, body: Record<string, unknown>, ownerName: string): Promise<string> {
  const cur = await orgTerms(orgId);
  const changes: string[] = [];
  const next = { ...cur, limits: { ...cur.limits } };
  const money = (v: unknown, label: string) => {
    if (v === null) return null;
    const n = Number(v);
    if (typeof v !== "number" || !Number.isFinite(n) || n < 0 || n > 10_000_000) throw new HttpError(400, `${label} must be a dollar amount of 0 or more, or empty.`);
    return Math.round(n * 100) / 100;
  };
  if ("limits" in body) {
    if (body.limits === null) next.limits = {};
    else {
      const parsed = parseCustomLimits(body.limits);
      if ("error" in parsed) throw new HttpError(400, parsed.error);
      Object.assign(next.limits, parsed.limits);
    }
    changes.push(Object.keys(next.limits).length ? `custom limits ${LIMIT_KEYS.filter((k) => k in next.limits).map((k) => `${LIMIT_LABEL[k].many} ${next.limits[k] ?? "unlimited"}`).join(", ")}` : "plan limits (no custom ones)");
  }
  if ("aiCreditUsd" in body) {
    next.aiCreditUsd = money(body.aiCreditUsd, "The AI credit");
    changes.push(next.aiCreditUsd === null ? "the plan's AI credit" : `AI credit $${next.aiCreditUsd.toFixed(2)} a month`);
  }
  if ("monthlyPriceUsd" in body) {
    next.monthlyPriceUsd = money(body.monthlyPriceUsd, "The monthly price");
    changes.push(next.monthlyPriceUsd === null ? "no contract price" : `contract price $${next.monthlyPriceUsd.toFixed(2)} a month`);
  }
  if ("partner" in body) {
    const p = body.partner;
    if (p !== null && typeof p !== "string") throw new HttpError(400, "Partner must be text.");
    next.partner = p ? p.trim().slice(0, 120) || null : null;
    changes.push(next.partner ? `partner ${next.partner}` : "no partner");
  }
  if ("askPerHour" in body) {
    const v = body.askPerHour;
    if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000)) throw new HttpError(400, "Questions per hour must be a whole number from 1 to 10,000, or empty for the default.");
    next.askPerHour = v as number | null;
    changes.push(v === null ? "default questions per hour" : `${v} questions per person per hour`);
  }
  if (!changes.length) throw new HttpError(400, "Say what to change: limits, aiCreditUsd, monthlyPriceUsd, partner or askPerHour.");
  await run(
    `INSERT INTO org_terms (org_id, limits_json, ai_credit_usd, monthly_price_usd, partner, ask_per_hour, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET limits_json = excluded.limits_json, ai_credit_usd = excluded.ai_credit_usd,
       monthly_price_usd = excluded.monthly_price_usd, partner = excluded.partner, ask_per_hour = excluded.ask_per_hour,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    orgId, Object.keys(next.limits).length ? JSON.stringify(next.limits) : null, next.aiCreditUsd, next.monthlyPriceUsd, next.partner, next.askPerHour, ownerName, now(),
  );
  const summary = changes.join("; ");
  await audit({ org_id: orgId, name: "Sidekick team" }, `Set plan terms: ${summary}`, "Billing");
  return summary;
}
