"use client";

/**
 * The in-app assistant chat, shown under the crystal ball on the home page (see live-orb.tsx).
 *
 * The person types a question or a request; POST /api/assistant replies, and may attach one proposed
 * action (create a workspace, add a person, link a Teams chat, refresh a knowledge map, open a page),
 * already limited to what their role allows. Actions are confirm-first: a card lists exactly what will
 * happen, and only Confirm sends the request, to the same API route the regular page uses (so role
 * checks and the audit log apply as usual). Cancel does nothing. Results and refusals appear in the card;
 * network/server problems also open the problem modal, so nothing fails silently.
 */
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApp } from "./shell";
import { api, ApiError, Spinner } from "./ui";

/** A confirm card's action, as built by lib/assistant.ts `checkAction`. */
type ReadyAction = {
  type: "create_workspace" | "add_person" | "link_teams" | "refresh_map" | "open_page";
  title: string;
  details: { label: string; value: string }[];
  confirm: boolean;
  request?: { method: "POST"; url: string; body: Record<string, unknown> };
  href?: string;
};
type CardState = { state: "ready" | "running" | "done" | "cancelled" | "failed"; note?: string; secret?: string; link?: { href: string; label: string } };
type Turn = { id: number; role: "user" | "assistant"; text: string; action?: ReadyAction | null; card?: CardState };

/** Starter prompts, by what the person's role can do. */
function suggestionsFor(role: string, admin: boolean): string[] {
  if (admin) return ["Create a workspace", "Add a person to a workspace", "Link a Teams chat", "What did we spend on AI this month?"];
  if (role === "Billing Admin") return ["What did we spend on AI this month?", "What can my role do?", "How is cost tracked?"];
  if (role === "Viewer") return ["What can my role do?", "How do I find a decision from a meeting?", "What are knowledge gaps?"];
  return ["How do I import a meeting?", "Refresh the knowledge map", "How do I use Sidekick in Teams?"];
}

/**
 * The chat box. `onThinking` tells the crystal ball to speed up while a reply is on its way.
 */
