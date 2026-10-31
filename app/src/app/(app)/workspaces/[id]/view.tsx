"use client";

/**
 * A group's page (/workspaces/[id]): one client team (a "workspace" in the API) with tabs for
 * - **Overview**: what the watchers noticed in this group (components/findings.tsx), a setup checklist (Team Lead,
 *   people, Teams chats, documents) and its counts; a **Sources** line for everyone in the group (which connected
 *   tools feed it, with their last sync: GET /api/workspaces/:id/sources), and for the group's Team Lead and Org
 *   Owners/Admins a **Last 30 days** card (questions, answers, meetings, documents, share of the organization's AI
 *   use; no prices: GET /api/workspaces/:id/usage);
 * - **People**: who is in the group; Org Owners/Admins and the group's Team Lead add people already in the
 *   organization and take Members/Viewers off it (/api/workspaces/:id/members);
 * - **Teams chats**: **Meeting notes go to** (which chats get the group's meeting notes: one, several, or none; the
 *   group's Team Lead and Org Owners/Admins choose, everyone else sees it read-only; GET/PUT
 *   /api/workspaces/:id/notes-chats, lib/notes-chats.ts; "Send test message" per chat: POST …/notes-chats/test), then
 *   **Transcription reminders** (on/off for "Turn on transcription?" in the group's calls: GET/PUT
 *   /api/workspaces/:id/call-nudge, lib/call-nudge.ts), **Live in meetings** (Enterprise: Sidekick joins the group's
 *   Teams meetings live; off / when asked / every group meeting, latest sessions, Stop: /api/workspaces/:id/live,
 *   lib/live-meetings/), then
 *   the chats assigned to the group with their settings (reminders, tracking, client guests;
 *   components/chat-settings.tsx), unassign, and **Assign a chat**: in an organization tied to its Microsoft
 *   tenant, the chats waiting to be assigned (name, who added Sidekick and when, who's in it; GET
 *   /api/teams-links?members=1), with the link code only under "Linking a chat from another organization?";
 *   otherwise the code Sidekick shows in Teams. Opening the page at `#chats` (the "Pick the notes chat" finding)
 *   starts on this tab;
 * - **Documents**: what Sidekick answers from, with a link to Knowledge & docs to upload;
 * - **Settings** (Org Owners/Admins): name, client, engagement code, **Export** (zip of everything in it),
 *   **End this group** (engagement over: read-only now, deleted on a date, with a deletion certificate;
 *   lib/rolloff.ts) or cancel the ending, and delete now.
 * An ending group shows a banner with its deletion date on every tab.
 * Anyone in the group can open it; people outside it get "not found" (the workspace wall).
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { GROUP_DEFAULT_DAYS, MAX_ROLLOFF_DAYS, MIN_GROUP_DAYS } from "@/lib/rolloff-policy";
import { api, fmtDate, Icon, Modal, Pill, Spinner, Switch, useReportError, useToast } from "@/components/ui";
import { ChatSettingsModal, lastReminderText, type ChatSettings, type LastReminder } from "@/components/chat-settings";
import { Avatar, groupHealth, PeoplePicker, type Group, type OrgPerson } from "@/components/groups";
import { BRAND } from "@/lib/brand";
import { VoicePicker } from "@/components/voice-picker";
import { ANSWER_LABEL, BOT_NAME, LIVE_MODE_LABEL, LIVE_MODES, VOICE_LABEL, type LiveMode, type LiveSettings } from "@/lib/live-meetings/rules";
import { FindingRows, useFindings } from "@/components/findings";

type Member = { id: string; name: string; email?: string; role: string; microsoft: number };
type TeamsLink = {
  id: string; kind: string; name: string | null; guests: number; linked_at: string; last_seen_at: string; workspace_id: string; workspace: string;
  settings: ChatSettings; lastReminder: LastReminder; savedMessages: number;
};
/** A chat waiting to be assigned, as GET /api/teams-links?members=1 returns it (`members`: names from Teams, or null). */
type WaitingChat = { id: string; kind: string; name: string | null; added_by: string | null; created_at: string; waiting_since: string | null; leaves_at: string; members?: string[] | null };
/** "Meeting notes go to" for this group, as GET /api/workspaces/:id/notes-chats returns it (lib/notes-chats.ts `NotesPlan`). */
type NotesPlan = {
  mode: "chosen" | "none" | "unset"; chosenBy: string | null; chosenAt: string | null;
  chats: { id: string; name: string | null; kind: string; guests: number; member_count: number | null; last_seen_at: string | null }[];
  targets: string[]; defaultId: string | null; needsChoice: boolean; canManage: boolean;
  last: { title: string; held_at: string; chats: string[] } | null;
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
  const [picker, setPicker] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [notes, setNotes] = useState<NotesPlan | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  // A link to `#chats` (e.g. the "Pick the notes chat" finding) opens the Teams chats tab.
  useEffect(() => {
    if (window.location.hash === "#chats") setTab("chats");
  }, []);

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
          api<{ links: TeamsLink[]; picker?: boolean }>("/api/teams-links").then((l) => {
            setLinks(l.links.filter((x) => x.workspace_id === id));
            setPicker(!!l.picker);
          }),
          api<{ docs: Doc[] }>(`/api/docs?ws=${encodeURIComponent(id)}`).then((d) => setDocs(d.docs)),
          api<NotesPlan>(`/api/workspaces/${encodeURIComponent(id)}/notes-chats`).then(setNotes),
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
          <p>{group.leads.some((l) => l.id === me.user.id) ? "You lead this group. Add your people, assign your team's Teams chats and keep the key documents up to date." : `One client team: its people, Teams chats and documents. ${BRAND.name} only answers from what's in this group.`}</p>
        </div>
        <div className="actions"><span title={why}><Pill kind={k}>{label}</Pill></span>{group.code && <span className="tag mono">{group.code}</span>}</div>
      </div>
      {group.ending && (
        <div className="callout bad" style={{ marginBottom: 14 }}>
          <span>This group is ending: it&apos;s read-only and everything in it will be deleted on <b>{fmtDate(group.ending.deleteOn)}</b>.{me.user.admin ? " Download it or cancel the ending on the Settings tab." : " Ask an Org Owner or Org Admin if you need anything from it."}</span>
        </div>
      )}
      <div className="tabs" role="tablist">
        {tb("overview", "Overview")}
        {tb("people", "People", members.length)}
        {tb("chats", "Teams chats", links.length)}
        {tb("docs", "Documents", docs.length)}
        {me.user.admin && tb("settings", "Settings")}
      </div>
      {tab === "overview" && <Sources id={group.id} />}
      {tab === "overview" && <GroupFindings id={group.id} />}
      {tab === "overview" && canManage && <Activity id={group.id} />}
      {tab === "overview" && <Overview group={group} members={members} links={links} docs={docs} go={setTab} openDocs={openDocs} />}
      {tab === "people" && <People group={group} members={members} canManage={canManage} reload={load} />}
      {tab === "chats" && <Chats group={group} links={links} notes={notes} canManage={canManage} picker={picker} reload={load} />}
      {tab === "docs" && <Docs docs={docs} openDocs={openDocs} />}
      {tab === "settings" && me.user.admin && (
        <Settings group={group} onSaved={async () => { await reload(); await load(); toast("Group updated."); }} onChanged={async () => { await reload(); await load(); }} onDeleted={async () => { await reload(); router.push("/workspaces"); }} />
      )}
    </>
  );
}

