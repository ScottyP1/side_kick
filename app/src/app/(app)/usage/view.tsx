"use client";

/**
 * Usage & billing (/usage): the organization's plan (PlanSection: price, status, limits, pay / change / cancel),
 * what Sidekick did this month (questions answered, meetings written up, documents added, reminders sent,
 * assistant replies: in total, per day and per group), the AI allowance as a percent of the plan's included AI,
 * and **Export CSV** (the same counts per group with its engagement code, per month, for chargeback;
 * GET /api/usage/export). No AI cost, tokens, response times or model names: those are Sidekick's internals and
 * live in the Owner Console (lib/firm-usage.ts). Data: GET /api/usage.
 * Org Owners and Org Admins (only the Org Owner changes the plan).
 */

import { useEffect, useState } from "react";
import { api, ApiError, useReportError, useToast } from "@/components/ui";
import { PlanSection } from "./plan";
import { BRAND } from "@/lib/brand";

/** This month's AI allowance as the firm sees it: a percent and a level, no dollars (lib/firm-usage.ts). */
type Allowance = { month: string; pct: number; level: "unlimited" | "ok" | "warn" | "essentials"; toppedUp: boolean };
type Activity = { questions: number; answered: number; meetings: number; documents: number; reminders: number; assistant: number };

type U = {
  period: { start: string; end: string; day: number; days: number };
  totals: Activity;
  byWorkspace: (Activity & { id: string | null; name: string; color: string })[];
  daily: (Activity & { day: string })[];
  allowance: Allowance;
};

/** Everything Sidekick did in one bucket (for the per-day chart). */
const size = (a: Activity) => a.questions + a.meetings + a.documents + a.reminders + a.assistant;
/** "3 questions", "1 meeting": a count with its word. */
const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

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

/**
 * The month's AI allowance: a meter and "4% of this month's included AI used", then what happens at 80% and 100%.
 * No dollar amounts: what the AI costs is Sidekick's business, the firm sees how much of its plan it has used.
 */
function AllowancePanel({ a }: { a: Allowance }) {
  const pct = Math.min(100, a.pct);
  const shown = a.pct > 0 && a.pct < 1 ? "Under 1%" : `${Math.round(a.pct)}%`;
  return (
    <div className="panel">
      <div className="panel-h"><h2>AI allowance this month</h2>{a.level !== "unlimited" && <span className="muted">{a.level === "essentials" ? "Used up" : `${shown} used`}</span>}</div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {a.level === "unlimited" ? <b>No limit on AI use</b> : (
          <>
            <b className="num" style={{ fontSize: 18 }}>{a.level === "essentials" ? "All" : shown} of this month&apos;s included AI used</b>
            <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Share of this month's included AI used"><span style={{ width: `${pct}%`, background: a.level === "essentials" ? "var(--bad)" : a.level === "warn" ? "var(--warn)" : undefined }} /></div>
          </>
        )}
        {a.toppedUp && <span className="muted">Includes extra AI the {BRAND.name} team added for this month.</span>}
        <span className="muted">
          {a.level === "unlimited" ? "Your organization's AI use isn't capped."
            : a.level === "essentials" ? `Used up: ${BRAND.name} keeps answering questions and checking them against your guardrails; reminders, knowledge map updates, the assistant and notes for long meetings are paused until the 1st. Ask the ${BRAND.name} team for more, or move to a bigger plan.`
            : `Your plan includes a monthly AI allowance; it starts again on the 1st. At 80% the Org Owner and Org Admins see a notice. At 100% ${BRAND.name} keeps answering questions and pauses the extras until the 1st.`}
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
  const maxDay = Math.max(1, ...u.daily.map(size));
  // Every day of the month, so quiet days show as gaps instead of disappearing from the chart.
  const byDay = new Map(u.daily.map((d) => [d.day, d]));
  const monthDays = Array.from({ length: u.period.days }, (_, i) => {
    const day = new Date(Date.parse(u.period.start) + i * 86400000 + 12 * 3600000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, questions: 0, answered: 0, meetings: 0, documents: 0, reminders: 0, assistant: 0 };
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
          <p>What {BRAND.name} did for your team this month, and how much of your plan&apos;s included AI you&apos;ve used.</p>
        </div>
        <ExportButton />
      </div>
      <PlanSection />
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {([
          ["Questions answered", u.totals.answered, u.totals.questions ? `of ${n(u.totals.questions, "question")} asked` : "None asked yet"],
          ["Meetings written up", u.totals.meetings, "Notes, decisions and action items"],
          ["Documents added", u.totals.documents, "To groups' knowledge"],
          ["Reminders sent", u.totals.reminders, "Cards posted in Teams"],
          ["Assistant replies", u.totals.assistant, "In the portal's assistant"],
        ] as const).map(([l, v, d]) => (
          <div key={l} className="kpi" style={{ cursor: "default" }}>
            <span className="eyebrow">{l}</span>
            <span className="v">{v.toLocaleString()}</span>
            <span className="d muted">{d}</span>
          </div>
        ))}
      </div>
      <div className="grid g-main">
        <div className="panel">
          <div className="panel-h"><h2>Activity per day</h2><span className="muted">This month</span></div>
          <div className="panel-b">
            {!u.daily.length ? <div className="empty">Nothing yet this month.</div> : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 160, paddingTop: 8 }}>
                {monthDays.map((d) => (
                  <div key={d.day} title={`${d.day}: ${n(d.questions, "question")} · ${n(d.meetings, "meeting")} · ${n(d.documents, "document")} · ${n(d.reminders, "reminder")} · ${n(d.assistant, "assistant reply", "assistant replies")}`} style={{ flex: 1, minWidth: 4, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
                    <div style={{ width: "100%", height: size(d) ? `${Math.max(3, (size(d) / maxDay) * 130)}px` : 0, background: "var(--accent)", borderRadius: "4px 4px 0 0" }} />
                    {/* Day 1 and every 5th day only, so the numbers stay readable on phones. */}
                    <span className="faint" style={{ fontSize: 10.5, visibility: Number(d.day.slice(8)) === 1 || Number(d.day.slice(8)) % 5 === 0 ? "visible" : "hidden" }}>{Number(d.day.slice(8))}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <AllowancePanel a={u.allowance} />
      </div>
      <div className="panel">
        <div className="panel-h"><h2>By group</h2><span className="muted">This month</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Group</th><th className="r">Questions</th><th className="r">Answered</th><th className="r">Meetings</th><th className="r">Documents</th><th className="r">Reminders</th><th className="r">Assistant</th></tr></thead>
            <tbody>
              {u.byWorkspace.map((w) => (
                <tr key={w.id ?? "org"}>
                  <td><span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}><span className="swatch" style={{ background: w.color }} /><span>{w.name}</span></span></td>
                  <td className="r num">{w.questions}</td><td className="r num">{w.answered}</td><td className="r num">{w.meetings}</td><td className="r num">{w.documents}</td><td className="r num">{w.reminders}</td><td className="r num">{w.assistant}</td>
                </tr>
              ))}
              {!u.byWorkspace.length && <tr><td colSpan={7} className="muted">Nothing yet this month.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
