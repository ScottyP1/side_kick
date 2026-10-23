"use client";

/**
 * Activity (/activity): what Sidekick did for this organization, like an APM tool (Dynatrace-style).
 * - Overview: request volume, failures, response times, AI calls and cost, portal vs Teams, busiest operations.
 * - Traces: every request and Teams message; click one for its step-by-step waterfall (search, AI,
 *   embeddings, Teams delivery, database time).
 * - Messages: questions asked in the portal and in Teams, and whether Sidekick found the answer.
 * - Audit trail: who did what (the same log as Security & audit).
 * Org Owners and Admins only (other roles get a refusal box). Data comes from /api/activity and /api/audit; traces are kept 30 days and
 * hold timings and counts, never document text.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtTime, Modal, Pill, Spinner, usd, useReportError } from "@/components/ui";
import { BRAND } from "@/lib/brand";

type Overview = {
  days: number;
  guardrails: { total: number; blocked: number; rules: { rule: string; label: string; total: number }[] };
  kpis: { requests: number; failed: number; refused: number; errorRate: number; p50: number; p95: number; teams: number; portal: number; background: number; people: number; aiCalls: number; aiCost: number; aiFailed: number; questions: number; answered: number };
  series: { key: string; requests: number; errors: number }[];
  operations: { name: string; count: number; errors: number; p50: number; p95: number }[];
};
type Trace = { id: string; channel: string; name: string; actor: string | null; status: string; http_status: number | null; error: string | null; ref: string | null; duration_ms: number; span_count: number; db_queries: number; db_ms: number; started_at: string; workspace: string | null };
type SpanRow = { span_id: string; parent_id: string | null; kind: string; name: string; start_ms: number; duration_ms: number; status: string; error: string | null; attrs: Record<string, unknown> };
type Message = { id: string; question: string; found: number; created_at: string; asked_by: string | null; channel: string; workspace: string | null };
type AuditRow = { id: number; actor: string; action: string; kind: string; created_at: string; workspace: string | null };

const TABS = ["Overview", "Traces", "Messages", "Audit trail"] as const;
type Tab = (typeof TABS)[number];

/** Milliseconds as "320 ms" or "4.2 s". */
const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`);
const pctText = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`;

/** Plain-language names and colors (CSS classes k-*) for each kind of step. */
const KINDS: Record<string, string> = { request: "Request", search: "Search", rank: "Re-ranking", firm: "Firm library", feedback: "Answer feedback", rolloff: "Roll-off", ai: "AI", embed: "Embeddings", teams: "Teams", index: "Indexing", file: "Reading a file", guard: "Guardrails", remind: "Reminders", billing: "Sign-up & billing", microsoft: "Microsoft 365", auth: "Sign-in security", job: "Background job", watch: "Watchers" };

