"use client";

/**
 * "Sidekick live" on the home page: a greeting that fades in above the crystal ball (Sidekick itself), a row showing each connection's
 * health and who's active, and the in-app assistant chat underneath (components/assistant.tsx).
 *
 * What it shows (from GET /api/activity?view=live, refreshed every 5 seconds):
 * - The ball moves faster and glows brighter while Sidekick is working (a request in the last ~20 s, or
 *   while the assistant is writing a reply). While the assistant thinks, the dust inside also swirls in
 *   circles, as if an invisible finger were stirring it (`useThinkingSwirl`).
 * - Each connection (Teams, AI answers, search, database) has a dot colored by health: green Healthy, amber
 *   Slow/had errors, red Failing, grey Idle/Not set up. The word is always shown, so color is never the
 *   only signal. Admins also see who's active; everyone else sees a count.
 *
 * Care taken: the core is React Bits' Crystalized Ball (WebGL 2 via the small `ogl` library); it pauses
 * when off-screen, holds still when the person prefers reduced motion, follows light/dark mode, falls back
 * to a CSS gradient without WebGL 2, and a text summary is provided for screen readers.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import Link from "next/link";
import { api } from "./ui";
import CrystalizedBall from "./crystalized-ball/CrystalizedBall";
import { Assistant } from "./assistant";

type Health = { state: "ok" | "degraded" | "failing" | "idle" | "off"; calls?: number; errors?: number; avgMs?: number; last?: string | null };
type Live = {
  now: string;
  peopleCount: number;
  people: { actor: string; channel: string; last: string }[];
  connections: {
    teams: Health & { linked: number };
    claude: Health;
    search: Health & { engine: string };
    database: Health & { engine: string };
  };
  recent: { id: string; channel: string; name: string; status: string; started_at: string; duration_ms: number; kinds: string[] }[];
  busy: boolean;
};

const STATE_LABEL: Record<Health["state"], string> = { ok: "Healthy", degraded: "Slow / had errors", failing: "Failing", idle: "Idle", off: "Not set up" };
const STATE_COLOR: Record<Health["state"], string> = { ok: "var(--good)", degraded: "var(--warn)", failing: "var(--bad)", idle: "var(--faint)", off: "var(--faint)" };

type Conn = { key: string; label: string; detail: string; state: Health["state"] };

/* ---------------- The core: React Bits "Crystalized Ball" ---------------- */

/** "light" or "dark", following the app's theme switch (data-theme) or, if unset, the system setting. */
function useTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => {
      const forced = document.documentElement.getAttribute("data-theme");
      setTheme(forced === "light" || forced === "dark" ? forced : mq.matches ? "dark" : "light");
    };
    read();
    mq.addEventListener("change", read);
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", read);
      mo.disconnect();
    };
  }, []);
  return theme;
}

const noSubscribe = () => () => {};
let webgl2Cache: boolean | undefined;
const hasWebgl2 = () => (webgl2Cache ??= Boolean(document.createElement("canvas").getContext("webgl2")));

/**
 * Sidekick's core: a crystal ball with an electric rim and glowing dust (React Bits, see
 * crystalized-ball/). Idle it drifts calmly; while Sidekick is working it speeds up, crackles and
 * sparks more. Needs WebGL 2; without it a soft gradient stands in.
 */
function Core({ busy, reduced }: { busy: boolean; reduced: boolean }) {
  const theme = useTheme();
  // Checked in the browser only (null while server-rendering); the answer never changes, so no subscription.
  const webgl2 = useSyncExternalStore(noSubscribe, hasWebgl2, () => null);
  if (webgl2 === false) return <div className="orb-fallback" aria-hidden="true" />;
  if (webgl2 === null) return null;
  return (
    <CrystalizedBall
      preset="aurora"
      color={theme === "dark" ? "#8B85FF" : "#4F46E5"}
      theme={theme}
      size={0.8}
      speed={busy ? 1.9 : 0.75}
      crackle={busy ? 1 : 0.45}
      sparks={busy ? 0.9 : 0.3}
      flares={busy ? 0.85 : 0.4}
      glow={busy ? 1 : 0.75}
      particleCount={9000}
      interactive
      paused={reduced}
    />
  );
}

/**
 * While `on`, stirs the ball's dust in circles, as if someone were circling a mouse inside it.
 *
 * How: the ball (an unmodified React Bits component) already swirls its dust when the pointer moves
 * over it, by listening to pointer events on the window. This sends it a "ghost pointer" circling the
 * centre of `target` (about half the ball's radius, a little over one turn a second, wobbling slightly so
 * it looks alive). The ghost steps aside whenever the person's real mouse is over the ball, and a final
 * "pointer left" event lets the dust settle when thinking ends. Nothing happens for reduced motion.
 */
