"use client";

/**
 * Usage & billing (/usage): every Claude request metered: tokens, cost and response time by feature, model,
 * workspace and day. Owners, Admins and Billing Admins.
 */

import { useEffect, useState } from "react";
import { api, usd } from "@/components/ui";

type U = {
  period: { start: string; end: string; day: number; days: number };
  totals: { calls: number; cost: number; input: number; output: number; latency: number; errors: number };
  byFeature: { feature: string; calls: number; cost: number; latency: number }[];
  byModel: { model: string; calls: number; cost: number; input: number; output: number; cached: number }[];
  byWorkspace: { name: string; color: string; calls: number; cost: number }[];
  daily: { day: string; cost: number; calls: number }[];
  models: Record<string, string>;
};
const FEATURE: Record<string, string> = { ask: "Answering questions", extract: "Meeting notes", insights: "Knowledge map", assist: "In-app assistant", guard: "Guardrail check", remind: "Reminders", embed: "Search embeddings" };

export default function UsagePage() {
  const [u, setU] = useState<U | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<U>("/api/usage").then(setU).catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="callout bad">{err}</div>;
  if (!u) return <span className="muted">Loading…</span>;
  const projected = u.period.day ? (u.totals.cost / u.period.day) * u.period.days : 0;
  const maxWs = Math.max(0.0001, ...u.byWorkspace.map((w) => w.cost));
  const maxDay = Math.max(0.0001, ...u.daily.map((d) => d.cost));
  // Every day of the month, so quiet days show as gaps instead of disappearing from the chart.
  const byDay = new Map(u.daily.map((d) => [d.day, d]));
  const monthDays = Array.from({ length: u.period.days }, (_, i) => {
    const day = new Date(Date.parse(u.period.start) + i * 86400000 + 12 * 3600000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, cost: 0, calls: 0 };
  });
  // The month's start is midnight on the server's clock (UTC in Azure), which is still the previous month
  // in US time zones; naming the month from its middle is right in every time zone.
  const month = new Date((Date.parse(u.period.start) + Date.parse(u.period.end)) / 2).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Usage & billing</div>
          <h1>{month}</h1>
          <p>Every Claude request is metered: tokens, cost and response time. Prices are Claude API list prices. Pricing for clients isn&apos;t set yet.</p>
        </div>
      </div>
      <div className="grid g4">
        {[
          ["AI spend this month", usd(u.totals.cost), `On pace for ${usd(projected)}`],
          ["Claude requests", u.totals.calls.toLocaleString(), `${u.totals.errors} failed`],
          ["Tokens", `${((u.totals.input + u.totals.output) / 1000).toFixed(1)}k`, `${(u.totals.input / 1000).toFixed(1)}k in · ${(u.totals.output / 1000).toFixed(1)}k out`],
          ["Avg response time", `${(u.totals.latency / 1000).toFixed(1)} s`, u.totals.calls ? `Average over ${u.totals.calls.toLocaleString()} request${u.totals.calls === 1 ? "" : "s"}` : "No requests yet"],
        ].map(([l, v, d]) => (
          <div key={l} className="kpi" style={{ cursor: "default" }}>
            <span className="eyebrow">{l}</span>
            <span className="v">{v}</span>
            <span className="d muted">{d}</span>
          </div>
        ))}
      </div>
      <div className="grid g-main">
        <div className="panel">
          <div className="panel-h"><h2>Spend per day</h2><span className="muted">This month</span></div>
          <div className="panel-b">
            {!u.daily.length ? <div className="empty">No usage yet.</div> : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 160, paddingTop: 8 }}>
                {monthDays.map((d) => (
                  <div key={d.day} title={`${d.day}: ${usd(d.cost)} · ${d.calls} requests`} style={{ flex: 1, minWidth: 4, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
                    <div style={{ width: "100%", height: d.calls ? `${Math.max(3, (d.cost / maxDay) * 130)}px` : 0, background: "var(--accent)", borderRadius: "4px 4px 0 0" }} />
                    <span className="faint" style={{ fontSize: 10.5 }}>{Number(d.day.slice(8))}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>By feature</h2></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Feature</th><th className="r">Requests</th><th className="r">Avg time</th><th className="r">Cost</th></tr></thead>
              <tbody>
                {u.byFeature.map((f) => (
                  <tr key={f.feature}><td>{FEATURE[f.feature] ?? f.feature}</td><td className="r num">{f.calls}</td><td className="r num">{(f.latency / 1000).toFixed(1)} s</td><td className="r num">{usd(f.cost)}</td></tr>
                ))}
                {!u.byFeature.length && <tr><td colSpan={4} className="muted">No usage yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>By workspace</h2></div>
          <div className="panel-b">
            {!u.byWorkspace.length && <span className="muted">No usage yet.</span>}
            {u.byWorkspace.map((w) => (
              <div key={w.name} className="bar-row">
                <span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}><span className="swatch" style={{ background: w.color }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</span></span>
                <div className="bar"><span style={{ width: `${(w.cost / maxWs) * 100}%`, background: w.color }} /></div>
                <span className="num" style={{ textAlign: "right" }}>{usd(w.cost)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>By model</h2></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Model</th><th className="r">Requests</th><th className="r">Cached input</th><th className="r">Cost</th></tr></thead>
              <tbody>
                {u.byModel.map((m) => (
                  <tr key={m.model}><td className="mono">{m.model}</td><td className="r num">{m.calls}</td><td className="r num">{(m.cached / 1000).toFixed(1)}k</td><td className="r num">{usd(m.cost)}</td></tr>
                ))}
                {!u.byModel.length && <tr><td colSpan={4} className="muted">No usage yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
