"use client";

/**
 * Support inbox (/owner/support): every customer ticket, newest activity first, with filters (status, priority,
 * client, category, search), counts per status and the number with new customer activity (unread, marked with a
 * dot). Tickets from clients whose plan includes priority support (Business and up) come first, marked
 * "Priority support". Click a ticket to open it (support/[id]). Operators only.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, Pill, useReportError } from "@/components/ui";

type Row = { id: string; ref: string; subject: string; category: string; priority: string; status: string; source: string; requester: string; client: string; assignedTo: string | null; unread: boolean; prioritySupport: boolean; updatedAt: string };
type Inbox = { tickets: Row[]; counts: Record<string, number>; unread: number; clients: { id: string; name: string }[] };

const STATUS: Record<string, [string, string]> = { open: ["Open", "info"], waiting: ["Waiting on customer", "warn"], resolved: ["Resolved", "good"] };
const PRIORITY_KIND: Record<string, string> = { urgent: "bad", high: "warn", normal: "", low: "" };

export default function SupportInbox() {
  const report = useReportError();
  const [f, setF] = useState({ status: "open", priority: "", category: "", client: "", q: "" });
  const [data, setData] = useState<Inbox | null>(null);
  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    api<Inbox>(`/api/owner/support?${qs}`).then(setData).catch(report);
  }, [f, report]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div><h1>Support inbox</h1><p>Tickets from the portal, the Help chat, the website form and the help bot. {data ? `${data.unread} with new customer activity.` : ""}</p></div>
        <div style={{ display: "flex", gap: 8 }}><Link className="btn" href="/owner/articles">Support articles</Link><Link className="btn" href="/owner/helpbot">Help bot</Link></div>
      </div>
      <div className="filters" role="group" aria-label="Filters">
        {(["open", "waiting", "resolved", ""] as const).map((s) => (
          <button key={s || "all"} type="button" className={`btn small${f.status === s ? " primary" : ""}`} aria-pressed={f.status === s} onClick={() => setF({ ...f, status: s })}>
            {s ? STATUS[s][0] : "All"}{s && data ? ` (${data.counts[s] ?? 0})` : ""}
          </button>
        ))}
        <select className="input" aria-label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">Any priority</option>{["urgent", "high", "normal", "low"].map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <select className="input" aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Any category</option>{["question", "bug", "billing", "access", "feature"].map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select className="input" aria-label="Client" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })}><option value="">Every client</option><option value="none">Website (no organization)</option>{data?.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input className="input" aria-label="Search" placeholder="Search subject, reference, email…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <div className="panel">
        {!data ? <div className="empty">Loading…</div> : data.tickets.length === 0 ? <div className="empty">No tickets match.</div> : (
          <div className="ticket-list">
            {data.tickets.map((t) => (
              <Link key={t.id} href={`/owner/support/${t.id}`} className={`ticket-row${t.unread ? " unread" : ""}`}>
                <b>{t.subject}</b>
                <span style={{ display: "flex", gap: 6 }}>{t.prioritySupport && <Pill kind="info">Priority support</Pill>}<Pill kind={PRIORITY_KIND[t.priority]}>{t.priority}</Pill><Pill kind={STATUS[t.status]?.[1]}>{STATUS[t.status]?.[0] ?? t.status}</Pill></span>
                <span className="meta">{t.ref} · {t.client} · {t.requester} · {t.category} · from {t.source}{t.assignedTo ? ` · ${t.assignedTo}` : " · unassigned"} · {fmtTime(t.updatedAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
