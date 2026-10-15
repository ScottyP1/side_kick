"use client";

/**
 * Meetings (/meetings): import a transcript (Teams .vtt, Word or pasted text) and read the notes Sidekick wrote:
 * summary, decisions, action items, open questions and facts. Notes also go to the workspace's linked Teams channels.
 */

import { useCallback, useEffect, useState } from "react";
import { NeedsWorkspace, useApp } from "@/components/shell";
import { api, fmtDate, Icon, Modal, Pill, Spinner, useToast } from "@/components/ui";

type M = { id: string; title: string; held_at: string; external_guests: number; status: string; error: string | null; decisions: number; actions: number; open_questions: number };
type Detail = {
  meeting: { id: string; title: string; held_at: string; summary: string | null; transcript: string; status: string; error: string | null; external_guests: number };
  items: { id: string; kind: string; text: string; who: string | null; answered: number | null }[];
  actions: { id: string; text: string; owner: string | null; due: string | null; status: string }[];
};

export default function MeetingsPage() {
  const { ws, me } = useApp();
  const toast = useToast();
  const [list, setList] = useState<M[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState("Notes");
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ title: "", held_at: new Date().toISOString().slice(0, 10), external: false, text: "" });
  const [file, setFile] = useState<File | null>(null);
  const canEdit = !["Viewer", "Billing Admin"].includes(me.user.role);

  const load = useCallback(async () => {
    if (!ws) return;
    setList((await api<{ meetings: M[] }>(`/api/meetings?ws=${ws}`)).meetings);
  }, [ws]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(() => {});
  }, [load]);
  useEffect(() => {
    if (openId) api<Detail>(`/api/meetings/${openId}`).then(setDetail).catch((e) => toast(e.message));
  }, [openId, toast]);
  const openMeeting = (id: string | null) => {
    setDetail(null);
    setTab("Notes");
    setOpenId(id);
  };

  if (!ws) return <NeedsWorkspace />;

  const submit = async () => {
    setBusy(true);
    setErr("");
    const fd = new FormData();
    fd.set("ws", ws);
    fd.set("title", form.title);
    fd.set("held_at", form.held_at);
    fd.set("external", String(form.external));
    fd.set("text", form.text);
    if (file) fd.set("file", file);
    try {
      const r = await api<{ id: string }>("/api/meetings", { method: "POST", body: fd });
      setImporting(false);
      setFile(null);
      setForm({ title: "", held_at: new Date().toISOString().slice(0, 10), external: false, text: "" });
      toast("Notes are ready");
      await load();
      openMeeting(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed.");
      load();
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
      toast(e instanceof Error ? e.message : "Still failing.");
      load();
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await api(`/api/meetings/${id}`, { method: "DELETE" });
    toast("Meeting, notes and transcript deleted");
    openMeeting(null);
    load();
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
                <div className="eyebrow">{fmtDate(m!.held_at)}{m!.external_guests ? " · client guests present" : " · internal"}</div>
                <h1>{m!.title}</h1>
              </div>
              {canEdit && (
                <div className="actions">
                  {m!.status === "Failed" && <button className="btn primary" disabled={busy} onClick={() => retry(m!.id)}>{busy ? <><Spinner /> Processing</> : "Try again"}</button>}
                  <button className="btn danger" onClick={() => remove(m!.id)}>Delete</button>
                </div>
              )}
            </div>
            {m!.status === "Failed" && <div className="callout bad"><Icon n="alert" /><div>Sidekick couldn&apos;t write notes: {m!.error}</div></div>}
            <div className="grid g4">
              {[["Decisions", of("decision").length], ["Action items", detail.actions.length], ["Open questions", of("question").filter((q) => !q.answered).length], ["Facts learned", of("requirement").length + of("fact").length + of("risk").length + of("glossary").length]].map(([l, v]) => (
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
                  <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 780 }}>
                    <div>
                      <h3>Summary</h3>
                      <p style={{ margin: "4px 0 0" }}>{m!.summary ?? "—"}</p>
                    </div>
                    <Section title="Decisions" items={of("decision").map((d) => `${d.text}${d.who ? ` (${d.who})` : ""}`)} />
                    <div>
                      <h3>Action items</h3>
                      {detail.actions.length ? (
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                          {detail.actions.map((a) => (
                            <li key={a.id}>
                              {a.owner ? <b>{a.owner}: </b> : <span style={{ color: "var(--hand)" }}>No owner yet: </span>}
                              {a.text}
                              {a.due && <span className="muted">, due {a.due}</span>}
                            </li>
                          ))}
                        </ul>
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
                    <Section title="Requirements, facts & risks" items={[...of("requirement"), ...of("fact"), ...of("risk"), ...of("glossary")].map((f) => `${f.kind[0].toUpperCase() + f.kind.slice(1)}: ${f.text}`)} />
                  </div>
                )}
                {tab === "Transcript" && <pre className="transcript-raw">{m!.transcript}</pre>}
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
          <p>Import a Teams transcript and Sidekick writes the notes: summary, decisions, action items, open questions and facts to remember. Live meeting joining arrives in step 3.</p>
        </div>
        {canEdit && (
          <div className="actions">
            <button className="btn primary" onClick={() => setImporting(true)}>
              <Icon n="upload" />
              Import transcript
            </button>
          </div>
        )}
      </div>
      <div className="panel">
        {list && !list.length ? (
          <div className="empty">
            <h2>No meetings yet</h2>
            <span>In Teams, open a meeting&apos;s Recap → Transcript → Download (.vtt or .docx), then import it here.</span>
            {canEdit && <button className="btn primary" onClick={() => setImporting(true)}>Import transcript</button>}
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
                    <td><b>{x.title}</b></td>
                    <td className="muted">{fmtDate(x.held_at)}</td>
                    <td><Pill kind={x.status === "Ready" ? "good" : x.status === "Failed" ? "bad" : "info"}>{x.status}</Pill></td>
                    <td className="r num">{x.decisions}</td>
                    <td className="r num">{x.actions}</td>
                    <td className="r num">{x.open_questions}</td>
                    <td className="r">{x.external_guests ? <span className="tag">Client guests</span> : <span className="tag">Internal</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {importing && (
        <Modal
          title="Import a meeting transcript"
          onClose={() => !busy && setImporting(false)}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setImporting(false)}>Cancel</button>
              <button className="btn primary" disabled={busy || (!file && !form.text.trim()) || (!file && !form.title.trim())} onClick={submit}>
                {busy ? <><Spinner /> Sidekick is writing notes…</> : "Import & write notes"}
              </button>
            </>
          }
        >
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
