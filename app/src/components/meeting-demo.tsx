"use client";
/**
 * The website's picture of Sidekick live in a meeting: a made-up call drawn in HTML (not a recording), so it's
 * sharp on every screen and costs no video download. Four tiles (three made-up Contoso people and Sidekick, whose
 * tile runs the real crystal ball, components/crystalized-ball, the same one as the portal home and the meeting
 * bot's camera, left to move on its own) and a meeting chat that plays a short loop: a question → the answer
 * with sources while it "speaks" (speaking ring and caption on its tile) → a room question nobody answers →
 * ✋ → "Go ahead, Sidekick" → the answer → its own "by when?" question → reply. Then it starts again.
 *
 * A generic call in Sidekick's own colours, never Microsoft's artwork; the pages say "Teams" only in text.
 * Care taken: the loop and the ball pause when the picture is off screen; people who prefer reduced motion see the
 * finished conversation with the ball still; the chat is a live region only for its text (the ball is decorative).
 * Used on the public home, Features and How it works pages. No data, no requests.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import CrystalizedBall from "./crystalized-ball/CrystalizedBall";
import { BRAND } from "@/lib/brand";

type Who = "maria" | "priya" | "jordan" | "sk";
type Msg = { who: Who; text: string; sources?: string[]; hand?: boolean };
/** One beat of the loop: after `at` ms, add `msg`, and show who's speaking, the ball's mood and a caption. */
type Beat = { at: number; msg?: Msg; speaking?: Who | null; ball?: "idle" | "thinking" | "speaking"; hand?: boolean; caption?: string | null };

const PEOPLE: Record<Exclude<Who, "sk">, { name: string; initials: string; color: string }> = {
  maria: { name: "Maria Chen", initials: "MC", color: "#7c5cff" },
  priya: { name: "Priya Raman", initials: "PR", color: "#1d7f8c" },
  jordan: { name: "Jordan Alvarez", initials: "JA", color: "#b4541a" },
};

/** The script (made-up Contoso Retail engagement, the same story as the site's other pictures). */
const BEATS: Beat[] = [
  { at: 0, msg: { who: "sk", text: `Hi, I'm ${BRAND.name}, listening for Contoso Retail – Cloud Migration. Ask me by saying or typing "${BRAND.name}, …".` }, speaking: "maria", ball: "idle", caption: null },
  { at: 500, msg: { who: "maria", text: "Quick wave 2 check-in before the client call." } },
  { at: 1400, msg: { who: "priya", text: `${BRAND.name}, when is the wave 2 cutover?` }, speaking: null, ball: "thinking" },
  { at: 3600, msg: { who: "sk", text: "Thursday, November 12. It moved from November 5, and Jordan confirmed the new date on October 15.", sources: ["Sprint 14 planning · meeting", "Wave 2 cutover runbook v0.3"] }, ball: "speaking", speaking: "sk", caption: "It's Thursday, November 12. It moved from the fifth." },
  { at: 7600, ball: "idle", speaking: "jordan", caption: null },
  { at: 8200, msg: { who: "jordan", text: "Does anyone know what could make it slip again?" } },
  { at: 9400, speaking: null, ball: "thinking" },
  { at: 11200, msg: { who: "sk", text: `I can help with that. Say "go ahead, ${BRAND.name}".`, hand: true }, ball: "idle", hand: true },
  { at: 13000, msg: { who: "maria", text: `Go ahead, ${BRAND.name}.` }, speaking: "maria" },
  { at: 14000, msg: { who: "sk", text: "The card reader driver fix is still in QA, and PCI testing is booked for Tuesday. If either fails, the date slips.", sources: ["Vendor status · Oct 30 stand-up", "RAID log"] }, ball: "speaking", speaking: "sk", hand: false, caption: "The card reader fix is still in QA, and PCI testing is Tuesday." },
  { at: 18400, ball: "idle", speaking: null, caption: null },
  { at: 19200, msg: { who: "sk", text: `Quick check: by when should Priya update the runbook with the new date?` } },
  { at: 21000, msg: { who: "priya", text: "By Wednesday." }, speaking: "priya" },
  { at: 22400, speaking: null },
];
const LOOP_MS = 27000;

