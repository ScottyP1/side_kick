"use client";

/**
 * Owner Console business view (/owner/business): the operator's one place to watch the business, instead of
 * an Azure dashboard. MRR and margin (plan revenue minus AI cost), plan mix, trials ending soon, failed
 * payments, sign-ups per week, every client's usage against its plan with "near limit" / "over limit" flags
 * and its partner, and the app's own infrastructure health (health checks, running release, recent deploys,
 * app errors, and how full Azure AI Search is: storage and indexes against the tier's limits, lib/search-capacity.ts). Data: GET /api/owner/business. Operators only. Prices are test-mode placeholders.
 */

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { api, fmtDate, fmtTime, Pill, usd, useReportError } from "@/components/ui";
import { BRAND } from "@/lib/brand";

/** "Oct 5" for a week that starts on 2026-10-05 (the API's Monday-based weeks, in UTC). */
const weekLabel = (week: string) => new Date(`${week}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

type Client = {
  id: string; name: string; paused: boolean; plan: string; status: string; people: number; revenue: number; aiCost: number; margin: number;
  creditPct: number; creditLevel: string; partner: string | null; near: string[]; over: string[];
};
type B = {
  kpis: { mrr: number; aiCost: number; margin: number; clients: number; paying: number; nearLimit: number };
  planMix: Record<string, number>;
  trialsEnding: { id: string; name: string; plan?: string; endsAt: string; ended: boolean }[];
  pastDue: { id: string; name: string; plan?: string; since: string | null }[];
  signups: { week: string; all: number; selfService: number }[];
  clients: Client[];
  infra: {
    health: { ok: boolean; database: { engine: string; reachable: boolean }; claude: boolean; search: string; teams: boolean };
    build: { version: string; commit: string | null; releasedAt: string | null; startedAt: string; node: string; environment: string };
    releases: { commit_sha: string | null; released_at: string | null; first_seen_at: string }[];
    errors24h: number;
    recentErrors: { ref: string; status: number; route: string | null; created_at: string }[];
    searchCapacity: Capacity | null;
  };
};
type Capacity = {
  tier: string | null;
  storage: { usedBytes: number; quotaBytes: number | null; pct: number | null } | null;
  indexes: { used: number; quota: number | null; pct: number | null } | null;
  documents: number | null;
  level: "ok" | "warn" | "full";
  message: string | null;
  checkedAt: string | null;
  error: string | null;
};

const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

/** Azure AI Search use against the tier's limits (operators only), with the upgrade alert while it's 70%+ full. */
function SearchCapacity({ c }: { c: Capacity }) {
  const kind = c.level === "full" ? "bad" : c.level === "warn" ? "warn" : "good";
  const row = (label: string, value: string, pct: number | null) => (
    <div className="bar-row">
      <span>{label}<div className="muted" style={{ fontSize: 12.5 }}>{value}</div></span>
      <div className="bar" role="img" aria-label={`${label}: ${pct ?? 0}% used`}><span style={{ width: `${Math.min(100, pct ?? 0)}%`, background: pct !== null && pct >= 90 ? "var(--bad)" : pct !== null && pct >= 70 ? "var(--warn)" : undefined }} /></div>
      <span className="num r">{pct === null ? "—" : `${pct}%`}</span>
    </div>
  );
  return (
    <div className="panel" id="search-capacity">
      <div className="panel-h"><h2>Search capacity</h2><Pill kind={kind}>{c.tier ? `${c.tier} tier` : "Azure AI Search"}</Pill></div>
      <div className="panel-b">
        {c.message && <div className={`callout ${kind}`} role="status" style={{ marginBottom: 12 }}><div><b>{c.message}.</b> How: docs/RUNBOOKS.md, “Upgrade the search tier”.</div></div>}
        {c.storage && row("Storage", `${mb(c.storage.usedBytes)} of ${c.storage.quotaBytes ? mb(c.storage.quotaBytes) : "no limit"}`, c.storage.pct)}
        {c.indexes && row("Indexes", `${c.indexes.used} of ${c.indexes.quota ?? "no limit"}`, c.indexes.pct)}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          {c.checkedAt ? `Checked ${fmtTime(c.checkedAt)}, every hour.` : "Not checked yet: the first check runs within the hour."}
          {c.documents !== null && ` ${c.documents.toLocaleString("en-US")} passages indexed.`}
          {" "}Warns at 70% of storage or one index left, and again at 90%.
        </p>
        {c.error && <div className="callout bad" role="alert"><div>The last check failed: {c.error}</div></div>}
      </div>
    </div>
  );
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BusinessPage() {
  const reportError = useReportError();
  const [b, setB] = useState<B | null>(null);
  useEffect(() => {
    api<B>("/api/owner/business").then(setB).catch(reportError);
  }, [reportError]);
  if (!b) return <span className="muted">Loading…</span>;
  const k = b.kpis;
  const maxSign = Math.max(1, ...b.signups.map((s) => s.all));
  const h = b.infra.health;
  const checks: [string, boolean, string][] = [
    ["Database", h.database.reachable, `${h.database.engine === "postgres" ? "Postgres" : "SQLite"} · ${h.database.reachable ? "reachable" : "unreachable"}`],
    ["AI key", h.claude, h.claude ? "Set" : "Missing (ANTHROPIC_API_KEY)"],
    ["Search", true, h.search === "azure-hybrid" ? "Azure AI Search, hybrid" : h.search === "azure-keyword" ? "Azure AI Search, keyword" : "Local keyword index"],
    ["Teams bot", h.teams, h.teams ? "Set up" : "Not set up"],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Owner Console</div>
          <h1>Business</h1>
          <p>Revenue, margin, plans, trials, payments, sign-ups, usage against limits and the app&apos;s own health, in one place. Prices are test-mode placeholders.</p>
        </div>
      </div>

      <div className="grid g4">
        {[
          ["MRR", money(k.mrr), `${k.paying} paying of ${k.clients} clients`],
          ["AI cost this month", money(k.aiCost), `What Claude cost ${BRAND.name} so far`],
          ["Margin this month", money(k.margin), k.mrr ? `${Math.round((k.margin / k.mrr) * 100)}% of MRR` : "No revenue yet"],
          ["Near or over a limit", String(k.nearLimit), k.nearLimit ? "See the clients table" : "Nobody is close"],
        ].map(([l, v, d]) => (
          <div key={l} className="kpi" style={{ cursor: "default" }}>
            <span className="eyebrow">{l}</span>
            <span className="v">{v}</span>
            <span className="d muted">{d}</span>
          </div>
        ))}
      </div>

      <div className="grid g3">
        <div className="panel">
          <div className="panel-h"><h2>Plan mix</h2></div>
          <div className="panel-b">
            <dl className="kv">
              {Object.entries(b.planMix).map(([plan, n]) => <Fragment key={plan}><dt>{plan}</dt><dd>{n}</dd></Fragment>)}
            </dl>
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Trials ending soon</h2><span className="muted">Next 7 days</span></div>
          <div className="list">
            {!b.trialsEnding.length && <div className="li muted">None.</div>}
            {b.trialsEnding.map((t) => (
              <div key={t.id} className="li"><Link href={`/owner/clients/${t.id}`}><b>{t.name}</b></Link><span className="muted">{t.plan} · {t.ended ? "ended" : "ends"} {fmtDate(t.endsAt)}</span></div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Failed payments</h2></div>
          <div className="list">
            {!b.pastDue.length && <div className="li muted">None.</div>}
            {b.pastDue.map((t) => (
              <div key={t.id} className="li"><Link href={`/owner/clients/${t.id}`}><b>{t.name}</b></Link><span className="muted">{t.plan} · since {fmtDate(t.since)}</span></div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><h2>Sign-ups per week</h2><span className="muted">Last 12 weeks · darker = self-service</span></div>
        <div className="panel-b">
          <div className="spark" role="img" aria-label={`Sign-ups per week: ${b.signups.map((s) => `week of ${weekLabel(s.week)}: ${s.all}`).join(", ")}`}>
            {b.signups.map((s) => (
              <div key={s.week} title={`Week of ${weekLabel(s.week)}: ${s.all} new (${s.selfService} self-service)`}>
                {s.all > 0 && <span className="spark-n">{s.all}</span>}
                <div className="c" style={{ height: `${((s.all - s.selfService) / maxSign) * 130}px`, opacity: 0.45 }} />
                <div className="c" style={{ height: `${(s.selfService / maxSign) * 130}px`, borderRadius: s.all === s.selfService ? "3px 3px 0 0" : 0 }} />
              </div>
            ))}
          </div>
          {/* Week labels under the bars (the Monday each week starts); every other one on narrow screens. */}
          <div className="spark-x" aria-hidden="true">
            {b.signups.map((s) => <span key={s.week}>{weekLabel(s.week)}</span>)}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><h2>Clients: usage, limits and margin</h2><span className="muted">This month</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Client</th><th>Plan</th><th>Partner</th><th className="r">People</th><th className="r">Revenue</th><th className="r">AI cost</th><th className="r">Margin</th><th className="r">AI credit</th><th>Limits</th></tr></thead>
            <tbody>
              {b.clients.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/owner/clients/${c.id}`}><b>{c.name}</b></Link>{c.paused && <> <Pill kind="bad">Paused</Pill></>}</td>
                  <td>{c.plan}<div className="muted" style={{ fontSize: 12.5 }}>{c.status}</div></td>
                  <td className="muted">{c.partner ?? "—"}</td>
                  <td className="r num">{c.people}</td>
                  <td className="r num">{money(c.revenue)}</td>
                  <td className="r num">{usd(c.aiCost)}</td>
                  <td className="r num" style={{ color: c.margin < 0 ? "var(--bad)" : undefined }}>{money(c.margin)}</td>
                  <td className="r num">{c.creditLevel === "unlimited" ? "No limit" : `${c.creditPct}%`}</td>
                  <td>
                    {c.over.map((l) => <Pill key={l} kind="bad">Over: {l}</Pill>)}
                    {c.near.map((l) => <Pill key={l} kind="warn">Near: {l}</Pill>)}
                    {!c.over.length && !c.near.length && <span className="muted">OK</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>Infrastructure health</h2><Pill kind={h.ok ? "good" : "bad"}>{h.ok ? "Healthy" : "Database down"}</Pill></div>
          <div className="panel-b">
            <dl className="kv">
              {checks.map(([l, ok, text]) => <Fragment key={l}><dt>{l}</dt><dd><Pill kind={ok ? "good" : "warn"}>{text}</Pill></dd></Fragment>)}
              <dt>Running</dt><dd className="mono">{b.infra.build.commit ?? "unknown"} · v{b.infra.build.version}</dd>
              <dt>Released</dt><dd>{b.infra.build.releasedAt ? fmtTime(b.infra.build.releasedAt) : "Not set by the deploy"}</dd>
              <dt>Up since</dt><dd>{fmtTime(b.infra.build.startedAt)}</dd>
              <dt>App errors (24 h)</dt><dd>{b.infra.errors24h}</dd>
            </dl>
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Recent deploys and errors</h2><Link className="btn small" href="/owner/performance">Performance &amp; errors</Link></div>
          <div className="list">
            {b.infra.releases.map((r) => (
              <div key={`${r.commit_sha}-${r.first_seen_at}`} className="li"><span className="mono">{r.commit_sha ?? "unknown"}</span><span className="muted">{r.released_at ? `released ${fmtTime(r.released_at)}` : `first seen ${fmtTime(r.first_seen_at)}`}</span></div>
            ))}
            {b.infra.recentErrors.map((e) => (
              <div key={e.ref} className="li"><span><Pill kind="bad">{e.status}</Pill> <span className="mono">{e.ref}</span></span><span className="muted">{e.route} · {fmtTime(e.created_at)}</span></div>
            ))}
            {!b.infra.releases.length && !b.infra.recentErrors.length && <div className="li muted">Nothing yet.</div>}
          </div>
        </div>
      </div>
      {b.infra.searchCapacity && <SearchCapacity c={b.infra.searchCapacity} />}
    </>
  );
}