export default function ActivityPage() {
  const [tab, setTab] = useState<Tab>("Overview");
  const { me } = useApp();
  // Same refusal box as Usage and Security & audit, instead of a spinner that never finishes.
  if (!me.user.admin) return <div className="callout bad">Only Org Owners and Org Admins can see Activity. Ask one of them if you need it.</div>;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Activity</div>
          <h1>Everything {BRAND.name} did, step by step</h1>
          <p>Requests from the portal and Teams, how long each step took, what failed, and what people asked. Kept for 30 days; no document text is stored here.</p>
        </div>
      </div>
      <div className="tabs-row" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Overview" && <OverviewTab />}
      {tab === "Traces" && <TracesTab />}
      {tab === "Messages" && <MessagesTab />}
      {tab === "Audit trail" && <AuditTab />}
    </>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab() {
  const [days, setDays] = useState(7);
  const [o, setO] = useState<Overview | null>(null);
  const reportError = useReportError();
  useEffect(() => {
    api<Overview>(`/api/activity?view=overview&days=${days}`).then(setO).catch(reportError);
  }, [days, reportError]);
  if (!o) return <span className="muted"><Spinner /> Loading activity…</span>;
  const k = o.kpis;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="muted">Showing</span>
        {[1, 7, 30].map((d) => (
          <button key={d} className={`btn small${days === d ? " primary" : ""}`} aria-pressed={days === d} onClick={() => setDays(d)}>
            {d === 1 ? "Last 24 hours" : `Last ${d} days`}
          </button>
        ))}
      </div>
      <div className="grid g3">
        <Kpi label="Requests" value={k.requests.toLocaleString()} sub={`${k.portal} portal · ${k.teams} Teams${k.background ? ` · ${k.background} background` : ""}`} />
        <Kpi label="Failures" value={pctText(k.errorRate)} sub={`${k.failed} failed · ${k.refused} refused (not allowed / not found)`} tone={k.failed ? "bad" : undefined} />
        <Kpi label="Response time" value={ms(k.p50)} sub={`typical · slowest 5% take ${ms(k.p95)} or more`} />
        <Kpi label="AI work" value={`${k.aiCalls} calls`} sub={`${usd(k.aiCost)}${k.aiFailed ? ` · ${k.aiFailed} failed` : ""}`} tone={k.aiFailed ? "bad" : undefined} />
        <Kpi label="Questions answered" value={k.questions ? pctText(k.answered / k.questions) : "—"} sub={`${k.answered} of ${k.questions} found in the sources`} />
        <Kpi label="People active" value={String(k.people)} sub="signed-in people and Teams users" />
        <Kpi label="Guardrails" value={`${o.guardrails.blocked} refused`} sub={o.guardrails.total ? `${o.guardrails.total - o.guardrails.blocked} answers cleaned · most: ${o.guardrails.rules[0].label}` : "nothing refused or cleaned up"} />
      </div>
      <div className="panel">
        <div className="panel-h">
          <h2>Requests over time</h2>
          <div className="legend">
            <span><i style={{ background: "var(--viz-1)" }} />Succeeded</span>
            <span><i style={{ background: "var(--bad)" }} />Failed</span>
          </div>
        </div>
        <div className="panel-b">
          <Columns series={o.series} hourly={o.days === 1} />
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Busiest operations</h2><span className="muted">Typical and slowest-5% time</span></div>
        <OperationsTable rows={o.operations} />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "bad" }) {
  return (
    <div className="kpi" style={{ cursor: "default" }}>
      <span className="eyebrow">{label}</span>
      <b className="num" style={{ fontSize: 22, color: tone === "bad" ? "var(--bad)" : undefined }}>{value}</b>
      <span className="muted" style={{ fontSize: 12.5 }}>{sub}</span>
    </div>
  );
}

/** Requests per hour/day as columns: succeeded (blue) with failed (red) stacked on top, 2px gap. */
function Columns({ series, hourly }: { series: Overview["series"]; hourly: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => s.requests));
  const label = (key: string) => (hourly ? `${key.slice(11, 13)}:00` : new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  return (
    <div style={{ position: "relative" }}>
      <div className="cols" role="img" aria-label={`Requests per ${hourly ? "hour" : "day"}; busiest ${max}`} onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => (
          <div key={s.key} className="col" onMouseEnter={() => setHover(i)}>
            {s.requests - s.errors > 0 && <div className="ok" style={{ height: `${((s.requests - s.errors) / max) * 100}%` }} />}
            {s.errors > 0 && <div className="bad" style={{ height: `${Math.max(2, (s.errors / max) * 100)}%` }} />}
          </div>
        ))}
        {hover !== null && (
          <div className="viz-tip" style={{ left: `${((hover + 0.5) / series.length) * 100}%`, top: 0 }}>
            <b>{label(series[hover].key)}</b> · {series[hover].requests} requests{series[hover].errors ? ` · ${series[hover].errors} failed` : ""}
          </div>
        )}
      </div>
      <div className="axis">
        <span>{label(series[0].key)}</span>
        <span>{label(series[Math.floor(series.length / 2)].key)}</span>
        <span>{label(series[series.length - 1].key)}</span>
      </div>
    </div>
  );
}

