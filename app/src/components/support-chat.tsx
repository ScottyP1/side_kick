"use client";

/**
 * The Help chat (the support assistant, lib/support-assistant.ts): opened from the bottom-left assistant
 * button → "I need help". It answers from the help guides and support articles, checks the person's own setup
 * (shown under each reply as "What I checked"), offers safe fixes behind Confirm, and **Turn this into a
 * ticket** sends the conversation, with what was checked, to the Sidekick team (POST /api/support/tickets).
 * Follow-ups build on the conversation; **New conversation** starts over.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type Ref } from "react";
import { ActionCard, ChatInput, ChatThread, runAction, useConversation, type ChatAction, type ChatTurn } from "./chat";
import { api, Icon, Spinner } from "./ui";
import { BRAND } from "@/lib/brand";

type SupportReply = { conversation: string; reply: string; action: ChatAction | null; followUp: string | null; checks: ChatTurn["checks"] };

const LABELS = ["Reading your question", "Checking your setup", "Looking through the help articles", "Drafting a reply", "Almost there"];
const STARTERS = [`${BRAND.name} doesn't answer in our Teams chat`, "Why is the assistant paused?", "I saw an error with a reference code", "Someone can't sign in"];

/** Status words for the checks list. */
const STATUS: Record<string, string> = { ok: "OK", warn: "Check", problem: "Problem", info: "Info" };

/** The Help chat. `inputRef` lets the panel focus the message box when it opens. */
export function SupportChat({ inputRef }: { inputRef?: Ref<HTMLInputElement> }) {
  const chat = useConversation<SupportReply>("/api/support/assistant", "support");
  const { restore } = chat;
  const path = usePathname();
  const [ticket, setTicket] = useState<{ state: "idle" | "busy" | "done" | "failed"; ref?: string; id?: string; note?: string }>({ state: "idle" });

  useEffect(() => {
    restore();
  }, [restore]);

  async function confirm(turn: ChatTurn) {
    if (!turn.action) return;
    chat.setCard(turn.id, { state: "running" });
    chat.setCard(turn.id, await runAction(turn.action, () => ({ state: "done", note: turn.action!.type === "turn_on_tracking" ? `Tracking is on. ${BRAND.name} told the chat.` : "Done." })));
  }

  async function makeTicket() {
    setTicket({ state: "busy" });
    try {
      const r = await api<{ ticket: { id: string; ref: string } }>("/api/support/tickets", { method: "POST", json: { conversation: chat.conversation, page: path } });
      setTicket({ state: "done", ref: r.ticket.ref, id: r.ticket.id });
    } catch (e) {
      setTicket({ state: "failed", note: e instanceof Error ? e.message : "Couldn't open the ticket." });
    }
  }

  return (
    <div className="assist">
      {chat.turns.length === 0 && <p className="muted chat-small" style={{ margin: 0 }}>Tell me what isn&apos;t working. I&apos;ll check your setup and the help articles, and you can turn this into a ticket for the {BRAND.name} team at any time.</p>}
      <ChatThread
        turns={chat.turns}
        thinking={chat.thinking}
        labels={LABELS}
        extra={(t) => (
          <>
            {t.role === "assistant" && t.checks && t.checks.length > 0 && (
              <details className="chat-checks">
                <summary>What I checked</summary>
                <ul>
                  {t.checks.map((c) => (
                    <li key={c.name}><span className={`pill ${c.status === "ok" ? "good" : c.status === "problem" ? "bad" : c.status === "warn" ? "warn" : ""}`}>{STATUS[c.status] ?? c.status}</span> <b>{c.name}:</b> {c.summary}</li>
                  ))}
                </ul>
              </details>
            )}
            {t.action && !t.action.confirm && t.action.href && <Link className="btn small" href={t.action.href}>{t.action.title}</Link>}
            {t.action?.confirm && t.card && <ActionCard action={t.action} card={t.card} onConfirm={() => confirm(t)} onCancel={() => chat.setCard(t.id, { state: "cancelled" })} />}
          </>
        )}
      />
      <ChatInput inputRef={inputRef} onSend={(m) => { setTicket({ state: "idle" }); chat.send(m, { page: path }); }} busy={chat.thinking} placeholder="Describe the problem…" label="Message the Help assistant" />
      {chat.error && <p className="err" style={{ margin: 0 }}>{chat.error}</p>}
      {chat.notice && <div className="callout info" role="status"><Icon n="lock" /><div>{chat.notice} <Link href="/help">Contact support</Link></div></div>}
      {chat.turns.length === 0 ? (
        <div className="assist-chips">
          {STARTERS.map((s) => <button key={s} type="button" className="btn small ghost assist-chip" onClick={() => chat.send(s, { page: path })}>{s}</button>)}
        </div>
      ) : (
        <div className="chat-tools">
          {ticket.state === "done" ? (
            <span className="good-text" role="status">✓ Ticket {ticket.ref} opened. <Link href={`/help/tickets/${ticket.id}`}>Open it</Link></span>
          ) : (
            <button type="button" className="btn small" onClick={makeTicket} disabled={ticket.state === "busy" || chat.thinking || !chat.conversation}>{ticket.state === "busy" ? <><Spinner /> Opening</> : "Turn this into a ticket"}</button>
          )}
          <button type="button" className="btn small ghost" onClick={() => { setTicket({ state: "idle" }); chat.reset(); }} disabled={chat.thinking}>New conversation</button>
        </div>
      )}
      {ticket.state === "failed" && <p className="err" style={{ margin: 0 }}>{ticket.note}</p>}
    </div>
  );
}
