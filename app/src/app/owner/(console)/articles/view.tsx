"use client";

/**
 * Support articles (/owner/articles): Sidekick's knowledge base of known issues and fixes, at three levels:
 * public (help center, help bot, Help chat), customer (Help chat only, when relevant) and internal (the team
 * only). Add, edit, publish or unpublish, delete (seed articles are unpublished instead). Shows how often the
 * assistants cited each one, how many tickets followed and how many of those were resolved. Drafts written by
 * Claude from resolved tickets ("Draft an article" on a ticket) wait here as drafts. Operators only.
 */
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, Modal, Pill, useReportError, useToast } from "@/components/ui";

type Article = { id: string; slug: string; title: string; body: string; level: string; status: string; tags: string[]; seed: boolean; sourceTicketId: string | null; updatedAt: string; uses: number; tickets: number; resolved: number };
type Edit = { id?: string; title: string; body: string; level: string; status: string; tags: string };

export default function ArticlesView() {
  const toast = useToast();
  const report = useReportError();
  const [list, setList] = useState<Article[] | null>(null);
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<Edit | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api<{ articles: Article[]; levels: Record<string, string> }>("/api/owner/support/articles").then((r) => (setList(r.articles), setLevels(r.levels))).catch(report), [report]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!edit) return;
    setErr("");
    try {
      await api("/api/owner/support/articles", { method: edit.id ? "PUT" : "POST", json: { ...edit, tags: edit.tags } });
      setEdit(null);
      toast("Saved.");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save.");
    }
  };
  const remove = async (a: Article) => {
    try {
      await api(`/api/owner/support/articles?id=${a.id}`, { method: "DELETE" });
      toast(a.seed ? "Unpublished (seed articles are kept as drafts)." : "Deleted.");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete.", "error");
    }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Support articles</h1><p>Known issues and fixes. Public ones appear in the help center; customer ones are only used by the Help chat when they fit; internal ones are for you only.</p></div>
        <button className="btn primary" onClick={() => setEdit({ title: "", body: "", level: "customer", status: "draft", tags: "" })}>New article</button>
      </div>
      <div className="panel">
        {!list ? <div className="empty">Loading…</div> : (
          <div className="ticket-list">
            {list.map((a) => (
              <div key={a.id} className="ticket-row">
                <b>{a.title}</b>
                <span style={{ display: "flex", gap: 6 }}><Pill kind={a.level === "public" ? "good" : a.level === "internal" ? "warn" : "info"}>{a.level}</Pill><Pill kind={a.status === "published" ? "accent" : ""}>{a.status}</Pill></span>
                <span className="meta">
                  Cited {a.uses}× · {a.tickets} ticket{a.tickets === 1 ? "" : "s"} after, {a.resolved} resolved · {a.tags.join(", ") || "no tags"}{a.sourceTicketId ? " · drafted from a ticket" : ""}{a.seed ? " · seed" : ""} · {fmtDate(a.updatedAt)}{" · "}
                  <button className="linkish" onClick={() => setEdit({ id: a.id, title: a.title, body: a.body, level: a.level, status: a.status, tags: a.tags.join(", ") })}>Edit</button>{" · "}
                  <button className="linkish" onClick={() => remove(a)}>{a.seed ? "Unpublish" : "Delete"}</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {edit && (
        <Modal title={edit.id ? "Edit article" : "New article"} onClose={() => setEdit(null)} wide footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
          <label className="field"><span>Title</span><input className="input" maxLength={140} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
          <label className="field"><span>Text (Markdown)</span><textarea className="input" rows={12} maxLength={10000} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          <label className="field"><span>Who it&apos;s for</span><select className="input" value={edit.level} onChange={(e) => setEdit({ ...edit, level: e.target.value })}>{Object.entries(levels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field"><span>Status</span><select className="input" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="draft">Draft (not used anywhere)</option><option value="published">Published</option></select></label>
          <label className="field"><span>Tags (comma separated)</span><input className="input" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} /></label>
          {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
        </Modal>
      )}
    </>
  );
}
