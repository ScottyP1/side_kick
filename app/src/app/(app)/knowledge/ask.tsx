"use client";

/**
 * Ask Sidekick on the Knowledge page (`AskPanel`), with follow-ups, filters, 👍/👎 and, for Org Owners/Admins, the
 * answer-quality counts. The server keeps the conversation (POST/GET/DELETE /api/ask, lib/sidekick.ts); this panel
 * only remembers its id in sessionStorage per group and guests setting, so it survives a page change in this tab.
 */

import { useCallback, useEffect, useState } from "react";
import { api, CitedText, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { BRAND } from "@/lib/brand";

type Source = { id: string; title: string; loc: string; type: string; excerpt?: string; origin?: "group" | "firm"; date?: string | null; outdated?: string | null };
type Answer = {
  found: boolean;
  answer: string;
  blocked?: string | null;
  sources: Source[];
  conflict?: boolean;
  questionId?: string | null;
  conversation?: string;
  followUp?: string | null;
};
/** One exchange shown in the panel: what was typed and the answer. */
type Exchange = { question: string; answer: Answer; vote?: "up" | "down" };
/** A saved turn as GET /api/ask returns it (lib/conversations.ts `turnsForBrowser`). */
type Turn = { role: "user" | "assistant"; text: string; followUp?: string | null; found?: boolean; conflict?: boolean; questionId?: string | null; sources?: Source[] };
type Quality = { total: { up: number; down: number; helpful: number | null }; answers: { total: number; dontKnow: number }; groups: { id: string; name: string; up: number; down: number; helpful: number | null }[] };

/** The type filters Ask offers (keys match FILTER_TYPES in lib/search.ts). */
const FILTERS: [string, string][] = [["documents", "Documents"], ["meetings", "Meetings"], ["chats", "Teams chats"], ["decisions", "Decisions & notes"], ["firm", "Firm library"]];

const storeKey = (ws: string, guests: boolean) => `sk_ask:${ws}:${guests ? "guests" : "team"}`;
const readStore = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeStore = (k: string, v: string | null) => {
  try {
    if (v) sessionStorage.setItem(k, v);
    else sessionStorage.removeItem(k);
  } catch {
    /* private mode: the conversation just isn't restored after a page change */
  }
};

/** Rebuilds the exchanges from saved turns (user turn, then the assistant's). */
function fromTurns(turns: Turn[]): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i + 1 < turns.length; i += 2) {
    const a = turns[i + 1];
    out.push({ question: turns[i].text, answer: { found: Boolean(a.found), answer: a.text, sources: a.sources ?? [], conflict: a.conflict, questionId: a.questionId ?? null, followUp: a.followUp ?? null } });
  }
  return out;
}

/** One cited source line: "Firm policy ·" for the firm library, its location, and an outdated flag. */
function SourceLine({ s }: { s: Source }) {
  return (
    <div className="li" style={{ padding: "8px 12px" }}>
      <span className="cite">{s.id}</span>
      <div className="grow">
        {s.origin === "firm" && <Pill kind="info" nodot>Firm policy</Pill>}{" "}
        <b style={{ fontSize: 13 }}>{s.title}</b>
        {s.loc && <span className="muted" style={{ fontSize: 12 }}> · {s.loc}</span>}
        {s.date && <span className="muted" style={{ fontSize: 12 }}> · {s.date}</span>}
        {s.outdated && <div style={{ fontSize: 12, color: "var(--warn)" }}>May be out of date: {s.outdated}</div>}
        {s.excerpt && <div className="muted" style={{ fontSize: 12.5 }}>{s.excerpt}…</div>}
      </div>
    </div>
  );
}

/**
 * The Ask panel for one group. `admin` shows the answer-quality counts; `onAsked` lets the page refresh its
 * question counts after each answer.
 */
