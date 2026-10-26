/**
 * GET /api/owner/business: the Owner Console's business view, the operator's one place to watch the business
 * (no Azure dashboard needed). Who: platform operators only (401 for anyone else, client accounts included).
 *
 * Returns:
 * - `kpis`: MRR (monthly recurring revenue), paying clients, AI cost this month, margin (revenue minus AI cost).
 * - `planMix`: clients per plan ("managed" = no self-service plan).
 * - `trialsEnding` (next 7 days) and `pastDue` (failed payments), each with the client's name and dates.
 * - `signups`: new organizations per week for the last 12 weeks (all, and self-service ones).
 * - `clients`: per client: plan, status, people, revenue, AI cost, margin, AI credit used, the limits at 80%
 *   or more (`near`) or over (`over`), and the partner/referrer.
 * - `infra`: the app's own health facts (as /api/health), the build and release it runs, the last releases
 *   seen, app errors in the last 24 hours (latest 5 with their reference codes), and `searchCapacity`: how full
 *   the Azure AI Search service is (storage and indexes against the tier's limits, the tier, the alert while it's
 *   70%+ full; null on the local keyword index; lib/search-capacity.ts).
 *
 * Revenue rules (test-mode prices, lib/plans.ts): an **active** subscription counts people × the plan's
 * price per person; Enterprise and managed clients count the contract price the team set
 * (`org_terms.monthly_price_usd`); trials, failed payments and canceled plans count 0 towards MRR.
 */
import { handle } from "@/lib/api";
import { all, get } from "@/lib/db";
import { requireOwner } from "@/lib/owner";
import { creditStatus } from "@/lib/credit";
import { limitReport, monthStart } from "@/lib/limits";
import { monthlyPrice, planById, planWithExtras, STATUS_LABEL, type PlanId, type SubStatus } from "@/lib/plans";
import { buildInfo, healthFacts, noteRelease } from "@/lib/ops";
import { searchCapacity } from "@/lib/search-capacity";

type OrgRow = {
  id: string; name: string; status: string; created_at: string;
  plan: PlanId | null; sub_status: SubStatus | null; provider: string | null; trial_ends_at: string | null; past_due_since: string | null; current_period_end: string | null;
  monthly_price_usd: number | null; partner: string | null; extra_groups: number | null;
};

export const GET = handle(async () => {
  await requireOwner();
  await noteRelease();
  const month = monthStart();
  const orgs = await all<OrgRow>(
    `SELECT o.id, o.name, o.status, o.created_at, s.plan, s.status AS sub_status, s.provider, s.trial_ends_at, s.past_due_since, s.current_period_end, s.extra_groups,
            t.monthly_price_usd, t.partner
       FROM orgs o LEFT JOIN subscriptions s ON s.org_id = o.id LEFT JOIN org_terms t ON t.org_id = o.id ORDER BY o.name`,
  );
  const seats = new Map((await all<{ org_id: string; n: number }>("SELECT org_id, COUNT(*) AS n FROM users GROUP BY org_id")).map((r) => [r.org_id, Number(r.n)]));
  const cost = new Map((await all<{ org_id: string; cost: number }>("SELECT org_id, COALESCE(SUM(cost_usd), 0) AS cost FROM usage_events WHERE created_at >= ? AND org_id IS NOT NULL GROUP BY org_id", month)).map((r) => [r.org_id, Number(r.cost)]));

  const clients = await Promise.all(orgs.map(async (o) => {
    const people = seats.get(o.id) ?? 0;
    const plan = o.plan ? planById(o.plan) : null;
    const custom = !plan || !plan.selfService;
    const revenue = o.sub_status === "active" || (!o.plan && o.monthly_price_usd !== null)
      ? custom ? (o.monthly_price_usd ?? 0) : monthlyPrice(plan!, Number(o.extra_groups ?? 0))
      : 0;
    const aiCost = cost.get(o.id) ?? 0;
    const credit = await creditStatus(o.id);
    const { lines } = await limitReport(o.id, credit.usedUsd);
    return {
      id: o.id, name: o.name, paused: o.status !== "Active", plan: plan?.name ?? "Managed", planLabel: plan ? planWithExtras(plan, plan.selfService ? Number(o.extra_groups ?? 0) : 0) : "Managed", status: o.sub_status ? STATUS_LABEL[o.sub_status] : "Managed",
      people, revenue, aiCost, margin: revenue - aiCost, creditPct: Math.round(credit.pct), creditLevel: credit.level, partner: o.partner,
      near: lines.filter((l) => l.near && !l.over).map((l) => l.label), over: lines.filter((l) => l.over).map((l) => l.label),
    };
  }));

  const mrr = clients.reduce((s, c) => s + c.revenue, 0);
  const aiCost = clients.reduce((s, c) => s + c.aiCost, 0);
  const planMix: Record<string, number> = {};
  for (const c of clients) planMix[c.plan] = (planMix[c.plan] ?? 0) + 1;
  const soon = new Date(Date.now() + 7 * 86400_000).toISOString();
  const nowIso = new Date().toISOString();

  // Sign-ups per week (Monday-based weeks, UTC), last 12 weeks.
  const weekStart = (iso: string) => {
    const d = new Date(iso);
    const day = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
  };
  const weeks = Array.from({ length: 12 }, (_, i) => weekStart(new Date(Date.now() - (11 - i) * 7 * 86400_000).toISOString()));
  const signups = weeks.map((week) => ({ week, all: 0, selfService: 0 }));
  for (const o of orgs) {
    const w = signups.find((s) => s.week === weekStart(o.created_at));
    if (!w) continue;
    w.all++;
    if (o.provider && o.provider !== "manual") w.selfService++;
  }

  const since24 = new Date(Date.now() - 86400_000).toISOString();
  return {
    kpis: {
      mrr, aiCost, margin: mrr - aiCost, clients: clients.length,
      paying: clients.filter((c) => c.revenue > 0).length,
      nearLimit: clients.filter((c) => c.near.length || c.over.length || c.creditPct >= 80).length,
    },
    planMix,
    trialsEnding: orgs.filter((o) => o.sub_status === "trialing" && o.trial_ends_at && o.trial_ends_at <= soon).map((o) => ({ id: o.id, name: o.name, plan: planById(o.plan)?.name, endsAt: o.trial_ends_at, ended: o.trial_ends_at! < nowIso })),
    pastDue: orgs.filter((o) => o.sub_status === "past_due").map((o) => ({ id: o.id, name: o.name, plan: planById(o.plan)?.name, since: o.past_due_since })),
    signups,
    clients: clients.sort((a, b) => b.revenue - a.revenue || b.aiCost - a.aiCost),
    infra: {
      health: await healthFacts(),
      build: buildInfo(),
      releases: await all("SELECT commit_sha, released_at, first_seen_at FROM app_releases ORDER BY first_seen_at DESC LIMIT 10"),
      errors24h: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM app_errors WHERE created_at >= ?", since24))?.n ?? 0),
      recentErrors: await all("SELECT ref, status, route, created_at FROM app_errors ORDER BY id DESC LIMIT 5"),
      searchCapacity: await searchCapacity(),
    },
  };
});
