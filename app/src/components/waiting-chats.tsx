"use client";

/**
 * "Waiting to be assigned" on the Workspaces page: Teams chats and channels Sidekick was added to in the
 * organization's own Microsoft 365 tenant that aren't linked to a workspace yet (no link code needed).
 * Shown to Org Owners/Admins and Team Leads (who can only pick the workspaces they lead). Assigning one links
 * it (POST /api/teams-links with its id), Sidekick confirms it in Teams, and the page opens the chat's
 * settings (notes, tracking, reminders) straight away.
 */

import { useState } from "react";
import { api, fmtDate, Pill, useToast } from "@/components/ui";

/** One waiting chat, as GET /api/teams-links returns it in `waiting`. */
export type WaitingChat = { id: string; kind: string; name: string | null; added_by: string | null; created_at: string; last_seen_at: string };

/**
 * The panel. `workspaces` are the ones this person may assign to; `onAssigned(id)` runs after a chat was
 * linked (the page reloads its lists and opens that chat's settings).
 */
export function WaitingChats({ chats, workspaces, onAssigned }: { chats: WaitingChat[]; workspaces: { id: string; name: string }[]; onAssigned: (id: string) => void }) {
  const toast = useToast();
  const [pick, setPick] = useState<Record<string, { ws: string; guests: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  if (!chats.length) return null;
  const choice = (id: string) => pick[id] ?? { ws: workspaces[0]?.id ?? "", guests: false };

  const assign = async (c: WaitingChat) => {
    const { ws, guests } = choice(c.id);
    setBusy(c.id);
    setError(null);
    try {
      await api("/api/teams-links", { method: "POST", json: { id: c.id, ws, guests } });
      toast(`Assigned “${c.name ?? "Teams chat"}” to ${workspaces.find((w) => w.id === ws)?.name ?? "the workspace"}. Sidekick confirmed it in Teams.`);
      onAssigned(c.id);
    } catch (e) {
      setError({ id: c.id, message: e instanceof Error ? e.message : "Couldn't assign that chat." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h">
        <div>
          <h2>Waiting to be assigned</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>Sidekick was added to these Teams chats and channels in your organization. Pick the workspace each one belongs to; Sidekick only answers there once it&apos;s assigned.</span>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Chat or channel</th>
              <th>Added by</th>
              <th>Workspace</th>
              <th>Client guests</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {chats.map((c) => {
              const ch = choice(c.id);
              return (
                <tr key={c.id}>
                  <td>
                    <b>{c.name ?? "Teams chat"}</b> <Pill nodot>{c.kind === "channel" ? "Channel" : "Group chat"}</Pill>
                  </td>
                  <td>
                    {c.added_by ?? "Someone in Teams"}
                    <div className="muted" style={{ fontSize: 12 }}>{fmtDate(c.created_at)}</div>
                  </td>
                  <td>
                    <select className="input" style={{ width: "auto", padding: "4px 8px" }} aria-label={`Workspace for ${c.name ?? "this chat"}`} value={ch.ws} onChange={(e) => setPick({ ...pick, [c.id]: { ...ch, ws: e.target.value } })}>
                      {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                      <input type="checkbox" checked={ch.guests} onChange={(e) => setPick({ ...pick, [c.id]: { ...ch, guests: e.target.checked } })} />
                      Guests present
                    </label>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn primary" disabled={!ch.ws || busy === c.id} onClick={() => assign(c)}>Assign</button>
                    {error?.id === c.id && <div className="err" style={{ whiteSpace: "normal" }}>{error.message}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