const reducedQuery = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (cb: () => void) => {
  const m = window.matchMedia(reducedQuery);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

/** The state after the beats up to `t` ms. */
function stateAt(t: number) {
  const s = { msgs: [] as Msg[], speaking: null as Who | null, ball: "idle" as "idle" | "thinking" | "speaking", hand: false, caption: null as string | null };
  for (const b of BEATS) {
    if (b.at > t) break;
    if (b.msg) s.msgs.push(b.msg);
    if (b.speaking !== undefined) s.speaking = b.speaking;
    if (b.ball) s.ball = b.ball;
    if (b.hand !== undefined) s.hand = b.hand;
    if (b.caption !== undefined) s.caption = b.caption;
  }
  return s;
}
const FINAL = stateAt(Infinity);

/** The looping meeting picture (see the file comment). `caption` is a line under it. */
export function MeetingDemo({ caption }: { caption?: string }) {
  const reduced = useSyncExternalStore(subscribeReduced, () => window.matchMedia(reducedQuery).matches, () => false);
  const box = useRef<HTMLDivElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [visible, setVisible] = useState(false);

  // Only animate while on screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "100px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The clock: steps to the next beat (and round again), only while visible and motion is welcome.
  useEffect(() => {
    if (!visible || reduced) return;
    const next = BEATS.find((b) => b.at > t)?.at ?? LOOP_MS;
    const id = setTimeout(() => setT(next >= LOOP_MS ? 0 : next), next - t);
    return () => clearTimeout(id);
  }, [t, visible, reduced]);

  const s = reduced ? FINAL : stateAt(t);
  const live = visible && !reduced;

  // Keep the newest message in view (inside the chat panel only, never scrolling the page).
  useEffect(() => {
    const c = chat.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [s.msgs.length, reduced]);

  return (
    <figure className="site-shot meet-demo-fig" style={{ margin: 0 }}>
      <div className="meet-demo" ref={box}>
        <div className="meet-bar" aria-hidden="true"><span className="meet-rec" />Wave 2 check-in<span className="meet-time">12:04</span></div>
        <div className="meet-grid" aria-hidden="true">
          {(Object.keys(PEOPLE) as Exclude<Who, "sk">[]).map((k) => (
            <div key={k} className={`meet-tile${s.speaking === k ? " talking" : ""}`}>
              <span className="meet-avatar" style={{ background: PEOPLE[k].color }}>{PEOPLE[k].initials}</span>
              <span className="meet-name">{PEOPLE[k].name}</span>
            </div>
          ))}
          <div className={`meet-tile sk${s.speaking === "sk" ? " talking" : ""}`}>
            <div className="meet-ball">
              <CrystalizedBall
                preset="aurora"
                color="#8B85FF"
                theme="dark"
                size={0.82}
                speed={0.75}
                crackle={0.45}
                sparks={0.3}
                flares={0.4}
                glow={0.75}
                particleCount={2500}
                interactive={live}
                paused={!live}
              />
            </div>
            {s.hand && <span className="meet-hand" title="Hand raised">✋</span>}
            {s.caption && <span className="meet-caption">{s.caption}</span>}
            <span className="meet-name">{BRAND.name}</span>
          </div>
        </div>
        <div className="meet-chat">
          <div className="meet-chat-head">Meeting chat</div>
          <div className="meet-chat-body" ref={chat} aria-live={live ? "polite" : "off"}>
            {s.msgs.map((m, i) => (
              <div key={i} className={`meet-msg${m.who === "sk" ? " sk" : ""}`}>
                <b>{m.who === "sk" ? BRAND.name : PEOPLE[m.who].name}</b>
                <p>{m.hand && <span aria-label="Hand raised">✋ </span>}{m.text}</p>
                {m.sources && <ol>{m.sources.map((x) => <li key={x}>{x}</li>)}</ol>}
              </div>
            ))}
          </div>
        </div>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
