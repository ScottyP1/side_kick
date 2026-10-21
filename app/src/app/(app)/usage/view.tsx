"use client";

/**
 * Usage & billing (/usage): the organization's plan (PlanSection: status, limits, pay / change / cancel), the
 * monthly AI credit, then every AI request metered: tokens, cost and response time by feature, group and day,
 * and **Export CSV** (AI cost and activity per group with its engagement code, per month, for chargeback;
 * GET /api/usage/export). Plain wording: no model names (those are for the Sidekick team).
 * Owners, Admins and Billing Admins (only Owners and Billing Admins change the plan).
 */

import { useEffect, useState } from "react";
import { api, ApiError, usd, useReportError, useToast } from "@/components/ui";
import { PlanSection } from "./plan";

type Credit = { month: string; creditUsd: number | null; topUpUsd: number; usedUsd: number; pct: number; level: "unlimited" | "ok" | "warn" | "essentials" };

type U = {
  period: { start: string; end: string; day: number; days: number };
  totals: { calls: number; cost: number; input: number; output: number; latency: number; errors: number };
  byFeature: { feature: string; calls: number; cost: number; latency: number }[];
  byWorkspace: { name: string; color: string; calls: number; cost: number }[];
  daily: { day: string; cost: number; calls: number }[];
  credit: Credit;
};
const FEATURE: Record<string, string> = { ask: "Answering questions", extract: "Meeting notes", insights: "Knowledge map", assist: "In-app assistant", guard: "Guardrail check", remind: "Reminders", embed: "Search embeddings" };

/**
 * Downloads the usage CSV for the last `months` months. Problems (not allowed, server trouble) show as a
 * toast or the problem modal, never silently.
 */
function ExportButton() {
  const toast = useToast();
  const reportError = useReportError();
  const [months, setMonths] = useState("12");
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/usage/export?months=${months}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new ApiError(res.status, data?.error ?? `Export failed (${res.status}).`, res.status >= 500 ? "server" : "request");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "sidekick-usage.csv" });
      a.click();
      URL.revokeObjectURL(url);
      toast("Usage exported");
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="actions" style={{ alignItems: "center" }}>
      <select className="input" style={{ width: "auto" }} value={months} onChange={(e) => setMonths(e.target.value)} aria-label="Months to export">
        <option value="1">This month</option>
        <option value="3">Last 3 months</option>
        <option value="12">Last 12 months</option>
      </select>
      <button className="btn" onClick={download} disabled={busy}>{busy ? "Exporting…" : "Export CSV"}</button>
    </div>
  );
}

/** The month's AI credit: used / included (with top-ups), a meter, and what happens at 80% and 100%. */
function CreditPanel({ c }: { c: Credit }) {
  const pct = Math.min(100, c.pct);
  return (
    <div className="panel">
      <div className="panel-h"><h2>AI credit this month</h2><span className="muted">{c.creditUsd === null ? "No limit" : `${Math.round(c.pct)}% used`}</span></div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <b className="num" style={{ fontSize: 18 }}>{usd(c.usedUsd)}{c.creditUsd !== null && <span className="muted" style={{ fontWeight: 400 }}> of {usd(c.creditUsd)}</span>}</b>
        {c.creditUsd !== null && <div className="meter"><span style={{ width: `${pct}%`, background: c.level === "essentials" ? "var(--bad)" : c.level === "warn" ? "var(--warn)" : undefined }} /></div>}
        {c.topUpUsd > 0 && <span className="muted">Includes a {usd(c.topUpUsd)} top-up from the Sidekick team.</span>}
        <span className="muted">
          {c.creditUsd === null ? "Your organization's AI use isn't capped."
            : c.level === "essentials" ? "Used up: Sidekick keeps answering questions and checking them against your guardrails; reminders, knowledge map updates, the assistant and notes for long meetings are paused until the 1st. Ask the Sidekick team for a top-up, or move to a bigger plan."
            : "At 80% the Org Owner, Org Admins and Billing Admins see a notice. At 100% Sidekick keeps answering questions and pauses the extras until the 1st."}
        </span>
      </div>
    </div>
  );
}

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
          <p>Every AI request is metered: cost, size and response time. Your plan includes a monthly AI credit; the plan&apos;s price is separate.</p>
        </div>
        <ExportButton />
      </div>
      <PlanSection />
      <div className="grid g4">
        {[
          ["AI spend this month", usd(u.totals.cost), `On pace for ${usd(projected)}`],
          ["AI requests", u.totals.calls.toLocaleString(), `${u.totals.errors} failed`],
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
          <div className="panel-h"><h2>By group</h2></div>
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
        <CreditPanel c={u.credit} />
      </div>
    </>
  );
}
