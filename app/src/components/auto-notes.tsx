"use client";

/**
 * The "Automatic notes after Teams meetings" panel on the Meetings page (data from GET /api/meetings/auto,
 * lib/meetings-graph.ts). Shows whether it's on, the last check and any problem in plain words, and recent Teams
 * meetings Sidekick heard about. Org Owners/Admins turn it on or off and press **Check now**; they and Team Leads
 * pick the group for a meeting that isn't clearly one group's (several groups' people, or fewer than two of one
 * group's people recognised), then see that meeting's people who aren't in the group yet, each with **Add to
 * group**; Org Owners/Admins can try a skipped or failed one again.
 * Everyone else sees only meetings captured into their own groups. `onCaptured` lets the page reload its list.
 */

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, Icon, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { BRAND } from "@/lib/brand";

type Recent = {
  id: string;
  title: string;
  status: "captured" | "done" | "waiting" | "skipped" | "failed";
  reason: string | null;
  startedAt: string | null;
  workspace: { id: string; name: string } | null;
  meetingId: string | null;
  candidates: { id: string; name: string }[];
  /** Fewer than two of one group's people were recognised (rather than a tie). */
  unclear?: boolean;
  /** After someone picked its group: the meeting's people who aren't in that group yet. */
  newcomers?: { oid: string; name: string; email: string }[];
};
type Status = { enabled: boolean; connected: boolean; changedBy: string | null; lastCheckAt: string | null; lastError: string | null; instant: boolean; recent: Recent[] };

const STATUS_PILL: Record<Recent["status"], { label: string; kind: "good" | "info" | "warn" | "bad" | "hand" }> = {
  captured: { label: "Writing notes", kind: "info" },
  done: { label: "Notes written", kind: "good" },
  waiting: { label: "Pick a group", kind: "hand" },
  skipped: { label: "Skipped", kind: "warn" },
  failed: { label: "Failed", kind: "bad" },
};

/** The panel. `role` decides which controls show; `onOpen` opens a captured meeting's notes on the page. */
export function AutoNotesPanel({ role, onOpen }: { role: string; onOpen: (meetingId: string) => void }) {
  const toast = useToast();
  const reportError = useReportError();
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const admin = role === "Org Owner" || role === "Org Admin";
  const manager = admin || role === "Team Lead";

  const load = useCallback(async () => setS(await api<Status>("/api/meetings/auto")), []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(reportError);
  }, [load, reportError]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => act(() => api("/api/meetings/auto", { method: "PUT", body: JSON.stringify({ enabled: !s!.enabled }) }), s!.enabled ? "Automatic notes are off" : `Automatic notes are on. ${BRAND.name} checks for new meetings now.`);
  const post = (body: Record<string, string>, done: string) => act(() => api("/api/meetings/auto", { method: "POST", body: JSON.stringify(body) }), done);

  if (!s) return null;
  // People who can't change anything and have nothing captured yet don't need the panel.
  if (!manager && !s.enabled) return null;
  const waiting = s.recent.filter((r) => r.status === "waiting");
  const others = s.recent.filter((r) => r.status !== "waiting").slice(0, 8);
  const toAdd = s.recent.filter((r) => r.status !== "waiting" && r.newcomers?.length && r.workspace).slice(0, 5);

  return (
    <div className="panel">
      <div className="panel-h">
        <div>
          <h2 style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Icon n="video" /> Automatic notes after Teams meetings {s.enabled ? <Pill kind="good">On</Pill> : <Pill kind="warn">Off</Pill>}
          </h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {s.enabled
              ? `When a Teams meeting of a group's people ends, ${BRAND.name} reads its transcript, writes the notes into that group and posts them to the group's notes chat.`
              : `Turn this on and ${BRAND.name} writes notes after every Teams meeting of a group's people, with no bot in the call. Teams needs transcription on.`}
            {s.enabled && s.lastCheckAt ? ` Last checked ${fmtDate(s.lastCheckAt)}${s.instant ? "; new meetings arrive within minutes" : "; checked every 15 minutes"}.` : ""}
          </p>
        </div>
        {admin && (
          <div className="actions">
            {s.enabled && <button className="btn small" disabled={busy} onClick={() => post({ action: "check" }, "Checking for new meetings").catch(reportError)}><Icon n="refresh" /> Check now</button>}
            <button className={`btn small${s.enabled ? "" : " primary"}`} disabled={busy || (!s.enabled && !s.connected)} onClick={() => toggle().catch(reportError)}>
              {busy ? <Spinner /> : null} {s.enabled ? "Turn off" : "Turn on"}
            </button>
          </div>
        )}
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {admin && !s.connected && (
          <div className="callout"><Icon n="alert" /><div>Connect {BRAND.name} to your Microsoft 365 organization first (Settings → Microsoft sign-in). A Microsoft admin then approves meeting transcripts once.</div></div>
        )}
        {s.enabled && s.lastError && manager && <div className="callout bad"><Icon n="alert" /><div>{s.lastError}</div></div>}
        {manager && waiting.map((r) => (
          <div key={r.id} className="callout">
            <Icon n="users" />
            <div style={{ flex: 1 }}>
              <b>{r.title}</b>{r.startedAt ? ` · ${fmtDate(r.startedAt)}` : ""}
              <div className="muted">{r.reason}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                {r.candidates.map((g) => (
                  <button key={g.id} className="btn small wrap" disabled={busy} onClick={() => post({ action: "assign", id: r.id, ws: g.id }, `Notes will go to ${g.name}`).catch(reportError)}>{g.name}</button>
                ))}
              </div>
            </div>
          </div>
        ))}
        {manager && toAdd.map((r) => (
          <div key={`add-${r.id}`} className="callout">
            <Icon n="users" />
            <div style={{ flex: 1 }}>
              <b>People in this meeting who aren&apos;t in {r.workspace!.name} yet</b>
              <div className="muted">{r.title}{r.startedAt ? ` · ${fmtDate(r.startedAt)}` : ""}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                {r.newcomers!.map((p) => (
                  <div key={p.oid} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{p.name} <span className="muted">{p.email}</span></span>
                    <button className="btn small" disabled={busy} onClick={() => post({ action: "add-person", id: r.id, oid: p.oid }, `${p.name} is now in ${r.workspace!.name}`).catch(reportError)}>Add to group</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
        {others.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Teams meeting</th><th>When</th><th>Group</th><th>Status</th><th /></tr></thead>
              <tbody>
                {others.map((r) => (
                  <tr key={r.id}>
                    <td>{r.meetingId && r.status === "done" ? <button type="button" className="linklike" onClick={() => onOpen(r.meetingId!)}><b>{r.title}</b></button> : <b>{r.title}</b>}</td>
                    <td className="muted">{r.startedAt ? fmtDate(r.startedAt) : "—"}</td>
                    <td>{r.workspace?.name ?? <span className="muted">—</span>}</td>
                    <td><Pill kind={STATUS_PILL[r.status].kind}>{STATUS_PILL[r.status].label}</Pill>{r.reason && (r.status === "skipped" || r.status === "failed") ? <div className="muted" style={{ fontSize: 12.5 }}>{r.reason}</div> : null}</td>
                    <td className="r">{admin && (r.status === "skipped" || r.status === "failed") && <button className="btn small ghost" disabled={busy} onClick={() => post({ action: "retry", id: r.id }, "Trying again").catch(reportError)}>Try again</button>}</td>
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
