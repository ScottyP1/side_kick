"use client";

/**
 * Live meetings (/owner/live): Sidekick in Teams meetings live (lib/live-meetings/, Enterprise) across every client.
 * Whether the meeting-bot service is set up on this copy; per client this month: sessions, live hours against the
 * plan's limit, answers given and failures; the sessions running now; the latest failures with their reason (lobby
 * timeouts, the provider refusing, chat posts that failed). Titles only, never anything said in a meeting. The
 * "Live in meetings" switch on Releases & switches pauses it for everyone or one client. Operators only.
 * Data: GET /api/owner/live.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTime, Pill, useReportError } from "@/components/ui";

type Session = { id: string; orgId: string; org: string; group: string; title: string; status: string; invitedBy: string; createdAt: string; minutes: number; endReason: string | null; error: string | null };
type Report = {
  configured: boolean; provider: string | null;
  orgs: { orgId: string; org: string; sessions: number; hours: number; limit: number | null; failures: number; answers: number; running: number }[];
  running: Session[]; failures: Session[];
};

const invited = (s: Session) => (s.invitedBy === "auto" ? "Every group meeting" : s.invitedBy);

export default function LiveMeetingsPage() {
  const reportError = useReportError();
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => {
    api<Report>("/api/owner/live").then(setR).catch(reportError);
  }, [reportError]);
  if (!r) return <span className="muted">Loading…</span>;
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
