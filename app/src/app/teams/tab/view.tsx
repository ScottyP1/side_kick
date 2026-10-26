"use client";

/**
 * /teams/tab: Sidekick inside Microsoft Teams (personal app and chat/channel/meeting tab; lib/teams/tab.ts).
 * Shows one group's meetings (with a "Teams" tag for automatically captured ones), a meeting's notes with
 * **Save to knowledge** on decisions and facts, and the group's open action items with **Mark done**. A group
 * switcher lists the person's own groups; in a chat or meeting tab the chat's linked group opens first.
 *
 * Sign-in is Teams single sign-on: the page asks Teams for a token and sends it as `Authorization: Bearer …` to
 * /api/teams-tab on every call (no cookies; they're blocked in Teams' frame on the web). Outside Teams the page
 * says to open it there, with a link to the portal.
 *
 * Teams Store rules it follows: a loading message within 2 seconds, never a dead end (an error says what happened
 * with **Try again** and a link to help), Teams' theme (always dark in a meeting, `followTeamsTheme`), links that
 * leave Teams say so ("opens in browser"), no pricing or upgrade prompts (they're not allowed on mobile), and no
 * horizontal scrolling at phone width.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDate, Pill } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { followTeamsTheme } from "../teams-theme";

type Meeting = { id: string; title: string; held_at: string; status: string; source: string | null; decisions: number; open_actions: number };
type Action = { id: string; text: string; owner: string | null; due: string | null; status: string; meeting?: string | null };
type Item = { id: string; kind: string; text: string; who: string | null; answered: number | null; pinned: number; saved_by: string | null };
type View = {
  user: { name: string; role: string; canEdit: boolean };
  groups: { id: string; name: string }[];
  portal: string;
  ws: string | null;
  meetings: Meeting[];
  actions: Action[];
  meeting: (Meeting & { summary: string | null; items: Item[]; actions: Action[] }) | null;
};

const KEEP = ["decision", "requirement", "fact", "risk", "glossary"];
const LABEL: Record<string, string> = { requirement: "Requirement", fact: "Fact", risk: "Risk", glossary: "Term" };

export default function TeamsTab() {
  const [phase, setPhase] = useState<"connecting" | "outside" | "error" | "ready">("connecting");
  const [error, setError] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [tab, setTab] = useState<"meetings" | "actions">("meetings");
  const [busy, setBusy] = useState(false);
  const token = useRef<() => Promise<string>>(async () => "");
  const chat = useRef<string | null>(null);

  /** Calls /api/teams-tab with a fresh Teams SSO token (Teams caches it and renews it when needed). */
  const call = useCallback(async <T,>(query: string, init?: { method: string; body: unknown }): Promise<T> => {
    const res = await fetch(`/api/teams-tab${query}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${await token.current()}`, ...(init ? { "Content-Type": "application/json" } : {}) },
      body: init ? JSON.stringify(init.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `${BRAND.name} couldn't load this (${res.status}).`);
    return data as T;
  }, []);

  const load = useCallback(async (ws: string | null, meeting: string | null = null) => {
    const q = new URLSearchParams();
    if (ws) q.set("ws", ws);
    if (!ws && chat.current) q.set("chat", chat.current);
    if (meeting) q.set("meeting", meeting);
    setView(await call<View>(`?${q}`));
  }, [call]);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { app, authentication } = await import("@microsoft/teams-js");
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 4000));
      // Outside Teams the SDK either rejects at once ("No Parent window found") or never answers.
      if ((await Promise.race([app.initialize().then(() => "ok" as const, () => "outside" as const), timer])) !== "ok") {
        if (!cancelled) setPhase("outside");
        return;
      }
      const ctx = await app.getContext();
      followTeamsTheme(app, ctx);
      chat.current = ctx.chat?.id ?? ctx.channel?.id ?? null;
      token.current = () => authentication.getAuthToken();
      try {
        await load(null);
        if (!cancelled) setPhase("ready");
        app.notifySuccess();
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : `${BRAND.name} couldn't sign you in.`);
        setPhase("error");
        app.notifySuccess(); // the page itself loaded: Teams should show it (with the error), not its own failure screen
      }
    })().catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : `${BRAND.name} couldn't start.`);
      setPhase("error");
    });
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);

  const act = async (action: string, id: string) => {
    if (!view?.ws) return;
    setBusy(true);
    try {
      await call("", { method: "POST", body: { action, id, ws: view.ws } });
      await load(view.ws, view.meeting?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "connecting") return <Shell><p className="muted">Connecting to Teams…</p></Shell>;
  if (phase === "outside") return <Shell><p>This page works inside Microsoft Teams. In a browser, use the <a href="/meetings">{BRAND.name} portal</a>.</p></Shell>;
  if (phase === "error" || !view) {
    return (
      <Shell>
        <div className="callout bad" role="alert"><div>{error || `${BRAND.name} couldn't load this.`}</div></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn small" onClick={() => { setError(""); setPhase("connecting"); setAttempt((n) => n + 1); }}>Try again</button>
          <a className="btn small ghost" href="/docs/teams-guide" target="_blank" rel="noreferrer">Help (opens in browser)</a>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Still stuck? Write to <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>.</p>
      </Shell>
    );
  }

  const group = view.groups.find((g) => g.id === view.ws);
  return (
    <Shell>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {view.groups.length > 1 ? (
          <select className="input" style={{ maxWidth: 320 }} aria-label="Group" value={view.ws ?? ""} onChange={(e) => load(e.target.value).catch((x) => setError(String(x?.message ?? x)))}>
            {view.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        ) : <h1 style={{ margin: 0, fontSize: 18 }}>{group?.name ?? BRAND.name}</h1>}
        <a className="btn small ghost" href={view.portal} target="_blank" rel="noreferrer">Open in {BRAND.name} (opens in browser)</a>
      </div>
      {error && <div className="callout bad" role="alert"><div>{error}</div></div>}
      {!view.ws ? (
        <p className="muted">You&apos;re not in any group yet. Ask your Team Lead or admin to add you to the group for your client; its meetings, notes and action items then show here.</p>
      ) : view.meeting ? (
        <MeetingNotes m={view.meeting} canEdit={view.user.canEdit} busy={busy} onBack={() => load(view.ws)} onAct={act} />
      ) : (
        <>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "meetings"} onClick={() => setTab("meetings")}>Meetings</button>
            <button role="tab" aria-selected={tab === "actions"} onClick={() => setTab("actions")}>Open action items ({view.actions.length})</button>
          </div>
          {tab === "meetings" ? (
            view.meetings.length ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {view.meetings.map((m) => (
                  <li key={m.id} className="panel" style={{ padding: "10px 12px" }}>
                    <button type="button" className="linklike" onClick={() => load(view.ws, m.id).catch((x) => setError(String(x?.message ?? x)))}><b>{m.title}</b></button>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {fmtDate(m.held_at)} · {m.decisions} decision{m.decisions === 1 ? "" : "s"} · {m.open_actions} open action item{m.open_actions === 1 ? "" : "s"}{" "}
                      {m.source === "teams" && <span className="tag">Teams</span>} {m.status !== "Ready" && <Pill kind={m.status === "Failed" ? "bad" : "info"}>{m.status}</Pill>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No meetings yet. With automatic notes on, the group&apos;s Teams meetings appear here after they end.</p>
          ) : (
            <ActionList actions={view.actions} canEdit={view.user.canEdit} busy={busy} onAct={act} />
          )}
        </>
      )}
    </Shell>
  );
}

/** The page frame: a little padding, Sidekick's styles, never wider than the frame (no sideways scrolling on phones). */
function Shell({ children }: { children: React.ReactNode }) {
  return <main style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, maxWidth: 900, overflowWrap: "anywhere" }}>{children}</main>;
}

/** Open action items with owner and due date, and Mark done / Reopen for people who can edit. */
function ActionList({ actions, canEdit, busy, onAct }: { actions: Action[]; canEdit: boolean; busy: boolean; onAct: (action: string, id: string) => void }) {
  if (!actions.length) return <p className="muted">No open action items.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {actions.map((a) => (
        <li key={a.id} className="panel" style={{ padding: "10px 12px", display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <b>{a.text}</b>
            <div className="muted" style={{ fontSize: 13 }}>{a.owner || "Unassigned"} · {a.due || "No date"}{a.meeting ? ` · ${a.meeting}` : ""}</div>
          </div>
          {canEdit && (a.status === "Done"
            ? <button className="btn small" disabled={busy} onClick={() => onAct("reopen", a.id)}>Reopen</button>
            : <button className="btn small" disabled={busy} onClick={() => onAct("done", a.id)}>Mark done</button>)}
        </li>
      ))}
    </ul>
  );
}

/** One meeting's notes: summary, decisions and things to keep (Save to knowledge), open questions, action items. */
function MeetingNotes({ m, canEdit, busy, onBack, onAct }: { m: NonNullable<View["meeting"]>; canEdit: boolean; busy: boolean; onBack: () => void; onAct: (action: string, id: string) => void }) {
  const keep = [...m.items.filter((i) => i.kind === "decision"), ...m.items.filter((i) => i.kind !== "decision" && KEEP.includes(i.kind))];
  const open = m.items.filter((i) => i.kind === "question" && !i.answered);
  return (
    <>
      <div><button className="btn small ghost" onClick={onBack}>← All meetings</button></div>
      <div>
        <div className="eyebrow">{fmtDate(m.held_at)}{m.source === "teams" ? " · captured from Microsoft Teams" : ""}</div>
        <h2 style={{ margin: "2px 0 0" }}>{m.title}</h2>
      </div>
      <p style={{ margin: 0 }}>{m.summary ?? (m.status === "Ready" ? "" : `${BRAND.name} is still writing these notes.`)}</p>
      {keep.length > 0 && (
        <section>
          <h3>Decisions and things to keep</h3>
          <ul style={{ paddingLeft: 18, margin: "4px 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
            {keep.map((i) => (
              <li key={i.id}>
                {LABEL[i.kind] ? `${LABEL[i.kind]}: ` : ""}{i.text}{" "}
                {i.pinned ? <Pill kind="good">Saved{i.saved_by ? ` by ${i.saved_by}` : ""}</Pill> : null}{" "}
                {canEdit && <button className="btn small ghost" disabled={busy} onClick={() => onAct(i.pinned ? "unsave" : "save", i.id)}>{i.pinned ? "Remove from knowledge" : "Save to knowledge"}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {open.length > 0 && (
        <section>
          <h3>Still open</h3>
          <ul style={{ paddingLeft: 18, margin: "4px 0 0" }}>{open.map((q) => <li key={q.id}>{q.text}</li>)}</ul>
        </section>
      )}
      <section>
        <h3>Action items</h3>
        <ActionList actions={m.actions} canEdit={canEdit} busy={busy} onAct={onAct} />
      </section>
    </>
  );
}
