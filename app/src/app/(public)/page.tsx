/**
 * Website home (/) for visitors: what Sidekick is in one screen, a static demo of its Teams cards, what it
 * does, who it's for, placeholders where customer quotes and logos will go (clearly marked, nothing made up),
 * and Get started / Sign in. Public, static, no JavaScript of its own.
 *
 * Signed-in people never see this page: src/proxy.ts sends anyone with a portal session cookie from / to
 * their portal home at /home (docs/ARCHITECTURE.md → Routes).
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { SiteIcon } from "@/components/site-icons";
import { TeamsDemo } from "@/components/teams-demo";
import { TRIAL_DAYS } from "@/lib/plans";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = pageMetadata("/");

const HIGHLIGHTS: [string, string, string][] = [
  ["answer", "Answers with sources", `Ask in the chat. ${BRAND.name} answers from that client's documents, meetings and chat, and shows where each answer came from. If it doesn't know, it says so.`],
  ["notes", "Meeting notes, done", `Add a meeting's transcript and ${BRAND.name} writes the summary, decisions, open questions and action items with owners and due dates, and posts them to the team's chat. Automatic notes after every Teams meeting are coming soon.`],
  ["bell", "Reminders that matter", "Overdue and unowned action items, decisions still waiting, and documents that look out of date, raised in the chat before they slip."],
  ["groups", "One group per client", "Each engagement gets its own walled-off group with its own Team Lead, chats and documents. One client's material never shows up in another's answers."],
  ["shield", "Guardrails on every answer", `Company-wide and per-group rules, checked before ${BRAND.name} answers and again after. Client guests only ever see what's marked shareable.`],
  ["audit", "Everything on the record", `An audit log of who did what, and usage per group, so admins and Team Leads always know what ${BRAND.name} is doing.`],
];

export default function HomePage() {
  return (
    <PublicShell layout="full" current="/">
      <div className="site-wrap">
        <section className="site-hero" aria-labelledby="hero-title">
          <div>
            <span className="site-eyebrow">AI teammate for Microsoft Teams</span>
            <h1 id="hero-title">Every meeting, <em>remembered</em>.</h1>
            <p className="site-hero-text">
              {BRAND.name} turns your Teams meetings into notes, decisions and action items, posted straight to your team&apos;s chat, then keeps everyone on track.
            </p>
            <p className="site-hero-sub">A fast, reliable teammate in Teams chats, channels and 1:1. Answers with sources. A wall around every client.</p>
            <ul className="site-hero-badges" aria-label="Coming soon">
              <li><span className="site-badge">Coming soon</span> Automatic notes after every Teams meeting</li>
              <li><span className="site-badge">Enterprise · coming soon</span> {BRAND.name} live in your meetings</li>
            </ul>
            <div className="site-hero-cta">
              <Link className="btn primary" href="/signup">Get started</Link>
              <Link className="btn" href="/login">Sign in</Link>
              <Link className="btn ghost" href="/how-it-works">How it works →</Link>
            </div>
            <div className="site-hero-note">{TRIAL_DAYS}-day free trial on every plan. Set up in an afternoon with the setup wizard.</div>
          </div>
          <TeamsDemo />
        </section>
      </div>

      <section className="site-section alt" aria-labelledby="what-title">
        <div className="site-wrap">
          <span className="site-eyebrow">What it does</span>
          <h2 id="what-title">Less hunting for answers, fewer dropped balls</h2>
          <p className="site-lead">Your people already live in Teams. {BRAND.name} joins the chats you choose and keeps each client&apos;s knowledge in one place.</p>
          <div className="site-grid">
            {HIGHLIGHTS.map(([icon, title, text]) => (
              <div key={title} className="site-card">
                <SiteIcon name={icon} />
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <p style={{ margin: "20px 0 0" }}><Link href="/features">See all features →</Link></p>
        </div>
      </section>

      <section className="site-section" aria-labelledby="who-title">
        <div className="site-wrap site-grid two" style={{ alignItems: "center" }}>
          <div>
            <span className="site-eyebrow">Who it&apos;s for</span>
            <h2 id="who-title">Built for firms with many clients</h2>
            <p className="site-lead" style={{ marginBottom: 12 }}>
              Consultancies, agencies and tech firms where every client engagement has its own team, its own documents and its own Teams chats.
            </p>
            <ul className="site-checks">
              <li><span><b>Team Leads</b> run their group: they add people and pick which chats {BRAND.name} follows.</span></li>
              <li><span><b>Admins</b> set the rules once for the whole company, and see usage and the audit log.</span></li>
              <li><span><b>Everyone</b> asks in the chat they&apos;re already in, and gets an answer with its sources.</span></li>
            </ul>
          </div>
          <div className="site-card">
            <h3 style={{ marginTop: 0 }}>Up and running in five steps</h3>
            <ol style={{ margin: "8px 0 0", paddingLeft: 20, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 6 }}>
              <li>Sign up and pick a plan</li>
              <li>Approve {BRAND.name} for your Microsoft 365</li>
              <li>Install it in Teams</li>
              <li>Create a group per client, with its Team Lead</li>
              <li>Pick the chats {BRAND.name} should follow</li>
            </ol>
            <p style={{ margin: "12px 0 0" }}><Link href="/how-it-works">How it works →</Link></p>
          </div>
        </div>
      </section>

      <section className="site-section alt" aria-labelledby="proof-title">
        <div className="site-wrap">
          <span className="site-eyebrow">Customers</span>
          <h2 id="proof-title">What teams say</h2>
          <p className="site-lead">{BRAND.name} is new. These spaces are placeholders until real customers agree to be quoted: nothing here is a real quote or a real company.</p>
          <div className="site-grid" style={{ marginBottom: 16 }}>
            {[1, 2, 3].map((n) => (
              <div key={n} className="site-placeholder" role="note">
                <span className="tag">Placeholder</span>
                <span>A quote from a customer&apos;s Team Lead will go here.</span>
              </div>
            ))}
          </div>
          <div className="site-logos">
            {[1, 2, 3, 4].map((n) => <div key={n} className="site-placeholder" role="note">Customer logo placeholder</div>)}
          </div>
        </div>
      </section>

      <section className="site-section">
        <div className="site-wrap">
          <div className="site-band">
            <div>
              <h2>Give every team a {BRAND.name}</h2>
              <p>Start a {TRIAL_DAYS}-day free trial, or read the help center first.</p>
            </div>
            <div className="site-hero-cta">
              <Link className="btn primary" href="/signup">Get started</Link>
              <Link className="btn" href="/docs">Help center</Link>
            </div>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}
