"use client";

/**
 * Meetings (/meetings): the group's meetings and the notes Sidekick wrote: summary, decisions, action items (editable
 * here: owner, due date, status), open questions and facts. Two ways in:
 * - **Automatic notes** after Teams meetings (panel at the top, components/auto-notes.tsx; lib/meetings-graph.ts),
 *   shown with a "Teams" tag;
 * - **Add a past or outside meeting**: upload a transcript (Teams .vtt, Word or pasted text), for meetings held before
 *   automatic notes were on or outside Teams. A failed one is still saved; the page then opens it with **Try again**.
 *   The dialog says which group the meeting goes to (components/upload-guard.tsx); people in two or more groups pick
 *   the group right there. If the transcript looks like another client's meeting, nothing is saved yet: the dialog
 *   asks "Keep it here, or move it?" (add here anyway, or add it to that group instead).
 * Decisions, requirements, risks, facts and terms can be **saved to knowledge** (PATCH /api/items/:id), like the
 * button on the notes card in Teams. Notes also go to the group's notes chats in Teams.
 */

import { useCallback, useEffect, useState } from "react";
import { NeedsWorkspace, useApp } from "@/components/shell";
import { api, ApiError, fmtDate, Icon, Modal, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { ActionItemsTable, useUpdateAction, type ActionItem } from "@/components/action-items";
import { BRAND } from "@/lib/brand";
import { AutoNotesPanel } from "@/components/auto-notes";
import { groupLabel, UploadTarget, type GuardMatch } from "@/components/upload-guard";

/** Same limit as the server (lib/extract.ts MAX_TRANSCRIPT_CHARS), so the dialog can say so before sending. */
const MAX_TRANSCRIPT_CHARS = 300_000;
/** The Transcript tab shows a long transcript in pieces of this many characters, so the page stays quick. */
const TRANSCRIPT_PAGE = 40_000;

type M = { id: string; title: string; held_at: string; external_guests: number; status: string; error: string | null; decisions: number; actions: number; open_questions: number; source: string | null };
type Item = { id: string; kind: string; text: string; who: string | null; answered: number | null; pinned?: number; saved_by?: string | null };
type Detail = {
  meeting: { id: string; title: string; held_at: string; summary: string | null; transcript: string; status: string; error: string | null; external_guests: number; source: string | null };
  items: Item[];
  actions: ActionItem[];
};

export default function MeetingsPage() {
  const { ws, me, setWs } = useApp();
  const toast = useToast();
  const [list, setList] = useState<M[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState("Notes");
  const [shownChars, setShownChars] = useState(TRANSCRIPT_PAGE);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ title: "", held_at: new Date().toISOString().slice(0, 10), external: false, text: "" });
  const [file, setFile] = useState<File | null>(null);
  // Upload guard: the group this meeting goes to (people in 2+ groups pick it), and the question when it looks
  // like another client's meeting.
  const [target, setTarget] = useState("");
  const [check, setCheck] = useState<{ question: string; match: GuardMatch } | null>(null);
  const canEdit = me.user.role !== "Viewer";

  const load = useCallback(async () => {
    if (!ws) return;
    setList((await api<{ meetings: M[] }>(`/api/meetings?ws=${ws}`)).meetings);
  }, [ws]);
  const reportError = useReportError();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(reportError);
  }, [load, reportError]);
  const loadDetail = useCallback(async () => {
    if (openId) setDetail(await api<Detail>(`/api/meetings/${openId}`));
  }, [openId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch when a meeting opens; state is set after the request resolves
    loadDetail().catch(reportError);
  }, [loadDetail, reportError]);
  const updateAction = useUpdateAction(
    (id, patch) => setDetail((d) => (d ? { ...d, actions: d.actions.map((x) => (x.id === id ? { ...x, ...patch } : x)) } : d)),
    () => loadDetail().catch(reportError),
  );
  const openMeeting = (id: string | null) => {
    setDetail(null);
    setTab("Notes");
    setShownChars(TRANSCRIPT_PAGE);
    setOpenId(id);
  };

  if (!ws) return <NeedsWorkspace />;

  const resetImport = () => {
    setImporting(false);
    setCheck(null);
    setTarget("");
    setFile(null);
    setForm({ title: "", held_at: new Date().toISOString().slice(0, 10), external: false, text: "" });
  };
  const submit = async (opts: { to?: string; anyway?: boolean } = {}) => {
    setBusy(true);
    setErr("");
    const dest = opts.to ?? (target || ws);
    const fd = new FormData();
    fd.set("ws", dest);
    if (opts.anyway) fd.set("wrong_client_ok", "1");
    fd.set("title", form.title);
    fd.set("held_at", form.held_at);
    fd.set("external", String(form.external));
    fd.set("text", form.text);
    if (file) fd.set("file", file);
    try {
      const r = await api<{ id?: string; check?: { question: string; match: GuardMatch } }>("/api/meetings", { method: "POST", body: fd });
      if (r.check) {
        // Nothing saved yet: ask where it belongs.
        setTarget(dest);
        setCheck(r.check);
        return;
      }
      resetImport();
      toast("Notes are ready");
      if (dest !== ws) setWs(dest);
      await load();
      openMeeting(r.id!);
    } catch (e) {
      // The meeting was saved but its notes failed: close the dialog and open it, with Try again, so the
      // person retries there instead of importing it again (which left duplicate Failed meetings).
      const savedId = e instanceof ApiError && typeof e.data?.meeting_id === "string" ? e.data.meeting_id : null;
      if (savedId) {
        resetImport();
        toast(`The meeting is saved, but ${BRAND.name} couldn't write the notes. Use Try again.`, "error");
        openMeeting(savedId);
      } else {
        setErr(e instanceof Error ? e.message : "Import failed.");
      }
      load().catch(reportError);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (id: string) => {
    setBusy(true);
    try {
      await api(`/api/meetings/${id}`, { method: "POST" });
      toast("Notes are ready");
      await load();
      openMeeting(id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Still failing.", "error");
      load().catch(reportError);
      loadDetail().catch(reportError);
    } finally {
      setBusy(false);
    }
  };
  const setSaved = async (item: Item, saved: boolean) => {
    await api(`/api/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ saved }) });
    toast(saved ? "Saved to the group's knowledge" : "Removed from knowledge");
    await loadDetail();
  };
  const remove = async (id: string, title: string) => {
    if (!confirm(`Delete “${title}”? Its notes, action items and transcript are deleted too. This can't be undone.`)) return;
    await api(`/api/meetings/${id}`, { method: "DELETE" });
    toast("Meeting, notes and transcript deleted");
    openMeeting(null);
    load().catch(reportError);
  };

  if (openId) {
    const m = detail?.meeting;
    const of = (k: string) => detail?.items.filter((i) => i.kind === k) ?? [];
    return (
      <>
        <div>
          <button className="btn small ghost" onClick={() => openMeeting(null)}>
            <Icon n="back" />
            All meetings
          </button>
        </div>
        {!detail ? (
          <span className="muted">Loading…</span>
        ) : (
          <>
            <div className="page-head">
              <div>
                <div className="eyebrow">
                  {fmtDate(m!.held_at)}{m!.source === "teams" ? " · captured from Microsoft Teams" : ""}{m!.external_guests ? " · client guests present" : " · internal"}{" "}
                  <Pill kind={m!.status === "Ready" ? "good" : m!.status === "Failed" ? "bad" : "info"}>{m!.status}</Pill>
                </div>
                <h1>{m!.title}</h1>
              </div>
              {canEdit && (
                <div className="actions">
                  {m!.status === "Failed" && <button className="btn primary" disabled={busy} onClick={() => retry(m!.id)}>{busy ? <><Spinner /> Processing</> : "Try again"}</button>}
                  <button className="btn danger" onClick={() => remove(m!.id, m!.title).catch(reportError)}>Delete</button>
                </div>
              )}
            </div>
            {m!.status === "Failed" && <div className="callout bad"><Icon n="alert" /><div>{BRAND.name} couldn&apos;t write notes: {m!.error}</div></div>}
            <div className="grid g4">
              {[["Decisions", of("decision").length], ["Open action items", detail.actions.filter((a) => a.status !== "Done").length], ["Open questions", of("question").filter((q) => !q.answered).length], ["Facts learned", of("requirement").length + of("fact").length + of("risk").length + of("glossary").length]].map(([l, v]) => (
                <div key={l as string} className="kpi" style={{ cursor: "default" }}>
                  <span className="eyebrow">{l}</span>
                  <span className="v" style={{ fontSize: 22 }}>{v}</span>
                </div>
              ))}
            </div>
            <div className="panel">
              <div className="tabs" role="tablist">
                {["Notes", "Transcript"].map((k) => (
                  <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{k}</button>
                ))}
              </div>
              <div className="panel-b">
                {tab === "Notes" && (
                  <div className="notes-col">
                    <div>
                      <h3>Summary</h3>
                      <p style={{ margin: "4px 0 0" }}>{m!.summary ?? "—"}</p>
                    </div>
                    <KeepSection title="Decisions" items={of("decision")} canEdit={canEdit} onSave={(i, v) => setSaved(i, v).catch(reportError)} label={(d) => `${d.text}${d.who ? ` (${d.who})` : ""}`} />
                    {of("pending").length > 0 && <Section title="Decisions still to make" items={of("pending").map((d) => `${d.text}${d.answered ? " (made)" : ""}`)} />}
                    <div className="notes-wide">
                      <h3>Action items</h3>
                      {detail.actions.length ? (
                        <ActionItemsTable items={detail.actions} canEdit={canEdit} onChange={updateAction} />
                      ) : <p className="muted" style={{ margin: "4px 0 0" }}>None</p>}
                    </div>
                    <div>
                      <h3>Open questions</h3>
                      {of("question").length ? (
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                          {of("question").map((q) => (
                            <li key={q.id}>{q.text} {q.answered ? <Pill kind="good">Answered</Pill> : <Pill kind="hand">Unanswered</Pill>}</li>
                          ))}
                        </ul>
                      ) : <p className="muted" style={{ margin: "4px 0 0" }}>None</p>}
                    </div>
                    <KeepSection title="Requirements, facts & risks" items={[...of("requirement"), ...of("fact"), ...of("risk"), ...of("glossary")]} canEdit={canEdit} onSave={(i, v) => setSaved(i, v).catch(reportError)} label={(f) => `${f.kind[0].toUpperCase() + f.kind.slice(1)}: ${f.text}`} />
                  </div>
                )}
                {tab === "Transcript" && (
                  <>
                    {m!.transcript ? <pre className="transcript-raw">{m!.transcript.slice(0, shownChars)}</pre> : <p className="muted">No transcript text.</p>}
                    {m!.transcript.length > shownChars && (
                      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
                        <span className="muted">Showing {shownChars.toLocaleString()} of {m!.transcript.length.toLocaleString()} characters.</span>
                        <button className="btn small" onClick={() => setShownChars((n) => n + TRANSCRIPT_PAGE)}>Show more</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Meetings</div>
          <h1>{list ? `${list.length} meeting${list.length === 1 ? "" : "s"}` : "Meetings"}</h1>
          <p>{BRAND.name} writes the notes after your Teams meetings: summary, decisions, action items, open questions and facts to remember. For a meeting held earlier or outside Teams, add its transcript.</p>
        </div>
        {canEdit && (
          <div className="actions">
            <button className="btn primary" onClick={() => setImporting(true)}>
              <Icon n="upload" />
              Add a past or outside meeting
            </button>
          </div>
        )}
      </div>
      <AutoNotesPanel role={me.user.role} onOpen={(id) => openMeeting(id)} />
      <div className="panel">
        {list && !list.length ? (
          <div className="empty">
            <h2>No meetings yet</h2>
            <span>With automatic notes on, Teams meetings of this group&apos;s people show up here by themselves. For a past or outside meeting, download its transcript (in Teams: Recap → Transcript → Download) and add it here.</span>
            {canEdit && <button className="btn primary" onClick={() => setImporting(true)}>Add a past or outside meeting</button>}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="r">Decisions</th>
                  <th className="r">Actions</th>
                  <th className="r">Open questions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list?.map((x) => (
                  <tr key={x.id} className="clickable" onClick={() => openMeeting(x.id)}>
                    {/* The title is a real button, so the row can be reached and opened with the keyboard. */}
                    <td><button type="button" className="linklike" onClick={(e) => { e.stopPropagation(); openMeeting(x.id); }}><b>{x.title}</b></button></td>
                    <td className="muted">{fmtDate(x.held_at)}</td>
                    <td><Pill kind={x.status === "Ready" ? "good" : x.status === "Failed" ? "bad" : "info"}>{x.status}</Pill></td>
                    <td className="r num">{x.decisions}</td>
                    <td className="r num">{x.actions}</td>
                    <td className="r num">{x.open_questions}</td>
                    <td className="r">{x.source === "teams" && <span className="tag">Teams</span>} {x.external_guests ? <span className="tag">Client guests</span> : <span className="tag">Internal</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {importing && (
        <Modal
          title="Add a past or outside meeting"
          onClose={() => !busy && setImporting(false)}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setImporting(false)}>Cancel</button>
              <button className="btn primary" disabled={busy || (!file && !form.text.trim()) || (!file && !form.title.trim()) || (!file && form.text.length > MAX_TRANSCRIPT_CHARS) || Boolean(check)} onClick={() => submit()}>
                {busy ? <><Spinner /> {BRAND.name} is writing notes…</> : "Add & write notes"}
              </button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0 }}>For a meeting held before automatic notes were on, or outside Teams (another tool, in person with a recording). Teams meetings are added by themselves when automatic notes are on.</p>
          <UploadTarget group={me.workspaces.find((w) => w.id === (target || ws))} />
          {me.workspaces.length > 1 && (
            <div className="field">
              <label htmlFor="mgroup">Group (only its people see the notes)</label>
              <select id="mgroup" className="input" value={target || ws} onChange={(e) => { setTarget(e.target.value); setCheck(null); }}>
                {me.workspaces.map((w) => <option key={w.id} value={w.id}>{groupLabel(w)}</option>)}
              </select>
            </div>
          )}
          {check && (
            <div className="callout warn" role="alert">
              <div className="grow">
                <b>{check.question}</b>
                <div className="muted" style={{ fontSize: 12.5 }}>It mentions {check.match.terms.map((t) => `“${t}”`).join(", ")}. Nothing is saved yet.</div>
                <div className="actions" style={{ marginTop: 8 }}>
                  {me.workspaces.some((w) => w.id === check.match.workspaceId) && (
                    <button className="btn small primary" disabled={busy} onClick={() => { setCheck(null); submit({ to: check.match.workspaceId }); }}>Add it to {check.match.group}</button>
                  )}
                  <button className="btn small" disabled={busy} onClick={() => { const to = target || ws; setCheck(null); submit({ to, anyway: true }); }}>Keep it here</button>
                </div>
              </div>
            </div>
          )}
          <div className="field">
            <label htmlFor="mfile">Transcript file</label>
            <input id="mfile" type="file" accept=".vtt,.docx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="hint">Teams: meeting Recap → Transcript → Download. Or paste the text below.</span>
          </div>
          <div className="field">
            <label htmlFor="mtitle">Title {file ? "(optional)" : ""}</label>
            <input id="mtitle" className="input" placeholder={file ? file.name.replace(/\.[^.]+$/, "") : "e.g. Sprint 14 planning"} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="grid g2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="mdate">Meeting date</label>
              <input id="mdate" className="input" type="date" value={form.held_at} onChange={(e) => setForm({ ...form, held_at: e.target.value })} />
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 22 }}>
              <input type="checkbox" checked={form.external} onChange={(e) => setForm({ ...form, external: e.target.checked })} />
              Client guests attended
            </label>
          </div>
          {!file && (
            <div className="field">
              <label htmlFor="mtext">Or paste the transcript</label>
              <textarea id="mtext" className="input" rows={6} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder={"Priya: Let's lock sprint 14…\nSam: …"} />
              <span className={`hint${form.text.length > MAX_TRANSCRIPT_CHARS ? " err" : ""}`}>
                {form.text.length > MAX_TRANSCRIPT_CHARS
                  ? `Too long: ${form.text.length.toLocaleString()} characters (limit ${MAX_TRANSCRIPT_CHARS.toLocaleString()}). Split it into parts.`
                  : `Up to ${MAX_TRANSCRIPT_CHARS.toLocaleString()} characters (about five hours of talk).`}
              </span>
            </div>
          )}
          {err && <p className="err">{err}</p>}
          <span className="hint muted" style={{ fontSize: 12.5 }}>Writing notes usually takes 20–60 seconds.</span>
        </Modal>
      )}
    </>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length ? (
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {items.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      ) : <p className="muted" style={{ margin: "4px 0 0" }}>None</p>}
    </div>
  );
}

/**
 * A list of meeting items (decisions, or requirements/facts/risks/terms) with **Save to knowledge** per item for
 * people who can edit. A saved item shows who saved it and can be removed again.
 */
function KeepSection({ title, items, canEdit, onSave, label }: { title: string; items: Item[]; canEdit: boolean; onSave: (i: Item, saved: boolean) => void; label: (i: Item) => string }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length ? (
        <ul style={{ margin: "4px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((i) => (
            <li key={i.id}>
              {label(i)}{" "}
              {i.pinned ? <Pill kind="good">Saved{i.saved_by ? ` by ${i.saved_by}` : ""}</Pill> : null}{" "}
              {canEdit && (
                <button type="button" className="btn small ghost" onClick={() => onSave(i, !i.pinned)}>
                  {i.pinned ? "Remove from knowledge" : "Save to knowledge"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="muted" style={{ margin: "4px 0 0" }}>None</p>}
    </div>
  );
}