/** "Needs attention": what the watchers found in this group that this person may see (nothing shown when there's none). */
function GroupFindings({ id }: { id: string }) {
  const { findings, reload } = useFindings(id);
  if (!findings?.length) return null;
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h2>Needs attention</h2><Pill kind="warn">{findings.length}</Pill></div>
      <div className="list"><FindingRows findings={findings} reload={reload} here={`/workspaces/${id}`} /></div>
    </div>
  );
}

type Source = { tool: string; name: string; lastSync: string | null; working: boolean };

/** One quiet line: which connected tools feed this group (nothing shown when none do). Read-only, for everyone in it. */
function Sources({ id }: { id: string }) {
  const reportError = useReportError();
  const [sources, setSources] = useState<Source[] | null>(null);
  useEffect(() => {
    api<{ sources: Source[] }>(`/api/workspaces/${encodeURIComponent(id)}/sources`).then((r) => setSources(r.sources)).catch(reportError);
  }, [id, reportError]);
  if (!sources?.length) return null;
  return (
    <p className="muted" style={{ margin: "0 0 14px" }} data-testid="group-sources">
      <b>Sources:</b>{" "}
      {sources.map((x, i) => (
        <span key={`${x.tool}-${x.name}`}>
          {i > 0 && " · "}
          {x.tool} ({x.name}){!x.working ? ", not syncing" : x.lastSync ? `, synced ${fmtDate(x.lastSync)}` : ""}
        </span>
      ))}
    </p>
  );
}

type GroupActivity = { days: number; questions: number; answered: number; meetings: number; documents: number; aiSharePct: number | null };

/** The group's last 30 days, for its Team Lead and Org Owners/Admins (the server checks the same). No prices. */
function Activity({ id }: { id: string }) {
  const reportError = useReportError();
  const [a, setA] = useState<GroupActivity | null>(null);
  useEffect(() => {
    api<{ activity: GroupActivity }>(`/api/workspaces/${encodeURIComponent(id)}/usage`).then((r) => setA(r.activity)).catch(reportError);
  }, [id, reportError]);
  if (!a) return null;
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h2>Last {a.days} days</h2><span className="muted" style={{ fontSize: 12.5 }}>This group only</span></div>
      <div className="panel-b">
        {[["Questions asked", a.questions], ["Answered with sources", a.answered], ["Meetings captured", a.meetings], ["Documents added", a.documents]].map(([l, v]) => (
          <div key={l as string} className="stat-line"><span className="muted">{l}</span><b className="num">{v}</b></div>
        ))}
        <div className="stat-line"><span className="muted">Share of your organization&apos;s AI use</span><b className="num">{a.aiSharePct === null ? "None yet" : `${a.aiSharePct}%`}</b></div>
        {a.aiSharePct !== null && <div className="meter" aria-hidden="true"><span style={{ width: `${Math.min(100, a.aiSharePct)}%` }} /></div>}
      </div>
    </div>
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
    // The server lists only people not in the group that the caller may add (Members and Viewers for a Team Lead).
    api<{ candidates: OrgPerson[] }>(`/api/workspaces/${encodeURIComponent(group.id)}/members?candidates=1`).then((r) => setOrg(r.candidates)).catch(reportError);
  };
  const inGroup = new Set(members.map((m) => m.id));
  const candidates = (org ?? []).filter((p) => !inGroup.has(p.id));

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

/** From this many linked chats on, the picker gets a search box and shows each chat's member count and last activity. */
const NOTES_SEARCH_FROM = 6;

