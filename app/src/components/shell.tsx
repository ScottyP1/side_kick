"use client";

/**
 * The client portal frame: sidebar menu, workspace picker and header, around every signed-in page.
 * It loads /api/me once and shares it through `useApp()`: the user, their role, branding, workspaces and the current workspace.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, Icon, Pill, ToastProvider } from "./ui";

export type Workspace = { id: string; name: string; code: string | null; color: string };
export type Me = {
  user: { id: string; name: string; email: string; role: string; mustChangePassword: boolean; admin: boolean };
  org: { name: string };
  workspaces: Workspace[];
  claude: { configured: boolean; models: Record<string, string> };
  branding: { logo?: string | null; accent?: string | null };
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
  { g: "Manage", items: [["/workspaces", "Workspaces", "folder"], ["/knowledge", "Knowledge & docs", "doc"], ["/meetings", "Meetings", "video"], ["/memory", "Memory & gaps", "brain"], ["/connectors", "Connectors", "plug"], ["/users", "Users & access", "users", (m) => m.user.admin]] },
  { g: "Govern", items: [["/activity", "Activity", "activity", (m) => m.user.admin], ["/audit", "Security & audit", "lock", (m) => m.user.admin], ["/settings", "Settings", "gear"]] },
];

const WS_KEY = "sidekick.ws";

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

  if (error) return <div className="auth-wrap"><div className="auth-card"><h2>Something went wrong</h2><p className="err">{error}</p><button className="btn" onClick={() => location.reload()}>Try again</button></div></div>;
  if (!me) return <div className="auth-wrap"><span className="muted">Loading Sidekick…</span></div>;

  const items = NAV.map((g) => ({ g: g.g, items: g.items.filter((i) => !i[3] || i[3](me)) })).filter((g) => g.items.length);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  };

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
            {!me.claude.configured && (
              <div className="banner">
                <Icon n="alert" />
                <span>
                  <b>Claude isn&apos;t connected yet.</b> Add your key as <code>ANTHROPIC_API_KEY</code> in <code>app/.env.local</code>, then restart the app. Uploads and search work without it; answers and meeting notes need it.
                </span>
              </div>
            )}
            {me.user.mustChangePassword && (
              <div className="banner">
                <Icon n="lock" />
                <span>You&apos;re using a temporary password.</span>
                <Link className="btn small" href="/settings">
                  Change it now
                </Link>
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
              <div className="ws-pick">
                <span className="eyebrow">Workspace</span>
                {me.workspaces.length ? (
                  <select className="input" value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Current workspace">
                    {me.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="muted">None yet</span>
                )}
              </div>
              <span className="spacer" />
              <Pill kind={me.claude.configured ? "good" : "warn"}>{me.claude.configured ? "Claude connected" : "Claude not connected"}</Pill>
              <span className="avatar" title={`${me.user.name} · ${me.user.role}`}>
                {me.user.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
              </span>
            </header>
            <main className="content" key={ws}>{children}</main>
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