function useThinkingSwirl(on: boolean, target: RefObject<HTMLElement | null>, reduced: boolean) {
  useEffect(() => {
    const el = target.current;
    if (!on || reduced || !el) return;
    let raf = 0;
    let realUntil = 0;
    const t0 = performance.now();
    const onReal = (e: PointerEvent) => {
      if (!e.isTrusted) return;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) realUntil = performance.now() + 1200;
    };
    window.addEventListener("pointermove", onReal, { passive: true });
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (now < realUntil) return;
      const r = el.getBoundingClientRect();
      const t = (now - t0) / 1000;
      const ballRadius = (0.8 * Math.min(r.width, r.height)) / 2; // matches size={0.8} below
      const rad = ballRadius * (0.5 + 0.12 * Math.sin(t * 1.7));
      const a = t * 2 * Math.PI * 1.15;
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + r.width / 2 + Math.cos(a) * rad, clientY: r.top + r.height / 2 + Math.sin(a) * rad, pointerType: "mouse" }));
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onReal);
      if (performance.now() >= realUntil) window.dispatchEvent(new PointerEvent("pointerout", { relatedTarget: null })); // let the dust settle
    };
  }, [on, target, reduced]);
}

/* ---------------- The panel: ball, connection health, assistant ---------------- */

/**
 * The home page's live panel. `admin` decides whether names of active people are shown; `greeting`
 * ("Good morning, Cody") fades in above the ball (shown without the fade for reduced motion).
 */
export function LiveOrb({ admin, greeting }: { admin: boolean; greeting?: string }) {
  const [live, setLive] = useState<Live | null>(null);
  const [failed, setFailed] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [thinking, setThinking] = useState(false);
  const coreRef = useRef<HTMLDivElement>(null);
  useThinkingSwirl(thinking, coreRef, reduced);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduced(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  // Poll the live view every 5 seconds while the tab is visible.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const l = await api<Live>("/api/activity?view=live");
        if (stop) return;
        setFailed(false);
        setLive(l);
      } catch {
        if (!stop) setFailed(true); // the problem modal already explains network/server problems
      }
    };
    tick();
    const t = setInterval(() => document.visibilityState === "visible" && tick(), 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const c = live?.connections;
  const conns: Conn[] = c
    ? [
        { key: "teams", label: "Teams", detail: c.teams.linked ? `${c.teams.linked} chat${c.teams.linked === 1 ? "" : "s"} linked` : "No chats linked", state: c.teams.state },
        { key: "claude", label: "AI answers", detail: c.claude.calls ? `${c.claude.calls} requests · ${(c.claude.avgMs! / 1000).toFixed(1)} s avg` : "Answers & meeting notes", state: c.claude.state },
        { key: "search", label: "Search", detail: c.search.engine, state: c.search.state },
        { key: "database", label: "Database", detail: c.database.engine, state: c.database.state },
      ]
    : [];
  const people = live ? (admin ? [...new Set(live.people.map((p) => p.actor.replace(/ \(Teams\)$/, "")))] : []) : [];
  const busy = Boolean(live?.busy) || thinking;

  const summary = live
    ? `Sidekick is ${busy ? "working right now" : "idle"}. ` +
      conns.map((n) => `${n.label}: ${STATE_LABEL[n.state]}, ${n.detail}.`).join(" ") +
      ` ${live.peopleCount} ${live.peopleCount === 1 ? "person" : "people"} active in the last 15 minutes.`
    : "Loading live status.";

  return (
    <div className="panel live-orb">
      <div className="panel-h">
        <div>
          <h2>Sidekick live</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {failed ? "Live status unavailable right now" : thinking ? "Writing a reply" : live?.busy ? "Working right now" : "Idle · watching for activity"}
          </span>
        </div>
        {admin && <Link className="btn small" href="/activity">Open Activity</Link>}
      </div>
      <p className="sr-only" aria-live="polite">{summary}</p>
      <div className="orb-stage">
        {greeting && <p className="orb-greeting">{greeting}</p>}
        <div className="orb-core" ref={coreRef}>
          <Core busy={busy} reduced={reduced} />
        </div>
      </div>
      <div className="orb-status" aria-hidden="true">
        {conns.map((n) => (
          <span key={n.key} className="orb-conn" title={`${STATE_LABEL[n.state]} · ${n.detail}`}>
            <span className="orb-dot" style={{ background: STATE_COLOR[n.state] }} />
            <b>{n.label}</b>
            <span className="muted">{STATE_LABEL[n.state]}</span>
          </span>
        ))}
        {live && (
          <span className="orb-conn" title={people.join(", ") || undefined}>
            <span className="orb-dot" style={{ background: live.peopleCount ? "var(--good)" : "var(--faint)" }} />
            <b>{live.peopleCount} active</b>
            <span className="muted">{people.length ? people.slice(0, 3).join(", ") + (people.length > 3 ? ` +${people.length - 3}` : "") : "in the last 15 min"}</span>
          </span>
        )}
      </div>
      <div className="panel-b orb-assist">
        <Assistant onThinking={setThinking} />
      </div>
    </div>
  );
}
