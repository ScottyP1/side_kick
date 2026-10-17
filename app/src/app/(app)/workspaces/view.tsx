"use client";

/**
 * Workspaces (/workspaces): one workspace per client engagement, plus the Teams channels and chats linked to them.
 * Admins create workspaces. Admins, and Team Leads for the workspaces they lead, link Teams channels with the
 * code Sidekick shows in Teams, and choose per chat what Sidekick does there (meeting notes, tracking every
 * message, reminders; components/chat-settings.tsx).
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, Icon, Modal, Pill, Switch, useReportError, useToast } from "@/components/ui";
import { ChatSettingsModal, lastReminderText, type ChatSettings, type LastReminder } from "@/components/chat-settings";

type TeamsLink = {
  id: string; kind: string; name: string | null; guests: number; linked_at: string; last_seen_at: string; workspace_id: string; workspace: string;
  settings: ChatSettings; lastReminder: LastReminder; savedMessages: number;
};
type W = { id: string; name: string; code: string | null; color: string; docs: number; meetings: number; members: number; open_items: number; last_meeting: string | null };

export default function WorkspacesPage() {
  const { me, setWs, reload } = useApp();
  const toast = useToast();
  const [list, setList] = useState<W[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const [links, setLinks] = useState<TeamsLink[] | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkForm, setLinkForm] = useState({ code: "", ws: "", guests: false });
  const [linkError, setLinkError] = useState("");
  const [settingsFor, setSettingsFor] = useState<TeamsLink | null>(null);
  const reportError = useReportError();

  const load = useCallback(
    () =>
      Promise.all([
        api<{ workspaces: W[] }>("/api/workspaces").then((r) => setList(r.workspaces)),
        api<{ links: TeamsLink[] }>("/api/teams-links").then((r) => setLinks(r.links)),
      ]),
    [],
  );
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);

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

  const openLink = () => {
    setLinkForm({ code: "", ws: list?.[0]?.id ?? "", guests: false });
    setLinkError("");
    setLinkOpen(true);
  };

  const link = async () => {
    setLinkError("");
    try {
      const r = await api<{ name: string | null }>("/api/teams-links", { method: "POST", json: linkForm });
      setLinkOpen(false);
      await load();
      toast(`Linked “${r.name ?? "Teams chat"}”. Sidekick confirmed it in Teams.`);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "Couldn't link the channel.");
    }
  };

  const setGuests = async (l: TeamsLink, guests: boolean) => {
    try {
      await api("/api/teams-links", { method: "PATCH", json: { id: l.id, guests } });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update the channel.");
    }
  };

  const unlink = async (l: TeamsLink) => {
    if (!confirm(`Unlink “${l.name ?? "this chat"}” from ${l.workspace}? Sidekick will stop answering and posting there, and forget the messages it saved from it.`)) return;
    try {
      await api(`/api/teams-links?id=${encodeURIComponent(l.id)}`, { method: "DELETE" });
      await load();
      toast("Unlinked.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't unlink the channel.");
    }
  };

  // Org Owners/Admins and Team Leads link Teams chats (a Team Lead only sees, so only links, their workspaces).
  const manage = me.user.admin || Boolean(me.user.lead);
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
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <div>
            <h2>Teams channels and chats</h2>
            <span className="muted" style={{ fontSize: 12.5 }}>@Sidekick answers there from the linked workspace only. Per chat, choose whether it gets meeting notes, keeps track of every message and posts reminders.</span>
          </div>
          {manage && !!list?.length && (
            <button className="btn" onClick={openLink}>
              <Icon n="plus" />
              Link Teams channel
            </button>
          )}
        </div>
        {!links?.length ? (
          <div className="empty">
            <span>No Teams channels linked yet. Add Sidekick to a channel or chat in Teams and mention it: it replies with a link code to enter here.</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Channel or chat</th>
                  <th>Workspace</th>
                  <th>Client guests</th>
                  <th>Sidekick here</th>
                  <th>Linked</th>
                  <th>Last activity</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <b>{l.name ?? "Teams chat"}</b> <Pill nodot>{l.kind === "channel" ? "Channel" : l.kind === "groupChat" ? "Group chat" : "1:1 chat"}</Pill>
                    </td>
                    <td>{l.workspace}</td>
                    <td>
                      {manage ? (
                        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                          <Switch on={!!l.guests} onChange={(v) => setGuests(l, v)} label={`Client guests in ${l.name ?? "this chat"}`} />
                          <span className="muted" style={{ fontSize: 12.5 }}>{l.guests ? "Shareable sources only" : "Internal team"}</span>
                        </span>
                      ) : l.guests ? "Yes" : "No"}
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                        {l.settings.notes && <Pill nodot>Notes</Pill>}
                        {l.settings.track && <Pill kind="hand" nodot>Tracking messages</Pill>}
                        {l.settings.reminders && <Pill kind="good" nodot>Reminders {l.settings.time}</Pill>}
                        {!l.settings.notes && !l.settings.track && !l.settings.reminders && <span className="muted">Answers only</span>}
                      </span>
                      {l.settings.reminders && <div className="muted" style={{ fontSize: 12 }}>{lastReminderText(l.lastReminder)}</div>}
                    </td>
                    <td>{fmtDate(l.linked_at)}</td>
                    <td>{fmtDate(l.last_seen_at)}</td>
                    {manage && (
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button className="btn" onClick={() => setSettingsFor(l)} style={{ marginRight: 6 }}>Settings</button>
                        <button className="btn" onClick={() => unlink(l)}>Unlink</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {settingsFor && <ChatSettingsModal chat={settingsFor} onClose={() => setSettingsFor(null)} onSaved={() => load().catch(reportError)} />}
      {linkOpen && (
        <Modal
          title="Link a Teams channel or chat"
          onClose={() => setLinkOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setLinkOpen(false)}>Cancel</button>
              <button className="btn primary" disabled={!linkForm.code.trim() || !linkForm.ws} onClick={link}>Link</button>
            </>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>In Teams, add Sidekick to the channel or chat and mention it (for example “@Sidekick link”). It replies with an 8-character code.</p>
          <div className="field">
            <label htmlFor="lcode">Link code</label>
            <input id="lcode" className="input mono" placeholder="ABCD-2345" value={linkForm.code} onChange={(e) => setLinkForm({ ...linkForm, code: e.target.value })} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="lws">Workspace</label>
            <select id="lws" className="input" value={linkForm.ws} onChange={(e) => setLinkForm({ ...linkForm, ws: e.target.value })}>
              {list?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={linkForm.guests} onChange={(e) => setLinkForm({ ...linkForm, guests: e.target.checked })} />
            Client guests are in this channel (answer from Shareable sources only, and don&apos;t post notes from internal meetings)
          </label>
          {linkError && <p className="err">{linkError}</p>}
        </Modal>
      )}
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
