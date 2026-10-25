"use client";

/**
 * Knowledge & docs (/knowledge): upload documents to the current workspace (group), tag them Internal or Shareable,
 * and Ask Sidekick. Shareable documents are the only ones used when client guests are present.
 * Deleting a document asks for confirmation first; unsupported, empty or duplicate files are refused by the server.
 *
 * Ask (`AskPanel`): answers come from this group and the organization's firm library (cited as "Firm policy · …").
 * Filters narrow the sources by type (documents, meetings, chats, decisions, firm library) and date. Follow-ups build
 * on the conversation: the page keeps the conversation id (per group and guests setting, in this browser tab) and
 * sends it back; the answer says what it followed up on, and New question starts afresh. Each answer has 👍/👎.
 * Org Owners/Admins also see the answer-quality counts for the last 30 days (no text).
 *
 * Upload guard (components/upload-guard.tsx, lib/upload-guard.ts): the drop zone says which group the files go to
 * (in its colour); people in two or more groups confirm the group for each upload. A file that looks like another
 * client's is **Held** (not used in answers) and its row asks "Keep it here, or move it?". `?doc=<id>` (from a
 * "Needs attention" finding) scrolls to and highlights that document.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AskPanel } from "./ask";
import { NeedsWorkspace, useApp } from "@/components/shell";
import { api, fmtBytes, fmtDate, Icon, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { HeldActions, TargetConfirm, UploadTarget, type GuardMatch, type MoveTarget } from "@/components/upload-guard";

type Doc = {
  id: string; name: string; size: number; audience: string; status: string; error: string | null; chunk_count: number; created_at: string; uploaded_by: string | null;
  /** Upload guard: "kept" = flagged and kept here; `match`/`question` for held or flagged ones. */
  guard_status: string | null; match: GuardMatch | null; question: string | null;
};

export default function KnowledgePage() {
  const { ws, me, setWs } = useApp();
  // `?doc=<id>` from a "Needs attention" finding: read after mount (no useSearchParams, so no Suspense boundary needed).
  const [focus, setFocus] = useState<string | null>(null);
  const [targets, setTargets] = useState<MoveTarget[]>([]);
  const [pending, setPending] = useState<File[] | null>(null);
  const toast = useToast();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [index, setIndex] = useState({ passages: 0, questions: 0, answered: 0 });
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [audience, setAudience] = useState<"internal" | "shareable">("internal");
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = me.user.role !== "Viewer";

  const load = useCallback(async () => {
    if (!ws) return;
    const r = await api<{ docs: Doc[]; index: typeof index; targets: MoveTarget[] }>(`/api/docs?ws=${ws}`);
    setDocs(r.docs);
    setIndex(r.index);
    setTargets(r.targets);
  }, [ws]);
  const reportError = useReportError();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(reportError);
  }, [load, reportError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the address once after mount
    setFocus(new URLSearchParams(window.location.search).get("doc"));
  }, []);
  useEffect(() => {
    if (focus && docs?.some((d) => d.id === focus)) document.getElementById(`doc-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, docs]);

  if (!ws) return <NeedsWorkspace />;

  // People in two or more groups confirm the group first (TargetConfirm); everyone else uploads straight away.
  const choose = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    if (me.workspaces.length > 1) setPending(list);
    else upload(list, ws);
  };
  const upload = async (list: File[], target: string) => {
    setPending(null);
    setUploading(true);
    const form = new FormData();
    form.set("ws", target);
    form.set("audience", audience);
    list.forEach((f) => form.append("files", f));
    try {
      const r = await api<{ results: { name: string; ok: boolean; error?: string; held?: boolean }[] }>("/api/docs", { method: "POST", body: form });
      const failed = r.results.filter((x) => !x.ok);
      const held = r.results.filter((x) => x.held);
      const ready = r.results.length - failed.length - held.length;
      toast(
        held.length
          ? `${held.length} file${held.length > 1 ? "s" : ""} held: ${held.length > 1 ? "they look" : "it looks"} like another client's. Keep or move ${held.length > 1 ? "them" : "it"} below.${ready ? ` ${ready} indexed.` : ""}`
          : failed.length ? `${ready} indexed, ${failed.length} failed: ${failed[0].error}` : `${r.results.length} file${r.results.length > 1 ? "s" : ""} indexed and searchable`,
        held.length ? "error" : undefined,
      );
      // Uploaded to another group from the confirm step: switch to it, so the files are in view.
      if (target !== ws) setWs(target);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      load();
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
  const current = me.workspaces.find((w) => w.id === ws);
  const wsName = current?.name;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Knowledge & documents</div>
          <h1>{wsName}</h1>
          <p>Everything {BRAND.name} can reference in this group, plus your organization&apos;s <Link href="/firm-library">firm library</Link>. Tag documents “Internal” to keep them out of answers when client guests are present.</p>
        </div>
      </div>

      <AskPanel ws={ws} admin={me.user.admin} onAsked={() => load().catch(reportError)} />

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
            choose(e.dataTransfer.files);
          }}
        >
          <UploadTarget group={current} />
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
          <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.pptx,.txt,.md,.vtt,.csv,.json" onChange={(e) => e.target.files && choose(e.target.files)} />
        </div>
      )}
      {pending && (
        <TargetConfirm
          groups={me.workspaces}
          current={ws}
          what={pending.length > 1 ? `these ${pending.length} files` : `“${pending[0].name}”`}
          onPick={(id) => upload(pending, id)}
          onCancel={() => {
            setPending(null);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
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
            ["Questions asked", String(index.questions), "in this group"],
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
                  <tr key={d.id} id={`doc-${d.id}`} className={focus === d.id ? "focus-row" : undefined}>
                    <td style={{ minWidth: 200 }}>
                      <b style={{ overflowWrap: "break-word" }}>{d.name}</b>
                      {d.error && <div style={{ color: "var(--bad)", fontSize: 12.5 }}>{d.error}</div>}
                      {d.status === "Ready" && <div className="muted" style={{ fontSize: 12 }}>{d.chunk_count} passage{d.chunk_count === 1 ? "" : "s"}</div>}
                      {d.match && (d.status === "Held" || d.guard_status === "kept") && canEdit && (
                        <HeldActions scope="document" id={d.id} match={d.match} question={d.question} held={d.status === "Held"} targets={targets} currentWs={ws} canReview={me.user.admin || Boolean(me.user.lead)} onDone={() => load().catch(reportError)} />
                      )}
                    </td>
                    <td>
                      <Pill kind={d.status === "Ready" ? (d.guard_status === "kept" ? "warn" : "good") : d.status === "Failed" ? "bad" : d.status === "Held" ? "warn" : "info"}>{d.status}</Pill>
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
