"use client";

/**
 * Firm library (/firm-library): the organization's own policies, standards, templates, methods and rate-card rules,
 * which every group's answers can use (cited as "Firm policy · <title>"). Everyone in the organization sees the
 * list; Org Owners and Org Admins upload (with title, audience, effective date and what it replaces), edit and
 * delete. Shareable firm documents are the only ones used where client guests are present. Firm documents count
 * toward the plan's document limit. API: /api/firm and /api/firm/[id] (lib/firm.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtBytes, fmtDate, Icon, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { BRAND } from "@/lib/brand";

type FirmDoc = {
  id: string;
  title: string;
  name: string;
  size: number;
  audience: "internal" | "shareable";
  status: string;
  error: string | null;
  chunk_count: number;
  effective_on: string | null;
  superseded_by: string | null;
  superseded_title: string | null;
  uploaded_by: string | null;
  created_at: string;
};

export default function FirmLibraryPage() {
  const { me } = useApp();
  const toast = useToast();
  const reportError = useReportError();
  const [docs, setDocs] = useState<FirmDoc[] | null>(null);
  const [counts, setCounts] = useState({ documents: 0, passages: 0 });
  const [canManage, setCanManage] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [audience, setAudience] = useState<"internal" | "shareable">("internal");
  const [title, setTitle] = useState("");
  const [effective, setEffective] = useState("");
  const [replaces, setReplaces] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await api<{ docs: FirmDoc[]; counts: typeof counts; canManage: boolean }>("/api/firm");
    setDocs(r.docs);
    setCounts(r.counts);
    setCanManage(r.canManage);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(reportError);
  }, [load, reportError]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    const form = new FormData();
    form.set("audience", audience);
    if (title.trim()) form.set("title", title.trim());
    if (effective) form.set("effective_on", effective);
    if (replaces) form.set("replaces", replaces);
    list.forEach((f) => form.append("files", f));
    try {
      const r = await api<{ results: { name: string; ok: boolean; error?: string }[] }>("/api/firm", { method: "POST", body: form });
      const failed = r.results.filter((x) => !x.ok);
      toast(failed.length ? `${r.results.length - failed.length} added, ${failed.length} not added: ${failed[0].error}` : `${r.results.length} document${r.results.length > 1 ? "s" : ""} added. Every group can use ${r.results.length > 1 ? "them" : "it"} now`);
      if (!failed.length) {
        setTitle("");
        setEffective("");
        setReplaces("");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.", "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      load().catch(reportError);
    }
  };

  const change = async (d: FirmDoc, body: Record<string, unknown>) => {
    try {
      await api(`/api/firm/${d.id}`, { method: "PATCH", json: body });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.", "error");
    }
    load().catch(reportError);
  };
  const rename = (d: FirmDoc) => {
    const next = window.prompt("Title shown in answers and citations", d.title);
    if (next && next.trim() && next.trim() !== d.title) change(d, { title: next.trim() });
  };
  const setDate = (d: FirmDoc) => {
    const next = window.prompt("Effective from (YYYY-MM-DD, empty to clear)", d.effective_on ?? "");
    if (next !== null && next.trim() !== (d.effective_on ?? "")) change(d, { effective_on: next.trim() });
  };
  const remove = async (d: FirmDoc) => {
    if (!window.confirm(`Delete “${d.title}” from the firm library? It's removed from search, so no group's answers can use it any more. This can't be undone.`)) return;
    try {
      await api(`/api/firm/${d.id}`, { method: "DELETE" });
      toast(`“${d.title}” deleted and removed from search`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete.", "error");
    }
    load().catch(reportError);
  };

  const current = docs?.filter((d) => d.status === "Ready" && !d.superseded_by) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Firm library</div>
          <h1>{me.org.name}&apos;s policies and standards</h1>
          <p>
            Policies, standards, templates, methods and rate-card rules every group can use. Answers cite them as “Firm policy”, prefer them for policy
            questions, and say so when a group&apos;s own document disagrees. Groups never see each other&apos;s documents; client guests only see Shareable ones.
          </p>
        </div>
      </div>

      {canManage ? (
        <div className="panel">
          <div className="panel-h"><h2>Add to the firm library</h2></div>
          <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="grid g2" style={{ gap: 10 }}>
              <label className="field">
                <span>Title (one file only; otherwise the file names)</span>
                <input className="input" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Expense policy v3" />
              </label>
              <label className="field">
                <span>Effective from (optional)</span>
                <input className="input" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
              </label>
              <label className="field">
                <span>Replaces (optional: marks the older one as superseded)</span>
                <select className="input" value={replaces} onChange={(e) => setReplaces(e.target.value)}>
                  <option value="">Nothing</option>
                  {current.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                </select>
              </label>
              <div className="field">
                <span>Who may see it in answers</span>
                <div className="seg">
                  {(["internal", "shareable"] as const).map((a) => (
                    <button key={a} type="button" aria-pressed={audience === a} onClick={() => setAudience(a)}>{a === "internal" ? "Internal (team only)" : "Shareable (also with client guests)"}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="actions" style={{ alignItems: "center" }}>
              <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? <><Spinner /> Reading and indexing…</> : <><Icon n="upload" /> Choose files</>}
              </button>
              <span className="muted" style={{ fontSize: 12.5 }}>PDF, Word (.docx), text, Markdown, CSV or JSON · up to 25 MB each · counts toward your plan&apos;s document limit</span>
            </div>
            <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.json" onChange={(e) => e.target.files && upload(e.target.files)} />
          </div>
        </div>
      ) : (
        <div className="callout">Org Owners and Org Admins manage the firm library. {BRAND.name} uses it in every group&apos;s answers.</div>
      )}

      <div className="panel">
        <div className="panel-h">
          <h2>{docs ? `${docs.length} document${docs.length === 1 ? "" : "s"}` : "Documents"}</h2>
          <span className="muted">{counts.passages.toLocaleString()} passages searchable</span>
        </div>
        {docs && !docs.length ? (
          <div className="empty">No firm documents yet.{canManage ? " Add your expense, travel or security policy to get started." : ""}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Status</th>
                  <th>Audience</th>
                  <th>Effective</th>
                  <th>Added</th>
                  <th className="r">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs?.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <b style={{ wordBreak: "break-word" }}>{d.title}</b>
                      <div className="muted" style={{ fontSize: 12 }}>{d.name}{d.status === "Ready" ? ` · ${d.chunk_count} passage${d.chunk_count === 1 ? "" : "s"}` : ""}</div>
                      {d.superseded_title && <div style={{ fontSize: 12.5, color: "var(--warn)" }}>Superseded by “{d.superseded_title}”</div>}
                      {d.error && <div style={{ color: "var(--bad)", fontSize: 12.5 }}>{d.error}</div>}
                    </td>
                    <td><Pill kind={d.status === "Ready" ? (d.superseded_by ? "warn" : "good") : d.status === "Failed" ? "bad" : "info"}>{d.status === "Ready" && d.superseded_by ? "Superseded" : d.status}</Pill></td>
                    <td>
                      <div className="seg" style={{ fontSize: 12 }}>
                        {(["internal", "shareable"] as const).map((a) => (
                          <button key={a} style={{ padding: "3px 8px" }} aria-pressed={d.audience === a} disabled={!canManage} onClick={() => change(d, { audience: a })}>
                            {a === "internal" ? "Internal" : "Shareable"}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{d.effective_on ?? "—"}</td>
                    <td className="muted">{fmtDate(d.created_at)}{d.uploaded_by ? ` · ${d.uploaded_by}` : ""}</td>
                    <td className="r num muted">{d.size < 1024 ? `${d.size} bytes` : fmtBytes(d.size)}</td>
                    <td className="r" style={{ whiteSpace: "nowrap" }}>
                      {canManage && (
                        <>
                          <button className="btn small ghost" onClick={() => rename(d)}>Rename</button>
                          <button className="btn small ghost" onClick={() => setDate(d)}>Date</button>
                          {d.superseded_by ? (
                            <button className="btn small ghost" onClick={() => change(d, { superseded_by: null })}>Current again</button>
                          ) : null}
                          <button className="btn small ghost" onClick={() => remove(d)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
