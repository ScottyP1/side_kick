"use client";
/**
 * The website's picture of Sidekick in a Teams group chat: a made-up conversation drawn in HTML (not a screenshot),
 * so it's sharp on every screen and readable at any size. It plays a short loop: someone asks the team, someone
 * mentions @Sidekick, "Sidekick is typing", the answer card with numbered sources arrives, a thumbs-up, and later the
 * meeting notes card with decisions and action items (Assign / Mark done), then the next morning's reminder of what's
 * still open. Then it starts again.
 *
 * Same made-up Contoso Retail story and people as the meeting picture (components/meeting-demo.tsx), in Sidekick's
 * own colours, never Microsoft's artwork; the pages say "Teams" only in text. Care taken: the loop runs only while
 * on screen, people who prefer reduced motion see the finished conversation, and the messages are real text.
 * Used on the public Features page. No data, no requests.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BRAND } from "@/lib/brand";

type Who = "maria" | "priya" | "sk";
type Card =
  | { kind: "answer"; title: string; body: string; sources: string[] }
  | { kind: "notes"; title: string; decisions: string[]; actions: [string, string, string][] }
  | { kind: "reminder"; title: string; items: [string, string, string][] };
type Msg = { who: Who; time: string; text?: string; card?: Card; react?: string };
type Beat = { at: number; msg?: Msg; typing?: boolean; react?: { index: number; emoji: string } };

const PEOPLE: Record<Exclude<Who, "sk">, { name: string; initials: string; color: string }> = {
  maria: { name: "Maria Chen", initials: "MC", color: "#7c5cff" },
  priya: { name: "Priya Raman", initials: "PR", color: "#1d7f8c" },
};

/** The script. */
const BEATS: Beat[] = [
  { at: 0, msg: { who: "maria", time: "9:12 AM", text: "Store managers keep asking me about wave 2. What's the latest?" } },
  { at: 1200, msg: { who: "priya", time: "9:13 AM", text: `@${BRAND.name} when is the wave 2 cutover, how many stores, and who owns the rollback?` } },
  { at: 2200, typing: true },
  {
    at: 4600,
    typing: false,
    msg: {
      who: "sk",
      time: "9:13 AM",
      card: {
        kind: "answer",
        title: "When is the wave 2 cutover, how many stores, and who owns the rollback?",
        body: "The cutover moved from Wed Nov 5 to **Thu Nov 12**, which Jordan confirmed on Oct 15 [1][2]. The plan is **48 stores**, possibly 52 because two regions asked to join [3]. **Dev Patel** owns the rollback from Oct 15, but the RAID log still lists it as open [4].",
        sources: ["Meeting: Sprint 14 planning · 00:01:21", "Wave 2 cutover runbook v0.3.md", "Contoso SOW v3 – summary.md", "RAID log.csv"],
      },
    },
  },
  { at: 7600, react: { index: 2, emoji: "👍 2" } },
  { at: 8600, msg: { who: "maria", time: "9:14 AM", text: "Perfect, sending that to the store managers now." } },
  {
    at: 11000,
    msg: {
      who: "sk",
      time: "10:31 AM",
      card: {
        kind: "notes",
        title: "Meeting notes · Wave 2 check-in",
        decisions: ["Keep Thursday, November 12 unless PCI testing fails", "Send the cutover notice to store ops by Friday"],
        actions: [["Update the runbook with the new date", "Priya Raman", "Wed"], ["Find two more store managers for the pilot", "Unassigned", "No date"]],
      },
    },
  },
  {
    at: 14500,
    msg: {
      who: "sk",
      time: "Mon 9:00 AM",
      card: {
        kind: "reminder",
        title: "Still open for the team",
        items: [
          ["Overdue action item", "Send the updated cutover date to all store managers (Priya Raman, was due Oct 16).", "Meeting: Sprint 14 planning"],
          ["Out of date", "Runbook v0.3 still says the cutover is Wed Nov 5; it moved to Thu Nov 12.", "Wave 2 cutover runbook v0.3.md"],
        ],
      },
    },
  },
];
const LOOP_MS = 21000;

const reducedQuery = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (cb: () => void) => {
  const m = window.matchMedia(reducedQuery);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

/** The conversation after the beats up to `t` ms. */
function stateAt(t: number) {
  const s = { msgs: [] as Msg[], typing: false };
  for (const b of BEATS) {
    if (b.at > t) break;
    if (b.msg) s.msgs.push({ ...b.msg });
    if (b.typing !== undefined) s.typing = b.typing;
    if (b.react && s.msgs[b.react.index]) s.msgs[b.react.index] = { ...s.msgs[b.react.index], react: b.react.emoji };
  }
  return s;
}
const FINAL = stateAt(Infinity);

/** "**bold**" and "[n]" markers to elements (the only formatting the script uses). */
function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\[\d\])/).map((part, i) =>
    part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : /^\[\d\]$/.test(part) ? <span key={i} className="chat-cite">{part}</span> : part,
  );
}

