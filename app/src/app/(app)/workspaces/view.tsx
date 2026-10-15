"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, Icon, Modal, useToast } from "@/components/ui";

type W = { id: string; name: string; code: string | null; color: string; docs: number; meetings: number; members: number; open_items: number; last_meeting: string | null };

export default function WorkspacesPage() {
  const { me, setWs, reload } = useApp();
  const toast = useToast();
  const [list, setList] = useState<W[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => api<{ workspaces: W[] }>("/api/workspaces").then((r) => setList(r.workspaces)), []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setError("");
    try {
      const r = await api<{ id: string }>("/api/workspaces", { method: "POST", json: { name, code } });
      setOpen(false);
      setName("");
      setCode("");
      await reload();
      setWs(r.id);
      await load();
      toast(`Workspace “${name}” created. Add documents next.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the workspace.");
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspaces</div>
          <h1>One workspace per client engagement</h1>
          <p>Each workspace has its own documents, meetings, memory and members. Sidekick only searches the workspace you&apos;re in.</p>
        </div>
        {me.user.admin && (
          <div className="actions">
            <button className="btn primary" onClick={() => setOpen(true)}>
              <Icon n="plus" />
              New workspace
            </button>
          </div>
        )}
      </div>
      {list && !list.length && (
        <div className="panel">
          <div className="empty">
            <h2>No workspaces yet</h2>
            <span>Create one for each client engagement, like “Contoso – Cloud Migration”.</span>
            {me.user.admin && <button className="btn primary" onClick={() => setOpen(true)}>Create your first workspace</button>}
          </div>
        </div>
      )}
      <div className="grid g3">
        {list?.map((w) => (
          <Link key={w.id} className="ws-card" href="/knowledge" onClick={() => setWs(w.id)} style={{ textDecoration: "none" }}>
            <span className="mono faint">{w.code || "No code"}</span>
            <h3 style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="swatch" style={{ background: w.color }} />
              {w.name}
            </h3>
            <div className="grid" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 8, width: "100%" }}>
              {[["Docs", w.docs], ["Meetings", w.meetings], ["Members", w.members], ["Open items", w.open_items]].map(([l, v]) => (
                <div key={l as string}>
                  <div className="eyebrow">{l}</div>
                  <b className="num">{v}</b>
                </div>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>Last meeting: {fmtDate(w.last_meeting)}</span>
          </Link>
        ))}
      </div>
      {open && (
        <Modal
          title="New workspace"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn primary" disabled={!name.trim()} onClick={create}>Create workspace</button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="wname">Workspace name</label>
            <input id="wname" className="input" placeholder="e.g. Contoso – Cloud Migration" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="wcode">Engagement code (optional)</label>
            <input id="wcode" className="input mono" placeholder="ENG-2041" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          {error && <p className="err">{error}</p>}
        </Modal>
      )}
    </>
  );
}
