"use client";

/**
 * New group (/workspaces/new): everything needed to set up a client team on one page: name, client and
 * engagement code, its Team Lead, and its first members. Only the name and a Team Lead are required; the
 * lead adds more people and assigns Teams chats later. Org Owners and Org Admins only (others see a note).
 * Picking a Member or Viewer as lead makes them a Team Lead (the summary says so before saving).
 * Saves with POST /api/workspaces and opens the new group. Past the plan's group limit the server says the
 * cheaper way to make room (extra groups or the next plan, with monthly prices) and a button opens Usage &
 * billing with both options (`/usage?groups=N`).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, ApiError, Icon, useReportError, useToast } from "@/components/ui";
import { Avatar, PeoplePicker, type OrgPerson } from "@/components/groups";

const LEADABLE = ["Team Lead", "Member", "Viewer"];

export default function NewGroupPage() {
  const { me, reload } = useApp();
  const router = useRouter();
  const toast = useToast();
  const reportError = useReportError();
  const [people, setPeople] = useState<OrgPerson[] | null>(null);
  const [form, setForm] = useState({ name: "", client: "", code: "" });
  const [lead, setLead] = useState<string | null>(null);
  const [leadQ, setLeadQ] = useState("");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [memberQ, setMemberQ] = useState("");
  const [error, setError] = useState("");
  // Set when the group limit was reached: how many groups are needed, for the "make room" link to Usage & billing.
  const [needGroups, setNeedGroups] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (me.user.admin) api<{ users: OrgPerson[] }>("/api/users").then((r) => setPeople(r.users)).catch(reportError);
  }, [me.user.admin, reportError]);

  if (!me.user.admin) {
    return <div className="panel"><div className="empty"><h2>Only admins create groups</h2><span>Ask your Org Owner or an Org Admin to create a group and make you its Team Lead.</span><Link className="btn" href="/workspaces">Back to Groups</Link></div></div>;
  }

  const byId = new Map((people ?? []).map((p) => [p.id, p]));
  const leadPerson = lead ? byId.get(lead) : undefined;
  const lq = leadQ.trim().toLowerCase();
  const leadOptions = (people ?? []).filter((p) => LEADABLE.includes(p.role) && (!lq || `${p.name} ${p.email}`.toLowerCase().includes(lq))).slice(0, 6);
  const memberOptions = (people ?? []).filter((p) => p.id !== lead && p.id !== me.user.id);
  const ok = { basics: !!form.name.trim(), lead: !!lead, members: members.size > 0 };

  const create = async () => {
    setError("");
    setNeedGroups(0);
    setSaving(true);
    try {
      const r = await api<{ id: string }>("/api/workspaces", { method: "POST", json: { ...form, lead, members: [...members].filter((m) => m !== lead) } });
      await reload();
      toast(`Group “${form.name.trim()}” created. ${leadPerson ? `${leadPerson.name.split(" ")[0]} can now add people and chats.` : ""}`);
      router.push(`/workspaces/${encodeURIComponent(r.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the group.");
      if (e instanceof ApiError && e.data?.kind === "limit" && e.data.limit === "workspaces" && typeof e.data.need === "number") setNeedGroups(e.data.need);
      setSaving(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <div className="crumbs"><Link href="/workspaces">Groups</Link>›<span>New group</span></div>
      <div className="page-head">
        <div>
          <h1>New group</h1>
          <p>Everything for one client team in one place. Only the name and a Team Lead are needed now; the lead can add people and Teams chats later.</p>
        </div>
      </div>
      <div className="ng">
        <div className="panel">
          <section className="ng-sec">
            <span className={`n${ok.basics ? " ok" : ""}`}>{ok.basics ? <Icon n="check" /> : 1}</span>
            <div className="body">
              <h2>Basics</h2>
              <div className="ng-two">
                <div className="field"><label htmlFor="g-name">Group name</label><input id="g-name" className="input" value={form.name} onChange={set("name")} placeholder="e.g. Payments Platform" autoFocus /></div>
                <div className="field"><label htmlFor="g-client">Client</label><input id="g-client" className="input" value={form.client} onChange={set("client")} placeholder="e.g. Northwind Bank" /></div>
              </div>
              <div className="field" style={{ maxWidth: 260 }}><label htmlFor="g-code">Engagement code <span className="muted">(optional)</span></label><input id="g-code" className="input mono" value={form.code} onChange={set("code")} placeholder="NWB-2026-014" /></div>
            </div>
          </section>
          <section className="ng-sec">
            <span className={`n${ok.lead ? " ok" : ""}`}>{ok.lead ? <Icon n="check" /> : 2}</span>
            <div className="body">
              <div>
                <h2>Team Lead</h2>
                <span className="hint">Runs the group day to day: adds and removes people, assigns Teams chats, keeps documents up to date. Can&apos;t see other groups.</span>
              </div>
              {leadPerson ? (
                <div className="row">
                  <span className="chip"><Avatar name={leadPerson.name} /><b style={{ fontWeight: 500 }}>{leadPerson.name}</b><span className="muted">{leadPerson.email}</span></span>
                  <button className="btn small ghost" onClick={() => setLead(null)}>Change</button>
                </div>
              ) : (
                <div className="picker">
                  <div className="picker-h"><div className="search"><Icon n="search" /><input value={leadQ} onChange={(e) => setLeadQ(e.target.value)} placeholder="Search by name or email" aria-label="Search for a Team Lead" /></div></div>
                  <div className="plist">
                    {people === null ? <div className="empty">Loading people…</div>
                      : leadOptions.length ? leadOptions.map((p) => (
                        <button key={p.id} className="prow" onClick={() => { setLead(p.id); setMembers((m) => { const n = new Set(m); n.delete(p.id); return n; }); }}>
                          <Avatar name={p.name} /><span className="who"><b>{p.name}</b><span>{p.email} · {p.role}</span></span><span className="btn small">Make lead</span>
                        </button>
                      )) : <div className="empty">{leadQ ? `Nobody matches “${leadQ}”.` : "Nobody to pick yet."} Add people on <Link href="/users">Users &amp; access</Link> first.</div>}
                  </div>
                </div>
              )}
            </div>
          </section>
          <section className="ng-sec">
            <span className={`n${ok.members ? " ok" : ""}`}>{ok.members ? <Icon n="check" /> : 3}</span>
            <div className="body">
              <div>
                <h2>Members <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>(optional)</span></h2>
                <span className="hint">Pick people already in your organization. They keep their role (Member or Viewer). {leadPerson ? leadPerson.name.split(" ")[0] : "The Team Lead"} can add more later.</span>
              </div>
              {people && <PeoplePicker people={memberOptions} picked={members} onChange={setMembers} query={memberQ} onQuery={setMemberQ} />}
            </div>
          </section>
          <section className="ng-sec">
            <span className="n">4</span>
            <div className="body">
              <h2>Teams chats</h2>
              <span className="hint">After you create the group, its Team Lead adds Sidekick to the team&apos;s Teams chats and assigns them to this group from the group page. Sidekick stays silent in a chat until it&apos;s assigned.</span>
            </div>
          </section>
        </div>
        <aside className="panel ng-summary">
          <div className="panel-h"><h3>Summary</h3></div>
          <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <dl>
              <dt>Name</dt><dd>{form.name.trim() || <span className="faint">Not set</span>}</dd>
              <dt>Client</dt><dd>{form.client.trim() || <span className="faint">Not set</span>}</dd>
              <dt>Team Lead</dt><dd>{leadPerson?.name ?? <span className="faint">Not picked</span>}</dd>
              <dt>Members</dt><dd className="num">{members.size}</dd>
            </dl>
            {leadPerson && leadPerson.role !== "Team Lead" && (
              <p className="hint" style={{ margin: 0 }}>{leadPerson.name} is a {leadPerson.role} today and becomes a <b>Team Lead</b>, so they can manage the people and chats of every group they&apos;re in.</p>
            )}
            <button className="btn primary" disabled={!ok.basics || !ok.lead || saving} onClick={create}>{saving ? "Creating…" : "Create group"}</button>
            {(!ok.basics || !ok.lead) && <span className="hint">Add a name and pick a Team Lead to create it.</span>}
            {error && <p className="err" style={{ margin: 0 }}>{error}</p>}
            {needGroups > 0 && <Link className="btn" href={`/usage?groups=${needGroups}`}>See both options on Usage &amp; billing</Link>}
          </div>
        </aside>
      </div>
    </>
  );
}
