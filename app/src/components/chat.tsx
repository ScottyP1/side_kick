"use client";

/**
 * The pieces every assistant chat shares: the portal's in-app assistant (components/assistant.tsx), the Help
 * chat (support assistant, components/support-chat.tsx) and the website's help bot (components/helpbot.tsx).
 *
 * - `useConversation(url, kind)`: the conversation with one assistant. The server keeps the turns (24 hours,
 *   lib/conversations.ts); the browser only remembers the conversation's id (localStorage, per assistant), so
 *   the chat shows again on the next page and in every place that assistant appears (the home page chat and the
 *   bottom-left button share one). `send` posts a message, `reset` is "New conversation".
 * - `ChatThread`: the bubbles, the sources a reply cites, the "Following up on …" hint and a thinking bubble.
 *   It is a polite live region, so screen readers hear new replies.
 * - `ActionCard`: a confirm card for a proposed change (Confirm / Cancel). Only Confirm sends its fixed request,
 *   to the same API route the regular page uses. Cards restored from an earlier page are never re-armed.
 *
 * Nothing fails silently: problems show next to the chat, and network/server problems also open the problem
 * modal through `api()`.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, Spinner } from "./ui";

/** A proposed change, as the server checked it (lib/assistant.ts `ReadyAction`, lib/support-assistant.ts `ReadyFix`). */
export type ChatAction = {
  type: string;
  title: string;
  details: { label: string; value: string }[];
  confirm: boolean;
  request?: { method: "POST" | "PATCH"; url: string; body: Record<string, unknown> };
  href?: string;
};
/** Where a confirm card stands. */
export type CardState = { state: "ready" | "running" | "done" | "cancelled" | "failed"; note?: string; secret?: string; link?: { href: string; label: string } };
/** One turn as the chat shows it. Extra fields come from the server's reply (or the saved turn when restored). */
export type ChatTurn = {
  id: number;
  role: "user" | "assistant";
  text: string;
  sources?: { title: string; url: string | null }[];
  followUp?: string | null;
  action?: ChatAction | null;
  card?: CardState;
  /** A confirm card from before the page changed: shown as a note, never as buttons again. */
  suggested?: string | null;
  link?: { href: string; title: string } | null;
  checks?: { name: string; status: string; summary: string }[];
  faq?: { q: string; url: string }[];
  dontKnow?: boolean;
};

const storageKey = (kind: string) => `sidekick.conv.${kind}`;
const readId = (kind: string) => {
  try {
    return localStorage.getItem(storageKey(kind)) ?? "";
  } catch {
    return "";
  }
};
const writeId = (kind: string, id: string | null) => {
  try {
    if (id) localStorage.setItem(storageKey(kind), id);
    else localStorage.removeItem(storageKey(kind));
  } catch {}
};

/**
 * One conversation with an assistant at `url` (POST message, GET/DELETE `?conversation=`). `kind` names it in
 * localStorage. `restore` loads the saved turns once (call it when the chat is first shown).
 */
