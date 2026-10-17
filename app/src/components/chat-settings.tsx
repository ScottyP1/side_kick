"use client";

/**
 * The settings window for one linked Teams channel or chat (Workspaces page → Teams channels and chats →
 * Settings). Org Owners and Org Admins, and Team Leads for the workspaces they lead, choose what Sidekick does in that chat: post meeting notes, keep
 * track of every message, and send reminders (time, time zone, quiet days, kinds). They can also preview
 * the next reminder or send one now. Saved with PATCH /api/teams-links/settings (audited); preview and
 * send use POST /api/reminders. Rules and defaults live in lib/reminder-rules.ts.
 */

import { useMemo, useState } from "react";
import { api, fmtTime, Modal, Pill, Switch, useToast } from "@/components/ui";

/** A linked chat's settings, as returned by GET /api/teams-links. */
export type ChatSettings = {
  track: boolean;
  notes: boolean;
  reminders: boolean;
  time: string;
  timeZone: string;
  quietDays: number[];
  afterMeeting: boolean;
  kinds: { actions: boolean; questions: boolean; outdated: boolean; conflicts: boolean };
};

/** The latest reminder run of a chat: posted, empty (nothing to say), failed (with why) or building. */
export type LastReminder = { status: string; points: number; error: string | null; created_at: string } | null;

type Preview = { intro: string; points: { key: string; label: string; text: string; sources: { type: string; title: string; when: string | null }[] }[] } | null;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KINDS: [keyof ChatSettings["kinds"], string][] = [
  ["actions", "Overdue or unowned action items"],
  ["questions", "Open questions and decisions still to make"],
  ["outdated", "Documents that look out of date"],
  ["conflicts", "Sources that disagree"],
];

/** One line describing a chat's last reminder, for the table and this window. */
export function lastReminderText(r: LastReminder) {
  if (!r) return "No reminders yet";
  if (r.status === "posted") return `${r.points} reminder${r.points === 1 ? "" : "s"} posted ${fmtTime(r.created_at)}`;
  if (r.status === "empty") return `Nothing to remind about (${fmtTime(r.created_at)})`;
  if (r.status === "failed") return `Failed ${fmtTime(r.created_at)}: ${r.error ?? "unknown error"}`;
  return `Being prepared (${fmtTime(r.created_at)})`;
}

/**
 * The window itself. `chat` is the row from GET /api/teams-links; `onSaved` reloads the list.
 */
