"use client";

/**
 * Help & support (/help) in the portal:
 * - **Contact support**: subject, category, priority, description, an optional phone number and one
 *   attachment; the person's name and email come from their account and the page they came from is added
 *   (POST /api/support/tickets). The Sidekick team replies in the ticket.
 * - **My tickets** (`#tickets`): the person's tickets (Org Owners and Org Admins: everyone's in the
 *   organization), with a dot for a team reply they haven't read.
 * - A pointer to the Help chat (bottom-left button → I need help) and the help center.
 */
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useApp } from "@/components/shell";
import { api, fmtTime, Icon, Pill, Spinner, useReportError } from "@/components/ui";
import { BRAND } from "@/lib/brand";

type Ticket = { id: string; ref: string; subject: string; category: string; priority: string; status: string; requester: string; updatedAt: string; mine: boolean; unread: boolean };
type Choices = { categories: { id: string; label: string }[]; priorities: string[]; attachmentTypes: string; maxAttachmentMb: number };

/** Plain status names and their pill colours, shared with the ticket page. */
export const STATUS: Record<string, [string, string]> = { open: ["Open", "info"], waiting: ["Waiting on you", "warn"], resolved: ["Resolved", "good"] };

export default function HelpView() {
  const { me } = useApp();
  const report = useReportError();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [form, setForm] = useState({ subject: "", category: "question", priority: "normal", description: "", phone: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ id: string; ref: string } | null>(null);
  const [from, setFrom] = useState<string | null>(null);

  const load = useCallback(() => api<{ tickets: Ticket[]; choices: Choices }>("/api/support/tickets").then((r) => (setTickets(r.tickets), setChoices(r.choices))).catch(report), [report]);
  useEffect(() => {
    load();
    // The page they were on before opening Help (sent with the ticket so the team can look).
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFrom(document.referrer ? new URL(document.referrer).pathname : null);
    } catch {}
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    if (from && from !== "/help") fd.append("page", from);
    if (file) fd.append("file", file);
    try {
      const r = await api<{ ticket: { id: string; ref: string } }>("/api/support/tickets", { method: "POST", body: fd });
      setDone(r.ticket);
      setForm({ subject: "", category: "question", priority: "normal", description: "", phone: "" });
      setFile(null);
      load();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Couldn't send it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head"><div><h1>Help &amp; support</h1><p>Most answers are in the <Link href="/docs">help center</Link>. The Help chat (the round button, bottom left → I need help) can check your setup and fix common problems. For anything else, contact the {BRAND.name} team here.</p></div></div>
      <div className="grid g2">
        <form className="panel" onSubmit={submit}>
          <div className="panel-h"><h2>Contact support</h2></div>
          <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="muted">We&apos;ll reply here and to <b>{me.user.email}</b>. Never send passwords or payment details.</span>
            <div className="field"><label htmlFor="t-subject">Subject</label><input id="t-subject" className="input" required minLength={4} maxLength={160} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></div>
            <div className="grid g2" style={{ gap: 12 }}>
              <div className="field"><label htmlFor="t-cat">Category</label><select id="t-cat" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{(choices?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
              <div className="field"><label htmlFor="t-pri">Priority</label><select id="t-pri" className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>{(choices?.priorities ?? ["normal"]).map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></div>
            </div>
            <div className="field"><label htmlFor="t-desc">What happened?</label><textarea id="t-desc" className="input" required minLength={10} maxLength={8000} rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /><span className="hint">If you saw an error with a reference code (like K7Q2-9XM4), include it.</span></div>
            <div className="field"><label htmlFor="t-phone">Phone (optional)</label><input id="t-phone" className="input" type="tel" maxLength={40} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /><span className="hint">Only if you&apos;d like a call back.</span></div>
            <div className="field"><label htmlFor="t-file">Attachment (optional)</label><input id="t-file" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><span className="hint">{choices ? `${choices.attachmentTypes}, up to ${choices.maxAttachmentMb} MB.` : ""}</span></div>
            {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
            {done && <div className="callout info" role="status"><Icon n="check" /><span>Sent. Your reference is <b>{done.ref}</b>. <Link href={`/help/tickets/${done.id}`}>Open the ticket</Link></span></div>}
            <div><button className="btn primary" type="submit" disabled={busy}>{busy ? <><Spinner /> Sending</> : "Send to support"}</button></div>
          </div>
        </form>
        <div className="panel" id="tickets">
          <div className="panel-h"><h2>{me.user.admin ? "Your organization's tickets" : "My tickets"}</h2></div>
          {tickets === null ? <div className="empty"><Spinner /></div> : tickets.length === 0 ? <div className="empty">No tickets yet.</div> : (
            <div className="ticket-list">
              {tickets.map((t) => (
                <Link key={t.id} href={`/help/tickets/${t.id}`} className={`ticket-row${t.unread ? " unread" : ""}`}>
                  <b>{t.subject}</b>
                  <Pill kind={STATUS[t.status]?.[1]}>{STATUS[t.status]?.[0] ?? t.status}</Pill>
                  <span className="meta">{t.ref} · {t.category} · {t.priority}{!t.mine ? ` · ${t.requester}` : ""} · updated {fmtTime(t.updatedAt)}{t.unread ? " · new reply" : ""}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
