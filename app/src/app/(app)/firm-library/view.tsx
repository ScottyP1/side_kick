"use client";

/**
 * Firm library (/firm-library): the organization's own policies, standards, templates, methods and rate-card rules,
 * which every group's answers can use (cited as "Firm policy · <title>"). Everyone in the organization sees the
 * list; Org Owners and Org Admins upload (with title, audience, effective date and what it replaces), edit and
 * delete. Shareable firm documents are the only ones used where client guests are present. Firm documents count
 * toward the plan's document limit. API: /api/firm and /api/firm/[id] (lib/firm.ts).
 *
 * **Applies to**: every group (default) or chosen groups only; set when uploading and changed per document (Change).
 * **Upload guard** (components/upload-guard.tsx): the form says the upload reaches every group (or the chosen ones);
 * a file that mentions one of the org's clients is **Held** (not used in answers) and its row asks "Put it in the
 * Contoso group instead?" with Move / Only for that group / Keep for every group. `?doc=<id>` highlights one row.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtBytes, fmtDate, Icon, Modal, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { HeldActions, UploadTarget, type GuardMatch, type MoveTarget } from "@/components/upload-guard";
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
  applies_to: "all" | "some";
  groups: { id: string; name: string }[];
  /** For people who aren't admins: chosen groups they aren't in (names hidden). */
  hiddenGroups?: number;
  guard_status: string | null;
  match: GuardMatch | null;
  question: string | null;
};

