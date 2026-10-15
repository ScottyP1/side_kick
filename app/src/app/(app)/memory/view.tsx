"use client";

/**
 * Memory & gaps (/memory): the knowledge map (topics and how well each is covered), knowledge gaps with
 * suggested fixes, and the action-item tracker for the current workspace.
 */

import { useCallback, useEffect, useState } from "react";
import { NeedsWorkspace, useApp } from "@/components/shell";
import { api, fmtDate, fmtTime, Icon, Pill, Spinner, useToast } from "@/components/ui";

type Topic = { name: string; summary: string; coverage: number; key_facts: string[]; document_titles: string[]; meeting_titles: string[] };
type Gap = { kind: string; text: string; suggestion: string; topic: string; assignee: string | null };
type Item = { id: string; kind: string; text: string; who: string | null; answered: number | null; meeting: string | null; held_at: string | null };
type Action = { id: string; text: string; owner: string | null; due: string | null; status: string; meeting: string | null; held_at: string | null };
type Data = { topics: Topic[]; gaps: Gap[]; refreshedAt: string | null; items: Item[]; actions: Action[] };

const covKind = (c: number) => (c >= 70 ? "good" : c >= 40 ? "warn" : "bad");
const covWord = (c: number) => (c >= 70 ? "Well covered" : c >= 40 ? "Partial" : "Gap");
const gapKind: Record<string, string> = { "Couldn't find an answer": "bad", "Unanswered in meeting": "hand", "Conflicting information": "warn", "Out of date": "warn", "Thin coverage": "info", "Only in a meeting": "info" };

