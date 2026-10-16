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
 * Care taken: the orb is a small WebGL shader (no extra library); it pauses when the tab is hidden or the
 * orb is off-screen, holds still when the person prefers reduced motion, falls back to a CSS gradient when
 * WebGL isn't available, and a text summary is provided for screen readers.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "./ui";

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

/* ---------------- WebGL liquid orb ---------------- */

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
// 3D simplex noise (Ashima Arts, MIT) + a soft, glowing, slowly deforming sphere.
const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform float uEnergy; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;} vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);} vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=mod289(i);
vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / min(uRes.x, uRes.y);
  float t = uTime * (0.18 + 0.5 * uEnergy);
  float r = length(uv);
  float n1 = snoise(vec3(uv * 1.3, t)) ;
  float n2 = snoise(vec3(uv * 2.6 + n1 * 0.4, t * 1.6));
  float radius = 0.66 + 0.035 * n1 + 0.025 * uEnergy * sin(t * 4.0);
  float body = smoothstep(radius + 0.03, radius - 0.03, r + 0.022 * n2);
  vec3 col = mix(uA, uB, clamp(0.5 + 0.5 * n1, 0.0, 1.0));
  col = mix(col, uC, clamp(0.35 + 0.45 * n2, 0.0, 1.0) * 0.55);
  col *= 0.85 + 0.35 * smoothstep(radius - 0.35, radius, r);          // brighter rim, like a lit liquid
  col += vec3(1.0) * pow(max(0.0, 1.0 - length(uv - vec2(-0.22, 0.26)) * 2.4), 3.0) * 0.35; // soft highlight
  float glow = exp(-max(r - radius, 0.0) * 5.5) * (0.28 + 0.45 * uEnergy);
  vec3 outc = col * body + mix(uA, uB, 0.5) * glow * (1.0 - body);
  float alpha = max(body, glow * (1.0 - body));
  gl_FragColor = vec4(outc * alpha, alpha);
}`;

/** Reads a CSS color variable as [r,g,b] in 0-1, so the orb follows the theme (light/dark). */
function cssColor(el: HTMLElement, name: string): [number, number, number] {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  el.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.map(Number) ?? [79, 191, 168];
  probe.remove();
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}

function OrbCanvas({ energy, reduced }: { energy: number; reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const energyRef = useRef(energy);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    energyRef.current = energy;
  }, [energy]);
  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
    if (!gl) {
      setFallback(true);
      return;
    }
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setFallback(true);
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const setColors = () => {
      gl.uniform3fv(u("uA"), cssColor(canvas.parentElement!, "--accent"));
      gl.uniform3fv(u("uB"), cssColor(canvas.parentElement!, "--viz-1"));
      gl.uniform3fv(u("uC"), cssColor(canvas.parentElement!, "--viz-3"));
    };
    setColors();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", setColors);
    const themeObserver = new MutationObserver(setColors); // the app's own light/dark switch
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });

    let raf = 0;
    let visible = true;
    let smooth = energyRef.current;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);
    const start = performance.now();
    const frame = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      smooth += (energyRef.current - smooth) * 0.03; // ease between idle and busy
      gl.uniform2f(u("uRes"), w, h);
      gl.uniform1f(u("uTime"), reduced ? 2.0 : (performance.now() - start) / 1000);
      gl.uniform1f(u("uEnergy"), smooth);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reduced) raf = requestAnimationFrame(loop);
    };
    const loop = () => {
      if (visible && document.visibilityState === "visible") frame();
      else raf = requestAnimationFrame(loop);
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      themeObserver.disconnect();
      mq.removeEventListener("change", setColors);
    };
  }, [reduced]);
  if (fallback) return <div className="orb-fallback" aria-hidden="true" />;
  return <canvas ref={ref} className="orb-canvas" aria-hidden="true" />;
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

  const energy = live?.busy ? 1 : 0.15;
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
          <OrbCanvas energy={energy} reduced={reduced} />
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
