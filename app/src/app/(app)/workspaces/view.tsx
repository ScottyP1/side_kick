"use client";

/**
 * Groups (/workspaces): one card per client team (a "workspace" in the API), with its Team Lead, how many
 * people, Teams chats, documents and meetings it has, and a health label saying what needs attention.
 * Everyone sees the groups they belong to (Org Owners and Admins see all); a card opens the group page
 * (/workspaces/[id]). Org Owners and Admins create groups on /workspaces/new.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, Icon, Pill, useReportError } from "@/components/ui";
import { Avatar, groupHealth, type Group } from "@/components/groups";
import { BRAND } from "@/lib/brand";

type Filter = "all" | "attention" | "setup";

export default function GroupsPage() {
  const { me } = useApp();
  const reportError = useReportError();
  const [list, setList] = useState<Group[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    api<{ workspaces: Group[] }>("/api/workspaces").then((r) => setList(r.workspaces)).catch(reportError);
  }, [reportError]);

  const admin = me.user.admin;
  const kind = (g: Group) => groupHealth(g)[0];
  const shown = (list ?? []).filter((g) => filter === "all" || (filter === "attention" ? ["bad", "warn"].includes(kind(g)) : kind(g) === "info"));
  const sum = (k: "members" | "chats" | "overdue") => (list ?? []).reduce((a, g) => a + g[k], 0);
  const fb = (v: Filter, label: string) => <button aria-pressed={filter === v} onClick={() => setFilter(v)}>{label}</button>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Groups</div>
          <h1>{admin ? "Your client teams" : "Your groups"}</h1>
          <p>One group per client team. Each has its own people, Teams chats and documents, and {BRAND.name} never mixes them.</p>
        </div>
        {admin && (
          <div className="actions">
            <Link className="btn primary" href="/workspaces/new"><Icon n="plus" />New group</Link>
          </div>
        )}
      </div>

      {list && !list.length ? (
        <div className="panel">
          <div className="empty">
            <h2>No groups yet</h2>
            <span>
              {admin
                ? "Create one for each client team, like “Payments Platform” for Northwind Bank, and pick its Team Lead."
                : "You haven't been added to a group yet. Ask an Org Admin or a Team Lead to add you to one."}
            </span>
            {admin && <Link className="btn primary" href="/workspaces/new">Create your first group</Link>}
          </div>
        </div>
      ) : (
        <>
          {list && (
            <div className="gstats">
              <div><span className="eyebrow">Groups</span><span className="v">{list.length}</span><span className="muted" style={{ fontSize: 12.5 }}>{list.filter((g) => !g.leads.length).length ? `${list.filter((g) => !g.leads.length).length} without a Team Lead` : "All have a Team Lead"}</span></div>
              <div><span className="eyebrow">People in groups</span><span className="v">{sum("members")}</span><span className="muted" style={{ fontSize: 12.5 }}>Counted once per group</span></div>
              <div><span className="eyebrow">Teams chats</span><span className="v">{sum("chats")}</span><span className="muted" style={{ fontSize: 12.5 }}>Assigned to a group</span></div>
              <div><span className="eyebrow">Overdue actions</span><span className="v" style={sum("overdue") ? { color: "var(--warn)" } : undefined}>{sum("overdue")}</span><span className="muted" style={{ fontSize: 12.5 }}>Past their due date</span></div>
            </div>
          )}
          <div className="row">
            <div className="seg" role="group" aria-label="Show">{fb("all", "All")}{fb("attention", "Needs attention")}{fb("setup", "Setting up")}</div>
          </div>
          <div className="gcards">
            {shown.map((g) => {
              const [k, label, why] = groupHealth(g);
              const lead = g.leads[0];
              return (
                <Link key={g.id} className="gcard" href={`/workspaces/${encodeURIComponent(g.id)}`} aria-label={`Open ${g.client ? `${g.client}, ` : ""}${g.name}`}>
                  <div className="top">
                    <div className="row">
                      <span className="eyebrow">{g.client || g.code || "No client set"}</span>
                      <span style={{ flex: 1 }} />
                      <span title={why}><Pill kind={k}>{label}</Pill></span>
                    </div>
                    <h3>{g.name}</h3>
                  </div>
                  <div className="lead">
                    {lead ? (
                      <>
                        <Avatar name={lead.name} large />
                        <div>
                          <b style={{ fontWeight: 500 }}>{lead.name}{g.leads.length > 1 ? ` +${g.leads.length - 1}` : ""}</b>
                          <div className="muted" style={{ fontSize: 12.5 }}>Team Lead</div>
                        </div>
                      </>
                    ) : <span className="muted" style={{ fontSize: 13 }}>No Team Lead yet</span>}
                  </div>
                  <div className="nums">
                    <div><b>{g.members}</b><span>people</span></div>
                    <div><b>{g.chats}</b><span>chats</span></div>
                    <div><b>{g.docs}</b><span>docs</span></div>
                    <div><b>{g.meetings}</b><span>meetings</span></div>
                  </div>
                </Link>
              );
            })}
            {admin && filter === "all" && list && (
              <Link className="gcard new" href="/workspaces/new"><Icon n="plus" />New group</Link>
            )}
          </div>
          {list && !shown.length && <p className="muted">No groups match this filter.</p>}
        </>
      )}
    </>
  );
}
