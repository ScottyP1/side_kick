"use client";

/**
 * The meeting bot's camera picture (page.tsx): the crystal ball, full-frame on a dark 16:9 background, that idles
 * calmly, swirls while Sidekick works out an answer and speeds up, crackles and sparks while Sidekick speaks.
 *
 * - **State**: long-polls GET /api/live/bot/orb with the `session` and `sig` from the address (lib/live-meetings/orb.ts),
 *   sending back the state it shows (`known`) so the answer comes when something changes. `?demo=idle|thinking|speaking`
 *   shows one state without asking (previews and the CPU check in docs/LIVE-MEETINGS.md).
 * - **Cheap to draw**: the bot's container has no graphics card (Chrome draws WebGL in software, and the cost is per
 *   pixel per frame), so the ball is drawn at half resolution and stretched (`?scale=`, default 0.5), animation frames
 *   are capped (`?fps=`, default 12; the container captures at 15) and it has fewer dust particles than the home page
 *   (`?particles=`, default 5000). Measured costs: docs/LIVE-MEETINGS.md → "Sidekick's camera".
 * - **Only the ball, ever**: Attendee's webpage streamer adds a script to every page it shows (it wires the meeting's
 *   audio in as a microphone) that draws a red box (`#attendee-audio-error`) or calls `alert()` when that fails. This
 *   page uses no microphone, so the box is hidden and `alert` does nothing here (the cause, the wrong port, is fixed in
 *   meetbot/patches/03; this is the backstop: first live test, Nov 1).
 * - **Problems**: nobody watches this page and anything it showed would be on the bot's camera in front of the meeting,
 *   so it never shows an error; a failed poll is logged to the console and retried after a pause, and a 401 (wrong or
 *   expired address) stops polling with the ball idle.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import CrystalizedBall from "@/components/crystalized-ball/CrystalizedBall";
import { useThinkingSwirl } from "@/components/thinking-swirl";

type Word = "idle" | "thinking" | "speaking" | "over";
const SIZE = 0.82;

/** Caps requestAnimationFrame at `fps` for this page (the ball and the swirl both draw on it). Runs once, in the browser. */
function capFrames(fps: number) {
  const w = window as Window & { __orbFrameCap?: boolean };
  if (w.__orbFrameCap || !(fps > 0 && fps < 60)) return;
  w.__orbFrameCap = true;
  const native = window.requestAnimationFrame.bind(window);
  const step = 1000 / fps;
  let next = 0;
  let admitted = -1;
  // Every callback of one browser frame gets the same timestamp: a frame is admitted once a step has passed, and all
  // of that frame's callbacks (the ball's and the swirl's) run in it; the others wait for the next admitted frame.
  window.requestAnimationFrame = (cb) =>
    native(function wait(t) {
      if (t !== admitted) {
        if (t + 1 < next) return void native(wait);
        admitted = t;
        next = Math.max(next + step, t);
      }
      cb(t);
    });
}

/**
 * Draws the ball at `scale` of the screen's resolution (the browser stretches it back up): the ball's cost is per pixel
 * drawn, so 0.5 costs about a quarter. The ball reads the scale from `devicePixelRatio`, set here before it mounts.
 */
function drawScale(scale: number) {
  if (scale === 1) return;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => scale });
}

const num = (v: string | null, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

type Settings = { session: string | null; sig: string | null; demo: Word | null; particles: number };
let settings: Settings | null = null;
/**
 * The page's settings from its address, read once in the browser. The frame cap and draw scale are applied here, so
 * they are in place before the ball draws its first frame (it only renders once these are known).
 */
function readSettings(): Settings {
  if (settings) return settings;
  const q = new URLSearchParams(window.location.search);
  capFrames(num(q.get("fps"), 12, 1, 60));
  drawScale(num(q.get("scale"), 0.5, 0.25, 2));
  const demo = q.get("demo");
  settings = {
    session: q.get("session"),
    sig: q.get("sig"),
    demo: demo === "idle" || demo === "thinking" || demo === "speaking" ? demo : null,
    particles: num(q.get("particles"), 5000, 500, 20000),
  };
  return settings;
}
const noSubscribe = () => () => {};

/** Hides Attendee's own error box on this page (see the file comment). */
export const HIDE_STREAMER_NOTICES = "#attendee-audio-error{display:none!important}";
// Its alert() would be a dialog on the bot's camera; nothing on this page needs one.
if (typeof window !== "undefined") window.alert = (msg?: unknown) => console.warn("[orb] alert suppressed:", msg);

/** The camera page's content (see the file comment). */
export default function OrbCamera() {
  // Null while rendering on the server: the ball is drawn in the browser only.
  const set = useSyncExternalStore(noSubscribe, readSettings, () => null);
  const [polled, setPolled] = useState<Word>("idle");
  const word = set?.demo ?? polled;
  const coreRef = useRef<HTMLDivElement>(null);
  useThinkingSwirl(word === "thinking", coreRef, false, SIZE);

  // The long poll: asks for the state, sending back what's shown, until the session is over or the address is refused.
  useEffect(() => {
    const { session, sig, demo } = readSettings();
    if (demo || !session || !sig) return;
    let stop = false;
    let known: Word = "idle";
    (async () => {
      while (!stop && known !== "over") {
        try {
          const res = await fetch(`/api/live/bot/orb?session=${encodeURIComponent(session)}&sig=${encodeURIComponent(sig)}&known=${known}&wait=20`, { cache: "no-store" });
          if (res.status === 401) {
            console.warn("[orb] this address isn't accepted any more; the ball stays idle");
            return;
          }
          if (!res.ok) throw new Error(`state answered ${res.status}`);
          const s = (await res.json()) as { speaking?: boolean; thinking?: boolean; over?: boolean };
          known = s.over ? "over" : s.speaking ? "speaking" : s.thinking ? "thinking" : "idle";
          if (!stop) setPolled(known);
        } catch (e) {
          console.warn("[orb] couldn't read the state, trying again", e instanceof Error ? e.message : e);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  const busy = word === "speaking";
  return (
    <main data-orb-camera style={{ position: "fixed", inset: 0, background: "radial-gradient(ellipse at center, #15132b 0%, #08070f 70%)", display: "grid", placeItems: "center", overflow: "hidden" }}>
      <style>{HIDE_STREAMER_NOTICES}</style>
      <div ref={coreRef} style={{ width: "min(100vh, 100vw)", height: "min(100vh, 100vw)" }} aria-hidden="true">
        {set && (
          <CrystalizedBall
            preset="aurora"
            color="#8B85FF"
            theme="dark"
            size={SIZE}
            speed={busy ? 1.9 : word === "thinking" ? 1.1 : 0.75}
            crackle={busy ? 1 : 0.45}
            sparks={busy ? 0.9 : 0.3}
            flares={busy ? 0.85 : 0.4}
            glow={busy ? 1 : 0.75}
            particleCount={set.particles}
            interactive
            paused={word === "over"}
          />
        )}
      </div>
    </main>
  );
}