export function useConversation<R extends { conversation: string | null; reply: string }>(url: string, kind: string) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conversation, setConversation] = useState("");
  const nextId = useRef(1);
  const restored = useRef(false);

  const restore = useCallback(async () => {
    if (restored.current) return;
    restored.current = true;
    const id = readId(kind);
    if (!id) return;
    try {
      const r = await api<{ conversation: string | null; turns: Omit<ChatTurn, "id">[] }>(`${url}?conversation=${encodeURIComponent(id)}`);
      if (!r.conversation) return writeId(kind, null);
      setConversation(r.conversation);
      // Restored cards are history: shown as "suggested earlier", never as live buttons.
      setTurns(r.turns.map((t) => ({ ...t, action: null, id: nextId.current++ })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the conversation.");
    }
  }, [url, kind]);

  const send = useCallback(
    async (message: string, extra: Record<string, unknown> = {}): Promise<R | null> => {
      const m = message.trim();
      if (!m || thinking) return null;
      setError("");
      setNotice("");
      setTurns((ts) => [...ts, { id: nextId.current++, role: "user", text: m }]);
      setThinking(true);
      try {
        const r = await api<R & Partial<ChatTurn>>(url, { method: "POST", json: { message: m, conversation: conversation || readId(kind) || undefined, ...extra } });
        if (r.conversation) {
          setConversation(r.conversation);
          writeId(kind, r.conversation);
        }
        setTurns((ts) => [...ts, { ...r, id: nextId.current++, role: "assistant", text: r.reply, card: r.action?.confirm ? { state: "ready" } : undefined }]);
        return r;
      } catch (e) {
        // A restriction or pause is a calm notice; other refusals (too long, limits) show as errors here.
        if (e instanceof ApiError && (e.kind === "restricted" || e.kind === "paused")) setNotice(e.message);
        else setError(e instanceof Error ? e.message : "The assistant couldn't answer. Try again.");
        return null;
      } finally {
        setThinking(false);
      }
    },
    [url, kind, conversation, thinking],
  );

  const reset = useCallback(async () => {
    const id = conversation || readId(kind);
    setTurns([]);
    setError("");
    setNotice("");
    setConversation("");
    writeId(kind, null);
    if (id) {
      try {
        await api(`${url}?conversation=${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't end the conversation on the server.");
      }
    }
  }, [url, kind, conversation]);

  const setCard = useCallback((id: number, card: CardState) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, card } : t))), []);

  return { turns, thinking, error, notice, conversation, send, reset, restore, setCard };
}

/** The thinking bubble: a spinner and labels that change every 1.8 seconds; screen readers hear one "Thinking". */
export function ThinkingBubble({ labels }: { labels: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(n + 1, labels.length - 1)), 1800);
    return () => clearInterval(t);
  }, [labels.length]);
  return (
    <div className="assist-bubble muted assist-thinking" role="status" aria-label="Thinking">
      <Spinner />
      <span key={i} className="assist-thinking-label" aria-hidden="true">{labels[i]}…</span>
    </div>
  );
}

/**
 * The conversation: bubbles, follow-up hints, cited sources and whatever `extra` adds under a reply (confirm
 * cards, checks). Scrolls to the newest turn.
 */
export function ChatThread({ turns, thinking, labels, extra, className = "" }: { turns: ChatTurn[]; thinking: boolean; labels: string[]; extra?: (t: ChatTurn) => ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);
  if (!turns.length && !thinking) return null;
  return (
    <div className={`assist-thread ${className}`} ref={ref} aria-live="polite">
      {turns.map((t) => (
        <div key={t.id} className={`assist-msg ${t.role}`}>
          {t.role === "assistant" && t.followUp && <span className="chat-followup">Following up on: “{t.followUp}”</span>}
          <div className="assist-bubble">{t.text}</div>
          {t.role === "assistant" && t.sources && t.sources.length > 0 && (
            <div className="chat-sources">
              <span className="muted">Sources:</span>
              {t.sources.map((s) => (s.url ? <Link key={s.title} href={s.url}>{s.title}</Link> : <span key={s.title}>{s.title}</span>))}
            </div>
          )}
          {t.role === "assistant" && t.suggested && !t.action && <span className="muted chat-small">Suggested earlier: {t.suggested}. Ask again to do it.</span>}
          {t.role === "assistant" && t.link && !t.action && <Link className="btn small" href={t.link.href}>{t.link.title}</Link>}
          {extra?.(t)}
        </div>
      ))}
      {thinking && (
        <div className="assist-msg assistant">
          <ThinkingBubble labels={labels} />
        </div>
      )}
    </div>
  );
}

/** The confirm card: exactly what will happen, then Confirm / Cancel, then the outcome. */
export function ActionCard({ action, card, onConfirm, onCancel }: { action: ChatAction; card: CardState; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className={`assist-card ${card.state}`}>
      <b>{action.title}</b>
      {action.details.length > 0 && (
        <dl>
          {action.details.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
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

/**
 * Runs a confirmed action's fixed request and turns the route's answer into the card's outcome (`done` comes
 * from `resultOf`). A refusal from the route shows on the card.
 */
export async function runAction(action: ChatAction, resultOf: (out: Record<string, unknown>) => CardState): Promise<CardState> {
  if (!action.request) return { state: "failed", note: "Nothing to run." };
  try {
    const out = await api<Record<string, unknown>>(action.request.url, { method: action.request.method, json: action.request.body });
    return resultOf(out);
  } catch (e) {
    return { state: "failed", note: e instanceof Error ? e.message : "That didn't work. Try again." };
  }
}

/** The message box and Send button. `inputRef` lets a panel focus it when it opens. */
export function ChatInput({ onSend, busy, placeholder, label, max = 1000, inputRef }: { onSend: (text: string) => void; busy: boolean; placeholder: string; label: string; max?: number; inputRef?: React.Ref<HTMLInputElement> }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };
  return (
    <form className="assist-input" onSubmit={submit}>
      <input ref={inputRef} className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={max} placeholder={placeholder} aria-label={label} />
      <button className="btn primary" type="submit" disabled={busy || !text.trim()}>{busy ? <Spinner /> : "Send"}</button>
    </form>
  );
}