export function Assistant({ onThinking }: { onThinking?: (on: boolean) => void }) {
  const { me, reload } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const nextId = useRef(1);
  const thread = useRef<HTMLDivElement>(null);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);

  const setCard = (id: number, card: CardState) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, card } : t)));

  async function send(message: string) {
    const m = message.trim();
    if (!m || thinking) return;
    setError("");
    setText("");
    const history = turns.map((t) => ({ role: t.role, text: t.text }));
    setTurns((ts) => [...ts, { id: nextId.current++, role: "user", text: m }]);
    setThinking(true);
    onThinking?.(true);
    try {
      const r = await api<{ reply: string; action: ReadyAction | null }>("/api/assistant", { method: "POST", json: { message: m, history } });
      setTurns((ts) => [...ts, { id: nextId.current++, role: "assistant", text: r.reply, action: r.action, card: r.action?.confirm ? { state: "ready" } : undefined }]);
    } catch (e) {
      // 4xx (e.g. paused, too long) shown here; network/server problems also open the problem modal.
      setError(e instanceof Error ? e.message : "The assistant couldn't answer. Try again.");
    } finally {
      setThinking(false);
      onThinking?.(false);
    }
  }

  async function confirm(turn: Turn) {
    const a = turn.action;
    if (!a?.request) return;
    setCard(turn.id, { state: "running" });
    try {
      const out = await api<Record<string, unknown>>(a.request.url, { method: a.request.method, json: a.request.body });
      setCard(turn.id, resultOf(a, out));
      if (a.type === "create_workspace" || a.type === "add_person") await reload();
    } catch (e) {
      setCard(turn.id, { state: "failed", note: e instanceof ApiError || e instanceof Error ? e.message : "That didn't work. Try again." });
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(text);
  };

  return (
    <div className="assist">
      {turns.length > 0 && (
        <div className="assist-thread" ref={thread} aria-live="polite">
          {turns.map((t) => (
            <div key={t.id} className={`assist-msg ${t.role}`}>
              <div className="assist-bubble">{t.text}</div>
              {t.action && !t.action.confirm && t.action.href && (
                <Link className="btn small" href={t.action.href}>{t.action.title}</Link>
              )}
              {t.action?.confirm && t.card && <ActionCard action={t.action} card={t.card} onConfirm={() => confirm(t)} onCancel={() => setCard(t.id, { state: "cancelled" })} />}
            </div>
          ))}
          {thinking && (
            <div className="assist-msg assistant">
              <div className="assist-bubble muted"><Spinner /> Thinking…</div>
            </div>
          )}
        </div>
      )}
      <form className="assist-input" onSubmit={onSubmit}>
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          placeholder={me.user.admin ? "Ask about Sidekick, or say “create a workspace for Fabrikam”…" : "Ask how something works in Sidekick…"}
          aria-label="Message the Sidekick assistant"
        />
        <button className="btn primary" type="submit" disabled={thinking || !text.trim()}>{thinking ? <Spinner /> : "Send"}</button>
      </form>
      {error && <p className="err" style={{ margin: 0 }}>{error}</p>}
      {turns.length === 0 && (
        <div className="assist-chips">
          {suggestionsFor(me.user.role, me.user.admin).map((s) => (
            <button key={s} type="button" className="btn small ghost assist-chip" onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      )}
      <p className="assist-note muted">Answers questions about Sidekick. Anything that changes data waits for you to press Confirm. For questions about a project, use Ask Sidekick on Knowledge &amp; docs.</p>
    </div>
  );
}

/** What to show after an action succeeded, from that route's response. */
function resultOf(a: ReadyAction, out: Record<string, unknown>): CardState {
  switch (a.type) {
    case "create_workspace":
      return { state: "done", note: "Workspace created. You're its first member.", link: { href: "/workspaces", label: "Open Workspaces" } };
    case "add_person":
      return {
        state: "done",
        note: "Person added. Send them this temporary password privately; it's shown only once and they'll set their own when they sign in.",
        secret: typeof out.tempPassword === "string" ? out.tempPassword : undefined,
        link: { href: "/users", label: "Open Users & access" },
      };
    case "link_teams":
      return { state: "done", note: `Linked${out.name ? ` “${out.name}”` : ""}. Sidekick posted a confirmation in Teams.`, link: { href: "/connectors", label: "Open Connectors" } };
    case "refresh_map":
      return { state: "done", note: "Knowledge map refreshed.", link: { href: "/memory", label: "Open Memory & gaps" } };
    default:
      return { state: "done" };
  }
}

/** The confirm card: exactly what will happen, then Confirm / Cancel, then the outcome. */
function ActionCard({ action, card, onConfirm, onCancel }: { action: ReadyAction; card: CardState; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className={`assist-card ${card.state}`}>
      <b>{action.title}</b>
      <dl>
        {action.details.map((d) => (
          <div key={d.label}>
            <dt>{d.label}</dt>
            <dd>{d.value}</dd>
          </div>
        ))}
      </dl>
      {(card.state === "ready" || card.state === "running") && (
        <div className="actions">
          <button className="btn small primary" onClick={onConfirm} disabled={card.state === "running"}>{card.state === "running" ? <><Spinner /> Working</> : "Confirm"}</button>
          <button className="btn small" onClick={onCancel} disabled={card.state === "running"}>Cancel</button>
        </div>
      )}
      {card.state === "cancelled" && <span className="muted">Cancelled. Nothing was changed.</span>}
      {card.state === "failed" && <span className="err">{card.note}</span>}
      {card.state === "done" && (
        <>
          <span className="good-text">✓ {card.note}</span>
          {card.secret && <code className="assist-secret">{card.secret}</code>}
          {card.link && <Link className="btn small" href={card.link.href}>{card.link.label}</Link>}
        </>
      )}
    </div>
  );
}
