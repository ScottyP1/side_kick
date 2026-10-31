/**
 * @file The monthly AI credit: how much of Sidekick's own AI spend each organization's plan includes, and
 * what happens as it runs out. Checked before every Claude call (lib/claude.ts `structured`).
 *
 * Concepts
 * - **AI credit**: US dollars of Claude usage per calendar month (UTC) included in the plan
 *   (`aiCreditUsd` in lib/plans.ts), or the Sidekick team's override (`org_terms.ai_credit_usd`), plus any
 *   **top-ups** the team granted for this month (`credit_topups`). Use = this month's `usage_events` cost
 *   for the organization. No credit (null) = unlimited.
 * - **Levels**: `ok`; `warn` from 80% (a banner for Org Owners and Org Admins, and one
 *   audit entry a month; email later); `essentials` from 100%: answers and the guardrail check keep working
 *   on cheaper models (`ESSENTIAL_MODELS`), short meetings still get notes, and the extras pause with a plain
 *   message: automatic reminders (which also stops Claude reading tracked chats for them), the knowledge
 *   map, the in-app assistant and notes for long meetings. Nothing else is refused and nothing is deleted.
 * - **Opting out**: a call can pass `skipCredit`, and work Sidekick pays for itself passes `payer` (lib/claude.ts:
 *   the support assistant and the public help bot). Those calls are recorded with `usage_events.payer` and left
 *   out of the month's use, so they never eat into the customer's credit.
 * - **Cheap and brief cache**: the month's use is one indexed SUM, cached per organization for
 *   `CACHE_MS`; every recorded call adds its cost to the cached figure straight away, so one copy of the app
 *   sees its own spend at once and other copies within the cache time.
 * - **Owner override**: the Sidekick team can raise the credit or grant a one-off top-up in the Owner
 *   Console (`grantTopUp`, terms in lib/limits.ts); both are audited in the client's log and the operator log.
 */
import "server-only";
import { audit, auditAsSidekick, HttpError } from "./auth";
import { get, newId, now, run } from "./db";
import { monthKey, monthStart, orgPlan } from "./limits";
import { FeatureOffError, platformLog } from "./owner";
import { BRAND } from "./brand";

/** Where an organization stands this month. `creditUsd` includes top-ups; null = no credit limit. */
export type CreditStatus = {
  month: string;
  creditUsd: number | null;
  topUpUsd: number;
  usedUsd: number;
  pct: number;
  level: "unlimited" | "ok" | "warn" | "essentials";
};

/** Warning level (share of the credit used). */
export const WARN_AT = 0.8;
/** How long a computed status is reused before the database is asked again. */
const CACHE_MS = 30_000;

/**
 * Models used once the credit is used up ("essentials only"): cheaper than the normal per-feature models.
 * Override with SIDEKICK_MODEL_ESSENTIAL_ASK / _GUARD / _EXTRACT.
 */
export const ESSENTIAL_MODELS = {
  ask: process.env.SIDEKICK_MODEL_ESSENTIAL_ASK || "claude-sonnet-5-5",
  guard: process.env.SIDEKICK_MODEL_ESSENTIAL_GUARD || "claude-haiku-5-5",
  extract: process.env.SIDEKICK_MODEL_ESSENTIAL_EXTRACT || "claude-sonnet-5-5",
} as const;

/** In essentials mode, meetings with longer transcripts than this (about an hour of talk) get no notes. */
export const ESSENTIAL_TRANSCRIPT_CHARS = 60_000;

/** What pauses at 100%, in plain words for the refusal message. */
const PAUSED: Record<string, string> = {
  remind: "Automatic reminders in Teams are",
  insights: "Knowledge map updates are",
  assist: "The in-app assistant is",
  extract: "Notes for long meetings (over about an hour) are",
  live: "Live meeting decision lists are",
};

const cache = new Map<string, { at: number; status: CreditStatus }>();

/** Forgets the cached status (after the Sidekick team changes the credit or tops it up). */
export function forgetCredit(orgId: string) {
  cache.delete(orgId);
}

function levelFor(credit: number | null, used: number): CreditStatus["level"] {
  if (credit === null) return "unlimited";
  if (used >= credit) return "essentials";
  return used >= credit * WARN_AT ? "warn" : "ok";
}

/**
 * This month's AI credit for the organization: credit (plan or override, plus top-ups), this month's use,
 * percent and level. Cached briefly (`fresh` skips the cache).
 */