function OperationsTable({ rows }: { rows: Overview["operations"] }) {
  const max = Math.max(1, ...rows.map((r) => r.p95));
  if (!rows.length) return <div className="empty">No activity in this period yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Operation</th><th>Count</th><th>Failed</th><th>Typical</th><th style={{ width: "30%" }}>Slowest 5%</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="mono" style={{ fontSize: 12.5 }}>{r.name}</td>
              <td className="num">{r.count}</td>
              <td>{r.errors ? <Pill kind="bad">{r.errors}</Pill> : <span className="muted">0</span>}</td>
              <td className="num">{ms(r.p50)}</td>
              <td>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div className="bar" style={{ flex: 1 }}><span style={{ width: `${(r.p95 / max) * 100}%`, background: "var(--viz-1)" }} /></div>
                  <span className="num" style={{ minWidth: 58, textAlign: "right" }}>{ms(r.p95)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Traces ---------------- */

/** Status of a trace in words and pill style: Failed (5xx), Refused (4xx), or OK. */
const statusOf = (t: Trace) =>
  t.status === "error" ? { label: `Failed${t.http_status ? ` (${t.http_status})` : ""}`, kind: "bad" } : (t.http_status ?? 0) >= 400 ? { label: `Refused (${t.http_status})`, kind: "warn" } : { label: "OK", kind: "good" };

function TracesTab() {
  const [rows, setRows] = useState<Trace[] | null>(null);
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [hideReads, setHideReads] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const reportError = useReportError();
  const load = useCallback(() => {
    const p = new URLSearchParams({ view: "traces" });
    if (channel) p.set("channel", channel);
    if (status) p.set("status", status);
    if (q.trim()) p.set("q", q.trim());
    return api<{ traces: Trace[] }>(`/api/activity?${p}`).then((r) => setRows(r.traces));
  }, [channel, status, q]);
  useEffect(() => {
    const t = setTimeout(() => load().catch(reportError), 250);
    return () => clearTimeout(t);
  }, [load, reportError]);
  const shown = useMemo(() => (rows ?? []).filter((r) => !hideReads || !r.name.startsWith("GET ") || r.status === "error"), [rows, hideReads]);
  return (
    <div className="panel">
      <div className="panel-h" style={{ gap: 8 }}>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search operation, person or reference code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search traces" />
        <select className="input" style={{ width: "auto" }} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          <option value="">Everything</option>
          <option value="portal">Portal only</option>
          <option value="teams">Teams only</option>
          <option value="system">Background only</option>
        </select>
        <select className="input" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any result</option>
          <option value="error">Failed</option>
          <option value="refused">Refused</option>
          <option value="ok">OK</option>
        </select>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={hideReads} onChange={(e) => setHideReads(e.target.checked)} />
          Hide page loads
        </label>
        <button className="btn small" onClick={() => load().catch(reportError)}>Refresh</button>
      </div>
      {!rows ? (
        <div className="panel-b muted"><Spinner /> Loading traces…</div>
      ) : !shown.length ? (
        <div className="empty">No traces match. Activity appears here as people use {BRAND.name} in the portal and in Teams.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Operation</th><th>Where</th><th>Who</th><th>Workspace</th><th>Took</th><th>Steps</th><th>Result</th></tr></thead>
            <tbody>
              {shown.map((t) => {
                const st = statusOf(t);
                return (
                  <tr key={t.id} className="clickable" onClick={() => setOpen(t.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(t.id)}>
                    <td className="ts" style={{ whiteSpace: "nowrap" }}>{fmtTime(t.started_at)}</td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{t.name}</td>
                    <td><Pill nodot>{t.channel === "teams" ? "Teams" : t.channel === "portal" ? "Portal" : "System"}</Pill></td>
                    <td>{t.actor ?? <span className="muted">—</span>}</td>
                    <td>{t.workspace ?? <span className="muted">—</span>}</td>
                    <td className="num">{ms(t.duration_ms)}</td>
                    <td className="num">{t.span_count}</td>
                    <td><Pill kind={st.kind}>{st.label}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <TraceDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One trace's waterfall: each step as a bar placed by when it started and sized by how long it took. */
function TraceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<{ trace: Trace; spans: SpanRow[] } | null>(null);
  const reportError = useReportError();
  useEffect(() => {
    api<{ trace: Trace; spans: SpanRow[] }>(`/api/activity?view=trace&id=${encodeURIComponent(id)}`).then(setD).catch(reportError);
  }, [id, reportError]);
  const ordered = useMemo(() => {
    if (!d) return [];
    const depth = new Map<string, number>();
    const byId = new Map(d.spans.map((s) => [s.span_id, s]));
    const depthOf = (s: SpanRow): number => {
      if (depth.has(s.span_id)) return depth.get(s.span_id)!;
      const p = s.parent_id ? byId.get(s.parent_id) : undefined;
      const v = p ? depthOf(p) + 1 : 0;
      depth.set(s.span_id, v);
      return v;
    };
    return d.spans.map((s) => ({ ...s, depth: depthOf(s) })).sort((a, b) => a.start_ms - b.start_ms || a.depth - b.depth);
  }, [d]);
  const total = Math.max(1, d?.trace.duration_ms ?? 1, ...ordered.map((s) => s.start_ms + s.duration_ms));
  const kinds = [...new Set(ordered.map((s) => s.kind))];
  const st = d ? statusOf(d.trace) : null;
  return (
    <Modal title={d ? d.trace.name : "Trace"} onClose={onClose} wide>
      {!d ? (
        <span className="muted"><Spinner /> Loading…</span>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill kind={st!.kind}>{st!.label}</Pill>
            <span className="muted">{fmtTime(d.trace.started_at)} · {ms(d.trace.duration_ms)} · {d.trace.actor ?? "unknown"}{d.trace.workspace ? ` · ${d.trace.workspace}` : ""}</span>
          </div>
          {d.trace.error && (
            <div className="callout bad">
              <div>{d.trace.error}{d.trace.ref && <> · Reference <b className="mono">{d.trace.ref}</b></>}</div>
            </div>
          )}
          <div className="legend">
            {kinds.map((k) => (
              <span key={k}><i className={`k-${k}`} />{KINDS[k] ?? k}</span>
            ))}
            <span>Database: {d.trace.db_queries} queries · {ms(d.trace.db_ms)}</span>
          </div>
          <div className="wf" role="list" aria-label="Steps of this request">
            {ordered.map((s) => {
              const attrs = Object.entries(s.attrs).filter(([key]) => key !== "db_queries" && key !== "db_ms");
              const left = (s.start_ms / total) * 100;
              const width = Math.max(0.6, (s.duration_ms / total) * 100);
              return (
                <div key={s.span_id} className="wf-row" role="listitem">
                  <div className="wf-name" style={{ paddingLeft: s.depth * 14 }} title={s.name}>
                    {s.status === "error" && <span style={{ color: "var(--bad)" }}>✕ </span>}
                    {s.name}
                  </div>
                  <div className="wf-track">
                    <div className={`wf-bar k-${s.kind}${s.status === "error" ? " err" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} />
                    <span className="wf-dur" style={left + width > 78 ? { right: `${100 - left + 1}%` } : { left: `calc(${left + width}% + 6px)` }}>{ms(s.duration_ms)}</span>
                  </div>
                  {(attrs.length > 0 || s.error) && (
                    <div className="wf-attrs">
                      {s.error && <span style={{ color: "var(--bad)" }}>{s.error} · </span>}
                      {attrs.map(([key, v]) => `${key.replace(/_/g, " ")}: ${typeof v === "number" && key.startsWith("cost") ? usd(v) : String(v)}`).join(" · ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------------- Messages ---------------- */

function MessagesTab() {
  const [rows, setRows] = useState<Message[] | null>(null);
  const [channel, setChannel] = useState("");
  const reportError = useReportError();
  useEffect(() => {
    api<{ messages: Message[] }>("/api/activity?view=messages").then((r) => setRows(r.messages)).catch(reportError);
  }, [reportError]);
  const shown = (rows ?? []).filter((m) => !channel || m.channel === channel);
  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Questions asked</h2>
        <select className="input" style={{ width: "auto" }} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          <option value="">Everything</option>
          <option value="portal">Portal only</option>
          <option value="teams">Teams only</option>
        </select>
      </div>
      {!rows ? (
        <div className="panel-b muted"><Spinner /> Loading…</div>
      ) : !shown.length ? (
        <div className="empty">No questions yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Where</th><th>Who</th><th>Workspace</th><th>Question</th><th>Answer</th></tr></thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id}>
                  <td className="ts" style={{ whiteSpace: "nowrap" }}>{fmtTime(m.created_at)}</td>
                  <td><Pill nodot>{m.channel === "teams" ? "Teams" : "Portal"}</Pill></td>
                  <td>{m.asked_by ?? <span className="muted">—</span>}</td>
                  <td>{m.workspace ?? "—"}</td>
                  <td>{m.question}</td>
                  <td>{m.found ? <Pill kind="good">Answered</Pill> : <Pill kind="warn">Not in sources (gap)</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------- Audit trail ---------------- */

function AuditTab() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const reportError = useReportError();
  useEffect(() => {
    api<{ rows: AuditRow[] }>("/api/audit").then((r) => setRows(r.rows)).catch(reportError);
  }, [reportError]);
  return (
    <div className="panel">
      <div className="panel-h"><h2>Audit trail</h2><span className="muted">Who did what. Full page: Security &amp; audit</span></div>
      {!rows ? (
        <div className="panel-b muted"><Spinner /> Loading…</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Type</th><th>Workspace</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="ts" style={{ whiteSpace: "nowrap" }}>{fmtTime(r.created_at)}</td>
                  <td>{r.actor}</td>
                  <td>{r.action}</td>
                  <td><Pill nodot>{r.kind}</Pill></td>
                  <td>{r.workspace ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