function Avatar({ who }: { who: Who }) {
  if (who === "sk") return <span className="chat-av sk" aria-hidden="true"><svg viewBox="0 0 256 256"><circle cx="128" cy="128" r="96" fill="none" stroke="#fff" strokeWidth="18" /><path d="M44 150 C72 184 101 184 128 160 C155 138 179 125 213 137" fill="none" stroke="#A7A3FF" strokeWidth="28" strokeLinecap="round" /></svg></span>;
  return <span className="chat-av" style={{ background: PEOPLE[who].color }} aria-hidden="true">{PEOPLE[who].initials}</span>;
}

/** The looping group chat (see the file comment). `caption` is a line under it. */
export function ChatDemo({ caption }: { caption?: string }) {
  const reduced = useSyncExternalStore(subscribeReduced, () => window.matchMedia(reducedQuery).matches, () => false);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "100px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || reduced) return;
    const next = BEATS.find((b) => b.at > t)?.at ?? LOOP_MS;
    const id = setTimeout(() => setT(next >= LOOP_MS ? 0 : next), next - t);
    return () => clearTimeout(id);
  }, [t, visible, reduced]);

  const s = reduced ? FINAL : stateAt(t);
  useEffect(() => {
    const c = body.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [s.msgs.length, s.typing, reduced]);

  return (
    <figure className="site-shot" style={{ margin: 0 }}>
      <div className="chat-demo" ref={box}>
        <div className="chat-head">
          <span className="chat-group" aria-hidden="true">CD</span>
          <div>
            <b>Contoso delivery team</b>
            <small>Group chat · 6 people · {BRAND.name}: Contoso Retail – Cloud Migration</small>
          </div>
        </div>
        <div className="chat-body" ref={body} aria-live={visible && !reduced ? "polite" : "off"}>
          {s.msgs.map((m, i) => (
            <div key={i} className="chat-row">
              <Avatar who={m.who} />
              <div className="chat-main">
                <div className="chat-meta"><b>{m.who === "sk" ? BRAND.name : PEOPLE[m.who].name}</b><span>{m.time}</span></div>
                {m.text && <div className="chat-bubble">{m.text.startsWith(`@${BRAND.name}`) ? <><span className="chat-mention">{BRAND.name}</span>{m.text.slice(BRAND.name.length + 1)}</> : m.text}</div>}
                {m.card?.kind === "answer" && (
                  <div className="chat-card">
                    <small>{BRAND.name} · Contoso Retail – Cloud Migration</small>
                    <h4>{m.card.title}</h4>
                    <p>{rich(m.card.body)}</p>
                    <div className="chat-sources">
                      <b>Sources</b>
                      <ol>{m.card.sources.map((x) => <li key={x}>{x}</li>)}</ol>
                    </div>
                  </div>
                )}
                {m.card?.kind === "notes" && (
                  <div className="chat-card">
                    <small>Meeting notes · Contoso Retail – Cloud Migration</small>
                    <h4>{m.card.title}</h4>
                    <b className="chat-sub">Decisions</b>
                    <ul>{m.card.decisions.map((d) => <li key={d}>{d}</li>)}</ul>
                    <b className="chat-sub">Action items</b>
                    {m.card.actions.map(([what, who, due]) => (
                      <div key={what} className="chat-action">
                        <span>{what}<small>{who} · {due}</small></span>
                        <span className="chat-btns" aria-hidden="true"><span>Assign</span><span className="on">Mark done</span></span>
                      </div>
                    ))}
                  </div>
                )}
                {m.card?.kind === "reminder" && (
                  <div className="chat-card">
                    <small>Reminders · Contoso Retail – Cloud Migration</small>
                    <h4>{m.card.title}</h4>
                    {m.card.items.map(([label, text, source]) => (
                      <div key={label} className="chat-remind">
                        <b>{label}</b>
                        <span>{text}</span>
                        <small>Source: {source}</small>
                        <span className="chat-btns" aria-hidden="true"><span>Assign</span><span className="on">Mark done</span><span>Snooze</span></span>
                      </div>
                    ))}
                  </div>
                )}
                {m.react && <span className="chat-react">{m.react}</span>}
              </div>
            </div>
          ))}
          {s.typing && (
            <div className="chat-row">
              <Avatar who="sk" />
              <div className="chat-typing" aria-label={`${BRAND.name} is typing`}><i /><i /><i /></div>
            </div>
          )}
        </div>
        <div className="chat-input" aria-hidden="true">Type a message</div>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