export default function MemoryPage() {
  const { ws, me } = useApp();
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState("Topics");
  const [topic, setTopic] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("Open");
  const [factTab, setFactTab] = useState("decision");
  const canEdit = !["Viewer", "Billing Admin"].includes(me.user.role);

  const load = useCallback(async () => {
    if (!ws) return;
    setData(await api<Data>(`/api/memory?ws=${ws}`));
  }, [ws]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(() => {});
  }, [load]);

  if (!ws) return <NeedsWorkspace />;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api("/api/memory/refresh", { method: "POST", json: { ws } });
      await load();
      toast("Knowledge map updated");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't refresh.");
    } finally {
      setRefreshing(false);
    }
  };
  const updateAction = async (a: Action, patch: Partial<Action>) => {
    setData((d) => (d ? { ...d, actions: d.actions.map((x) => (x.id === a.id ? { ...x, ...patch } : x)) } : d));
    try {
      await api(`/api/action-items/${a.id}`, { method: "PATCH", json: patch });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.");
      load();
    }
  };
  const gapAction = async (g: Gap, status: "Open" | "Resolved", assignee?: string) => {
    try {
      await api("/api/gaps", { method: "POST", json: { ws, gap: g.text, status, assignee } });
      toast(status === "Resolved" ? "Gap resolved" : `Assigned to ${assignee}`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.");
    }
  };

  const topics = data?.topics ?? [];
  const sel = topics.find((t) => t.name === topic) ?? topics[0];
  const actions = data?.actions ?? [];
  const open = actions.filter((a) => a.status !== "Done");
  const shown = actions.filter((a) => (filter === "All" ? true : filter === "Open" ? a.status !== "Done" : filter === "No owner" ? !a.owner && a.status !== "Done" : a.status === "Done"));
  const owners = [...new Set(actions.map((a) => a.owner).filter(Boolean) as string[])];
  const facts = (data?.items ?? []).filter((i) => i.kind === factTab);
  const avg = topics.length ? Math.round(topics.reduce((s, t) => s + t.coverage, 0) / topics.length) : null;
  const wsName = me.workspaces.find((w) => w.id === ws)?.name;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Memory · {wsName}</div>
          <h1>What Sidekick knows, and what it doesn&apos;t</h1>
          <p>Built from this workspace&apos;s meetings and documents. Refresh the knowledge map after adding new material.</p>
        </div>
        <div className="actions" style={{ alignItems: "center" }}>
          {data?.refreshedAt && <span className="muted" style={{ fontSize: 12.5 }}>Map updated {fmtTime(data.refreshedAt)}</span>}
          {canEdit && <button className="btn primary" onClick={refresh} disabled={refreshing}>{refreshing ? <><Spinner /> Mapping…</> : <><Icon n="refresh" />Refresh knowledge map</>}</button>}
        </div>
      </div>

      <div className="grid g4">
        {[
          ["Topics", topics.length || "—", data?.refreshedAt ? "found in meetings and docs" : "Refresh to build the map", "Topics"],
          ["Coverage", avg !== null ? `${avg}%` : "—", topics.length ? `${topics.filter((t) => t.coverage >= 70).length} well covered · ${topics.filter((t) => t.coverage < 40).length} gaps` : "", "Topics"],
          ["Open gaps", data?.gaps.length ?? "—", "things the team should write down", "Gaps"],
          ["Action items", `${open.length} open`, `${open.filter((a) => !a.owner).length} without an owner`, "Action items"],
        ].map(([l, v, d, t]) => (
          <button key={l as string} className="kpi" onClick={() => setTab(t as string)}>
            <span className="eyebrow">{l}</span>
            <span className="v">{v}</span>
            <span className="d muted">{d}</span>
          </button>
        ))}
      </div>

      <div className="panel">
        <div className="tabs" role="tablist">
          {[["Topics", topics.length], ["Gaps", data?.gaps.length ?? 0], ["Action items", open.length], ["Decisions & facts", data?.items.length ?? 0]].map(([k, c]) => (
            <button key={k as string} role="tab" aria-selected={tab === k} onClick={() => setTab(k as string)}>
              {k} <span className="faint num">{c}</span>
            </button>
          ))}
        </div>

        {tab === "Topics" &&
          (!topics.length ? (
            <div className="empty">
              <span>No knowledge map yet.</span>
              {canEdit && <button className="btn primary" onClick={refresh} disabled={refreshing}>{refreshing ? "Mapping…" : "Build knowledge map"}</button>}
            </div>
          ) : (
            <div className="panel-b grid g-main">
              <div className="grid g2" style={{ gap: 10, alignContent: "start" }}>
                {topics.map((t) => (
                  <button key={t.name} className="ws-card" style={{ gap: 8, padding: 12, borderColor: sel?.name === t.name ? "var(--accent)" : undefined }} onClick={() => setTopic(t.name)}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", width: "100%" }}>
                      <b style={{ fontSize: 13.5 }}>{t.name}</b>
                      <Pill kind={covKind(t.coverage)}>{covWord(t.coverage)}</Pill>
                    </div>
                    <div className="meter" style={{ height: 6, width: "100%" }}>
                      <span style={{ width: `${t.coverage}%`, background: `var(--${covKind(t.coverage)})` }} />
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>{t.document_titles.length} docs · {t.meeting_titles.length} meetings</span>
                  </button>
                ))}
              </div>
              {sel && (
                <div className="model" style={{ alignSelf: "start" }}>
                  <span className="eyebrow">Topic</span>
                  <h2>{sel.name}</h2>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span className="muted">Coverage</span><b className="num">{sel.coverage}%</b></div>
                    <div className="meter" style={{ marginTop: 6 }}><span style={{ width: `${sel.coverage}%`, background: `var(--${covKind(sel.coverage)})` }} /></div>
                  </div>
                  <p style={{ margin: 0 }}>{sel.summary}</p>
                  {sel.key_facts.length > 0 && (
                    <div>
                      <div className="eyebrow" style={{ marginBottom: 4 }}>Key facts</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>{sel.key_facts.map((f) => <li key={f}>{f}</li>)}</ul>
                    </div>
                  )}
                  <div className="stat-line"><span className="muted">Documents</span><span style={{ textAlign: "right" }}>{sel.document_titles.join(", ") || "None"}</span></div>
                  <div className="stat-line"><span className="muted">Meetings</span><span style={{ textAlign: "right" }}>{sel.meeting_titles.join(", ") || "None"}</span></div>
                  <div className="stat-line"><span className="muted">Open gaps</span><span className="num">{data?.gaps.filter((g) => g.topic === sel.name).length ?? 0}</span></div>
                </div>
              )}
            </div>
          ))}

        {tab === "Gaps" && (
          <div className="list">
            {!data?.gaps.length && <div className="empty">{data?.refreshedAt ? "No open gaps. Nice." : "Refresh the knowledge map to find gaps."}</div>}
            {data?.gaps.map((g) => (
              <div key={g.text} className="li" style={{ flexWrap: "wrap" }}>
                <Pill kind={gapKind[g.kind] ?? "info"}>{g.kind}</Pill>
                <div className="grow" style={{ minWidth: 220 }}>
                  <b>{g.text}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>Topic: {g.topic}{g.assignee ? ` · Assigned to ${g.assignee}` : ""}</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}><span className="faint">Suggested: </span>{g.suggestion}</div>
                </div>
                {canEdit && (
                  <div className="actions">
                    <select className="input" style={{ width: "auto", padding: "4px 8px", fontSize: 12.5 }} aria-label="Assign gap" value="" onChange={(e) => e.target.value && gapAction(g, "Open", e.target.value)}>
                      <option value="">Assign…</option>
                      {owners.map((p) => <option key={p}>{p}</option>)}
                      <option value={me.user.name}>Me</option>
                    </select>
                    <button className="btn small ghost" onClick={() => gapAction(g, "Resolved")}>Resolve</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "Action items" && (
          <>
            <div className="panel-h">
              <div className="seg">
                {["Open", "No owner", "Done", "All"].map((f) => (
                  <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
                ))}
              </div>
              <span className="muted">Collected from meetings automatically</span>
            </div>
            {!shown.length ? (
              <div className="empty">No action items here.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }} />
                      <th>Action item</th>
                      <th>Owner</th>
                      <th>Due</th>
                      <th>Status</th>
                      <th>From meeting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((a) => (
                      <tr key={a.id}>
                        <td><input type="checkbox" aria-label={`Done: ${a.text}`} disabled={!canEdit} checked={a.status === "Done"} onChange={(e) => updateAction(a, { status: e.target.checked ? "Done" : "Open" })} /></td>
                        <td style={a.status === "Done" ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}><b>{a.text}</b></td>
                        <td>
                          <input className="input" style={{ padding: "3px 8px", width: 150, borderColor: a.owner ? undefined : "var(--hand)" }} placeholder="Assign owner" defaultValue={a.owner ?? ""} disabled={!canEdit} aria-label="Owner" onBlur={(e) => e.target.value !== (a.owner ?? "") && updateAction(a, { owner: e.target.value })} />
                        </td>
                        <td className="num">{a.due ?? "—"}</td>
                        <td>
                          <select className="input" style={{ width: "auto", padding: "3px 6px" }} value={a.status} disabled={!canEdit} aria-label="Status" onChange={(e) => updateAction(a, { status: e.target.value })}>
                            {["Open", "In progress", "Done"].map((s) => <option key={s}>{s}</option>)}
                          </select>
                        </td>
                        <td className="muted">{a.meeting ?? "—"}{a.held_at ? ` · ${fmtDate(a.held_at)}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === "Decisions & facts" && (
          <>
            <div className="panel-h">
              <div className="seg">
                {[["decision", "Decisions"], ["requirement", "Requirements"], ["fact", "Facts"], ["risk", "Risks"], ["glossary", "Glossary"], ["question", "Questions"]].map(([k, l]) => (
                  <button key={k} aria-pressed={factTab === k} onClick={() => setFactTab(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="list">
              {!facts.length && <div className="empty">Nothing here yet. Import meetings to build memory.</div>}
              {facts.map((f) => (
                <div key={f.id} className="li">
                  <div className="grow">
                    <b>{f.text}</b>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {f.meeting ?? "Document"}{f.held_at ? ` · ${fmtDate(f.held_at)}` : ""}{f.who ? ` · ${f.who}` : ""}
                      {f.kind === "question" && (f.answered ? " · answered" : " · unanswered")}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
