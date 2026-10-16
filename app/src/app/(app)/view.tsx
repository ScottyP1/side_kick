"use client";

/**
 * Home (/): what Sidekick knows and what needs attention across your workspaces: counts, recent meetings, open gaps and action items.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, Pill, usd, useReportError } from "@/components/ui";

type Overview = {
  stats: { workspaces: number; documents: number; meetings: number; questions: number; answered: number; openActions: number; noOwner: number; decisions: number; spendMonth: number };
  recentMeetings: { id: string; title: string; held_at: string; status: string; workspace: string; color: string; workspace_id: string }[];
  attention: {
    failedDocs: { id: string; name: string; error: string; workspace_id: string }[];
    failedQuestions: { question: string; c: number; workspace_id: string }[];
    failedMeetings: { id: string; title: string; error: string; workspace_id: string }[];
  };
};

export default function OverviewPage() {
  const { me, setWs } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const reportError = useReportError();
  useEffect(() => {
    api<Overview>("/api/overview").then(setData).catch(reportError);
  }, [reportError]);
  const s = data?.stats;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = me.user.name.split(" ")[0];

  const steps = [
    { done: (s?.workspaces ?? 0) > 0, label: "Create a workspace for a client engagement", href: "/workspaces" },
    { done: (s?.documents ?? 0) > 0, label: "Upload project documents (SOW, designs, runbooks)", href: "/knowledge" },
    { done: (s?.meetings ?? 0) > 0, label: "Import a Teams meeting transcript", href: "/meetings" },
    { done: (s?.questions ?? 0) > 0, label: "Ask Sidekick a question about the project", href: "/knowledge" },
  ];
  const attention = data
    ? [
        ...data.attention.failedMeetings.map((m) => ({ kind: "bad", label: "Error", title: `Meeting “${m.title}” wasn't processed`, detail: m.error, href: "/meetings", ws: m.workspace_id })),
        ...data.attention.failedQuestions.map((q) => ({ kind: "hand", label: "Gap", title: `No answer found${q.c > 1 ? ` (asked ${q.c}×)` : ""}`, detail: `“${q.question}”`, href: "/memory", ws: q.workspace_id })),
        ...data.attention.failedDocs.map((d) => ({ kind: "bad", label: "Error", title: `“${d.name}” couldn't be read`, detail: d.error, href: "/knowledge", ws: d.workspace_id })),
      ]
    : [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{me.org.name}</div>
          <h1>
            {greet}, {first}
          </h1>
          <p>Here&apos;s what Sidekick knows and what needs attention across your workspaces.</p>
        </div>
        <div className="actions">
          <Link className="btn" href="/meetings">Import meeting</Link>
          <Link className="btn primary" href="/knowledge">Ask Sidekick</Link>
        </div>
      </div>

      <div className="grid g4">
        <Link className="kpi" href="/meetings" style={{ textDecoration: "none" }}>
          <span className="eyebrow">Meetings</span>
          <span className="v">{s?.meetings ?? "—"}</span>
          <span className="d muted">{s?.decisions ?? 0} decisions captured</span>
        </Link>
        <Link className="kpi" href="/knowledge" style={{ textDecoration: "none" }}>
          <span className="eyebrow">Questions answered</span>
          <span className="v">{s ? `${s.answered}/${s.questions}` : "—"}</span>
          <span className="d muted">{s && s.questions ? `${Math.round((s.answered / s.questions) * 100)}% answered from your sources` : "Ask your first question"}</span>
        </Link>
        <Link className="kpi" href="/memory" style={{ textDecoration: "none" }}>
          <span className="eyebrow">Open action items</span>
          <span className="v">{s?.openActions ?? "—"}</span>
          <span className={`d ${s?.noOwner ? "down" : "muted"}`}>{s?.noOwner ? `${s.noOwner} without an owner` : "All have owners"}</span>
        </Link>
        <Link className="kpi" href={["Org Owner", "Org Admin", "Billing Admin"].includes(me.user.role) ? "/usage" : "/knowledge"} style={{ textDecoration: "none" }}>
          <span className="eyebrow">Documents</span>
          <span className="v">{s?.documents ?? "—"}</span>
          <span className="d muted">AI spend this month: {usd(s?.spendMonth ?? 0)}</span>
        </Link>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="panel-h">
            <h2>Recent meetings</h2>
            <Link className="btn small" href="/meetings">All meetings</Link>
          </div>
          <div className="list">
            {!data?.recentMeetings.length && <div className="li muted">No meetings yet. Import a Teams transcript to see Sidekick&apos;s notes.</div>}
            {data?.recentMeetings.map((m) => (
              <div key={m.id} className="li">
                <span className="swatch" style={{ background: m.color, marginTop: 6 }} />
                <div className="grow">
                  <b>{m.title}</b>
                  <div className="muted">
                    {m.workspace} · {fmtDate(m.held_at)}
                  </div>
                </div>
                <Pill kind={m.status === "Ready" ? "good" : m.status === "Failed" ? "bad" : "info"}>{m.status}</Pill>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h">
            <h2>{steps.every((x) => x.done) ? "Needs attention" : "Get started"}</h2>
            {attention.length > 0 && <Pill kind="warn">{attention.length}</Pill>}
          </div>
          <div className="list">
            {!steps.every((x) => x.done) &&
              steps.map((x) => (
                <div key={x.label} className="li">
                  <Pill kind={x.done ? "good" : ""}>{x.done ? "Done" : "To do"}</Pill>
                  <div className="grow" style={x.done ? { color: "var(--muted)" } : undefined}>{x.label}</div>
                  {!x.done && <Link className="btn small" href={x.href}>Go</Link>}
                </div>
              ))}
            {attention.map((a, i) => (
              <div key={i} className="li">
                <Pill kind={a.kind}>{a.label}</Pill>
                <div className="grow">
                  <b>{a.title}</b>
                  <div className="muted">{a.detail}</div>
                </div>
                <Link className="btn small" href={a.href} onClick={() => setWs(a.ws)}>View</Link>
              </div>
            ))}
            {steps.every((x) => x.done) && !attention.length && <div className="li muted">Nothing needs attention right now.</div>}
          </div>
        </div>
      </div>
    </>
  );
}