/** Ticks for choosing groups ("Applies to"). */
function GroupPicks({ groups, picked, setPicked }: { groups: MoveTarget[]; picked: string[]; setPicked: (ids: string[]) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
      {groups.map((g) => (
        <label key={g.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={picked.includes(g.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, g.id] : picked.filter((x) => x !== g.id))} />
          {g.name}
        </label>
      ))}
    </div>
  );
}

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
  const [groups, setGroups] = useState<MoveTarget[]>([]);
  const [limited, setLimited] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ doc: FirmDoc; limited: boolean; picked: string[] } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await api<{ docs: FirmDoc[]; counts: typeof counts; canManage: boolean; groups: MoveTarget[] }>("/api/firm");
    setDocs(r.docs);
    setCounts(r.counts);
    setCanManage(r.canManage);
    setGroups(r.groups);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(reportError);
  }, [load, reportError]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads `?doc=` once after mount (a "Needs attention" link)
    setFocus(new URLSearchParams(window.location.search).get("doc"));
  }, []);
  useEffect(() => {
    if (focus && docs?.some((d) => d.id === focus)) document.getElementById(`firm-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, docs]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    const form = new FormData();
    form.set("audience", audience);
    if (title.trim()) form.set("title", title.trim());
    if (effective) form.set("effective_on", effective);
    if (replaces) form.set("replaces", replaces);
    if (limited) picked.forEach((g) => form.append("applies_to", g));
    list.forEach((f) => form.append("files", f));
    try {
      const r = await api<{ results: { name: string; ok: boolean; error?: string; held?: boolean }[] }>("/api/firm", { method: "POST", body: form });
      const failed = r.results.filter((x) => !x.ok);
      const held = r.results.filter((x) => x.held);
      const who = limited ? "The chosen groups" : "Every group";
      toast(
        held.length
          ? `${held.length} held: ${held.length > 1 ? "they mention" : "it mentions"} one of your clients. Decide below where ${held.length > 1 ? "they belong" : "it belongs"}.`
          : failed.length ? `${r.results.length - failed.length} added, ${failed.length} not added: ${failed[0].error}` : `${r.results.length} document${r.results.length > 1 ? "s" : ""} added. ${who} can use ${r.results.length > 1 ? "them" : "it"} now`,
        held.length ? "error" : undefined,
      );
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
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "a group";
  const saveAppliesTo = async () => {
    if (!editing) return;
    await change(editing.doc, { applies_to: editing.limited ? editing.picked : "all" });
    setEditing(null);
  };

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
            <div className="field">
              <span>Applies to</span>
              <div className="seg">
                <button type="button" aria-pressed={!limited} onClick={() => setLimited(false)}>All groups</button>
                <button type="button" aria-pressed={limited} onClick={() => setLimited(true)}>Chosen groups</button>
              </div>
              {limited && <GroupPicks groups={groups} picked={picked} setPicked={setPicked} />}
            </div>
            <UploadTarget firm limitedTo={limited ? picked.map(groupName) : undefined} />
            <div className="actions" style={{ alignItems: "center" }}>
              <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={uploading || (limited && !picked.length)}>
                {uploading ? <><Spinner /> Reading and indexing…</> : <><Icon n="upload" /> Choose files</>}
              </button>
              <span className="muted" style={{ fontSize: 12.5 }}>PDF, Word (.docx), text, Markdown, CSV or JSON · up to 25 MB each · counts toward your plan&apos;s document limit</span>
            </div>
            <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.pptx,.txt,.md,.csv,.json" onChange={(e) => e.target.files && upload(e.target.files)} />
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
                  <th>Applies to</th>
                  <th>Effective</th>
                  <th>Added</th>
                  <th className="r">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs?.map((d) => (
                  <tr key={d.id} id={`firm-${d.id}`} className={focus === d.id ? "focus-row" : undefined}>
                    <td style={{ minWidth: 220 }}>
                      <b style={{ overflowWrap: "break-word" }}>{d.title}</b>
                      <div className="muted" style={{ fontSize: 12 }}>{d.name}{d.status === "Ready" ? ` · ${d.chunk_count} passage${d.chunk_count === 1 ? "" : "s"}` : ""}</div>
                      {d.superseded_title && <div style={{ fontSize: 12.5, color: "var(--warn)" }}>Superseded by “{d.superseded_title}”</div>}
                      {d.error && <div style={{ color: "var(--bad)", fontSize: 12.5 }}>{d.error}</div>}
                      {canManage && d.match && (d.status === "Held" || d.guard_status === "kept") && (
                        <HeldActions scope="firm" id={d.id} match={d.match} question={d.question} held={d.status === "Held"} targets={groups} canReview onDone={() => load().catch(reportError)} />
                      )}
                    </td>
                    <td><Pill kind={d.status === "Ready" ? (d.superseded_by || d.guard_status === "kept" ? "warn" : "good") : d.status === "Failed" ? "bad" : d.status === "Held" ? "warn" : "info"}>{d.status === "Ready" && d.superseded_by ? "Superseded" : d.status}</Pill></td>
                    <td>
                      <div className="seg" style={{ fontSize: 12 }}>
                        {(["internal", "shareable"] as const).map((a) => (
                          <button key={a} style={{ padding: "3px 8px" }} aria-pressed={d.audience === a} disabled={!canManage} onClick={() => change(d, { audience: a })}>
                            {a === "internal" ? "Internal" : "Shareable"}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5, minWidth: 120 }}>
                      {d.applies_to === "some"
                        ? d.groups.length || d.hiddenGroups
                          ? [...d.groups.map((g) => g.name), ...(d.hiddenGroups ? [`${d.hiddenGroups} other group${d.hiddenGroups > 1 ? "s" : ""}`] : [])].join(", ")
                          : <span className="muted">No groups (removed)</span>
                        : <span className="muted">All groups</span>}
                      {canManage && (
                        <div><button className="btn small ghost" style={{ padding: "2px 6px" }} onClick={() => setEditing({ doc: d, limited: d.applies_to === "some", picked: d.groups.map((g) => g.id) })}>Change</button></div>
                      )}
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
      {editing && (
        <Modal
          title={`Who can use “${editing.doc.title}”?`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" disabled={editing.limited && !editing.picked.length} onClick={saveAppliesTo}>Save</button>
            </>
          }
        >
          <div className="seg">
            <button type="button" aria-pressed={!editing.limited} onClick={() => setEditing({ ...editing, limited: false })}>All groups</button>
            <button type="button" aria-pressed={editing.limited} onClick={() => setEditing({ ...editing, limited: true })}>Chosen groups</button>
          </div>
          {editing.limited && <GroupPicks groups={groups} picked={editing.picked} setPicked={(ids) => setEditing({ ...editing, picked: ids })} />}
          <UploadTarget firm limitedTo={editing.limited ? editing.picked.map(groupName) : undefined} />
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Only the chosen groups&apos; answers use it, straight away. Client guests still only see Shareable documents.</p>
        </Modal>
      )}
    </>
  );
}
