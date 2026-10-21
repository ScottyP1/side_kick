"use client";

/**
 * Owner Console home (/owner): spend, speed, errors and activity across every client organization.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTime, Pill, usd } from "@/components/ui";

type O = {
  kpis: {
    tenants: number; activeTenants: number; users: number; activeUsers: number; meetings: number; questions: number; documents: number;
    monthCost: number; monthCalls: number; errorRate: number; avgLatency: number; todayCost: number; todayCalls: number; projected: number;
  };
  daily: { day: string; cost: number; calls: number; errors: number }[];
  topTenants: { id: string; name: string; status: string; cost: number; calls: number }[];
  recentErrors: { created_at: string; feature: string; model: string; error: string | null; tenant: string | null }[];
};
const FEATURE: Record<string, string> = { ask: "Answers", extract: "Meeting notes", insights: "Knowledge map", assist: "In-app assistant", guard: "Guardrail check", remind: "Reminders" };

export default function OwnerOverview() {
  const [o, setO] = useState<O | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<O>("/api/owner/overview").then(setO).catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="callout bad">{err}</div>;
  if (!o) return <span className="muted">Loading…</span>;
  const k = o.kpis;

  const days = o.daily;
  const max = Math.max(0.0001, ...days.map((d) => d.cost));
  const maxTenant = Math.max(0.0001, ...o.topTenants.map((t) => t.cost));
  const errPct = (k.errorRate * 100).toFixed(1);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Owner Console</div>
          <h1>Sidekick at a glance</h1>
          <p>Spend, speed, errors and activity across every client organization.</p>
        </div>
        <div className="actions">
          <Link className="btn" href="/owner/performance">Performance</Link>
          <Link className="btn primary" href="/owner/clients">Add client</Link>
        </div>
      </div>

      <div className="grid g4">
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">AI spend this month</span>
          <span className="v">{usd(k.monthCost)}</span>
          <span className="d muted">On pace for {usd(k.projected)} · today {usd(k.todayCost)}</span>
        </div>
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">Clients</span>
          <span className="v">{k.tenants}</span>
          <span className="d muted">{k.activeTenants} active in the last 7 days · {k.activeUsers} of {k.users} users active this week</span>
        </div>
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">Error rate</span>
          <span className="v" style={{ color: k.errorRate > 0.05 ? "var(--bad)" : undefined }}>{errPct}%</span>
          <span className="d muted">{k.monthCalls.toLocaleString()} Claude requests this month</span>
        </div>
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">Avg response time</span>
          <span className="v">{(k.avgLatency / 1000).toFixed(1)} s</span>
          <span className="d muted">Per Claude request, this month</span>
        </div>
      </div>

      <div className="grid g-main">
        <div className="panel">
          <div className="panel-h">
            <h2>AI spend per day</h2>
            <div className="legend"><span><i style={{ background: "var(--accent)" }} />Spend</span><span><i style={{ background: "var(--bad)" }} />Failed requests</span></div>
          </div>
          <div className="panel-b">
            <div className="spark" role="img" aria-label="AI spend per day for the last 30 days">
              {days.map((d) => (
                <div key={d.day} title={`${d.day}: ${usd(d.cost)} · ${d.calls} requests · ${d.errors} failed`}>
                  {d.errors > 0 && <span className="e" style={{ height: Math.min(20, 4 + d.errors * 3) }} />}
                  <span className="c" style={{ height: d.cost ? Math.max(3, (d.cost / max) * 120) : 1, opacity: d.cost ? 1 : 0.25 }} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }} className="faint">
              <span style={{ fontSize: 11.5 }}>{days[0].day.slice(5)}</span>
              <span style={{ fontSize: 11.5 }}>Today</span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Activity this month</h2></div>
          <div className="panel-b">
            <dl className="kv">
              <dt>Meetings processed</dt><dd>{k.meetings}</dd>
              <dt>Questions answered</dt><dd>{k.questions}</dd>
              <dt>Documents indexed (all time)</dt><dd>{k.documents}</dd>
              <dt>Claude requests today</dt><dd>{k.todayCalls}</dd>
            </dl>
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>Spend by client</h2><Link className="btn small" href="/owner/clients">All clients</Link></div>
          <div className="panel-b">
            {!o.topTenants.length && <span className="muted">No clients yet.</span>}
            {o.topTenants.map((t) => (
              <div key={t.id} className="bar-row">
                <span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                  {t.status === "Suspended" && <Pill kind="bad">Paused</Pill>}
                </span>
                <div className="bar"><span style={{ width: `${(t.cost / maxTenant) * 100}%` }} /></div>
                <span className="num" style={{ textAlign: "right" }}>{usd(t.cost)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Latest errors</h2><Link className="btn small" href="/owner/performance">All errors</Link></div>
          <div className="list">
            {!o.recentErrors.length && <div className="li muted">No failed requests. 🎉</div>}
            {o.recentErrors.map((e, i) => (
              <div key={i} className="li">
                <Pill kind="bad">{FEATURE[e.feature] ?? e.feature}</Pill>
                <div className="grow">
                  <b style={{ fontSize: 13 }}>{e.error ?? "Unknown error"}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>{e.tenant ?? "—"} · {fmtTime(e.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
