"use client";

/**
 * @file Shared pieces of the Groups pages (workspaces/view.tsx, workspaces/new, workspaces/[id]).
 *
 * Concepts
 * - A **group** is what the portal calls a workspace: one client team ("Payments Platform" for the client
 *   "Northwind Bank") with its own people, Teams chats and documents. The API and database still say
 *   "workspace".
 * - A group's **Team Lead** is any member whose role is Team Lead (`leads` from GET /api/workspaces).
 * - **Health** is a one-word summary for the group card, worked out in the browser from the counts:
 *   no lead, setting up, overdue action items, no documents, or healthy.
 */
import { Icon } from "@/components/ui";

/** A group as GET /api/workspaces returns it. */
export type Group = {
  id: string; name: string; code: string | null; client: string | null; color: string; created_at: string;
  docs: number; meetings: number; members: number; open_items: number; overdue: number; chats: number;
  last_meeting: string | null; leads: { id: string; name: string }[];
  /** Set when the group is ending (read-only, deleted on `deleteOn`; lib/rolloff.ts), otherwise null. */
  ending?: { deleteOn: string; requestedBy: string } | null;
};

/** A person in the organization as GET /api/users returns them. */
export type OrgPerson = { id: string; name: string; email: string; role: string; microsoft: number; workspaces: string[] };

/** Up to two initials for an avatar ("Priya Natarajan" → "PN"). */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

/** A round initials avatar. */
export const Avatar = ({ name, large }: { name: string; large?: boolean }) => (
  <span className={`av${large ? " lg" : ""}`} title={name} aria-hidden="true">{initials(name)}</span>
);

/**
 * The group's state for its card: `[pill kind, label, explanation]`. Checked in order of what needs a
 * person most: no Team Lead, nobody added yet, overdue action items, no documents, otherwise healthy.
 */
export function groupHealth(g: Group): [string, string, string] {
  if (g.ending) return ["bad", `Ending ${new Date(g.ending.deleteOn).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`, `Read-only. Everything in it is deleted on that date (set by ${g.ending.requestedBy}). An Org Owner or Org Admin can download it or cancel on the group's Settings tab.`];
  if (!g.leads.length) return ["bad", "No Team Lead", "Nobody runs this group day to day. An admin picks a Team Lead on the group's People tab."];
  if (g.members <= 2 && !g.chats && !g.docs) return ["info", "Setting up", `${g.leads[0].name.split(" ")[0]} hasn't added people, chats or documents yet.`];
  if (g.overdue) return ["warn", `${g.overdue} overdue action item${g.overdue === 1 ? "" : "s"}`, "Action items from meetings are past their due date."];
  if (!g.docs) return ["warn", "No documents", "Sidekick can only answer from documents and meetings in the group."];
  return ["good", "Healthy", "People, chats and documents are in place."];
}

/** "Northwind Bank" over "Payments Platform", or just the name when no client is set. */
export const groupTitle = (g: Pick<Group, "name" | "client">) => (g.client ? `${g.client} – ${g.name}` : g.name);

/**
 * A searchable list of people with checkboxes (the "New group" members step and "Add people" on a group).
 * `people` are the candidates; `picked` the chosen ids. Shows how many are picked and a Clear button.
 */
export function PeoplePicker({ people, picked, onChange, query, onQuery }: {
  people: OrgPerson[]; picked: Set<string>; onChange: (next: Set<string>) => void; query: string; onQuery: (q: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const shown = people.filter((p) => !q || `${p.name} ${p.email} ${p.role}`.toLowerCase().includes(q));
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className="picker">
      <div className="picker-h">
        <div className="search"><Icon n="search" /><input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={`Search ${people.length} people`} aria-label="Search people" /></div>
      </div>
      <div className="plist">
        {shown.length ? shown.map((p) => (
          <label key={p.id} className={`prow${picked.has(p.id) ? " on" : ""}`}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
            <Avatar name={p.name} />
            <span className="who"><b>{p.name}</b><span>{p.email}</span></span>
            <span className="tag">{p.role}</span>
          </label>
        )) : <div className="empty">{people.length ? `Nobody matches “${query}”.` : "Everyone in your organization is already in this group."}</div>}
      </div>
      <div className="picker-h foot">
        <span style={{ fontSize: 12.5 }}><b>{picked.size}</b> selected</span>
        <span style={{ flex: 1 }} />
        {picked.size > 0 && <button className="btn small ghost" onClick={() => onChange(new Set())}>Clear</button>}
      </div>
    </div>
  );
}