export function AskPanel({ ws, admin, onAsked }: { ws: string; admin: boolean; onAsked: () => void }) {
  const toast = useToast();
  const reportError = useReportError();
  const [q, setQ] = useState("");
  const [guests, setGuests] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState("");
  const [conversation, setConversation] = useState<string | null>(null);
  const [thread, setThread] = useState<Exchange[]>([]);
  const [quality, setQuality] = useState<Quality | null>(null);

  // Restore this tab's conversation for the group and guests setting.
  useEffect(() => {
    const id = readStore(storeKey(ws, guests));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the group or guests setting changes
    setConversation(id);
    setThread([]);
    if (!id) return;
    api<{ conversation: string | null; turns: Turn[] }>(`/api/ask?ws=${ws}&guests=${guests ? 1 : 0}&conversation=${encodeURIComponent(id)}`)
      .then((r) => {
        setConversation(r.conversation);
        setThread(fromTurns(r.turns));
        if (!r.conversation) writeStore(storeKey(ws, guests), null);
      })
      .catch(reportError);
  }, [ws, guests, reportError]);

  const loadQuality = useCallback(async () => {
    if (admin) setQuality(await api<Quality>("/api/feedback?days=30"));
  }, [admin]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    loadQuality().catch(reportError);
  }, [loadQuality, reportError]);

  const askNow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setAsking(true);
    setErr("");
    try {
      const a = await api<Answer>("/api/ask", {
        method: "POST",
        json: { ws, question: q, guests, conversation, types: types.length ? types : undefined, since: since || undefined, until: until || undefined },
      });
      setThread((t) => [...(a.conversation === conversation ? t : []), { question: q, answer: a }]);
      setConversation(a.conversation ?? null);
      writeStore(storeKey(ws, guests), a.conversation ?? null);
      setQ("");
      onAsked();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Couldn't get an answer.");
    } finally {
      setAsking(false);
    }
  };

  const newQuestion = async () => {
    const id = conversation;
    setConversation(null);
    setThread([]);
    writeStore(storeKey(ws, guests), null);
    if (id) await api(`/api/ask?ws=${ws}&guests=${guests ? 1 : 0}&conversation=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(reportError);
  };

  const vote = async (i: number, v: "up" | "down") => {
    const ex = thread[i];
    if (!ex.answer.questionId) return;
    setThread((t) => t.map((x, j) => (j === i ? { ...x, vote: v } : x)));
    try {
      await api("/api/feedback", { method: "POST", json: { ws, questionId: ex.answer.questionId, vote: v } });
      toast(v === "up" ? "Thanks, glad it helped" : "Thanks. Your admins can see which answers weren't helpful");
      loadQuality().catch(reportError);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save your feedback.", "error");
    }
  };

  const toggleType = (t: string) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const filtered = types.length > 0 || Boolean(since) || Boolean(until);
  const latest = thread.at(-1);

  return (
    <div className="panel">
      <div className="panel-h" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>Ask {BRAND.name}</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} />
            Client guests are present (use Shareable sources only)
          </label>
          {thread.length > 0 && <button className="btn small" type="button" onClick={newQuestion}>New question</button>}
        </div>
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {thread.slice(0, -1).map((ex, i) => (
          <div key={i} className="muted" style={{ fontSize: 13, borderLeft: "2px solid var(--line)", paddingLeft: 10 }}>
            <b>You asked:</b> {ex.question}
            <div style={{ marginTop: 2 }}><CitedText text={ex.answer.answer} /></div>
          </div>
        ))}
        {latest && (
          <div className="answer">
            <div className="muted" style={{ fontSize: 13 }}><b>You asked:</b> {latest.question}</div>
            {latest.answer.followUp && <div className="muted" style={{ fontSize: 12.5 }}>Following up on “{latest.answer.followUp}”</div>}
            {latest.answer.blocked ? (
              <Pill kind="warn">Refused by your organization&apos;s guardrails (see Guardrails)</Pill>
            ) : (
              !latest.answer.found && <Pill kind="hand">No answer in your sources. Logged as a knowledge gap</Pill>
            )}
            {latest.answer.conflict && <Pill kind="warn">The sources disagree: both are cited</Pill>}
            <p style={{ margin: 0 }}>
              <CitedText text={latest.answer.answer} />
            </p>
            {latest.answer.sources.length > 0 && (
              <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
                {latest.answer.sources.map((s) => <SourceLine key={s.id} s={s} />)}
              </div>
            )}
            {latest.answer.questionId && (
              <div className="actions" style={{ alignItems: "center" }}>
                <span className="muted" style={{ fontSize: 12.5 }}>Was this helpful?</span>
                <div className="seg" style={{ fontSize: 12 }}>
                  <button type="button" aria-pressed={latest.vote === "up"} aria-label="Helpful" onClick={() => vote(thread.length - 1, "up")}>👍</button>
                  <button type="button" aria-pressed={latest.vote === "down"} aria-label="Not helpful" onClick={() => vote(thread.length - 1, "down")}>👎</button>
                </div>
              </div>
            )}
          </div>
        )}
        <form style={{ display: "flex", gap: 8 }} onSubmit={askNow}>
          <input
            className="input"
            placeholder={thread.length ? "Ask a follow-up, e.g. “and who owns the rollback?”" : "e.g. What did we decide about the cutover date?"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Question"
          />
          <button className="btn primary" type="submit" disabled={asking || !q.trim()}>{asking ? <><Spinner /> Thinking</> : "Ask"}</button>
        </form>
        {err && <p className="err">{err}</p>}
        <div>
          <button className="btn small ghost" type="button" aria-expanded={showFilters} onClick={() => setShowFilters((x) => !x)}>
            {showFilters ? "Hide filters" : "Filters"}{filtered ? " (on)" : ""}
          </button>
          {showFilters && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              <div className="seg" role="group" aria-label="Only these sources">
                {FILTERS.map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={types.includes(key)} onClick={() => toggleType(key)}>{label}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                <label>From <input className="input" type="date" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: "auto" }} /></label>
                <label>To <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={{ width: "auto" }} /></label>
                {filtered && <button className="btn small ghost" type="button" onClick={() => { setTypes([]); setSince(""); setUntil(""); }}>Clear filters</button>}
              </div>
              <span className="muted" style={{ fontSize: 12.5 }}>No type picked = everything. Dates: when a document was added, a meeting held, a chat message sent, or a firm document took effect.</span>
            </div>
          )}
        </div>
        {admin && quality && (quality.total.up + quality.total.down > 0 || quality.answers.total > 0) && (
          <div className="muted" style={{ fontSize: 12.5 }}>
            Answer quality, last 30 days (your whole organization): {quality.answers.total} answers, {quality.answers.dontKnow} “I don&apos;t know”, {quality.total.up} 👍 and {quality.total.down} 👎
            {quality.total.helpful !== null && ` (${quality.total.helpful}% helpful)`}.
          </div>
        )}
      </div>
    </div>
  );
}
