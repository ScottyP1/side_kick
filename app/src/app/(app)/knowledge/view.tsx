"use client";

/**
 * Knowledge & docs (/knowledge): upload documents to the current workspace, tag them Internal or Shareable,
 * and try Ask Sidekick. Shareable documents are the only ones used when client guests are present.
 * Deleting a document asks for confirmation first; unsupported or empty files are refused by the server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { NeedsWorkspace, useApp } from "@/components/shell";
import { api, CitedText, fmtBytes, fmtDate, Icon, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { BRAND } from "@/lib/brand";

type Doc = { id: string; name: string; size: number; audience: string; status: string; error: string | null; chunk_count: number; created_at: string; uploaded_by: string | null };
type Answer = { found: boolean; answer: string; blocked?: string | null; sources: { id: string; title: string; loc: string; type: string; excerpt: string }[] };

export default function KnowledgePage() {
  const { ws, me } = useApp();
  const toast = useToast();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [index, setIndex] = useState({ passages: 0, questions: 0, answered: 0 });
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [audience, setAudience] = useState<"internal" | "shareable">("internal");
  const [q, setQ] = useState("");
  const [guests, setGuests] = useState(false);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [askErr, setAskErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = !["Viewer", "Billing Admin"].includes(me.user.role);

  const load = useCallback(async () => {
    if (!ws) return;
    const r = await api<{ docs: Doc[]; index: typeof index }>(`/api/docs?ws=${ws}`);
    setDocs(r.docs);
    setIndex(r.index);
  }, [ws]);
  const reportError = useReportError();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(reportError);
  }, [load, reportError]);

  if (!ws) return <NeedsWorkspace />;

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    const form = new FormData();
    form.set("ws", ws);
    form.set("audience", audience);
    list.forEach((f) => form.append("files", f));
    try {
      const r = await api<{ results: { name: string; ok: boolean; error?: string }[] }>("/api/docs", { method: "POST", body: form });
      const failed = r.results.filter((x) => !x.ok);
      toast(failed.length ? `${r.results.length - failed.length} indexed, ${failed.length} failed: ${failed[0].error}` : `${r.results.length} file${r.results.length > 1 ? "s" : ""} indexed and searchable`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      load();
    }
  };

  const askNow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setAsking(true);
    setAskErr("");
    setAnswer(null);
    try {
      setAnswer(await api<Answer>("/api/ask", { method: "POST", json: { ws, question: q, guests } }));
      load();
    } catch (err) {
      setAskErr(err instanceof Error ? err.message : "Couldn't get an answer.");
    } finally {
      setAsking(false);
    }
  };

  const setDocAudience = async (d: Doc, a: string) => {
    setDocs((cur) => cur?.map((x) => (x.id === d.id ? { ...x, audience: a } : x)) ?? null);
    try {
      await api(`/api/docs/${d.id}`, { method: "PATCH", json: { audience: a } });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.");
      load();
    }
  };
  const remove = async (d: Doc) => {
    if (!window.confirm(`Delete “${d.name}”? It's removed from search, so ${BRAND.name} can no longer use it in answers. This can't be undone.`)) return;
    try {
      await api(`/api/docs/${d.id}`, { method: "DELETE" });
      toast(`“${d.name}” deleted and removed from search`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete.");
    }
  };
  const wsName = me.workspaces.find((w) => w.id === ws)?.name;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Knowledge & documents</div>
          <h1>{wsName}</h1>
          <p>Everything {BRAND.name} can reference in this workspace. Tag documents “Internal” to keep them out of answers when client guests are present.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h2>Ask {BRAND.name}</h2>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} />
            Client guests are present (use Shareable sources only)
          </label>
        </div>
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <form style={{ display: "flex", gap: 8 }} onSubmit={askNow}>
            <input className="input" placeholder="e.g. What did we decide about the cutover date?" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Question" />
            <button className="btn primary" type="submit" disabled={asking || !q.trim()}>{asking ? <><Spinner /> Thinking</> : "Ask"}</button>
          </form>
          {askErr && <p className="err">{askErr}</p>}
          {answer && (
            <div className="answer">
              {answer.blocked ? <Pill kind="warn">Refused by your organization&apos;s guardrails (see Guardrails)</Pill> : !answer.found && <Pill kind="hand">No answer in your sources. Logged as a knowledge gap</Pill>}
              <p style={{ margin: 0 }}>
                <CitedText text={answer.answer} />
              </p>
              {answer.sources.length > 0 && (
                <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
                  {answer.sources.map((s) => (
                    <div key={s.id} className="li" style={{ padding: "8px 12px" }}>
                      <span className="cite">{s.id}</span>
                      <div className="grow">
                        <b style={{ fontSize: 13 }}>{s.title}</b>
                        {s.loc && <span className="muted" style={{ fontSize: 12 }}> · {s.loc}</span>}
                        <div className="muted" style={{ fontSize: 12.5 }}>{s.excerpt}…</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {canEdit && (
        <div
          className={`drop${over ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            upload(e.dataTransfer.files);
          }}
        >
          <span style={{ color: "var(--accent)" }}>{uploading ? <Spinner /> : <Icon n="upload" />}</span>
          <b>{uploading ? "Reading and indexing…" : "Drop files here"}</b>
          <span className="muted">PDF, Word (.docx), text, Markdown, CSV, JSON or Teams transcripts (.vtt) · up to 25 MB each</span>
          <div className="actions" style={{ justifyContent: "center", alignItems: "center" }}>
            <span className="muted">New files are</span>
            <div className="seg">
              {(["internal", "shareable"] as const).map((a) => (
                <button key={a} type="button" aria-pressed={audience === a} onClick={() => setAudience(a)}>
                  {a === "internal" ? "Internal" : "Shareable"}
                </button>
              ))}
            </div>
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}>Choose files</button>
          </div>
          <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.vtt,.csv,.json" onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
      )}

      <div className="panel">
        <div className="panel-h">
          <h2>Search index</h2>
          <Pill kind="good">Keyword search (BM25)</Pill>
        </div>
        <div className="panel-b grid g4">
          {[
            ["Passages indexed", index.passages.toLocaleString(), "from documents and meeting transcripts"],
            ["Documents", String(docs?.filter((d) => d.status === "Ready").length ?? 0), `${docs?.filter((d) => d.status === "Failed").length ?? 0} failed`],
            ["Questions asked", String(index.questions), "in this workspace"],
            ["Answered from sources", index.questions ? `${Math.round((index.answered / index.questions) * 100)}%` : "—", "the rest become knowledge gaps"],
          ].map(([l, v, d]) => (
            <div key={l}>
              <div className="eyebrow">{l}</div>
              <div className="num" style={{ fontFamily: "var(--f-display)", fontSize: 20, fontWeight: 600 }}>{v}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{d}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h2>{docs ? `${docs.length} document${docs.length === 1 ? "" : "s"}` : "Documents"}</h2>
        </div>
        {docs && !docs.length ? (
          <div className="empty">No documents yet. Upload an SOW, design doc or runbook to get started.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Status</th>
                  <th>Audience</th>
                  <th>Added by</th>
                  <th>Added</th>
                  <th className="r">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs?.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <b style={{ wordBreak: "break-word" }}>{d.name}</b>
                      {d.error && <div style={{ color: "var(--bad)", fontSize: 12.5 }}>{d.error}</div>}
                      {d.status === "Ready" && <div className="muted" style={{ fontSize: 12 }}>{d.chunk_count} passage{d.chunk_count === 1 ? "" : "s"}</div>}
                    </td>
                    <td>
                      <Pill kind={d.status === "Ready" ? "good" : d.status === "Failed" ? "bad" : "info"}>{d.status}</Pill>
                    </td>
                    <td>
                      <div className="seg" style={{ fontSize: 12 }}>
                        {["internal", "shareable"].map((a) => (
                          <button key={a} style={{ padding: "3px 8px" }} aria-pressed={d.audience === a} disabled={!canEdit} onClick={() => setDocAudience(d, a)}>
                            {a === "internal" ? "Internal" : "Shareable"}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="muted">{d.uploaded_by ?? "—"}</td>
                    <td className="muted">{fmtDate(d.created_at)}</td>
                    <td className="r num muted">{d.size < 1024 ? `${d.size} bytes` : fmtBytes(d.size)}</td>
                    <td className="r">{canEdit && <button className="btn small ghost" onClick={() => remove(d)}>Delete</button>}</td>
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
