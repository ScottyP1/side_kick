"use client";

/**
 * The client portal frame: sidebar menu and top bar (with the workspace label or switcher on workspace pages), around every signed-in page.
 * It loads /api/me once and shares it through `useApp()`: the user, their role, branding, workspaces and the current workspace.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, Icon, Pill, ToastProvider } from "./ui";

export type Workspace = { id: string; name: string; code: string | null; color: string };
export type Me = {
  user: { id: string; name: string; email: string; role: string; mustChangePassword: boolean; admin: boolean; lead?: boolean };
  org: { name: string };
  workspaces: Workspace[];
  /** Plain status of AI answers (no model or provider names in the portal). */
  ai: { working: boolean };
  /** This month's AI credit (Org Owners, Org Admins, Billing Admins only; null for others). */
  credit?: { level: "unlimited" | "ok" | "warn" | "essentials"; pct: number } | null;
  /** The plan's name (null = managed by the Sidekick team) and connectors included (0, 1, null = all). */
  plan?: { name: string | null; connectors: number | null };
  branding: { logo?: string | null; accent?: string | null };
  /** What the organization's plan allows now (lib/plans.ts accessFor) and the notice to show, if any. */
  billing?: { mode: "full" | "read_only"; notice: string | null };
};

type Ctx = { me: Me; ws: string; setWs: (id: string) => void; reload: () => Promise<void> };
const AppCtx = createContext<Ctx | null>(null);
/**
 * Everything a portal page needs about the current session: `me` (user, role, org, branding, workspaces),
 * the current workspace id `ws` and `setWs` to switch it, and `reload` to refresh after changes.
 */
export function useApp() {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp must be used inside the app shell");
  return c;
}

const NAV: { g: string; items: [string, string, string, ((m: Me) => boolean)?][] }[] = [
  { g: "Overview", items: [["/", "Overview", "home"], ["/usage", "Usage & billing", "chart", (m) => ["Org Owner", "Org Admin", "Billing Admin"].includes(m.user.role)], ["/agent", "AI models & agent", "cpu"]] },
  { g: "Manage", items: [["/workspaces", "Groups", "folder"], ["/knowledge", "Knowledge & docs", "doc"], ["/meetings", "Meetings", "video"], ["/memory", "Memory & gaps", "brain"], ["/connectors", "Connectors", "plug"], ["/users", "Users & access", "users", (m) => m.user.admin || Boolean(m.user.lead)]] },
  { g: "Govern", items: [["/guardrails", "Guardrails", "shield"], ["/activity", "Activity", "activity", (m) => m.user.admin], ["/audit", "Security & audit", "lock", (m) => m.user.admin], ["/settings", "Settings", "gear"]] },
];

const WS_KEY = "sidekick.ws";

/**
 * Pages whose content belongs to one workspace, so the top bar shows which one.
 * Every other page (Overview, Usage, Users, Activity, Audit, Settings, ...) is org-wide and shows no workspace.
 */
const WS_PAGES = ["/knowledge", "/meetings", "/memory"];

/**
 * The top-bar workspace indicator on workspace pages. Most people work in one workspace, so they just see its
 * name as a quiet label; only someone in two or more gets a compact switcher. With no workspaces it shows nothing
 * (the page itself explains via `NeedsWorkspace`).
 */
