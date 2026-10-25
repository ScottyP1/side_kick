"use client";

/**
 * The "Automatic notes after Teams meetings" panel on the Meetings page (data from GET /api/meetings/auto,
 * lib/meetings-graph.ts). Shows whether it's on, the last check and any problem in plain words, and recent Teams
 * meetings Sidekick heard about. Org Owners/Admins turn it on or off and press **Check now**; they and Team Leads
 * pick the group for a meeting several groups were in; Org Owners/Admins can try a skipped or failed one again.
 * Everyone else sees only meetings captured into their own groups. `onCaptured` lets the page reload its list.
 *
 * Below it, once automatic notes are on, **Group meetings record and transcribe by themselves** (lib/auto-record.ts):
 * an Org Owner/Admin opts in after a dialog that says plainly that Teams also saves a video; everyone in a group sees
 * the group's upcoming meetings Sidekick set; admins and Team Leads see problems.
 */

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtTime, Icon, Modal, Pill, Spinner, useReportError, useToast } from "@/components/ui";
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
};
/** The automatic-recording part of the status (lib/auto-record.ts `autoRecordStatus`). */
type AutoRecord = {
  enabled: boolean;
  changedBy: string | null;
  changedAt: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
  upcoming: { title: string; startsAt: string | null; status: "set" | "already"; group: string }[];
  failed: { title: string; reason: string | null }[];
};
type Status = { enabled: boolean; connected: boolean; changedBy: string | null; lastCheckAt: string | null; lastError: string | null; instant: boolean; recent: Recent[]; autoRecord?: AutoRecord };

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
  const [askRecord, setAskRecord] = useState(false);
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
  const setRecord = (on: boolean) =>
    act(() => api("/api/meetings/auto", { method: "PUT", body: JSON.stringify({ autoRecord: on }) }), on ? `Group meetings will record and transcribe by themselves. ${BRAND.name} sets the upcoming ones now.` : "Group meetings no longer record by themselves");
  const post = (body: Record<string, string>, done: string) => act(() => api("/api/meetings/auto", { method: "POST", body: JSON.stringify(body) }), done);

  if (!s) return null;
  // People who can't change anything and have nothing captured yet don't need the panel.
  if (!manager && !s.enabled) return null;
  const waiting = s.recent.filter((r) => r.status === "waiting");
  const others = s.recent.filter((r) => r.status !== "waiting").slice(0, 8);

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
                  <button key={g.id} className="btn small" disabled={busy} onClick={() => post({ action: "assign", id: r.id, ws: g.id }, `Notes will go to ${g.name}`).catch(reportError)}>{g.name}</button>
                ))}
              </div>
            </div>
          </div>
        ))}
        {s.enabled && s.autoRecord && (manager || s.autoRecord.enabled) && (
          <AutoRecordSection r={s.autoRecord} admin={admin} manager={manager} busy={busy} onToggle={() => (s.autoRecord!.enabled ? setRecord(false).catch(reportError) : setAskRecord(true))} />
        )}
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
      {askRecord && (
        <Modal
          title="Record and transcribe group meetings by themselves?"
          onClose={() => setAskRecord(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAskRecord(false)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={() => { setAskRecord(false); setRecord(true).catch(reportError); }}>Turn on</button>
            </>
          }
        >
          <p>{BRAND.name} will turn on <b>Record and transcribe automatically</b> for upcoming scheduled Teams meetings that are clearly one group&apos;s, so they have a transcript and notes without anyone pressing Start transcription.</p>
          <ul>
            <li><b>Teams also saves a video recording</b>, in the organizer&apos;s OneDrive, kept as your Teams policy says. Microsoft doesn&apos;t let apps choose &quot;transcribe only&quot;.</li>
            <li>Only meetings a group&apos;s person organizes whose meeting chat is linked to that group, or where at least half of the people invited are that group&apos;s.</li>
            <li>Never meetings with people from outside your organization.</li>
            <li>Each meeting is set once. If its organizer turns it off in Meeting options, {BRAND.name} leaves it off.</li>
            <li>A Microsoft admin approves two more permissions first (reading calendars and changing Teams meetings).</li>
          </ul>
          <p className="muted">Everyone in the meeting sees that it&apos;s being recorded, as usual in Teams. Turning this off later stops new meetings being set; meetings already set keep recording until their organizer changes them.</p>
        </Modal>
      )}
    </div>
  );
}

/**
 * "Group meetings record and transcribe by themselves": the switch (admins), its last check and problems (admins and
 * Team Leads), and the group's upcoming meetings that will record (everyone who can see the group).
 */
function AutoRecordSection({ r, admin, manager, busy, onToggle }: { r: AutoRecord; admin: boolean; manager: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <div className="callout info" style={{ alignItems: "flex-start" }}>
      <Icon n="video" />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b>Group meetings record and transcribe by themselves</b> {r.enabled ? <Pill kind="good">On</Pill> : <Pill kind="warn">Off</Pill>}
          {admin && <button className={`btn small${r.enabled ? "" : " primary"}`} style={{ marginLeft: "auto" }} disabled={busy} onClick={onToggle}>{r.enabled ? "Turn off" : "Turn on"}</button>}
        </div>
        <div className="muted">
          {r.enabled
            ? `${BRAND.name} turns on Record and transcribe automatically for upcoming scheduled meetings that are clearly one group's (never with people from outside your organization). Teams also saves a video recording.${r.lastCheckAt ? ` Last checked ${fmtDate(r.lastCheckAt)}.` : ""}`
            : "People forget to start transcription. Turn this on and scheduled group meetings transcribe by themselves. Teams also saves a video recording, because Microsoft doesn't let apps choose transcribe only."}
        </div>
        {manager && r.enabled && r.lastError && <div className="callout bad"><Icon n="alert" /><div>{r.lastError}</div></div>}
        {r.enabled && r.upcoming.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.upcoming.map((m, i) => <li key={i}><b>{m.title}</b> · {fmtTime(m.startsAt)} · {m.group}{m.status === "already" ? <span className="muted"> (the organizer had already turned it on)</span> : null}</li>)}
          </ul>
        )}
        {manager && r.enabled && r.failed.map((f, i) => <div key={i} className="muted" style={{ fontSize: 12.5 }}>Couldn&apos;t set <b>{f.title}</b>: {f.reason}</div>)}
      </div>
    </div>
  );
}
