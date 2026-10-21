/**
 * The frame for Sidekick's public pages (no sign-in): pricing, sign-up, privacy, terms and support. A slim
 * top bar with the Sidekick mark and links, the page, and a footer with the legal links (the same links the
 * Teams Store listing points to). Uses the existing styles only (globals.css), no colours of its own.
 */
import Link from "next/link";
import type { ReactNode } from "react";

/** Shown on every public page: the brand, the main links and the legal footer around `children`. */
export function PublicShell({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <header className="topbar" style={{ position: "static" }}>
        <Link href="/pricing" className="brand" style={{ padding: 0, textDecoration: "none" }}>
          <span className="brand-mark">S</span>
          <b style={{ color: "var(--fg)" }}>Sidekick</b>
        </Link>
        <span className="spacer" />
        <nav style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} aria-label="Sidekick">
          <Link className="btn small ghost" href="/pricing">Pricing</Link>
          <Link className="btn small ghost" href="/support">Support</Link>
          <Link className="btn small" href="/login">Sign in</Link>
          <Link className="btn small primary" href="/signup">Sign up</Link>
        </nav>
      </header>
      <main style={{ flex: 1, width: `min(${narrow ? 760 : 1080}px, 100%)`, margin: "0 auto", padding: "32px 16px", display: "flex", flexDirection: "column", gap: 20 }}>
        {children}
      </main>
      <footer className="muted" style={{ borderTop: "1px solid var(--line)", padding: "16px", display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", fontSize: 13 }}>
        <span>Sidekick: a personal project, not a company</span>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms of use</Link>
        <Link href="/support">Support</Link>
        <Link href="/privacy">Powered by Claude</Link>
      </footer>
    </div>
  );
}

/** The "draft, not reviewed by a lawyer" note at the top of the privacy and terms pages. */
export function DraftNote() {
  return (
    <div className="callout warn" role="note">
      <span>
        <b>Draft.</b> This is placeholder text written in plain language for a lawyer to review. It isn&apos;t legal advice and isn&apos;t final.
      </span>
    </div>
  );
}

/** The banner shown wherever billing appears while payments are in test mode. */
export function TestModeBanner() {
  return (
    <div className="callout info" role="note">
      <span>
        <b>Test mode.</b> No money moves and Sidekick never asks for card or bank details. Prices are made up while pricing is decided.
      </span>
    </div>
  );
}
