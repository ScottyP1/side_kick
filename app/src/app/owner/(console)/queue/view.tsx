"use client";

/**
 * Job queue (/owner/queue): the background work's health (lib/jobs.ts): how many jobs are waiting now (backlog), how
 * long the oldest has waited, running and stuck jobs (lease ran out), failures and finished jobs in the last day,
 * dead letters (gave up after their attempts) with Retry / Cancel, counts per kind of job and per company, and open
 * watcher findings per kind (lib/watchers.ts). "Run all now" enqueues every recurring job for the next heartbeat.
 * Counts, kinds and error reasons only: never job payloads or client content. Operators only.
 * Data: GET/POST /api/owner/queue. What to do when it's stuck: docs/RUNBOOKS.md → "Job queue stuck".
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, Pill, useReportError, useToast } from "@/components/ui";

type Health = {
  now: string; backlog: number; waiting: number; running: number; stuck: number; failedDay: number; doneDay: number; dead: number;
  oldestWaitMs: number; lastDone: string | null;
  kinds: { kind: string; label: string; status: string; n: number }[];
  companies: { org_id: string; name: string; backlog: number; running: number; failed: number; dead: number; done: number }[];
  deadJobs: { id: string; kind: string; label: string; org: string | null; attempts: number; last_error: string | null; updated_at: string }[];
  findings: { kind: string; label: string; open: number }[];
};

const wait = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1)} h`);

export default function QueuePage() {
  const toast = useToast();
  const reportError = useReportError();
  const [h, setH] = useState<Health | null>(null);
  const load = useCallback(() => api<Health>("/api/owner/queue").then(setH), []);
  useEffect(() => {
    load().catch(reportError);
    const t = setInterval(() => load().catch(() => undefined), 15_000);
    return () => clearInterval(t);
  }, [load, reportError]);
  const act = async (json: Record<string, unknown>, done: string) => {
    try {
      await api("/api/owner/queue", { method: "POST", json });
      toast(done);
      await load();
    } catch (e) {
      reportError(e);
    }
  };
  if (!h) return <span className="muted">Loading…</span>;
  // Kinds as rows with a column per status.
  const kinds = [...new Set(h.kinds.map((k) => k.kind))].map((kind) => {
    const rows = h.kinds.filter((k) => k.kind === kind);
    const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { kind, label: rows[0].label, queued: n("queued"), running: n("running"), done: n("done"), dead: n("dead") };
  });
  const healthy = h.stuck === 0 && h.dead === 0 && h.oldestWaitMs < 5 * 60_000;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Job queue</div>
          <h1>Background work</h1>
          <p>Reminders, watchers, roll-off deletions and clean-up run here, each exactly once. Counts only, no client content. Refreshes every 15 seconds.</p>
        </div>
        <div className="actions">
          <Pill kind={healthy ? "good" : "warn"}>{healthy ? "Healthy" : "Needs a look"}</Pill>
          <button className="btn" onClick={() => act({ action: "sweep" }, "Every recurring job is queued for the next heartbeat")}>Run all now</button>
        </div>
      </div>

      <div className="grid g4">
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">Backlog</span>
          <span className="v">{h.backlog}</span>
          <span className="d muted">{h.backlog ? `oldest waiting ${wait(h.oldestWaitMs)}` : "nothing waiting"} · {h.waiting} later</span>
        </div>
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">Running</span>
          <span className="v">{h.running}</span>
          <span className="d muted" style={{ color: h.stuck ? "var(--bad)" : undefined }}>{h.stuck ? `${h.stuck} stuck (lease ran out)` : "none stuck"}</span>
        </div>
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">Last 24 hours</span>
          <span className="v">{h.doneDay}</span>
          <span className="d muted">finished · {h.failedDay} failed attempts · last {fmtTime(h.lastDone)}</span>
        </div>
        <div className="kpi" style={{ cursor: "default" }}>
          <span className="eyebrow">Dead letters</span>
          <span className="v" style={{ color: h.dead ? "var(--bad)" : undefined }}>{h.dead}</span>
          <span className="d muted">gave up after every attempt</span>
        </div>
      </div>

      {h.deadJobs.length > 0 && (
        <div className="panel">
          <div className="panel-h"><h2>Dead letters</h2><span className="muted" style={{ fontSize: 12.5 }}>Fix the cause first (docs/RUNBOOKS.md), then Retry.</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Job</th><th>Company</th><th>Attempts</th><th>Last error</th><th>When</th><th></th></tr></thead>
              <tbody>
                {h.deadJobs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.label}<div className="muted mono" style={{ fontSize: 12 }}>{d.kind}</div></td>
                    <td>{d.org ?? <span className="muted">System</span>}</td>
                    <td className="num">{d.attempts}</td>
                    <td className="err" style={{ fontSize: 12.5 }}>{d.last_error}</td>
                    <td className="num">{fmtTime(d.updated_at)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn small" onClick={() => act({ action: "retry", id: d.id }, "Back in the queue")}>Retry</button>{" "}
                      <button className="btn small ghost" onClick={() => act({ action: "cancel", id: d.id }, "Canceled")}>Cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>By kind of job</h2></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Job</th><th className="num">Queued</th><th className="num">Running</th><th className="num">Done (7 days)</th><th className="num">Dead</th></tr></thead>
              <tbody>
                {!kinds.length && <tr><td colSpan={5} className="muted">No jobs yet.</td></tr>}
                {kinds.map((k) => (
                  <tr key={k.kind}>
                    <td>{k.label}<div className="muted mono" style={{ fontSize: 12 }}>{k.kind}</div></td>
                    <td className="num">{k.queued}</td><td className="num">{k.running}</td><td className="num">{k.done}</td><td className="num">{k.dead}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Open watcher findings</h2><span className="muted" style={{ fontSize: 12.5 }}>All clients, counts only</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Kind</th><th className="num">Open</th></tr></thead>
              <tbody>
                {!h.findings.length && <tr><td colSpan={2} className="muted">Nothing open.</td></tr>}
                {h.findings.map((f) => <tr key={f.kind}><td>{f.label}</td><td className="num">{f.open}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><h2>By company</h2><span className="muted" style={{ fontSize: 12.5 }}>Jobs that belong to one client (system sweeps aren&apos;t listed)</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Company</th><th className="num">Backlog</th><th className="num">Running</th><th className="num">Done (24 h)</th><th className="num">Failed (24 h)</th><th className="num">Dead</th></tr></thead>
            <tbody>
              {!h.companies.length && <tr><td colSpan={6} className="muted">No client jobs yet.</td></tr>}
              {h.companies.map((c) => (
                <tr key={c.org_id}>
                  <td><Link href={`/owner/clients/${c.org_id}`}>{c.name}</Link></td>
                  <td className="num">{c.backlog}</td><td className="num">{c.running}</td><td className="num">{c.done}</td>
                  <td className="num">{c.failed}</td><td className="num" style={{ color: c.dead ? "var(--bad)" : undefined }}>{c.dead}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