export async function creditStatus(orgId: string, opts: { fresh?: boolean } = {}): Promise<CreditStatus> {
  const hit = cache.get(orgId);
  const month = monthKey();
  if (!opts.fresh && hit && hit.status.month === month && Date.now() - hit.at < CACHE_MS) return hit.status;
  const [{ limits }, used, topUp] = await Promise.all([
    orgPlan(orgId),
    // Calls Sidekick pays for itself (support assistant, help bot: `payer` set) don't count.
    get<{ n: number | null }>("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM usage_events WHERE org_id = ? AND created_at >= ? AND payer IS NULL", orgId, monthStart()),
    get<{ n: number | null }>("SELECT COALESCE(SUM(amount_usd), 0) AS n FROM credit_topups WHERE org_id = ? AND month = ?", orgId, month),
  ]);
  const usedUsd = Number(used?.n ?? 0);
  const topUpUsd = Number(topUp?.n ?? 0);
  const creditUsd = limits.aiCreditUsd === null ? null : limits.aiCreditUsd + topUpUsd;
  const status: CreditStatus = {
    month, creditUsd, topUpUsd, usedUsd,
    pct: creditUsd ? (usedUsd / creditUsd) * 100 : creditUsd === 0 ? 100 : 0,
    level: levelFor(creditUsd, usedUsd),
  };
  cache.set(orgId, { at: Date.now(), status });
  return status;
}

/** Adds a just-recorded call to the cached status, so the next check sees it straight away. */
export function addSpend(orgId: string | null, costUsd: number) {
  if (!orgId) return;
  const hit = cache.get(orgId);
  if (!hit) return;
  const s = hit.status;
  s.usedUsd += costUsd;
  s.pct = s.creditUsd ? (s.usedUsd / s.creditUsd) * 100 : s.pct;
  s.level = levelFor(s.creditUsd, s.usedUsd);
}

// Notices already written by this copy of the app (the database row stops duplicates across copies).
const noticed = new Set<string>();

/** Writes the 80% / 100% notice once a month: the client's audit log, and the operator log at 100%. */
async function notice(orgId: string, s: CreditStatus) {
  if (s.level !== "warn" && s.level !== "essentials") return;
  const key = `${orgId}:${s.month}:${s.level}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  const r = await run("INSERT INTO credit_notices (org_id, month, level, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, month, level) DO NOTHING", orgId, s.month, s.level, now());
  if (!r.changes) return;
  const credit = `$${s.creditUsd!.toFixed(2)}`;
  if (s.level === "warn") {
    // The client's log has no dollar amounts (firms see their AI allowance as a percent; lib/firm-usage.ts).
    await auditAsSidekick(orgId, "80% of this month's included AI is used", "Billing");
  } else {
    await auditAsSidekick(orgId, "This month's included AI is used up: essentials only until the 1st (answers keep working)", "Billing");
    const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId);
    await platformLog(BRAND.name, `${org?.name ?? orgId} used up its AI credit (${credit}): essentials only`);
  }
}

/** The plain message for a paused extra, worded for whoever reads it. */
function pausedMessage(feature: string) {
  return `${PAUSED[feature] ?? "This AI feature is"} paused because your organization has used this month's included AI. Answers to questions keep working. The allowance starts again on the 1st; an Org Owner or Org Admin can see the details on Usage & billing.`;
}

/**
 * The credit check before a Claude call. Returns the model to use instead of the feature's normal one
 * (essentials mode), or nothing to go ahead as usual. Throws `FeatureOffError("credit")` when the feature
 * pauses at 100%. `size` is the content length (for long meeting notes). Skipped for `skipCredit` calls
 * and work with no organization.
 */
export async function creditGate(feature: string, orgId: string | null | undefined, opts: { size?: number; skipCredit?: boolean } = {}): Promise<{ model?: string }> {
  if (!orgId || opts.skipCredit) return {};
  const s = await creditStatus(orgId);
  await notice(orgId, s);
  if (s.level !== "essentials") return {};
  if (feature === "ask" || feature === "guard") return { model: ESSENTIAL_MODELS[feature] };
  if (feature === "extract" && (opts.size ?? 0) <= ESSENTIAL_TRANSCRIPT_CHARS) return { model: ESSENTIAL_MODELS.extract };
  throw new FeatureOffError("credit", pausedMessage(feature));
}

/**
 * The Sidekick team grants a one-off top-up for this month (Owner Console). Audited in the client's log
 * and the operator log; takes effect at once on this copy of the app.
 */
export async function grantTopUp(orgId: string, amountUsd: unknown, note: unknown, ownerName: string) {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) throw new HttpError(400, "Enter a top-up between $0.01 and $100,000.");
  const text = typeof note === "string" ? note.trim().slice(0, 200) || null : null;
  const month = monthKey();
  await run("INSERT INTO credit_topups (id, org_id, month, amount_usd, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId(), orgId, month, Math.round(amount * 100) / 100, text, ownerName, now());
  forgetCredit(orgId);
  // The dollar amount is in the operator log; the client's log says only that extra AI was added.
  await audit({ org_id: orgId, name: `${BRAND.name} team` }, `Added extra AI for ${month}${text ? ` (${text})` : ""}`, "Billing");
  return creditStatus(orgId, { fresh: true });
}
