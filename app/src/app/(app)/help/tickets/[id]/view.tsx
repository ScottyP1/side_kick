"use client";

/**
 * One support ticket in the portal (/help/tickets/[id]): its status, the thread with the Sidekick team (internal
 * notes are never sent here), attachments to download, a reply box (with one attachment; replying reopens a
 * waiting or resolved ticket) and "Mark resolved". Who: the requester, or an Org Owner/Admin of the same
 * organization; anyone else gets "not found".
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, fmtBytes, fmtTime, Pill, Spinner } from "@/components/ui";
import { STATUS } from "../../view";

type Msg = { id: string; kind: string; author: string; body: string; at: string; attachment: { id: string; name: string; size: number } | null };
type Data = { ticket: { id: string; ref: string; subject: string; status: string; category: string; priority: string; createdAt: string; mine: boolean; requester: string }; messages: Msg[] };

export default function TicketView() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Data | null | undefined>(undefined);
  const [reply, setReply] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<Data>(`/api/support/tickets/${id}`).then(setData).catch((e) => (e instanceof ApiError && e.status === 404 ? setData(null) : setErr(e instanceof Error ? e.message : "Couldn't load the ticket."))), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const send = async (e: FormEvent | null, action?: "resolve") => {
    e?.preventDefault();
    setErr("");
    setBusy(true);
    const fd = new FormData();
    if (action) fd.append("action", action);
    else {
      fd.append("message", reply);
      if (file) fd.append("file", file);
    }
    try {
      setData(await api<Data>(`/api/support/tickets/${id}`, { method: "POST", body: fd }));
      setReply("");
      setFile(null);
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Couldn't send it.");
    } finally {
      setBusy(false);
    }
  };

  if (data === undefined) return err ? <p className="err">{err}</p> : <span className="muted">Loading ticket…</span>;
  if (data === null) return <div className="panel"><div className="empty"><h2>Ticket not found</h2><Link href="/help">Back to Help &amp; support</Link></div></div>;
  const t = data.ticket;
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow"><Link href="/help#tickets">Help &amp; support</Link> · {t.ref}</div><h1>{t.subject}</h1><p>{t.category} · {t.priority} priority · opened {fmtTime(t.createdAt)}{!t.mine ? ` by ${t.requester}` : ""}</p></div>
        <Pill kind={STATUS[t.status]?.[1]}>{STATUS[t.status]?.[0] ?? t.status}</Pill>
      </div>
      <div className="thread">
        {data.messages.map((m) => (
          <div key={m.id} className={`thread-msg ${m.kind}`}>
            {m.kind !== "system" && <div className="who"><b>{m.author}</b><span>{fmtTime(m.at)}</span></div>}
            {m.body}
            {m.attachment && <div><a className="btn small" href={`/api/support/attachments/${m.attachment.id}`} download>{m.attachment.name} ({fmtBytes(m.attachment.size)})</a></div>}
          </div>
        ))}
      </div>
      <form className="panel" onSubmit={(e) => send(e)}>
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="field"><label htmlFor="r-msg">{t.status === "resolved" ? "Reply (reopens the ticket)" : "Reply"}</label><textarea id="r-msg" className="input" rows={4} maxLength={8000} value={reply} onChange={(e) => setReply(e.target.value)} /></div>
          <div className="field"><label htmlFor="r-file">Attachment (optional)</label><input id="r-file" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
          {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" type="submit" disabled={busy || (!reply.trim() && !file)}>{busy ? <Spinner /> : "Send reply"}</button>
            {t.status !== "resolved" && <button className="btn" type="button" disabled={busy} onClick={() => send(null, "resolve")}>Mark resolved</button>}
          </div>
        </div>
      </form>
    </>
  );
}