function WorkspacePick({ workspaces, ws, setWs }: { workspaces: Workspace[]; ws: string; setWs: (id: string) => void }) {
  if (!workspaces.length) return null;
  if (workspaces.length === 1) return <span className="ws-label" title="Workspace">{workspaces[0].name}</span>;
  return (
    <select className="input ws-pick" value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [ws, setWsState] = useState("");
  const path = usePathname();

  const reload = useCallback(async () => {
    try {
      const m = await api<Me>("/api/me");
      setMe(m);
      let saved = "";
      try {
        saved = localStorage.getItem(WS_KEY) ?? "";
      } catch {}
      setWsState((cur) => {
        const pick = [cur, saved].find((id) => id && m.workspaces.some((w) => w.id === id));
        return pick ?? m.workspaces[0]?.id ?? "";
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your account.");
    }
  }, []);

  useEffect(() => {
    // Load the account once on mount; reload() only sets state after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  const setWs = (id: string) => {
    setWsState(id);
    try {
      localStorage.setItem(WS_KEY, id);
    } catch {}
  };

  // Client branding: brand color applied to accent tokens.
  useEffect(() => {
    const r = document.documentElement.style;
    const a = me?.branding.accent;
    if (a) {
      r.setProperty("--accent", a);
      r.setProperty("--accent-soft", `color-mix(in srgb, ${a} 14%, var(--surface))`);
      r.setProperty("--accent-fg", "#ffffff");
    } else ["--accent", "--accent-soft", "--accent-fg"].forEach((k) => r.removeProperty(k));
  }, [me?.branding.accent]);

  // Also offered on the error screen (e.g. organization paused), so nobody is stuck signed in.
  if (error) return <div className="auth-wrap"><div className="auth-card"><h2>Something went wrong</h2><p className="err">{error}</p><div style={{ display: "flex", gap: 8 }}><button className="btn" onClick={() => location.reload()}>Try again</button><button className="btn ghost" onClick={signOut}><Icon n="logout" />Sign out</button></div></div></div>;
  if (!me) return <div className="auth-wrap"><span className="muted">Loading Sidekick…</span></div>;
  // The server refuses everything else until a temporary password is changed, so show only that.
  if (me.user.mustChangePassword) return <ChangeTemporaryPassword name={me.user.name} onDone={reload} />;

  const items = NAV.map((g) => ({ g: g.g, items: g.items.filter((i) => !i[3] || i[3](me)) })).filter((g) => g.items.length);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const logout = signOut;

  return (
    <AppCtx.Provider value={{ me, ws, setWs, reload }}>
      <ToastProvider>
        <div className="app">
          <aside className="rail">
            {me.branding.logo ? (
              <div className="brand brand-logo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={me.branding.logo} alt={me.org.name} />
                <small>Sidekick · AI teammate</small>
              </div>
            ) : (
              <div className="brand">
                <span className="brand-mark">S</span>
                <div>
                  <b>Sidekick</b>
                  <small>{me.org.name}</small>
                </div>
              </div>
            )}
            <nav className="nav" aria-label="Main">
              {items.map((g) => (
                <div key={g.g} style={{ display: "contents" }}>
                  <div className="nav-group">{g.g}</div>
                  {g.items.map(([href, label, ic]) => (
                    <Link key={href} href={href} aria-current={active(href) ? "page" : undefined}>
                      <Icon n={ic} />
                      {label}
                    </Link>
                  ))}
                </div>
              ))}
            </nav>
            <div className="rail-foot">
              <span style={{ color: "#e8efed" }}>{me.user.name}</span>
              <span>{me.user.role}</span>
              <button className="btn small ghost" style={{ color: "inherit", justifyContent: "flex-start", padding: "4px 0" }} onClick={logout}>
                <Icon n="logout" />
                Sign out
              </button>
            </div>
          </aside>
          <div className="main">
            {!me.ai.working && (
              <div className="banner">
                <Icon n="alert" />
                <span>
                  <b>AI answers aren&apos;t set up yet.</b> The Sidekick team needs to finish setting up this server. Uploads and search work already; answers and meeting notes need it.
                </span>
              </div>
            )}
            {me.credit && (me.credit.level === "warn" || me.credit.level === "essentials") && (
              <div className="banner" role="status">
                <Icon n="alert" />
                <span>
                  {me.credit.level === "warn"
                    ? <>Your organization has used {me.credit.pct}% of this month&apos;s AI credit. At 100%, Sidekick keeps answering questions but pauses extras like reminders and the knowledge map.</>
                    : <><b>This month&apos;s AI credit is used up.</b> Sidekick still answers questions; reminders, knowledge map updates, the assistant and notes for long meetings are paused until the 1st.</>}{" "}
                  <Link href="/usage">Open Usage &amp; billing</Link>
                </span>
              </div>
            )}
            {me.billing?.notice && (
              <div className="banner">
                <Icon n="alert" />
                <span>
                  {me.billing.notice}{" "}
                  {["Org Owner", "Org Admin", "Billing Admin"].includes(me.user.role) && <Link href="/usage">Open Usage &amp; billing</Link>}
                </span>
              </div>
            )}
            <header className="topbar">
              <div className="mobile-nav">
                <span className="brand-mark">S</span>
                <select className="input" value={items.flatMap((g) => g.items).find((i) => active(i[0]))?.[0] ?? "/"} onChange={(e) => (location.href = e.target.value)} aria-label="Page">
                  {items.flatMap((g) => g.items).map(([href, label]) => (
                    <option key={href} value={href}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {WS_PAGES.some((p) => path.startsWith(p)) && <WorkspacePick workspaces={me.workspaces} ws={ws} setWs={setWs} />}
              <span className="spacer" />
              <Pill kind={!me.ai.working ? "warn" : me.credit?.level === "essentials" ? "warn" : "good"}>{!me.ai.working ? "AI answers: not set up" : me.credit?.level === "essentials" ? "AI answers: essentials only" : "AI answers: working"}</Pill>
              <UserMenu name={me.user.name} detail={me.user.role} onSignOut={logout} />
            </header>
            {/* Workspace pages restart when the workspace changes; org-wide pages (incl. the home assistant) keep their state. */}
            <main className="content" key={WS_PAGES.some((p) => path.startsWith(p)) ? ws : "org"}>{children}</main>
          </div>
        </div>
      </ToastProvider>
    </AppCtx.Provider>
  );
}

// Shown on workspace pages when the person has no workspace yet.
/** Shown instead of a page's content when the user has no workspace yet (admins get a "create one" link). */
export function NeedsWorkspace() {
  const { me } = useApp();
  return (
    <div className="panel">
      <div className="empty">
        <h2>No workspace yet</h2>
        <span>Workspaces keep each client engagement&apos;s documents, meetings and memory separate.</span>
        {me.user.admin ? (
          <Link className="btn primary" href="/workspaces">
            Create a workspace
          </Link>
        ) : (
          <span>Ask an Org Admin to add you to one.</span>
        )}
      </div>
    </div>
  );
}

/** Signs the portal user out on this browser and goes to the sign-in page. */
async function signOut() {
  // A failure (network) opens the problem modal from api(); the person stays here and can try again.
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/login";
}

/**
 * The avatar in the top bar: opens a small menu with the person's name, role and Sign out. It's the only
 * way to sign out at phone width, where the sidebar is hidden. Used by the portal and the Owner Console.
 */
export function UserMenu({ name, detail, onSignOut }: { name: string; detail: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="user-menu" ref={ref}>
      <button className="avatar" title={`${name} · ${detail}`} aria-label="Account menu" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        {name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
      </button>
      {open && (
        <div className="user-menu-pop" role="menu">
          <b>{name}</b>
          <span className="muted">{detail}</span>
          <button className="btn small" role="menuitem" onClick={onSignOut}><Icon n="logout" />Sign out</button>
        </div>
      )}
    </div>
  );
}

/**
 * Full-screen step shown while the person still has the temporary password they were given: they pick a
 * new one (or sign out) before anything else. Microsoft sign-in also clears this step.
 */
function ChangeTemporaryPassword({ name, onDone }: { name: string; onDone: () => Promise<void> }) {
  const [pw, setPw] = useState({ current: "", next: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api("/api/auth/password", { method: "POST", json: pw });
      await onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Couldn't change the password.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h2>Pick your own password</h2>
        <p className="muted">Welcome, {name}. You signed in with a temporary password; choose a new one to start using Sidekick.</p>
        <div className="field"><label htmlFor="tmp-cur">Temporary password</label><input id="tmp-cur" className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
        <div className="field"><label htmlFor="tmp-new">New password</label><input id="tmp-new" className="input" type="password" autoComplete="new-password" minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /><span className="hint">At least 10 characters.</span></div>
        {err && <p className="err">{err}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" type="submit" disabled={busy || !pw.current || pw.next.length < 10}>Save password</button>
          <button className="btn ghost" type="button" onClick={signOut}>Sign out</button>
        </div>
      </form>
    </div>
  );
}
