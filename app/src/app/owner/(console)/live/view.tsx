"use client";

/**
 * Live meetings (/owner/live): Sidekick in Teams meetings live (lib/live-meetings/, Enterprise) across every client.
 * At the top, this month's **meeting-bot cost** (estimate from Sidekick's records and Azure list prices: bot containers,
 * Azure speech-to-text minutes, spoken characters, Recall.ai hours; "on pace for") and the **platform cap** the operator
 * sets (dollars or meeting hours a month, $50 by default; PUT /api/owner/live/cap; at 100% no new meetings).
 * Whether the meeting-bot service is set up on this copy; per client this month: sessions, live hours against the
 * plan's limit, answers given and failures; the sessions running now; the latest failures with their reason (lobby
 * timeouts, the provider refusing, chat posts that failed). Titles only, never anything said in a meeting. The
 * "Live in meetings" switch on Releases & switches pauses it for everyone or one client. Operators only.
 * Data: GET /api/owner/live.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTime, Pill, useReportError, useToast } from "@/components/ui";

type Session = { id: string; orgId: string; org: string; group: string; title: string; status: string; invitedBy: string; createdAt: string; minutes: number; endReason: string | null; error: string | null };
type Spend = { containerUsd: number; sttUsd: number; ttsUsd: number; recallUsd: number; totalUsd: number; onPaceUsd: number; hours: number; onPaceHours: number; containerHours: number; sttMinutes: number; ttsChars: number; size: { cpu: number; memoryGib: number } };
type CapState = { cap: { kind: "usd" | "hours"; amount: number }; used: number; pct: number; level: "ok" | "warn" | "reached"; message: string | null };
type Report = {
  configured: boolean; provider: string | null; spend: Spend; cap: CapState;
  orgs: { orgId: string; org: string; sessions: number; hours: number; limit: number | null; failures: number; answers: number; running: number }[];
  running: Session[]; failures: Session[];
};

const invited = (s: Session) => (s.invitedBy === "auto" ? "Every group meeting" : s.invitedBy);

export default function LiveMeetingsPage() {
  const reportError = useReportError();
  const toast = useToast();
  const [r, setR] = useState<Report | null>(null);
  const [cap, setCap] = useState<{ kind: "usd" | "hours"; amount: string } | null>(null);
  useEffect(() => {
    api<Report>("/api/owner/live").then((x) => {
      setR(x);
      setCap({ kind: x.cap.cap.kind, amount: String(x.cap.cap.amount) });
    }).catch(reportError);
  }, [reportError]);
  if (!r || !cap) return <span className="muted">Loading…</span>;
  const saveCap = async () => {
    try {
      const st = await api<CapState>("/api/owner/live/cap", { method: "PUT", json: { kind: cap.kind, amount: Number(cap.amount) } });
      setR({ ...r, cap: st });
      toast("Cap saved.");
    } catch (e) {
      reportError(e);
    }
  };
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const s = r.spend;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Live meetings</div>
          <h1>Sidekick in Teams meetings, live</h1>
          <p>Enterprise clients&apos; meetings the meeting bot joined this month: hours against each plan, answers given and what went wrong. Pause it on Releases &amp; switches (“Live in meetings”).</p>
        </div>
      </div>
      {!r.configured && <div className="callout warn" style={{ marginBottom: 16 }}><span>The meeting-bot service isn&apos;t set up on this copy (SIDEKICK_LIVE_PROVIDER, its keys and a public address), so no client can turn live meetings on. See docs/LIVE-MEETINGS.md.</span></div>}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-h"><h2>Meeting bot cost this month (estimate)</h2><Pill kind={r.cap.level === "reached" ? "bad" : r.cap.level === "warn" ? "warn" : "good"}>{r.cap.pct}% of the cap</Pill></div>
        <div className="panel-b">
          <p style={{ margin: 0 }}><b>{usd(s.totalUsd)}</b> so far, on pace for <b>{usd(s.onPaceUsd)}</b> · {s.hours} meeting hours (on pace for {s.onPaceHours})</p>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
            Bot containers {usd(s.containerUsd)} ({s.containerHours} h at {s.size.cpu} vCPU / {s.size.memoryGib} GiB) · Azure speech-to-text {usd(s.sttUsd)} ({s.sttMinutes} min) · spoken answers {usd(s.ttsUsd)} ({s.ttsChars.toLocaleString()} characters){s.recallUsd ? ` · Recall.ai ${usd(s.recallUsd)}` : ""}. From Sidekick&apos;s own records and Azure list prices (East US); Claude is the AI spend on the home page.
          </p>
          {r.cap.message && <div className={`callout ${r.cap.level === "reached" ? "bad" : "warn"}`} style={{ marginTop: 10 }}><span>{r.cap.message}</span></div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
            <label htmlFor="cap-amount">Monthly cap for all clients</label>
            <input id="cap-amount" className="input num" style={{ width: 110 }} type="number" min={0} value={cap.amount} onChange={(e) => setCap({ ...cap, amount: e.target.value })} />
            <select className="input" style={{ width: "auto" }} value={cap.kind} onChange={(e) => setCap({ ...cap, kind: e.target.value as "usd" | "hours" })} aria-label="Cap in">
              <option value="usd">dollars</option>
              <option value="hours">meeting hours</option>
            </select>
            <button className="btn small primary" onClick={saveCap}>Save cap</button>
          </div>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>At 80% you get a warning, at 100% an alert; then Sidekick joins no new meetings (running ones finish, notes after meetings still work). Azure budgets on the bot&apos;s resources only email.</p>
        </div>
      </div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-h"><h2>This month by client</h2>{r.provider && <Pill nodot>{r.provider}</Pill>}</div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Client</th><th className="r">Sessions</th><th className="r">Hours</th><th className="r">Answers</th><th className="r">Failures</th><th className="r">Running</th></tr></thead>
            <tbody>
              {!r.orgs.length && <tr><td colSpan={6} className="muted">No live meetings this month.</td></tr>}
              {r.orgs.map((o) => (
                <tr key={o.orgId}>
                  <td><Link href={`/owner/clients/${o.orgId}`}>{o.org}</Link></td>
                  <td className="r num">{o.sessions}</td>
                  <td className="r num">{o.hours}{o.limit !== null && <span className="muted"> / {o.limit}</span>}</td>
                  <td className="r num">{o.answers}</td>
                  <td className="r num">{o.failures ? <Pill kind="bad">{o.failures}</Pill> : 0}</td>
                  <td className="r num">{o.running}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <SessionTable title="Running now" rows={r.running} empty="Nothing running." />
      <SessionTable title="Latest failures" rows={r.failures} empty="No failures this month." />
    </>
  );
}

/** A list of sessions: client, group, meeting, who invited, when, minutes, and how it ended or failed. */
function SessionTable({ title, rows, empty }: { title: string; rows: Session[]; empty: string }) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-h"><h2>{title}</h2></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Client</th><th>Meeting</th><th>Invited</th><th>Started</th><th className="r">Min</th><th>Status</th></tr></thead>
          <tbody>
            {!rows.length && <tr><td colSpan={6} className="muted">{empty}</td></tr>}
            {rows.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/owner/clients/${s.orgId}`}>{s.org}</Link><div className="muted" style={{ fontSize: 12.5 }}>{s.group}</div></td>
                <td>{s.title}</td>
                <td>{invited(s)}</td>
                <td className="num">{fmtTime(s.createdAt)}</td>
                <td className="r num">{s.minutes}</td>
                <td>
                  <Pill kind={s.status === "failed" ? "bad" : s.status === "live" ? "good" : s.status === "joining" ? "info" : ""}>{s.status}</Pill>
                  {s.endReason && <div className="muted" style={{ fontSize: 12.5 }}>{s.endReason}</div>}
                  {s.error && <div className="err" style={{ fontSize: 12.5 }}>{s.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