export function ChatSettingsModal({
  chat,
  onClose,
  onSaved,
}: {
  chat: { id: string; kind: string; name: string | null; guests: number; workspace: string; settings: ChatSettings; lastReminder: LastReminder; savedMessages: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [s, setS] = useState<ChatSettings>(chat.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  const zones = useMemo(() => {
    try {
      const list = Intl.supportedValuesOf("timeZone");
      return list.includes(s.timeZone) ? list : [s.timeZone, ...list];
    } catch {
      return [s.timeZone];
    }
  }, [s.timeZone]);
  const personal = chat.kind === "personal";
  const where = chat.kind === "channel" ? "channel" : "chat";

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/teams-links/settings", { method: "PATCH", json: { id: chat.id, changes: s } });
      toast(`Saved settings for “${chat.name ?? "Teams chat"}”.`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the settings.");
    } finally {
      setBusy(false);
    }
  };

  const remind = async (action: "preview" | "send") => {
    setBusy(true);
    setError("");
    try {
      if (action === "preview") {
        setPreview((await api<{ preview: Preview }>("/api/reminders", { method: "POST", json: { id: chat.id, action } })).preview);
      } else {
        const r = await api<{ status: string; points: number }>("/api/reminders", { method: "POST", json: { id: chat.id, action } });
        toast(r.status === "posted" ? `Posted ${r.points} reminder${r.points === 1 ? "" : "s"} in Teams.` : "Nothing to remind about right now, so nothing was posted.");
        onSaved();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, help: string, on: boolean, set: (v: boolean) => void, disabled = false) => (
    <div className="li" style={{ alignItems: "flex-start", gap: 12, opacity: disabled ? 0.55 : 1 }}>
      <div className="grow">
        <b>{label}</b>
        <div className="muted" style={{ fontSize: 12.5 }}>{help}</div>
      </div>
      {disabled ? <Pill nodot>Not for 1:1 chats</Pill> : <Switch on={on} onChange={set} label={label} />}
    </div>
  );

  return (
    <Modal
      wide
      title={`${chat.name ?? "Teams chat"} · ${chat.workspace}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>Save</button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Choose what Sidekick does in this {where}. {chat.guests ? "Client guests are in it, so it only ever gets Shareable items." : "It's internal, so it can get internal items too."} Changes are recorded in the audit log.
      </p>
      <div className="list">
        {row("Meeting notes", `Post the notes and action items here after each meeting in ${chat.workspace}. Turn it off in the other chats to keep notes in one dedicated chat.`, s.notes, (v) => setS({ ...s, notes: v }))}
        {row(
          "Keep track of every message",
          `Sidekick reads the messages here (not only @mentions), so it can answer from them and spot what changed, like a new cutover date. Everyone here is told when you switch it. Kept 90 days.${chat.savedMessages ? ` ${chat.savedMessages} saved so far.` : ""}`,
          s.track,
          (v) => setS({ ...s, track: v }),
          personal,
        )}
        {row("Reminders", "Post a short card with what's still open: each point cites its source and has Assign, Mark done, Snooze and Not relevant buttons.", s.reminders, (v) => setS({ ...s, reminders: v }))}
      </div>

      {s.reminders && (
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)", gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="rtime">Every day at</label>
              <input id="rtime" type="time" className="input" value={s.time} onChange={(e) => setS({ ...s, time: e.target.value })} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="rtz">Time zone</label>
              <select id="rtz" className="input" value={s.timeZone} onChange={(e) => setS({ ...s, timeZone: e.target.value })}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
              </select>
            </div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Quiet days (no daily reminder)</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {DAYS.map((d, i) => (
                <label key={d} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
                  <input type="checkbox" checked={s.quietDays.includes(i)} onChange={(e) => setS({ ...s, quietDays: e.target.checked ? [...s.quietDays, i].sort() : s.quietDays.filter((x) => x !== i) })} />
                  {d}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Remind about</div>
            <div style={{ display: "grid", gap: 6 }}>
              {KINDS.map(([k, label]) => (
                <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input type="checkbox" checked={s.kinds[k]} onChange={(e) => setS({ ...s, kinds: { ...s.kinds, [k]: e.target.checked } })} />
                  {label}
                </label>
              ))}
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={s.afterMeeting} onChange={(e) => setS({ ...s, afterMeeting: e.target.checked })} />
                Also right after each meeting (what&apos;s still open from earlier ones)
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="li" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
        <div className="grow muted" style={{ fontSize: 12.5 }}>Last reminder: {lastReminderText(chat.lastReminder)}</div>
        <button className="btn" disabled={busy} onClick={() => remind("preview")}>Preview</button>
        <button className="btn" disabled={busy} onClick={() => remind("send")}>Send now</button>
      </div>
      {preview !== undefined && (
        <div style={{ marginTop: 8, padding: 12, border: "1px solid var(--line)", borderRadius: 10 }}>
          <div>
            {!preview ? (
              <span className="muted">Nothing to remind about right now. Nothing would be posted.</span>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>{preview.intro}</p>
                {preview.points.map((p) => (
                  <div key={p.key} style={{ marginBottom: 10 }}>
                    <div className="eyebrow">{p.label}</div>
                    <div>{p.text}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>Source: {p.sources.map((x) => `${x.title}${x.when ? ` · ${x.when}` : ""}`).join(" | ")}</div>
                  </div>
                ))}
                <span className="muted" style={{ fontSize: 12.5 }}>Preview only: nothing was posted in Teams.</span>
              </>
            )}
          </div>
        </div>
      )}
      {error && <p className="err">{error}</p>}
    </Modal>
  );
}
