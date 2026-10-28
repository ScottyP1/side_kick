"use client";

/**
 * The action-item table shared by Memory & gaps (every item in the workspace) and a meeting's own page (that
 * meeting's items): done checkbox, owner, due date and status, all editable by people who can edit content.
 * Changes go to `PATCH /api/action-items/:id` (validated and audited there).
 *
 * Layout: a full-width table on wide screens; on phones (under 720px, globals.css `.ai-table`) each item becomes a
 * stacked card (checkbox and text on top, then Owner, Due and Status as labelled lines), so nothing is cut off.
 */

import { api, fmtDate, useToast } from "@/components/ui";

/** One action item as the Memory and meeting APIs return it. `due` is what was said, `due_on` the date. */
export type ActionItem = { id: string; text: string; owner: string | null; due: string | null; due_on: string | null; status: string; meeting?: string | null; held_at?: string | null };

/** What a change sends: any of status, owner ("" clears) and due ("YYYY-MM-DD", "" clears). */
export type ActionPatch = { status?: string; owner?: string; due?: string };

/**
 * Saves one change to an action item. `onLocal` applies it on screen straight away; `onFailed` runs after the
 * error toast (pages reload the list there, so the screen matches what's saved).
 */
export function useUpdateAction(onLocal: (id: string, patch: Partial<ActionItem>) => void, onFailed: () => void) {
  const toast = useToast();
  return async (a: ActionItem, patch: ActionPatch) => {
    onLocal(a.id, { ...patch, ...(patch.due !== undefined ? { due_on: patch.due || null, due: patch.due || null } : {}), ...(patch.owner !== undefined ? { owner: patch.owner.trim() || null } : {}) });
    try {
      await api(`/api/action-items/${a.id}`, { method: "PATCH", json: patch });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.", "error");
      onFailed();
    }
  };
}

/**
 * The editable table. `showMeeting` adds the "From meeting" column (Memory & gaps); a meeting's own page
 * leaves it out. A due date written as words in the meeting ("next Friday") shows under the date field
 * until someone picks a real date.
 */
export function ActionItemsTable({ items, canEdit, onChange, showMeeting }: { items: ActionItem[]; canEdit: boolean; onChange: (a: ActionItem, patch: ActionPatch) => void; showMeeting?: boolean }) {
  return (
    <div className="table-wrap ai-wrap">
      <table className="ai-table">
        <thead>
          <tr>
            <th style={{ width: 36 }}><span className="sr-only">Done</span></th>
            <th>Action item</th>
            <th>Owner</th>
            <th>Due</th>
            <th>Status</th>
            {showMeeting && <th>From meeting</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="ai-done"><input type="checkbox" aria-label={`Done: ${a.text}`} disabled={!canEdit} checked={a.status === "Done"} onChange={(e) => onChange(a, { status: e.target.checked ? "Done" : "Open" })} /></td>
              <td className="ai-text" style={a.status === "Done" ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}><b>{a.text}</b></td>
              <td data-label="Owner">
                <input
                  key={a.owner ?? ""}
                  className="input"
                  style={{ padding: "3px 8px", width: 150, borderColor: a.owner ? undefined : "var(--hand)" }}
                  placeholder="Assign owner"
                  maxLength={120}
                  defaultValue={a.owner ?? ""}
                  disabled={!canEdit}
                  aria-label={`Owner: ${a.text}`}
                  onBlur={(e) => e.target.value.trim() !== (a.owner ?? "") && onChange(a, { owner: e.target.value })}
                />
              </td>
              <td className="num" data-label="Due">
                {canEdit ? (
                  <input className="input" type="date" style={{ padding: "3px 6px", width: "auto" }} value={a.due_on ?? ""} aria-label={`Due date: ${a.text}`} onChange={(e) => onChange(a, { due: e.target.value })} />
                ) : (
                  a.due_on ? fmtDate(a.due_on) : "—"
                )}
                {a.due && !a.due_on && <div className="muted" style={{ fontSize: 12 }}>said: {a.due}</div>}
              </td>
              <td data-label="Status">
                <select className="input" style={{ width: "auto", padding: "3px 6px" }} value={a.status} disabled={!canEdit} aria-label={`Status: ${a.text}`} onChange={(e) => onChange(a, { status: e.target.value })}>
                  {["Open", "In progress", "Done"].map((s) => <option key={s}>{s}</option>)}
                </select>
              </td>
              {showMeeting && <td className="muted" data-label="From meeting">{a.meeting ?? "—"}{a.held_at ? ` · ${fmtDate(a.held_at)}` : ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
