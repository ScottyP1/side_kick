"use client";

/**
 * A group's page (/workspaces/[id]): one client team (a "workspace" in the API) with tabs for
 * - **Overview**: a setup checklist (Team Lead, people, Teams chats, documents) and its counts;
 * - **People**: who is in the group; Org Owners/Admins and the group's Team Lead add people already in the
 *   organization and take Members/Viewers off it (/api/workspaces/:id/members);
 * - **Teams chats**: the chats assigned to the group, with their settings (notes, reminders, client guests;
 *   components/chat-settings.tsx), unassign, and assigning a chat with the code Sidekick shows in Teams;
 * - **Documents**: what Sidekick answers from, with a link to Knowledge & docs to upload;
 * - **Settings** (Org Owners/Admins): name, client, engagement code, delete.
 * Anyone in the group can open it; people outside it get "not found" (the workspace wall).
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, Icon, Modal, Pill, Switch, useReportError, useToast } from "@/components/ui";
import { ChatSettingsModal, lastReminderText, type ChatSettings, type LastReminder } from "@/components/chat-settings";
import { Avatar, groupHealth, PeoplePicker, type Group, type OrgPerson } from "@/components/groups";

type Member = { id: string; name: string; email?: string; role: string; microsoft: number };
type TeamsLink = {
  id: string; kind: string; name: string | null; guests: number; linked_at: string; last_seen_at: string; workspace_id: string; workspace: string;
  settings: ChatSettings; lastReminder: LastReminder; savedMessages: number;
};
type Doc = { id: string; name: string; audience: string; status: string; created_at: string; uploaded_by: string | null };
type Tab = "overview" | "people" | "chats" | "docs" | "settings";

export default function GroupView() {
  const { id } = useParams<{ id: string }>();
  const { me, setWs, reload } = useApp();
  const router = useRouter();
  const toast = useToast();
  const reportError = useReportError();
  const [group, setGroup] = useState<Group | null | undefined>(undefined);
  const [members, setMembers] = useState<Member[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [links, setLinks] = useState<TeamsLink[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [tab, setTab] = useState<Tab>("overview");

  // Loads the group (from the caller's list, so the workspace wall applies), then its people, chats and documents.
  const load = useCallback(
    () =>
      api<{ workspaces: Group[] }>("/api/workspaces").then((all) => {
        const g = all.workspaces.find((w) => w.id === id) ?? null;
        setGroup(g);
        if (!g) return;
        return Promise.all([
          api<{ members: Member[]; canManage: boolean }>(`/api/workspaces/${encodeURIComponent(id)}/members`).then((m) => {
            setMembers(m.members);
            setCanManage(m.canManage);
          }),
          api<{ links: TeamsLink[] }>("/api/teams-links").then((l) => setLinks(l.links.filter((x) => x.workspace_id === id))),
          api<{ docs: Doc[] }>(`/api/docs?ws=${encodeURIComponent(id)}`).then((d) => setDocs(d.docs)),
        ]).then(() => undefined);
      }),
    [id],
  );
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);

  if (group === undefined) return <span className="muted">Loading group…</span>;
  if (group === null) {
    return <div className="panel"><div className="empty"><h2>Group not found</h2><span>It may have been deleted, or you&apos;re not in it.</span><Link className="btn" href="/workspaces">Back to Groups</Link></div></div>;
  }

  const [k, label, why] = groupHealth(group);
  const tb = (v: Tab, text: string, count?: number) => (
    <button role="tab" aria-selected={tab === v} onClick={() => setTab(v)}>{text}{count !== undefined && <span className="muted"> {count}</span>}</button>
  );
  const openDocs = () => {
    setWs(group.id);
    router.push("/knowledge");
  };

  return (
    <>
      <div className="crumbs"><Link href="/workspaces">Groups</Link>›<span>{group.client || group.name}</span></div>
      <div className="page-head">
        <div>
          {group.client && <div className="eyebrow">{group.client}</div>}
          <h1>{group.name}</h1>
          <p>{group.leads.some((l) => l.id === me.user.id) ? "You lead this group. Add your people, assign your team's Teams chats and keep the key documents up to date." : "One client team: its people, Teams chats and documents. Sidekick only answers from what's in this group."}</p>
        </div>
        <div className="actions"><span title={why}><Pill kind={k}>{label}</Pill></span>{group.code && <span className="tag mono">{group.code}</span>}</div>
      </div>
      <div className="tabs" role="tablist">
        {tb("overview", "Overview")}
        {tb("people", "People", members.length)}
        {tb("chats", "Teams chats", links.length)}
        {tb("docs", "Documents", docs.length)}
        {me.user.admin && tb("settings", "Settings")}
      </div>
      {tab === "overview" && <Overview group={group} members={members} links={links} docs={docs} go={setTab} openDocs={openDocs} />}
      {tab === "people" && <People group={group} members={members} canManage={canManage} reload={load} />}
      {tab === "chats" && <Chats group={group} links={links} canManage={canManage} reload={load} />}
      {tab === "docs" && <Docs docs={docs} openDocs={openDocs} />}
      {tab === "settings" && me.user.admin && (
        <Settings group={group} onSaved={async () => { await reload(); await load(); toast("Group updated."); }} onDeleted={async () => { await reload(); router.push("/workspaces"); }} />
      )}
    </>
  );
}

/** The setup checklist and this week's counts. */
function Overview({ group, members, links, docs, go, openDocs }: { group: Group; members: Member[]; links: TeamsLink[]; docs: Doc[]; go: (t: Tab) => void; openDocs: () => void }) {
  const steps: [string, boolean, React.ReactNode][] = [
    ["Pick a Team Lead", group.leads.length > 0, <button key="l" className="btn small" onClick={() => go("people")}>People</button>],
    ["Add the team", members.filter((m) => m.role === "Member" || m.role === "Viewer").length > 0, <button key="p" className="btn small primary" onClick={() => go("people")}>Add people</button>],
    ["Assign the team's Teams chats", links.length > 0, <button key="c" className="btn small primary" onClick={() => go("chats")}>Teams chats</button>],
    ["Upload the key documents", docs.length > 0, <button key="d" className="btn small primary" onClick={openDocs}>Upload</button>],
  ];
  const done = steps.filter((s) => s[1]).length;
  return (
    <div className="grid g-main">
      <div className="panel">
        <div className="panel-h"><h2>Group setup</h2><span className="muted" style={{ fontSize: 12.5 }}>{done} of {steps.length} done</span></div>
        <div className="panel-b">
          <div className="meter" style={{ marginBottom: 12 }}><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
          <ul className="check-list">
            {steps.map(([s, ok, action]) => (
              <li key={s}>
                <span className={`ck${ok ? " ok" : ""}`}>{ok && <Icon n="check" />}</span>
                {ok ? <span className="muted">{s}</span> : <><b style={{ fontWeight: 500 }}>{s}</b><span style={{ flex: 1 }} />{action}</>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>In this group</h2></div>
        <div className="panel-b">
          {[["People", group.members], ["Teams chats", group.chats], ["Documents", group.docs], ["Meetings", group.meetings], ["Open action items", group.open_items], ["Overdue", group.overdue]].map(([l, v]) => (
            <div key={l as string} className="stat-line"><span className="muted">{l}</span><b className="num">{v}</b></div>
          ))}
          <div className="stat-line"><span className="muted">Last meeting</span><span>{fmtDate(group.last_meeting)}</span></div>
        </div>
      </div>
    </div>
  );
}

/** Who is in the group; managers add people already in the organization and take Members/Viewers off. */
function People({ group, members, canManage, reload }: { group: Group; members: Member[]; canManage: boolean; reload: () => Promise<void> }) {
  const { me } = useApp();
  const toast = useToast();
  const reportError = useReportError();
  const [adding, setAdding] = useState(false);
  const [org, setOrg] = useState<OrgPerson[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const lead = me.user.lead && !me.user.admin;

  const open = () => {
    setPicked(new Set());
    setQ("");
    setError("");
    setAdding(true);
    api<{ users: OrgPerson[] }>("/api/users").then((r) => setOrg(r.users)).catch(reportError);
  };
  const inGroup = new Set(members.map((m) => m.id));
  // A Team Lead can add Members and Viewers only (the server checks this too).
  const candidates = (org ?? []).filter((p) => !inGroup.has(p.id) && (!lead || p.role === "Member" || p.role === "Viewer"));

  const add = async () => {
    setError("");
    try {
      const r = await api<{ added: number }>(`/api/workspaces/${encodeURIComponent(group.id)}/members`, { method: "POST", json: { users: [...picked] } });
      setAdding(false);
      await reload();
      toast(`Added ${r.added} ${r.added === 1 ? "person" : "people"} to ${group.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add those people.");
    }
  };
  const remove = async (m: Member) => {
    if (!confirm(`Take ${m.name} off ${group.name}? Their account and other groups stay as they are.`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(group.id)}/members?user=${encodeURIComponent(m.id)}`, { method: "DELETE" });
      await reload();
      toast(`${m.name} was taken off ${group.name}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't take that person off the group.");
    }
  };
  // Admins may take anyone off; a Team Lead only Members and Viewers (the server checks this too).
  const removable = (m: Member) => canManage && (me.user.admin || m.role === "Member" || m.role === "Viewer");

  return (
    <>
      {canManage && (
        <div className="row">
          <p className="muted" style={{ flex: 1, minWidth: 240, margin: 0 }}>Add people who are already in your organization. To add someone new, use <Link href="/users">Users &amp; access</Link>{lead ? " (they join as Member or Viewer)" : ""}.</p>
          <button className="btn primary" onClick={open}><Icon n="plus" />Add people</button>
        </div>
      )}
      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Person</th><th>Role</th><th>Signs in with</th>{canManage && <th />}</tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td><div className="row" style={{ flexWrap: "nowrap" }}><Avatar name={m.name} /><div><div>{m.name}</div>{m.email && <div className="muted" style={{ fontSize: 12.5 }}>{m.email}</div>}</div></div></td>
                  <td>{m.role === "Team Lead" ? <Pill kind="accent" nodot>Team Lead</Pill> : m.role}</td>
                  <td className="muted">{m.microsoft ? "Microsoft" : "Password"}</td>
                  {canManage && <td style={{ textAlign: "right" }}>{removable(m) && <button className="btn small ghost" onClick={() => remove(m)}>Take off group</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {adding && (
        <Modal title={`Add people to ${group.name}`} onClose={() => setAdding(false)} footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={!picked.size} onClick={add}>Add {picked.size || ""}</button></>}>
          {org === null ? <span className="muted">Loading people…</span> : <PeoplePicker people={candidates} picked={picked} onChange={setPicked} query={q} onQuery={setQ} />}
          {error && <p className="err">{error}</p>}
        </Modal>
      )}
    </>
  );
}

/** The Teams chats assigned to this group, their settings, and assigning one with a code. */
function Chats({ group, links, canManage, reload }: { group: Group; links: TeamsLink[]; canManage: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  const reportError = useReportError();
  const [settingsFor, setSettingsFor] = useState<TeamsLink | null>(null);
  const [linking, setLinking] = useState(false);
  const [form, setForm] = useState({ code: "", guests: false });
  const [error, setError] = useState("");

  const link = async () => {
    setError("");
    try {
      const r = await api<{ name: string | null }>("/api/teams-links", { method: "POST", json: { ...form, ws: group.id } });
      setLinking(false);
      await reload();
      toast(`Assigned “${r.name ?? "Teams chat"}” to ${group.name}. Sidekick confirmed it in Teams.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't assign that chat.");
    }
  };
  const setGuests = async (l: TeamsLink, guests: boolean) => {
    try {
      await api("/api/teams-links", { method: "PATCH", json: { id: l.id, guests } });
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update that chat.");
    }
  };
  const unlink = async (l: TeamsLink) => {
    if (!confirm(`Unassign “${l.name ?? "this chat"}” from ${group.name}? Sidekick stops answering and posting there, and forgets the messages it saved from it.`)) return;
    try {
      await api(`/api/teams-links?id=${encodeURIComponent(l.id)}`, { method: "DELETE" });
      await reload();
      toast("Unassigned.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't unassign that chat.");
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          <div>
            <h2>Teams chats</h2>
            <span className="muted" style={{ fontSize: 12.5 }}>In these chats Sidekick answers from {group.name} only. Choose per chat whether it posts meeting notes and reminders.</span>
          </div>
          {canManage && <button className="btn" onClick={() => { setForm({ code: "", guests: false }); setError(""); setLinking(true); }}><Icon n="plus" />Assign a chat</button>}
        </div>
        {!links.length ? (
          <div className="empty"><span>{canManage ? "No chats yet. Add Sidekick to your team's Teams chat, mention it with “link”, then assign the chat here with the code it shows." : "No chats yet. The group's Team Lead assigns Teams chats here."}</span></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Chat</th><th>Client guests</th><th>Sidekick here</th><th>Assigned</th><th>Last activity</th>{canManage && <th />}</tr></thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td><b>{l.name ?? "Teams chat"}</b> <Pill nodot>{l.kind === "channel" ? "Channel" : l.kind === "groupChat" ? "Group chat" : "1:1 chat"}</Pill></td>
                    <td>
                      {canManage ? (
                        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                          <Switch on={!!l.guests} onChange={(v) => setGuests(l, v)} label={`Client guests in ${l.name ?? "this chat"}`} />
                          <span className="muted" style={{ fontSize: 12.5 }}>{l.guests ? "Shareable sources only" : "Internal team"}</span>
                        </span>
                      ) : l.guests ? "Yes" : "No"}
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                        {l.settings.notes && <Pill nodot>Notes</Pill>}
                        {l.settings.track && <Pill kind="hand" nodot>Reads every message</Pill>}
                        {l.settings.reminders && <Pill kind="good" nodot>Reminders {l.settings.time}</Pill>}
                        {!l.settings.notes && !l.settings.track && !l.settings.reminders && <span className="muted">Answers only</span>}
                      </span>
                      {l.settings.reminders && <div className="muted" style={{ fontSize: 12 }}>{lastReminderText(l.lastReminder)}</div>}
                    </td>
                    <td>{fmtDate(l.linked_at)}</td>
                    <td>{fmtDate(l.last_seen_at)}</td>
                    {canManage && (
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button className="btn small" onClick={() => setSettingsFor(l)} style={{ marginRight: 6 }}>Settings</button>
                        <button className="btn small" onClick={() => unlink(l)}>Unassign</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {settingsFor && <ChatSettingsModal chat={settingsFor} onClose={() => setSettingsFor(null)} onSaved={() => reload().catch(reportError)} />}
      {linking && (
        <Modal title={`Assign a Teams chat to ${group.name}`} onClose={() => setLinking(false)} footer={<><button className="btn" onClick={() => setLinking(false)}>Cancel</button><button className="btn primary" disabled={!form.code.trim()} onClick={link}>Assign</button></>}>
          <p className="muted" style={{ marginTop: 0 }}>In Teams, add Sidekick to the chat or channel and mention it with “link”. It replies with an 8-character code.</p>
          <div className="field">
            <label htmlFor="lcode">Code from Teams</label>
            <input id="lcode" className="input mono" placeholder="ABCD-2345" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoFocus />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={form.guests} onChange={(e) => setForm({ ...form, guests: e.target.checked })} />
            People from the client are in this chat (answer from Shareable documents only, and don&apos;t post notes from internal meetings)
          </label>
          {error && <p className="err">{error}</p>}
        </Modal>
      )}
    </>
  );
}

/** The group's documents; uploading and managing them stays on Knowledge & docs. */
function Docs({ docs, openDocs }: { docs: Doc[]; openDocs: () => void }) {
  return (
    <div className="panel">
      <div className="panel-h">
        <div><h2>Documents</h2><span className="muted" style={{ fontSize: 12.5 }}>What Sidekick answers from in this group. Shareable documents may be used in chats with the client.</span></div>
        <button className="btn primary" onClick={openDocs}><Icon n="upload" />Upload or manage</button>
      </div>
      {!docs.length ? (
        <div className="empty"><span>No documents yet. Upload specs, plans and runbooks so Sidekick can answer questions about this client.</span></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Document</th><th>Who can see it</th><th>Uploaded</th><th>Status</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td><b style={{ fontWeight: 500 }}>{d.name}</b>{d.uploaded_by && <div className="muted" style={{ fontSize: 12.5 }}>by {d.uploaded_by}</div>}</td>
                  <td>{d.audience}</td>
                  <td>{fmtDate(d.created_at)}</td>
                  <td>{d.status === "Ready" ? <Pill kind="good">Ready</Pill> : d.status === "Failed" ? <Pill kind="bad">Failed</Pill> : <Pill kind="info">{d.status}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Name, client and engagement code, and deleting the group (Org Owners and Admins). */
function Settings({ group, onSaved, onDeleted }: { group: Group; onSaved: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: group.name, client: group.client ?? "", code: group.code ?? "" });
  const [error, setError] = useState("");
  const path = `/api/workspaces/${encodeURIComponent(group.id)}`;

  const save = async () => {
    setError("");
    try {
      await api(path, { method: "PATCH", json: form });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the group.");
    }
  };
  const remove = async () => {
    try {
      const { contents: c } = await api<{ contents: { documents: number; meetings: number; actionItems: number; questions: number; chats: number } }>(path);
      const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
      const what = [n(c.documents, "document"), n(c.meetings, "meeting"), n(c.actionItems, "action item"), n(c.questions, "asked question")].join(", ");
      const chats = c.chats ? ` ${n(c.chats, "Teams chat")} will be unassigned.` : "";
      if (!confirm(`Delete the group “${group.name}”? This permanently deletes ${what}, its knowledge map, guardrail rules, saved Teams messages and reminders.${chats} The audit log and usage records are kept. This can't be undone.`)) return;
      await api(path, { method: "DELETE" });
      toast(`Group “${group.name}” deleted.`);
      await onDeleted();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete the group.");
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="panel">
      <form className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560 }} onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) save(); }}>
        <div className="field"><label htmlFor="s-name">Group name</label><input id="s-name" className="input" value={form.name} onChange={set("name")} /></div>
        <div className="field"><label htmlFor="s-client">Client</label><input id="s-client" className="input" value={form.client} onChange={set("client")} placeholder="e.g. Northwind Bank" /></div>
        <div className="field"><label htmlFor="s-code">Engagement code (optional)</label><input id="s-code" className="input mono" value={form.code} onChange={set("code")} placeholder="NWB-2026-014" /></div>
        {error && <p className="err" style={{ margin: 0 }}>{error}</p>}
        <div className="row"><button type="submit" className="btn primary" disabled={!form.name.trim()}>Save</button><span style={{ flex: 1 }} /><button type="button" className="btn danger" onClick={remove}>Delete group…</button></div>
      </form>
    </div>
  );
}
