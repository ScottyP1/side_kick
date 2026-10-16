"use client";

/**
 * The live "Sidekick core" on the home page: one liquid orb (Sidekick itself) with satellite orbs for
 * each connection (Teams, Claude, search, database) and the people active right now.
 *
 * What it shows (from GET /api/activity?view=live, refreshed every 5 seconds):
 * - The core moves faster and glows brighter while Sidekick is working (a request in the last ~20 s).
 * - Each satellite is labelled and colored by health: green Healthy, amber Slow/had errors, red Failing,
 *   grey Idle/Not set up. The word is always shown, so color is never the only signal.
 * - When a new piece of work arrives, a spark travels from the core to every connection it used
 *   (e.g. search + Claude for a question, Teams for a Teams answer).
 *
 * Care taken: the core is React Bits' Crystalized Ball (WebGL 2 via the small `ogl` library); it pauses
 * when off-screen, holds still when the person prefers reduced motion, follows light/dark mode, falls back
 * to a CSS gradient without WebGL 2, and a text summary is provided for screen readers.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { api } from "./ui";
import CrystalizedBall from "./crystalized-ball/CrystalizedBall";

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

type Node = { key: string; label: string; detail: string; state: Health["state"]; kinds: string[]; person?: boolean };

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
      color={theme === "dark" ? "#46D9BD" : "#0F8F78"}
      theme={theme}
      size={0.72}
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

/* ---------------- Satellites, links and sparks ---------------- */

export function LiveOrb({ admin }: { admin: boolean }) {
  const [live, setLive] = useState<Live | null>(null);
  const [failed, setFailed] = useState(false);
  const [reduced, setReduced] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const [sparks, setSparks] = useState<{ id: string; node: string; at: number }[]>([]);
  // Orbit angle and the animation clock (for sparks), advanced together by one animation loop.
  const [{ angle, now }, setClock] = useState({ angle: 0, now: 0 });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduced(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  // Poll the live view; new work becomes sparks toward the connections it used.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const l = await api<Live>("/api/activity?view=live");
        if (stop) return;
        setFailed(false);
        const fresh = l.recent.filter((r) => !seen.current.has(r.id));
        const first = seen.current.size === 0;
        for (const r of l.recent) seen.current.add(r.id);
        if (!first && fresh.length && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          const at = performance.now();
          setSparks((cur) => [
            ...cur.filter((s) => at - s.at < 1600),
            ...fresh.flatMap((r) => nodesFor(r.kinds, r.channel).map((node) => ({ id: `${r.id}-${node}`, node, at }))),
          ]);
        }
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

  // Slow orbit of the satellites (and spark progress). Paused for reduced motion.
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const loop = () => {
      setClock((c) => ({ angle: (c.angle + 0.0009) % (Math.PI * 2), now: performance.now() }));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const nodes: Node[] = useMemo(() => {
    if (!live) return [];
    const c = live.connections;
    const list: Node[] = [
      { key: "teams", label: "Teams", detail: c.teams.linked ? `${c.teams.linked} chat${c.teams.linked === 1 ? "" : "s"} linked` : "No chats linked", state: c.teams.state, kinds: ["teams"] },
      { key: "claude", label: "Claude", detail: c.claude.calls ? `${c.claude.calls} calls · ${(c.claude.avgMs! / 1000).toFixed(1)} s avg` : "AI answers & notes", state: c.claude.state, kinds: ["ai"] },
      { key: "search", label: "Search", detail: c.search.engine, state: c.search.state, kinds: ["search", "embed", "index"] },
      { key: "database", label: "Database", detail: c.database.engine, state: c.database.state, kinds: [] },
    ];
    for (const p of live.people.slice(0, 5)) list.push({ key: `p:${p.actor}:${p.channel}`, label: p.actor.replace(/ \(Teams\)$/, ""), detail: p.channel === "teams" ? "in Teams" : "in the portal", state: "ok", kinds: [], person: true });
    if (!admin && live.peopleCount) list.push({ key: "people", label: `${live.peopleCount} active`, detail: "people right now", state: "ok", kinds: [], person: true });
    return list;
  }, [live, admin]);

  const summary = live
    ? `Sidekick is ${live.busy ? "working right now" : "idle"}. ` +
      nodes.filter((n) => !n.person).map((n) => `${n.label}: ${STATE_LABEL[n.state]}, ${n.detail}.`).join(" ") +
      ` ${live.peopleCount} ${live.peopleCount === 1 ? "person" : "people"} active in the last 15 minutes.`
    : "Loading live status.";

  return (
    <div className="panel live-orb">
      <div className="panel-h">
        <div>
          <h2>Sidekick live</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {failed ? "Live status unavailable right now" : live?.busy ? "Working right now" : "Idle · watching for activity"}
          </span>
        </div>
        {admin && <Link className="btn small" href="/activity">Open Activity</Link>}
      </div>
      <div className="orb-stage">
        <p className="sr-only" aria-live="polite">{summary}</p>
        <svg className="orb-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {nodes.map((n, i) => {
            const pos = place(i, nodes.length, angle);
            return <line key={n.key} x1="50" y1="50" x2={pos.x} y2={pos.y} className={`orb-link${n.person ? " person" : ""}`} />;
          })}
        </svg>
        {sparks.map((s) => {
          const i = nodes.findIndex((n) => n.key === s.node);
          if (i < 0) return null;
          const p = Math.min(1, (now - s.at) / 1400);
          if (p >= 1) return null;
          const pos = place(i, nodes.length, angle);
          return <span key={s.id} className="orb-spark" aria-hidden="true" style={{ left: `${50 + (pos.x - 50) * p}%`, top: `${50 + (pos.y - 50) * p}%`, opacity: 1 - p * 0.6 }} />;
        })}
        <div className="orb-core">
          <Core busy={Boolean(live?.busy)} reduced={reduced} />
          <span className="orb-core-label">Sidekick</span>
        </div>
        {nodes.map((n, i) => {
          const pos = place(i, nodes.length, angle);
          return (
            <div key={n.key} className={`orb-node${n.person ? " person" : ""}`} style={{ left: `${pos.x}%`, top: `${pos.y}%` }}>
              <span className="orb-dot" style={{ background: STATE_COLOR[n.state], boxShadow: `0 0 0 4px color-mix(in srgb, ${STATE_COLOR[n.state]} 22%, transparent), 0 0 18px color-mix(in srgb, ${STATE_COLOR[n.state]} 55%, transparent)` }}>
                {n.person ? initials(n.label) : ""}
              </span>
              <span className="orb-text">
                <b>{n.label}</b>
                <span>{n.person ? n.detail : `${STATE_LABEL[n.state]} · ${n.detail}`}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Which satellites a piece of work touched, from the kinds of its steps. */
function nodesFor(kinds: string[], channel: string): string[] {
  const out = new Set<string>(["database"]);
  if (kinds.includes("ai")) out.add("claude");
  if (kinds.some((k) => k === "search" || k === "embed" || k === "index")) out.add("search");
  if (kinds.includes("teams") || channel === "teams") out.add("teams");
  return [...out];
}

/** Position of satellite i of n on an ellipse around the core (percent of the stage), slowly rotating. */
function place(i: number, n: number, angle: number) {
  const a = angle + (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
  return { x: 50 + Math.cos(a) * 36, y: 50 + Math.sin(a) * 38 };
}

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