/**
 * "Meeting notes go to": which of the group's chats get its meeting notes. The group's Team Lead and Org Owners/Admins
 * tick one chat (usual) or several, or "Don't post notes in Teams"; everyone else sees the same list read-only. Chats
 * with client guests are marked: only notes of meetings the client attended go there, internal meetings' never do.
 * While nobody has chosen, notes go to one default chat and a 2+ chat group shows "Pick which chat…".
 * Only this group's linked chats are ever listed (never anyone's other Teams chats). Managers also get "Send test
 * message" per chat (a small card in that chat; once per chat per minute). With 6+ chats there's a search box, and each
 * chat shows its member count and last activity so similar chats are easy to tell apart.
 */
function NotesGoTo({ group, plan, canManage, reload }: { group: Group; plan: NotesPlan; canManage: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  // Starts from the saved choice; the parent re-mounts this (its `key`) after a save or reload.
  const [sel, setSel] = useState(() => ({ none: plan.mode === "none", ids: plan.mode === "chosen" ? plan.targets : [] }));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const shown = sel.none ? [] : plan.mode === "unset" && !sel.ids.length ? plan.targets : sel.ids;
  const changed = sel.none !== (plan.mode === "none") || (!sel.none && (plan.mode !== "chosen" || sel.ids.slice().sort().join() !== plan.targets.slice().sort().join()));
  const name = (id: string) => plan.chats.find((c) => c.id === id)?.name ?? "Teams chat";
  const many = plan.chats.length >= NOTES_SEARCH_FROM;
  const needle = q.trim().toLowerCase();
  // Ticked chats stay visible while searching, so a choice never disappears from view.
  const listed = many && needle ? plan.chats.filter((c) => shown.includes(c.id) || (c.name ?? "teams chat").toLowerCase().includes(needle)) : plan.chats;
  const toggle = (id: string, on: boolean) => {
    const base = plan.mode === "unset" && !sel.ids.length && !sel.none ? plan.targets : sel.ids;
    setSel({ none: false, ids: on ? [...new Set([...base, id])] : base.filter((x) => x !== id) });
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/workspaces/${encodeURIComponent(group.id)}/notes-chats`, { method: "PUT", json: sel.none ? { none: true } : { chatIds: shown } });
      await reload();
      toast(sel.none ? "Meeting notes now stay in the portal." : `Meeting notes now go to ${shown.map(name).join(", ")}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save where meeting notes go.");
    } finally {
      setBusy(false);
    }
  };
  const sendTest = async (id: string) => {
    setTesting(id);
    setError("");
    try {
      await api(`/api/workspaces/${encodeURIComponent(group.id)}/notes-chats/test`, { method: "POST", json: { chatId: id } });
      toast(`Test message posted in ${name(id)}. Check it in Teams.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Couldn't post a test message in ${name(id)}.`);
    } finally {
      setTesting(null);
    }
  };
  const status =
    plan.mode === "none" ? "Not posted in Teams: notes stay in the portal."
    : plan.mode === "unset" ? (plan.targets.length ? `Nobody chose yet, so notes go to ${name(plan.targets[0])} only.` : "Nobody chose yet.")
    : `Notes go to ${plan.targets.map(name).join(", ")}.`;
  const meta = (c: NotesPlan["chats"][number]) =>
    [c.member_count != null ? `${c.member_count} ${c.member_count === 1 ? "member" : "members"}` : null, c.last_seen_at ? `last activity ${fmtDate(c.last_seen_at)}` : null].filter(Boolean).join(" · ");
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-h">
        <div>
          <h2>Meeting notes go to</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {status}
            {plan.mode !== "unset" && plan.chosenBy ? ` Chosen by ${plan.chosenBy}${plan.chosenAt ? ` on ${fmtDate(plan.chosenAt)}` : ""}.` : ""}
            {!canManage && " The group's Team Lead chooses this."}
          </span>
        </div>
        {plan.needsChoice && <Pill kind="hand" nodot>Needs a choice</Pill>}
      </div>
      <div className="panel-b">
        {many && (
          <input className="input" type="search" style={{ marginBottom: 12, maxWidth: 360 }} placeholder={`Search ${plan.chats.length} chats by name`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search this group's chats" />
        )}
        <div className="notes-opts" role="group" aria-label="Chats that get meeting notes">
          {listed.map((c) => (
            <div key={c.id} className={`notes-opt${shown.includes(c.id) ? " on" : ""}`}>
              <label>
                <input type="checkbox" disabled={!canManage || busy} checked={shown.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                <span style={{ minWidth: 0 }}>
                  <b>{c.name ?? "Teams chat"}</b>
                  {plan.mode === "unset" && c.id === plan.defaultId && <> <Pill nodot>Default</Pill></>}
                  {c.guests ? <> <Pill kind="warn" nodot>Client guests</Pill></> : null}
                  {many && meta(c) && <span className="meta">{meta(c)}</span>}
                  {c.guests ? <span className="meta">Internal meetings&apos; notes never go here: only notes of meetings the client attended.</span> : null}
                </span>
              </label>
              {canManage && (
                <button className="btn small" disabled={testing !== null} onClick={() => sendTest(c.id)} title={`Post a short test card in ${c.name ?? "this chat"}`}>
                  {testing === c.id ? "Sending…" : "Send test message"}
                </button>
              )}
            </div>
          ))}
          {many && needle && !listed.length && <p className="muted" style={{ margin: 0 }}>No chat in this group matches “{q.trim()}”.</p>}
          <div className={`notes-opt${sel.none ? " on" : ""}`}>
            <label>
              <input type="checkbox" disabled={!canManage || busy} checked={sel.none} onChange={(e) => setSel({ none: e.target.checked, ids: [] })} />
              <span>Don&apos;t post notes in Teams <span className="meta" style={{ display: "inline" }}>(they stay in {BRAND.name}&apos;s Meetings page)</span></span>
            </label>
          </div>
        </div>
        {error && <p className="err" style={{ marginBottom: 0 }}>{error}</p>}
      </div>
      {(plan.last || canManage) && (
        <div className="panel-f">
          <span className="muted" style={{ fontSize: 12.5, flex: "1 1 240px" }}>
            {plan.last ? <>Latest: notes for “{plan.last.title}” ({fmtDate(plan.last.held_at)}) were posted to {plan.last.chats.join(", ") || "no chat"}.</> : canManage ? <>Tip: in a chat, the Team Lead can also say “@{BRAND.name} post meeting notes here”.</> : null}
          </span>
          {canManage && (
            <button className="btn primary" disabled={busy || !changed || (!sel.none && !shown.length)} onClick={save}>
              {plan.mode === "unset" ? "Save choice" : "Save"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The group's "Turn on transcription" reminder, as GET /api/workspaces/:id/call-nudge returns it (lib/call-nudge.ts). */
type CallNudge = {
  enabled: boolean; changedBy: string | null; changedAt: string | null; autoNotes: boolean;
  unreadable: string[]; last: { chat: string; at: string } | null; scheduledProblem: string | null; canManage: boolean;
};

/**
 * "Transcription reminders": when a call starts in one of the group's Teams chats, or one of the group's scheduled Teams
 * meetings starts, and nobody has started transcription after about two minutes, Sidekick posts one short reminder
 * (lib/call-nudge.ts, lib/meeting-nudge.ts). On by default; the group's
 * Team Lead and Org Owners/Admins switch it (PUT /api/workspaces/:id/call-nudge, audited), everyone else sees it
 * read-only. Also says when it can't run (automatic notes off), which chats Microsoft won't let Sidekick read, and why
 * it can't see scheduled meetings (`scheduledProblem`).
 */
function CallReminders({ group }: { group: Group }) {
  const toast = useToast();
  const reportError = useReportError();
  const [st, setSt] = useState<CallNudge | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/workspaces/${encodeURIComponent(group.id)}/call-nudge`;
  useEffect(() => {
    api<CallNudge>(url).then(setSt).catch(reportError);
  }, [url, reportError]);
  if (!st) return null;
  const flip = async (on: boolean) => {
    setBusy(true);
    try {
      setSt(await api<CallNudge>(url, { method: "PUT", json: { enabled: on } }));
      toast(on ? "Transcription reminders are on." : "Transcription reminders are off.");
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-h">
        <div>
          <h2>Transcription reminders</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Notes need a transcript. When a call starts in one of this group&apos;s Teams chats, or one of the group&apos;s scheduled Teams meetings starts, and nobody has started transcription after about 2 minutes, {BRAND.name} posts one short reminder (in the meeting&apos;s chat when it&apos;s there, otherwise in the group&apos;s notes chat).
            {st.changedBy ? ` ${st.enabled ? "Turned on" : "Turned off"} by ${st.changedBy}${st.changedAt ? ` on ${fmtDate(st.changedAt)}` : ""}.` : ""}
            {!st.canManage && " The group's Team Lead chooses this."}
          </span>
        </div>
        {st.canManage ? busy ? <Spinner /> : <Switch on={st.enabled} onChange={flip} label="Transcription reminders" /> : <Pill nodot>{st.enabled ? "On" : "Off"}</Pill>}
      </div>
      {(!st.autoNotes || st.unreadable.length > 0 || st.scheduledProblem || st.last) && (
        <div className="panel-b">
          {!st.autoNotes && <p className="muted" style={{ margin: 0 }}>Automatic notes are off for your organization, so there are no reminders either. An Org Owner or Admin turns them on on the Meetings page.</p>}
          {st.unreadable.length > 0 && (
            <p className="err" style={{ margin: 0 }}>
              {BRAND.name} can&apos;t see calls in {st.unreadable.map((n) => `“${n}”`).join(", ")}. Microsoft hasn&apos;t granted it the chat-reading permission there: your Microsoft admin checks Teams&apos; chat consent setting, then remove {BRAND.name} from the chat and add it again. <a href="/settings#microsoft-permissions">See Microsoft permissions</a>
            </p>
          )}
          {st.scheduledProblem && <p className="err" style={{ margin: 0 }}>{st.scheduledProblem} <a href="/settings#microsoft-permissions">See Microsoft permissions</a></p>}
          {st.last && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Latest reminder: in {st.last.chat}, {fmtDate(st.last.at)}.</p>}
        </div>
      )}
    </div>
  );
}

/** The group's "Live in meetings" panel, as GET /api/workspaces/:id/live returns it (lib/live-meetings/sessions.ts). */
type LiveItem = { text: string; who: string | null; due?: string | null };
type LivePanel = {
  mode: LiveMode; changedBy: string | null; changedAt: string | null; included: boolean; configured: boolean; canManage: boolean;
  settings: LiveSettings;
  provider: { id: string; label: string; hosted: boolean; where: string; ready: boolean; canChoose: boolean; choices: { id: string; label: string; hosted: boolean }[] };
  can: { raiseHand: boolean; speak: boolean };
  /** The organization's voice (what "The organization's voice" means here). */
  orgVoice: string;
  hours: { used: number; limit: number | null };
  sessions: {
    id: string; title: string; status: "joining" | "live" | "ended" | "failed"; invitedBy: string; guests: boolean; createdAt: string; minutes: number;
    endReason: string | null; error: string | null; answers: number; quiet: boolean; notes: string | null; decisions: LiveItem[]; actions: LiveItem[];
  }[];
};

/**
 * "Live in meetings" (Enterprise): whether Sidekick joins this group's Teams meetings live as "Sidekick (notes)" (off,
 * when someone types @Sidekick join, or every group meeting), this month's live hours, and the latest sessions with
 * their running list of decisions and action items while live, how each ended, and **Stop** for a running one. The
 * group's Team Lead and Org Owners/Admins change it (PUT /api/workspaces/:id/live, audited); everyone else sees it.
 */
function LiveMeetings({ group }: { group: Group }) {
  const toast = useToast();
  const reportError = useReportError();
  const [st, setSt] = useState<LivePanel | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/workspaces/${encodeURIComponent(group.id)}/live`;
  useEffect(() => {
    api<LivePanel>(url).then(setSt).catch(reportError);
  }, [url, reportError]);
  if (!st) return null;
  const save = async (json: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      setSt(await api<LivePanel>(url, { method: "PUT", json }));
      toast(done);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const chooseProvider = async (provider: string) => {
    try {
      await api("/api/live/provider", { method: "PUT", json: { provider } });
      setSt(await api<LivePanel>(url));
      toast("Meeting bot changed for your organization.");
    } catch (e) {
      reportError(e);
    }
  };
  const change = async (mode: LiveMode) => {
    setBusy(true);
    try {
      setSt(await api<LivePanel>(url, { method: "PUT", json: { mode } }));
      toast(mode === "off" ? "Live in meetings is off." : `Live in meetings: ${LIVE_MODE_LABEL[mode].toLowerCase()}.`);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const stop = async (session: string) => {
    try {
      setSt(await api<LivePanel>(url, { method: "POST", json: { action: "stop", session } }));
      toast(`${BOT_NAME} is leaving the meeting.`);
    } catch (e) {
      reportError(e);
    }
  };
  const PILL: Record<LivePanel["sessions"][number]["status"], string> = { joining: "info", live: "good", ended: "", failed: "bad" };
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-h">
        <div>
          <h2>Live in meetings</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {BRAND.name} joins the group&apos;s Teams meetings as “{BOT_NAME}”, a member of the meeting: it answers when someone says or types “{BRAND.name}, …”, raises its hand when it can answer a question nobody else does, asks when an action item has no owner or date, keeps a list of decisions and action items, and the notes follow afterwards. It never talks over anyone, and with client guests present it only uses Shareable sources.
            {st.changedBy ? ` Set by ${st.changedBy}${st.changedAt ? ` on ${fmtDate(st.changedAt)}` : ""}.` : ""}
            {!st.canManage && " The group's Team Lead chooses this."}
          </span>
        </div>
        {st.canManage && st.included && st.configured ? (
          busy ? <Spinner /> : (
            <select className="input" style={{ width: "auto" }} value={st.mode} onChange={(e) => change(e.target.value as LiveMode)} aria-label="Live in meetings">
              {LIVE_MODES.map((m) => <option key={m} value={m}>{LIVE_MODE_LABEL[m]}</option>)}
            </select>
          )
        ) : <Pill nodot>{LIVE_MODE_LABEL[st.mode]}</Pill>}
      </div>
      <div className="panel-b">
        {!st.included && <p className="muted" style={{ margin: 0 }}>Live in meetings is part of the Enterprise plan. Contact the {BRAND.name} team to add it.</p>}
        {st.included && !st.configured && <p className="muted" style={{ margin: 0 }}>Live in meetings isn&apos;t set up on this {BRAND.name} yet. The {BRAND.name} team turns it on.</p>}
        {st.included && st.mode !== "off" && (
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {st.mode === "auto" ? `${BRAND.name} joins every scheduled meeting that is clearly this group's (automatic notes must be on), and ` : ""}anyone in the group can type <b>@{BRAND.name} join</b> in a meeting&apos;s chat (or paste the meeting link after it). Someone may need to admit it from the lobby. Live hours this month: {st.hours.used}{st.hours.limit !== null ? ` of ${st.hours.limit}` : ""}.
          </p>
        )}
        {st.included && st.mode !== "off" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10, fontSize: 13 }}>
            <label>Answers{" "}
              <select className="input" style={{ width: "auto" }} disabled={!st.canManage || busy} value={st.settings.answer} onChange={(e) => save({ answer: e.target.value }, "Saved.")} aria-label="Which questions Sidekick answers">
                {(Object.keys(ANSWER_LABEL) as LiveSettings["answer"][]).map((k) => <option key={k} value={k}>{ANSWER_LABEL[k]}</option>)}
              </select>
            </label>
            <label>Speaking{" "}
              <select className="input" style={{ width: "auto" }} disabled={!st.canManage || busy} value={st.settings.voice} onChange={(e) => save({ voice: e.target.value }, "Saved.")} aria-label="When Sidekick speaks">
                {(Object.keys(VOICE_LABEL) as LiveSettings["voice"][]).map((k) => <option key={k} value={k}>{VOICE_LABEL[k]}</option>)}
              </select>
            </label>
            {st.settings.voice === "auto" && (
              <label>Pause{" "}
                <select className="input" style={{ width: "auto" }} disabled={!st.canManage || busy} value={st.settings.pauseS} onChange={(e) => save({ pauseS: Number(e.target.value) }, "Saved.")} aria-label="Seconds of silence before speaking">
                  {[3, 5, 6, 8, 10, 15].map((n) => <option key={n} value={n}>{n} s of silence</option>)}
                </select>
              </label>
            )}
            <label><input type="checkbox" disabled={!st.canManage || busy} checked={st.settings.ask} onChange={(e) => save({ ask: e.target.checked }, "Saved.")} /> Asks its own questions (owners and dates)</label>
            {st.settings.voice !== "off" && (
              <label>Voice{" "}
                <VoicePicker voiceId={st.settings.voiceId} speed={st.settings.speed} inherit={st.orgVoice} disabled={!st.canManage || busy} speechReady={st.can.speak} onChange={(v) => save(v, "Saved.")} />
              </label>
            )}
          </div>
        )}
        {st.included && st.mode !== "off" && (
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
            Meeting bot: <b>{st.provider.label}</b>. {st.provider.where}
            {!st.can.speak && st.settings.voice !== "off" && " Spoken answers aren't set up yet, so it answers in the chat."}
            {!st.can.raiseHand && " It can't raise its hand in Teams yet, so it puts ✋ in the chat instead."}
            {" In a meeting, “"}{BRAND.name}{", quiet” keeps it to the chat until someone asks it."}
          </p>
        )}
        {st.provider.canChoose && st.provider.choices.length > 1 && (
          <p style={{ margin: "8px 0 0", fontSize: 12.5 }}>
            <label>Your organization&apos;s meeting bot (Org Owner){" "}
              <select className="input" style={{ width: "auto" }} value={st.provider.id} onChange={(e) => chooseProvider(e.target.value)} aria-label="Meeting bot for your organization">
                {st.provider.choices.map((c) => <option key={c.id} value={c.id}>{c.label}{c.hosted ? " (another company hosts it)" : " (default)"}</option>)}
              </select>
            </label>
          </p>
        )}
        {st.sessions.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Meeting</th><th>Invited</th><th className="r">Min</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {st.sessions.map((x) => (
                  <tr key={x.id}>
                    <td>
                      {x.title}<div className="muted" style={{ fontSize: 12.5 }}>{fmtDate(x.createdAt)}{x.guests ? " · client guests" : ""}{x.quiet ? " · quiet" : ""}{x.answers ? ` · ${x.answers} answer${x.answers === 1 ? "" : "s"}` : ""}{x.notes ? ` · notes: ${x.notes.toLowerCase()}` : ""}</div>
                      {x.status === "live" && (x.decisions.length > 0 || x.actions.length > 0) && (
                        <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                          {x.decisions.map((d, i) => <li key={`d${i}`}>Decided: {d.text}{d.who ? ` (${d.who})` : ""}</li>)}
                          {x.actions.map((a, i) => <li key={`a${i}`}>To do: {a.text}{a.who ? `: ${a.who}` : ""}{a.due ? `, by ${a.due}` : ""}</li>)}
                        </ul>
                      )}
                    </td>
                    <td>{x.invitedBy === "auto" ? "Every group meeting" : x.invitedBy}</td>
                    <td className="r num">{x.minutes}</td>
                    <td>
                      <Pill kind={PILL[x.status]}>{x.status === "joining" ? "Joining" : x.status === "live" ? "Live" : x.status === "ended" ? "Ended" : "Failed"}</Pill>
                      {x.endReason && <div className="muted" style={{ fontSize: 12.5 }}>{x.endReason}</div>}
                      {x.error && <div className="err" style={{ fontSize: 12.5 }}>{x.error}</div>}
                    </td>
                    <td>{st.canManage && (x.status === "joining" || x.status === "live") && <button className="btn small danger" onClick={() => stop(x.id)}>Stop</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Meeting notes go to", then the Teams chats assigned to this group, their settings, and assigning one: from the
 * chats waiting to be assigned when `picker` (the organization is tied to its Microsoft tenant, so Sidekick hands
 * out no codes in group chats), with the code box tucked under a disclosure for other organizations' chats and
 * 1:1 chats; otherwise with the code Sidekick shows in Teams.
 */
function Chats({ group, links, notes, canManage, picker, reload }: { group: Group; links: TeamsLink[]; notes: NotesPlan | null; canManage: boolean; picker: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  const reportError = useReportError();
  const [settingsFor, setSettingsFor] = useState<TeamsLink | null>(null);
  const [linking, setLinking] = useState(false);
  const [form, setForm] = useState({ code: "", guests: false });
  const [waiting, setWaiting] = useState<WaitingChat[] | null>(null);
  const [pick, setPick] = useState("");
  const [error, setError] = useState("");

  // Opens "Assign a chat" and loads the chats waiting to be assigned (with who's in them) where they apply.
  const open = () => {
    setForm({ code: "", guests: false });
    setPick("");
    setError("");
    setWaiting(picker ? null : []);
    setLinking(true);
    if (picker) {
      api<{ waiting: WaitingChat[] }>("/api/teams-links?members=1").then((r) => {
        setWaiting(r.waiting);
        if (r.waiting.length === 1) setPick(r.waiting[0].id);
      }, (e) => {
        setWaiting([]);
        reportError(e);
      });
    }
  };
  // A picked waiting chat wins; otherwise the code.
  const usingCode = !pick;
  const link = async () => {
    setError("");
    try {
      const json = usingCode ? { code: form.code, guests: form.guests, ws: group.id } : { id: pick, guests: form.guests, ws: group.id };
      const r = await api<{ name: string | null }>("/api/teams-links", { method: "POST", json });
      setLinking(false);
      await reload();
      toast(`Assigned “${r.name ?? "Teams chat"}” to ${group.name}. ${BRAND.name} confirmed it in Teams.`);
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
    if (!confirm(`Unassign “${l.name ?? "this chat"}” from ${group.name}? ${BRAND.name} stops answering and posting there, and forgets the messages it saved from it.`)) return;
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
      {notes && notes.chats.length > 0 && <NotesGoTo key={`${notes.mode}:${notes.targets.join()}:${notes.chats.map((c) => c.id).join()}`} group={group} plan={notes} canManage={canManage} reload={reload} />}
      {notes && notes.chats.length > 0 && <CallReminders group={group} />}
      <LiveMeetings group={group} />
      <div className="panel">
        <div className="panel-h">
          <div>
            <h2>Teams chats</h2>
            <span className="muted" style={{ fontSize: 12.5 }}>In these chats {BRAND.name} answers from {group.name} only. Choose per chat whether it reads every message and sends reminders.</span>
          </div>
          {canManage && <button className="btn" onClick={open}><Icon n="plus" />Assign a chat</button>}
        </div>
        {!links.length ? (
          <div className="empty"><span>{!canManage ? "No chats yet. The group's Team Lead assigns Teams chats here." : picker ? `No chats yet. Add ${BRAND.name} to your team's Teams chat, then assign it here with Assign a chat.` : `No chats yet. Add ${BRAND.name} to your team's Teams chat, mention it with “link”, then assign the chat here with the code it shows.`}</span></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Chat</th><th>Client guests</th><th>{BRAND.name} here</th><th>Assigned</th><th>Last activity</th>{canManage && <th />}</tr></thead>
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
                        {notes?.targets.includes(l.id) && <Pill nodot>Meeting notes</Pill>}
                        {l.settings.track && <Pill kind="hand" nodot>Reads every message</Pill>}
                        {l.settings.reminders && <Pill kind="good" nodot>Reminders {l.settings.time}</Pill>}
                        {!notes?.targets.includes(l.id) && !l.settings.track && !l.settings.reminders && <span className="muted">Answers only</span>}
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
        <Modal title={`Assign a Teams chat to ${group.name}`} onClose={() => setLinking(false)} footer={<><button className="btn" onClick={() => setLinking(false)}>Cancel</button><button className="btn primary" disabled={usingCode ? !form.code.trim() : false} onClick={link}>Assign</button></>}>
          {picker && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>Chats {BRAND.name} was added to in Teams that aren&apos;t assigned to a group yet. Assigned means {BRAND.name} reads every message there and answers from {group.name} only.</p>
              {waiting === null ? (
                <p className="muted">Loading chats waiting to be assigned…</p>
              ) : !waiting.length ? (
                <div className="empty" style={{ padding: 16 }}><span>No chats are waiting. Add {BRAND.name} to the chat in Teams first; it will show up here.</span></div>
              ) : (
                <div role="radiogroup" aria-label="Chats waiting to be assigned" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  {waiting.map((w) => (
                    <button key={w.id} className="choice" role="radio" aria-checked={pick === w.id} onClick={() => setPick(pick === w.id ? "" : w.id)}>
                      <span className="radio" />
                      <span>
                        <b>{w.name ?? "Teams chat"}</b> <Pill nodot>{w.kind === "channel" ? "Channel" : "Group chat"}</Pill>
                        <br />
                        <span className="muted" style={{ fontSize: 12.5 }}>
                          Added by {w.added_by ?? "someone in Teams"} on {fmtDate(w.waiting_since ?? w.created_at)} · {BRAND.name} leaves it on {fmtDate(w.leaves_at)} if nobody assigns it
                        </span>
                        {w.members && w.members.length > 0 && (
                          <><br /><span className="muted" style={{ fontSize: 12.5 }}>In the chat: {w.members.join(", ")}</span></>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {picker ? (
            <details style={{ marginBottom: 12 }}>
              <summary className="muted" style={{ cursor: "pointer" }}>Linking a chat from another organization?</summary>
              <p className="muted">For a 1:1 chat, or a chat in a Microsoft organization that isn&apos;t yours: mention {BRAND.name} there with “link”. It replies with an 8-character code.</p>
              <div className="field">
                <label htmlFor="lcode">Code from Teams</label>
                <input id="lcode" className="input mono" placeholder="ABCD-2345" value={form.code} onChange={(e) => { setPick(""); setForm({ ...form, code: e.target.value }); }} />
              </div>
            </details>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>In Teams, add {BRAND.name} to the chat or channel and mention it with “link”. It replies with an 8-character code.</p>
              <div className="field">
                <label htmlFor="lcode">Code from Teams</label>
                <input id="lcode" className="input mono" placeholder="ABCD-2345" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoFocus />
              </div>
            </>
          )}
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
        <div><h2>Documents</h2><span className="muted" style={{ fontSize: 12.5 }}>What {BRAND.name} answers from in this group. Shareable documents may be used in chats with the client.</span></div>
        <button className="btn primary" onClick={openDocs}><Icon n="upload" />Upload or manage</button>
      </div>
      {!docs.length ? (
        <div className="empty"><span>No documents yet. Upload specs, plans and runbooks so {BRAND.name} can answer questions about this client.</span></div>
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

/**
 * Export, end (roll-off) or cancel ending a group (Org Owners and Admins). Ending: read-only now, its Teams
 * chats are told and unlinked, it stops counting toward the plan's groups, and it's deleted on the date
 * (POST/DELETE /api/workspaces/:id/rolloff). Export: GET /api/workspaces/:id/export (a zip download).
 */
function RollOff({ group, onChanged }: { group: Group; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [days, setDays] = useState(GROUP_DEFAULT_DAYS);
  const [today] = useState(() => Date.now());
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const path = `/api/workspaces/${encodeURIComponent(group.id)}/rolloff`;
  const end = async () => {
    setError("");
    try {
      await api(path, { method: "POST", json: { days } });
      toast(`“${group.name}” is ending.`);
      setAsking(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't end the group.");
      setAsking(false);
    }
  };
  const keep = async () => {
    setError("");
    try {
      const r = await api<{ relinked: number }>(path, { method: "DELETE" });
      toast(`“${group.name}” is a normal group again${r.relinked ? `; ${r.relinked} Teams chat${r.relinked === 1 ? "" : "s"} relinked` : ""}.`);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel the ending.");
    }
  };
  const when = new Date(today + days * 86400_000);
  return (
    <div className="panel">
      <div className="panel-h"><h2>When the engagement ends</h2>{group.ending && <Pill kind="bad">Ending</Pill>}</div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <a className="btn" href={`/api/workspaces/${encodeURIComponent(group.id)}/export`}><Icon n="upload" /> Export everything (zip)</a>
          <span className="muted" style={{ fontSize: 13 }}>Documents&apos; text, meeting notes, decisions and action items, questions and gaps, a Teams chat summary and the people, with an index page.</span>
        </div>
        {group.ending ? (
          <>
            <p style={{ margin: 0 }}>Ending: read-only, and everything is deleted on <b>{fmtDate(group.ending.deleteOn)}</b> (set by {group.ending.requestedBy}). A deletion certificate goes into the audit log (Settings → Roll-offs and certificates).</p>
            <div className="row"><button className="btn" onClick={keep}>Cancel the ending</button></div>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>Ending a group makes it read-only straight away, tells and unlinks its Teams chats, and stops it counting toward your plan&apos;s groups. You can export and cancel until the date; then everything in it is deleted and you get a deletion certificate.</p>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label htmlFor="end-days">Delete in</label>
              <input id="end-days" className="input num" type="number" min={MIN_GROUP_DAYS} max={MAX_ROLLOFF_DAYS} style={{ width: 80 }} value={days} onChange={(e) => setDays(Math.max(MIN_GROUP_DAYS, Math.min(MAX_ROLLOFF_DAYS, Math.floor(Number(e.target.value) || MIN_GROUP_DAYS))))} />
              <span>days ({fmtDate(when.toISOString())})</span>
              <button className="btn danger" onClick={() => setAsking(true)}>End this group…</button>
            </div>
          </>
        )}
        {error && <p className="err" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
      {asking && (
        <Modal title={`End “${group.name}”?`} onClose={() => setAsking(false)} footer={<><button className="btn" onClick={() => setAsking(false)}>Back</button><button className="btn danger solid" onClick={end}>End group</button></>}>
          <p style={{ margin: 0 }}>The group turns read-only now and its Teams chats are told and unlinked. Everything in it (documents, meetings, notes, questions, saved chat messages) is deleted on <b>{fmtDate(when.toISOString())}</b>. Export it first if you need a copy. You can cancel until then.</p>
        </Modal>
      )}
    </div>
  );
}

/** Name, client and engagement code, and deleting the group now (Org Owners and Admins). */
function Settings({ group, onSaved, onChanged, onDeleted }: { group: Group; onSaved: () => Promise<void>; onChanged: () => Promise<void>; onDeleted: () => Promise<void> }) {
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
      if (!confirm(`Delete the group “${group.name}” now? This permanently deletes ${what}, its knowledge map, guardrail rules, saved Teams messages and reminders.${chats} The audit log, usage records and a deletion certificate are kept. This can't be undone. (To give people time to export, use “End this group” instead.)`)) return;
      await api(path, { method: "DELETE" });
      toast(`Group “${group.name}” deleted.`);
      await onDeleted();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete the group.");
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <RollOff group={group} onChanged={onChanged} />
    <div className="panel">
      <form className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560 }} onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) save(); }}>
        <div className="field"><label htmlFor="s-name">Group name</label><input id="s-name" className="input" value={form.name} onChange={set("name")} /></div>
        <div className="field"><label htmlFor="s-client">Client</label><input id="s-client" className="input" value={form.client} onChange={set("client")} placeholder="e.g. Northwind Bank" /></div>
        <div className="field"><label htmlFor="s-code">Engagement code (optional)</label><input id="s-code" className="input mono" value={form.code} onChange={set("code")} placeholder="NWB-2026-014" /></div>
        {error && <p className="err" style={{ margin: 0 }}>{error}</p>}
        <div className="row"><button type="submit" className="btn primary" disabled={!form.name.trim() || !!group.ending}>Save</button><span style={{ flex: 1 }} /><button type="button" className="btn danger" onClick={remove}>Delete group now…</button></div>
      </form>
    </div>
    </div>
  );
}
