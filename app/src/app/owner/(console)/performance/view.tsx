"use client";

/**
 * Performance & errors (/owner/performance): answer quality per client (👍/👎 and "I don't know" share, weekly trend;
 * counts only), response times, error rates and cache savings per feature and model.
 */

import { useEffect, useState } from "react";
import { api, fmtTime, Pill, usd } from "@/components/ui";

type G = { name: string; calls: number; errors: number; p50: number; p95: number; cost: number; cacheHit: number };
type Tally = { up: number; down: number; helpful: number | null };
type Quality = {
  clients: (Tally & { orgId: string; client: string; answers: number; dontKnow: number; dontKnowShare: number | null })[];
  weeks: (Tally & { week: string })[];
};
type P = {
  quality: Quality;
  byFeature: G[];
  byModel: G[];
  errors: { created_at: string; feature: string; model: string; latency_ms: number; error: string | null; tenant: string | null }[];
  processing: { tenant: string; failed_docs: number; failed_meetings: number; unanswered: number; questions: number }[];
  appErrors: { ref: string; status: number; method: string | null; route: string | null; message: string; created_at: string }[];
};
const FEATURE: Record<string, string> = { ask: "Answering questions", extract: "Meeting notes", insights: "Knowledge map", assist: "In-app assistant", guard: "Guardrail check", followup: "Follow-up rewrite" };
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function Table({ title, rows, label }: { title: string; rows: G[]; label: (n: string) => string }) {
  return (
    <div className="panel">
      <div className="panel-h"><h2>{title}</h2><span className="muted">Last 30 days</span></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>{title.split(" ").pop()}</th><th className="r">Requests</th><th className="r">Typical (p50)</th><th className="r">Slowest 5% (p95)</th><th className="r">Errors</th><th className="r">Cache hit</th><th className="r">Cost</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td className={label(r.name) === r.name ? "mono" : undefined}>{label(r.name)}</td>
                <td className="r num">{r.calls}</td>
                <td className="r num">{sec(r.p50)}</td>
                <td className="r num" style={{ color: r.p95 > 30000 ? "var(--warn)" : undefined }}>{sec(r.p95)}</td>
                <td className="r num" style={{ color: r.errors ? "var(--bad)" : undefined }}>{r.errors}{r.calls ? <span className="faint"> ({Math.round((r.errors / r.calls) * 100)}%)</span> : null}</td>
                <td className="r num">{Math.round(r.cacheHit * 100)}%</td>
                <td className="r num">{usd(r.cost)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">No requests yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PerformancePage() {
  const [p, setP] = useState<P | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<P>("/api/owner/performance").then(setP).catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="callout bad">{err}</div>;
  if (!p) return <span className="muted">Loading…</span>;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Performance & errors</div>
          <h1>Speed, reliability and cost</h1>
          <p>How fast each feature responds, how often it fails, and how much prompt caching saves.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Answer quality by client</h2><span className="muted">Last 30 days · 👍/👎 on answers, counts only</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Client</th><th className="r">Answers</th><th className="r">&ldquo;I don&apos;t know&rdquo;</th><th className="r">👍</th><th className="r">👎</th><th className="r">Helpful</th></tr></thead>
            <tbody>
              {p.quality.clients.map((c) => (
                <tr key={c.orgId}>
                  <td>{c.client}</td>
                  <td className="r num">{c.answers}</td>
                  <td className="r num">{c.dontKnow}{c.dontKnowShare !== null && <span className="faint"> ({c.dontKnowShare}%)</span>}</td>
                  <td className="r num">{c.up}</td>
                  <td className="r num" style={{ color: c.down > c.up ? "var(--warn)" : undefined }}>{c.down}</td>
                  <td className="r num">{c.helpful === null ? "—" : `${c.helpful}%`}</td>
                </tr>
              ))}
              {!p.quality.clients.length && <tr><td colSpan={6} className="muted">No answers yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {p.quality.weeks.length > 0 && (
          <div className="panel-b muted" style={{ fontSize: 13 }}>
            Weekly, all clients: {p.quality.weeks.map((w) => `week of ${w.week}: ${w.helpful === null ? "—" : `${w.helpful}% helpful`} (${w.up} 👍, ${w.down} 👎)`).join(" · ")}
          </div>
        )}
      </div>
      <Table title="By feature" rows={p.byFeature} label={(n) => FEATURE[n] ?? n} />
      <Table title="By model" rows={p.byModel} label={(n) => n} />
      <div className="panel">
        <div className="panel-h"><h2>Processing health by client</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Client</th><th className="r">Failed documents</th><th className="r">Failed meetings</th><th className="r">Questions with no answer</th></tr></thead>
            <tbody>
              {p.processing.map((r) => (
                <tr key={r.tenant}>
                  <td>{r.tenant}</td>
                  <td className="r num" style={{ color: r.failed_docs ? "var(--bad)" : undefined }}>{r.failed_docs}</td>
                  <td className="r num" style={{ color: r.failed_meetings ? "var(--bad)" : undefined }}>{r.failed_meetings}</td>
                  <td className="r num">{r.unanswered}<span className="faint"> of {r.questions}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Failed requests</h2><Pill kind={p.errors.length ? "bad" : "good"}>{p.errors.length}</Pill></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Client</th><th>Feature</th><th>Model</th><th>Error</th></tr></thead>
            <tbody>
              {p.errors.map((e, i) => (
                <tr key={i}>
                  <td className="ts" style={{ whiteSpace: "nowrap" }}>{fmtTime(e.created_at)}</td>
                  <td>{e.tenant ?? "—"}</td>
                  <td>{FEATURE[e.feature] ?? e.feature}</td>
                  <td className="mono">{e.model}</td>
                  <td style={{ color: "var(--bad)" }}>{e.error ?? "Unknown error"}</td>
                </tr>
              ))}
              {!p.errors.length && <tr><td colSpan={5} className="muted">No failed requests.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h">
          <h2>App errors (reference codes)</h2>
          <Pill kind={p.appErrors.length ? "bad" : "good"}>{p.appErrors.length}</Pill>
        </div>
        <div className="panel-b muted" style={{ paddingBottom: 0 }}>
          Unexpected problems a person saw as &ldquo;Something went wrong… (Reference ABCD-1234)&rdquo;. Use the code a client sends you to find the details here.
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Reference</th><th>Request</th><th>Status</th><th>What happened</th></tr></thead>
            <tbody>
              {p.appErrors.map((e) => (
                <tr key={e.ref}>
                  <td className="ts" style={{ whiteSpace: "nowrap" }}>{fmtTime(e.created_at)}</td>
                  <td className="mono"><b>{e.ref}</b></td>
                  <td className="mono">{e.method} {e.route}</td>
                  <td>{e.status}</td>
                  <td style={{ color: "var(--bad)" }}>{e.message}</td>
                </tr>
              ))}
              {!p.appErrors.length && <tr><td colSpan={5} className="muted">No app errors.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
