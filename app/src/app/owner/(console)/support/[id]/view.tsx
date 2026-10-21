"use client";

/**
 * One ticket in the Owner Console (/owner/support/[id]): the thread (internal notes shown on a yellow
 * background, never sent to the customer), contact details, what the Help chat checked (when the ticket came
 * from it), the client's plan and status and its recent errors by reference code, and the actions: reply,
 * internal note, assign, priority, resolve/reopen and "Draft an article" (from a resolved ticket, saved as a
 * draft in Support articles). Every action is in the operator log and, for a client's ticket, its audit log.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtBytes, fmtTime, Pill, Spinner, useReportError, useToast } from "@/components/ui";

type Msg = { id: string; kind: string; author: string; body: string; internal: boolean; at: string; attachment: { id: string; name: string; size: number } | null };
type Err = { ref: string; what: string; error: string | null; at: string; logged: string | null; who?: string | null };
type Data = {
  ticket: { id: string; ref: string; subject: string; status: string; priority: string; category: string; source: string; name: string; email: string; phone: string | null; page: string | null; assignedTo: string | null; createdAt: string; checks: { name: string; status: string; summary: string }[] | null };
  messages: Msg[];
  context: { client: { id: string; name: string; status: string; plan: string; subscription: string | null } | null; errors: Err[]; quoted: Err[] };
};

export default function OwnerTicketView() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const report = useReportError();
  const [d, setD] = useState<Data | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [me, setMe] = useState("");

  const load = useCallback(() => api<Data>(`/api/owner/support/tickets/${id}`).then(setD).catch(report), [id, report]);
  useEffect(() => {
    load();
    api<{ owner: { name: string } }>("/api/owner/me").then((r) => setMe(r.owner.name)).catch(report);
  }, [load, report]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(String(body.action));
    try {
      setD(await api<Data>(`/api/owner/support/tickets/${id}`, { method: "POST", json: body }));
      if (body.action === "reply" || body.action === "note") setText("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy("");
    }
  };
  const draft = async () => {
    setBusy("draft");
    try {
      const r = await api<{ article: { title: string } }>("/api/owner/support/articles", { method: "POST", json: { draftFrom: id } });
      toast(`Draft saved: “${r.article.title}”. Review and publish it in Support articles.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't draft an article.", "error");
    } finally {
      setBusy("");
    }
  };

  if (!d) return <span className="muted">Loading ticket…</span>;
  const t = d.ticket;
  const c = d.context;
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow"><Link href="/owner/support">Support inbox</Link> · {t.ref}</div><h1>{t.subject}</h1><p>{t.category} · from {t.source} · opened {fmtTime(t.createdAt)}</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select className="input" aria-label="Priority" style={{ width: "auto" }} value={t.priority} onChange={(e) => act({ action: "priority", priority: e.target.value })}>{["urgent", "high", "normal", "low"].map((p) => <option key={p} value={p}>{p}</option>)}</select>
          {t.status === "resolved" ? <button className="btn" onClick={() => act({ action: "reopen" })} disabled={!!busy}>Reopen</button> : <button className="btn primary" onClick={() => act({ action: "resolve" })} disabled={!!busy}>Resolve</button>}
          {t.status === "resolved" && <button className="btn" onClick={draft} disabled={!!busy}>{busy === "draft" ? <Spinner /> : "Draft an article"}</button>}
        </div>
      </div>
      <div className="owner-split">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel"><div className="panel-h"><h2>Contact</h2><Pill kind={t.status === "resolved" ? "good" : t.status === "waiting" ? "warn" : "info"}>{t.status}</Pill></div><div className="panel-b">
            <dl className="kv">
              <dt>Name</dt><dd>{t.name}</dd><dt>Email</dt><dd>{t.email}</dd>{t.phone && <><dt>Phone</dt><dd>{t.phone}</dd></>}{t.page && <><dt>Page</dt><dd className="mono">{t.page}</dd></>}
              <dt>Assigned</dt><dd>{t.assignedTo ?? "Nobody"} {t.assignedTo !== me && me && <button className="linkish" onClick={() => act({ action: "assign", to: me })}>Assign to me</button>} {t.assignedTo && <button className="linkish" onClick={() => act({ action: "assign", to: "" })}>Unassign</button>}</dd>
            </dl>
          </div></div>
          <div className="panel"><div className="panel-h"><h2>Client</h2></div><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {c.client ? (
              <dl className="kv"><dt>Organization</dt><dd><Link href={`/owner/clients/${c.client.id}`}>{c.client.name}</Link></dd><dt>Status</dt><dd>{c.client.status}</dd><dt>Plan</dt><dd>{c.client.plan}{c.client.subscription ? ` (${c.client.subscription})` : ""}</dd></dl>
            ) : <span className="muted">From the website: no organization.</span>}
            {c.quoted.length > 0 && <><b>Reference codes in the thread</b>{c.quoted.map((e) => <ErrLine key={e.ref} e={e} />)}</>}
            {c.client && <><b>Recent errors (14 days)</b>{c.errors.length ? c.errors.map((e) => <ErrLine key={e.ref} e={e} />) : <span className="muted">None.</span>}</>}
          </div></div>
          {t.checks && (
            <div className="panel"><div className="panel-h"><h2>What the Help chat checked</h2></div><div className="panel-b"><ul className="chat-checks" style={{ margin: 0, paddingLeft: 16 }}>{t.checks.map((x) => <li key={x.name}><b>{x.name}</b> ({x.status}): {x.summary}</li>)}</ul></div></div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="thread">
            {d.messages.map((m) => (
              <div key={m.id} className={`thread-msg ${m.kind}${m.internal && m.kind !== "system" ? " internal" : ""}`}>
                {m.kind !== "system" && <div className="who"><b>{m.author}</b><span>{fmtTime(m.at)}</span>{m.internal && <Pill kind="warn">Internal note</Pill>}</div>}
                {m.body}
                {m.attachment && <div><a className="btn small" href={`/api/support/attachments/${m.attachment.id}`} download>{m.attachment.name} ({fmtBytes(m.attachment.size)})</a></div>}
              </div>
            ))}
          </div>
          <div className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="field"><span>Reply or internal note</span><textarea className="input" rows={5} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} /></label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={!text.trim() || !!busy} onClick={() => act({ action: "reply", message: text })}>{busy === "reply" ? <Spinner /> : "Send reply to customer"}</button>
              <button className="btn" disabled={!text.trim() || !!busy} onClick={() => act({ action: "note", message: text })}>{busy === "note" ? <Spinner /> : "Add internal note"}</button>
            </div>
            <span className="muted chat-small">A reply sets the ticket to “waiting on customer” and shows the customer a dot on their assistant button. Email notifications come later.</span>
          </div></div>
        </div>
      </div>
    </>
  );
}

/** One error by reference code: when, what, and the error log's message. */
function ErrLine({ e }: { e: Err }) {
  return <div className="chat-small"><span className="mono">{e.ref}</span> · {fmtTime(e.at)} · {e.what}{e.who ? ` · ${e.who}` : ""}<br /><span className="muted">{e.logged ?? e.error ?? ""}</span></div>;
}
