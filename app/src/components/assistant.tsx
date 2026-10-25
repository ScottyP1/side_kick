"use client";

/**
 * The in-app assistant chat: under the crystal ball on the home page (see live-orb.tsx) and in the
 * bottom-left assistant button on every portal page (components/assistant-dock.tsx). Both show the same
 * conversation (kept on the server for 24 hours, lib/conversations.ts), so a follow-up builds on what was
 * said on another page; **New conversation** starts over.
 *
 * The person types a question or a request; POST /api/assistant replies, and may attach one proposed
 * action (create a workspace, add a person, link a Teams chat, refresh a knowledge map, open a page),
 * already limited to what their role allows. Actions are confirm-first: a card lists exactly what will
 * happen, and only Confirm sends the request, to the same API route the regular page uses (so role
 * checks and the audit log apply as usual). Cancel does nothing. Results and refusals appear in the card;
 * network/server problems also open the problem modal, so nothing fails silently.
 * While a reply is on its way, the "thinking" bubble steps through short labels so the wait feels alive.
 */
import Link from "next/link";
import { useEffect, type Ref } from "react";
import { useApp } from "./shell";
import { ActionCard, ChatInput, ChatThread, runAction, useConversation, type CardState, type ChatAction, type ChatTurn } from "./chat";
import { Icon } from "./ui";
import { BRAND } from "@/lib/brand";

/** Starter prompts, by what the person's role can do. */
function suggestionsFor(role: string, admin: boolean): string[] {
  if (admin) return ["Create a workspace", "Add a person to a workspace", "Link a Teams chat", "What did we spend on AI this month?"];
  if (role === "Viewer") return ["What can my role do?", "How do I find a decision from a meeting?", "What are knowledge gaps?"];
  return ["How do I add a past meeting?", "Refresh the knowledge map", `How do I use ${BRAND.name} in Teams?`];
}

/** What the thinking bubble cycles through, in order (the last one repeats until the reply arrives). */
const THINKING_LABELS = ["Reading your question", "Checking what your role allows", `Looking through how ${BRAND.name} works`, "Weighing the options", "Drafting a reply", "Double-checking the details", "Almost there"];

type AssistReply = { conversation: string; reply: string; action: ChatAction | null; followUp: string | null };

/**
 * The chat box. `onThinking` tells the crystal ball to speed up while a reply is on its way; `inputRef` lets
 * the assistant button focus the message box when it opens; `compact` drops the footnote (the button's panel).
 */
export function Assistant({ onThinking, inputRef, compact }: { onThinking?: (on: boolean) => void; inputRef?: Ref<HTMLInputElement>; compact?: boolean }) {
  const { me, reload } = useApp();
  const chat = useConversation<AssistReply>("/api/assistant", "assist");
  const { restore, thinking } = chat;

  useEffect(() => {
    restore();
  }, [restore]);
  useEffect(() => onThinking?.(thinking), [thinking, onThinking]);

  async function confirm(turn: ChatTurn) {
    const a = turn.action;
    if (!a?.request) return;
    chat.setCard(turn.id, { state: "running" });
    const card = await runAction(a, (out) => resultOf(a, out));
    chat.setCard(turn.id, card);
    if (card.state === "done" && (a.type === "create_workspace" || a.type === "add_person")) await reload();
  }

  return (
    <div className="assist">
      <ChatThread
        turns={chat.turns}
        thinking={thinking}
        labels={THINKING_LABELS}
        extra={(t) => (
          <>
            {t.action && !t.action.confirm && t.action.href && <Link className="btn small" href={t.action.href}>{t.action.title}</Link>}
            {t.action?.confirm && t.card && <ActionCard action={t.action} card={t.card} onConfirm={() => confirm(t)} onCancel={() => chat.setCard(t.id, { state: "cancelled" })} />}
          </>
        )}
      />
      <ChatInput
        inputRef={inputRef}
        onSend={(m) => chat.send(m)}
        busy={thinking}
        placeholder={me.user.admin ? `Ask about ${BRAND.name}, or say “create a workspace for Fabrikam”…` : `Ask how something works in ${BRAND.name}…`}
        label={`Message the ${BRAND.name} assistant`}
      />
      {chat.error && <p className="err" style={{ margin: 0 }}>{chat.error}</p>}
      {chat.notice && <div className="callout info" role="status"><Icon n="lock" /><div>{chat.notice}</div></div>}
      {chat.turns.length === 0 ? (
        <div className="assist-chips">
          {suggestionsFor(me.user.role, me.user.admin).map((s) => (
            <button key={s} type="button" className="btn small ghost assist-chip" onClick={() => chat.send(s)}>{s}</button>
          ))}
        </div>
      ) : (
        <div className="chat-tools">
          <button type="button" className="btn small ghost" onClick={chat.reset} disabled={thinking}>New conversation</button>
        </div>
      )}
      {!compact && <p className="assist-note muted">Answers questions about {BRAND.name}. Anything that changes data waits for you to press Confirm. For questions about a project, use Ask {BRAND.name} on Knowledge &amp; docs.</p>}
    </div>
  );
}

/** What to show after an action succeeded, from that route's response. */
function resultOf(a: ChatAction, out: Record<string, unknown>): CardState {
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
      return { state: "done", note: `Linked${out.name ? ` “${out.name}”` : ""}. ${BRAND.name} posted a confirmation in Teams.`, link: { href: "/workspaces", label: "Open Workspaces" } };
    case "refresh_map":
      return { state: "done", note: "Knowledge map refreshed.", link: { href: "/memory", label: "Open Memory & gaps" } };
    default:
      return { state: "done" };
  }
}
