/**
 * The frame for Sidekick's public website (no sign-in): home, features, how it works, security, pricing, the
 * help center, support, changelog, sign-up, checkout, privacy and terms. One header (logo, Features, How it
 * works, Security, Pricing, FAQ, Help, Sign in, Get started) with a menu button on phones, the page, and one footer
 * (product, help and legal links; FAQ is under Help; the privacy/terms links are also what the Teams Store listing points to).
 *
 * Server component with no JavaScript of its own: the phone menu is a native <details> element, so it works
 * under the enforced Content-Security-Policy and before any script loads. Styles: components/public-site.css
 * on top of the Indigo tokens in globals.css. The links come from lib/site.ts. <SiteChatSlot> at the end is the
 * bottom-left "Ask about Sidekick" help bot (a small client component; the rest of the frame has no script).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { SITE_NAV } from "@/lib/site";
import { SiteChatSlot } from "./site-chat-slot";
import "./public-site.css";
import { BRAND } from "@/lib/brand";

/**
 * Shown on every public page around `children`.
 * - `current`: the page's path, so its header link is marked as the current page.
 * - `layout`: "page" (default, a centred column like the portal's pages), "narrow" (reading width, for
 *   legal text and forms) or "full" (the page draws its own full-width sections, like the home page).
 *   `narrow` is the older way to ask for "narrow".
 */
export function PublicShell({ children, narrow, current, layout }: { children: ReactNode; narrow?: boolean; current?: string; layout?: "page" | "narrow" | "full" }) {
  const mode = layout ?? (narrow ? "narrow" : "page");
  const here = (href: string) => (current && (current === href || current.startsWith(`${href}/`)) ? "page" : undefined);
  return (
    <div className="site dock-space">
      <a className="site-skip" href="#main">Skip to content</a>
      <header className="site-head">
        <div className="site-head-in">
          <Link href="/" className="site-brand" aria-label={`${BRAND.name} home`}>
            <span className="brand-mark" aria-hidden="true">S</span>
            {BRAND.name}
          </Link>
          <nav className="site-nav" aria-label="Main">
            {SITE_NAV.map((l) => <Link key={l.href} href={l.href} aria-current={here(l.href)}>{l.label}</Link>)}
          </nav>
          <div className="site-cta">
            <Link className="btn ghost" href="/login">Sign in</Link>
            <Link className="btn primary" href="/signup">Get started</Link>
          </div>
          <details className="site-menu">
            <summary className="btn" aria-label="Menu">
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
              Menu
            </summary>
            <nav className="site-menu-panel" aria-label="Main">
              {SITE_NAV.map((l) => <Link key={l.href} href={l.href} aria-current={here(l.href)}>{l.label}</Link>)}
              <div className="site-menu-cta">
                <Link className="btn" href="/login">Sign in</Link>
                <Link className="btn primary" href="/signup">Get started</Link>
              </div>
            </nav>
          </details>
        </div>
      </header>
      <main id="main" className="site-main">
        {mode === "full" ? children : (
          <div className={`site-wrap ${mode === "narrow" ? "site-narrow" : ""}`} style={{ display: "flex", flexDirection: "column", gap: 20, padding: "32px 16px 56px" }}>
            {children}
          </div>
        )}
      </main>
      <SiteFooter />
      {/* "Ask about Sidekick", the help bot behind the bottom-left button (site-chat-slot.tsx). */}
      <SiteChatSlot />
    </div>
  );
}

/** The footer on every public page: product, help and legal links, and who runs Sidekick. */
function SiteFooter() {
  const cols: [string, [string, string][]][] = [
    ["Product", [["/features", "Features"], ["/how-it-works", "How it works"], ["/security", "Security & trust"], ["/pricing", "Pricing"], ["/changelog", "Changelog"]]],
    ["Help", [["/faq", "FAQ"], ["/docs", "Help center"], ["/support", "Support"], ["/login", "Sign in"], ["/signup", "Get started"]]],
    ["Legal", [["/privacy", "Privacy policy"], ["/terms", "Terms of use"], ["/privacy/subprocessors", "Sub-processors"]]],
  ];
  return (
    <footer className="site-foot">
      <div className="site-foot-in">
        <div>
          <Link href="/" className="site-brand" aria-label={`${BRAND.name} home`}><span className="brand-mark" aria-hidden="true">S</span>{BRAND.name}</Link>
          <p>The AI teammate for client teams in Microsoft Teams. A personal project, not a company. <Link href="/security">Powered by Claude</Link>.</p>
        </div>
        {cols.map(([title, links]) => (
          <nav key={title} aria-label={title}>
            <h2>{title}</h2>
            <ul>{links.map(([href, label]) => <li key={href}><Link href={href}>{label}</Link></li>)}</ul>
          </nav>
        ))}
      </div>
    </footer>
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
        <b>Test mode.</b> No money moves and {BRAND.name} never asks for card or bank details. Prices are made up while pricing is decided.
      </span>
    </div>
  );
}
