"use client";

/**
 * "Ask about Sidekick": the website's help bot behind the bottom-left button on every public page (rendered by
 * components/site-chat-slot.tsx). It says up front that it's an AI, answers from public help content with links
 * to its sources, keeps the conversation across pages (POST/GET/DELETE /api/help-bot; the server ties it to this
 * browser and keeps it 24 hours), shows FAQ answers when it can't use AI right now, and **Talk to a human** opens
 * a short form that creates a support ticket (POST /api/support/public) with the conversation attached. Every
 * rule it follows is in lib/helpbot.ts.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChatInput, ChatThread, useConversation, type ChatTurn } from "./chat";
import { Dock } from "./dock";
import { api, Spinner } from "./ui";

type BotReply = { conversation: string | null; reply: string; mode: "answer" | "faq"; faq?: ChatTurn["faq"]; dontKnow: boolean };

const LABELS = ["Reading your question", "Looking through the help center", "Writing a short answer"];
const STARTERS = ["What does Sidekick do?", "How much does it cost?", "Is our data used to train AI?", "How do I add Sidekick to Teams?"];

/** The website's assistant button and the help bot panel. */
export function HelpBotDock() {
  const [open, setOpen] = useState(false);
  const [human, setHuman] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const chat = useConversation<BotReply>("/api/help-bot", "helpbot");
  const { restore } = chat;

  useEffect(() => {
    if (open) restore();
  }, [open, restore]);

  return (
    <Dock open={open} setOpen={setOpen} label="Ask about Sidekick" title="Ask about Sidekick" focusRef={input}>
      <p className="muted chat-small" style={{ margin: 0 }}>
        I&apos;m an AI assistant. I answer questions about Sidekick from the <Link href="/docs">help center</Link> and <Link href="/faq">FAQ</Link>, and I can be wrong. Please don&apos;t share personal details here.
      </p>
      <ChatThread
        turns={chat.turns}
        thinking={chat.thinking}
        labels={LABELS}
        extra={(t) =>
          t.faq?.length ? (
            <ul className="chat-faq">
              {t.faq.map((f) => <li key={f.url}><Link href={f.url}>{f.q}</Link></li>)}
            </ul>
          ) : t.dontKnow ? (
            <button type="button" className="btn small" onClick={() => setHuman(true)}>Talk to a human</button>
          ) : null
        }
      />
      {!human && <ChatInput inputRef={input} onSend={(m) => chat.send(m)} busy={chat.thinking} placeholder="Ask about Sidekick…" label="Ask about Sidekick" max={500} />}
      {chat.error && <p className="err" style={{ margin: 0 }}>{chat.error}</p>}
      {chat.notice && <p className="muted" role="status" style={{ margin: 0 }}>{chat.notice}</p>}
      {chat.turns.length === 0 && !human && (
        <div className="assist-chips">
          {STARTERS.map((s) => <button key={s} type="button" className="btn small ghost assist-chip" onClick={() => chat.send(s)}>{s}</button>)}
        </div>
      )}
      {human ? (
        <HumanForm conversation={chat.conversation} onClose={() => setHuman(false)} />
      ) : (
        <div className="chat-tools">
          <button type="button" className="btn small" onClick={() => setHuman(true)}>Talk to a human</button>
          {chat.turns.length > 0 && <button type="button" className="btn small ghost" onClick={chat.reset} disabled={chat.thinking}>New conversation</button>}
        </div>
      )}
    </Dock>
  );
}

/** "Talk to a human": name, email and the question, sent as a support ticket with the conversation. */
function HumanForm({ conversation, onClose }: { conversation: string; onClose: () => void }) {
  const [f, setF] = useState({ name: "", email: "", description: "", website: "" });
  const [state, setState] = useState<{ s: "idle" | "busy" | "done" | "failed"; msg?: string }>({ s: "idle" });
  const page = usePathname();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ s: "busy" });
    try {
      const r = await api<{ ref?: string }>("/api/support/public", { method: "POST", json: { ...f, subject: f.description.slice(0, 80) || "Question from the website", category: "question", page, conversation: conversation || undefined } });
      setState({ s: "done", msg: r.ref ? `Thanks. Your reference is ${r.ref}; the Sidekick team will reply by email, usually within two working days.` : "Thanks, we've got it." });
    } catch (x) {
      setState({ s: "failed", msg: x instanceof Error ? x.message : "Couldn't send it. Try again." });
    }
  };
  if (state.s === "done") return <div className="callout info" role="status"><span>{state.msg} <button type="button" className="linkish" onClick={onClose}>Back to the chat</button></span></div>;
  return (
    <form className="chat-human" onSubmit={submit}>
      <b>Talk to a human</b>
      <span className="muted chat-small">We&apos;ll reply by email. {conversation ? "This conversation is attached so you don't have to repeat yourself." : ""}</span>
      <label className="field"><span>Your name</span><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>Email</span><input className="input" type="email" required maxLength={200} autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label className="field"><span>How can we help?</span><textarea className="input" required minLength={10} maxLength={4000} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      {/* Honeypot: hidden from people (and screen readers); bots that fill every field are dropped quietly. */}
      <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></label>
      {state.s === "failed" && <p className="err" style={{ margin: 0 }}>{state.msg}</p>}
      <div className="chat-tools">
        <button className="btn small primary" type="submit" disabled={state.s === "busy"}>{state.s === "busy" ? <><Spinner /> Sending</> : "Send"}</button>
        <button className="btn small ghost" type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
