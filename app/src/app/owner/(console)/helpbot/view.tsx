"use client";

/**
 * Help bot review (/owner/helpbot): how the website's "Ask about Sidekick" bot is doing over the last 30 days
 * (answered, "I don't know", refused by rule, limited, budget or paused), today's spend against its daily
 * budget, its limits and switch, and the questions it couldn't answer (masked) to turn into FAQ entries or
 * support articles: mark one done or delete it. The switch itself is on Releases & switches. Operators only.
 */
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { api, fmtTime, Pill, usd, useReportError, useToast } from "@/components/ui";

type Review = {
  budget: { spentToday: number; dailyUsd: number };
  limits: { perVisitorHour: number; perIpHour: number };
  enabled: boolean;
  outcomes: { outcome: string; rule: string | null; n: number }[];
  questions: { id: string; question: string; reason: string; status: string; at: string }[];
};
const OUTCOME: Record<string, string> = { answered: "Answered", dont_know: "“I don't know”", refused: "Refused", limited: "Hit a limit", budget: "Budget spent (FAQ shown)", paused: "Paused (FAQ shown)" };

export default function HelpbotView() {
  const report = useReportError();
  const toast = useToast();
  const [r, setR] = useState<Review | null>(null);
  const load = useCallback(() => api<Review>("/api/owner/support/helpbot").then(setR).catch(report), [report]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (id: string, action: "done" | "delete") => {
    try {
      await api("/api/owner/support/helpbot", { method: "POST", json: { id, action } });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.", "error");
    }
  };
  if (!r) return <span className="muted">Loading…</span>;
  const total = (o: string) => r.outcomes.filter((x) => x.outcome === o).reduce((n, x) => n + x.n, 0);
  return (
    <>
      <div className="page-head"><div><h1>Help bot</h1><p>“Ask about Sidekick” on the website: public help content only, every answer cited, its own budget. The switch is on <Link href="/owner/releases">Releases &amp; switches</Link>.</p></div><Pill kind={r.enabled ? "good" : "warn"}>{r.enabled ? "On" : "Paused"}</Pill></div>
      <div className="grid g3">
        <div className="panel"><div className="panel-b"><div className="eyebrow">Spent today</div><b className="num">{usd(r.budget.spentToday)} of {usd(r.budget.dailyUsd)}</b></div></div>
        <div className="panel"><div className="panel-b"><div className="eyebrow">Limits</div><b>{r.limits.perVisitorHour}/hour per visitor · {r.limits.perIpHour}/hour per network</b></div></div>
        <div className="panel"><div className="panel-b"><div className="eyebrow">Last 30 days</div><b className="num">{total("answered")} answered · {total("dont_know")} unanswered · {total("refused")} refused</b></div></div>
      </div>
      <div className="panel"><div className="panel-h"><h2>Outcomes (30 days)</h2></div><div className="panel-b">
        {r.outcomes.length ? <dl className="kv">{r.outcomes.map((o) => <Fragment key={`${o.outcome}${o.rule}`}><dt>{OUTCOME[o.outcome] ?? o.outcome}{o.rule ? `: ${o.rule}` : ""}</dt><dd className="num">{o.n}</dd></Fragment>)}</dl> : <span className="muted">No questions yet.</span>}
      </div></div>
      <div className="panel"><div className="panel-h"><h2>Questions it couldn&apos;t answer</h2><span className="muted chat-small">Masked, kept 30 days. Add an FAQ entry or a public support article, then mark it done.</span></div>
        {r.questions.length === 0 ? <div className="empty">Nothing waiting.</div> : (
          <div className="ticket-list">
            {r.questions.map((q) => (
              <div key={q.id} className="ticket-row">
                <span>{q.question}</span>
                <Pill kind={q.status === "done" ? "good" : ""}>{q.status}</Pill>
                <span className="meta">{fmtTime(q.at)} · {q.reason === "no_source" ? "no matching help content" : "answer wasn't backed by a source"}{" · "}{q.status !== "done" && <><button className="linkish" onClick={() => act(q.id, "done")}>Mark done</button>{" · "}</>}<button className="linkish" onClick={() => act(q.id, "delete")}>Delete</button></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
