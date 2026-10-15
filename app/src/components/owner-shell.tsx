"use client";

/**
 * The Owner Console frame: sidebar and header around every Owner Console page, and the owner sign-in check.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, Icon, Pill, ToastProvider } from "./ui";

const NAV: [string, string, string][] = [
  ["/owner", "Overview", "home"],
  ["/owner/clients", "Clients", "users"],
  ["/owner/performance", "Performance & errors", "chart"],
  ["/owner/releases", "Releases & switches", "gear"],
];

// The Owner Console: Sidekick's operator view across every client organization.
export function OwnerShell({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<{ name: string; email: string } | null>(null);
  const path = usePathname();

  useEffect(() => {
    api<{ owner: { name: string; email: string } }>("/api/owner/me")
      .then((r) => setOwner(r.owner))
      .catch(() => {
        window.location.assign("/owner/login");
      });
  }, []);

  if (!owner) return <div className="auth-wrap"><span className="muted">Loading Owner Console…</span></div>;
  const active = (href: string) => (href === "/owner" ? path === "/owner" : path.startsWith(href));
  const logout = async () => {
    await api("/api/owner/auth/logout", { method: "POST" });
    window.location.assign("/owner/login");
  };

  return (
    <ToastProvider>
      <div className="app owner-app">
        <aside className="rail">
          <div className="brand">
            <span className="brand-mark owner-mark">S</span>
            <div>
              <b>Sidekick</b>
              <small>Owner Console</small>
            </div>
          </div>
          <nav className="nav" aria-label="Owner">
            <div className="nav-group">Operate</div>
            {NAV.map(([href, label, ic]) => (
              <Link key={href} href={href} aria-current={active(href) ? "page" : undefined}>
                <Icon n={ic} />
                {label}
              </Link>
            ))}
          </nav>
          <div className="rail-foot">
            <span style={{ color: "#e8efed" }}>{owner.name}</span>
            <span>Platform owner</span>
            <button className="btn small ghost" style={{ color: "inherit", justifyContent: "flex-start", padding: "4px 0" }} onClick={logout}>
              <Icon n="logout" />
              Sign out
            </button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="mobile-nav">
              <span className="brand-mark owner-mark">S</span>
              <select className="input" value={NAV.find((n) => active(n[0]))?.[0] ?? "/owner"} onChange={(e) => window.location.assign(e.target.value)} aria-label="Page">
                {NAV.map(([href, label]) => (
                  <option key={href} value={href}>{label}</option>
                ))}
              </select>
            </div>
            <span className="eyebrow">Owner Console · all clients</span>
            <span className="spacer" />
            <Pill kind="accent" nodot>Operator</Pill>
          </header>
          <main className="content">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
