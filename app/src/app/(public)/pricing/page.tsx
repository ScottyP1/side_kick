/**
 * Pricing (/pricing): the plans from lib/plans.ts (the single source; made-up, test-mode prices) as cards
 * with their main limits, a "Start free trial" button per plan that opens /signup with that plan picked, and
 * Enterprise as "talk to us" (set up by the Sidekick team, never self-service). While sign-up isn't open (the
 * default) a note says so and the buttons say "Contact us" (components/signup-status.tsx). Then good-to-know
 * notes and the pricing questions from lib/faq.ts. No sign-in needed.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { FaqList } from "@/components/faq-list";
import { PublicShell, TestModeBanner } from "@/components/public-shell";
import { SignupClosedNotice, TrialButton } from "@/components/signup-status";
import { faqFor } from "@/lib/faq";
import { ENTERPRISE, limitText, PLANS, TRIAL_DAYS, type Plan } from "@/lib/plans";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/pricing");

/** The limits a buyer compares, from the plan itself. */
const limits = (p: Plan) => [
  `${limitText(p.seats)} people`,
  `${limitText(p.workspaces)} groups`,
  `${limitText(p.chats)} Teams chats`,
  `${limitText(p.meetingHours)} meeting hours / month`,
];

export default function PricingPage() {
  return (
    <PublicShell layout="full" current="/pricing">
      <div className="site-wrap site-page-head site-center">
        <span className="site-eyebrow">Pricing</span>
        <h1>Simple per-person pricing</h1>
        <p>Every plan starts with a {TRIAL_DAYS}-day free trial. Client guests in your Teams chats are always free.</p>
      </div>
      <div className="site-wrap site-stack">
        <SignupClosedNotice />
        <TestModeBanner />
        <div className="site-plans">
          {PLANS.map((p) => (
            <div key={p.id} className={`site-card site-plan ${p.id === "team" ? "featured" : ""}`}>
              <div className="site-plan-head"><h2>{p.name}</h2>{p.id === "team" && <span className="pill accent nodot">Most popular</span>}</div>
              <div className="site-plan-price"><b>${p.pricePerSeat}</b><span>per person / month</span></div>
              <p>{p.blurb}</p>
              <TrialButton plan={p.id} primary={p.id === "team"} />
              <ul className="site-checks">{[...limits(p), ...p.features.filter((f) => !/^Up to|workspaces$/.test(f))].map((f) => <li key={f}><span>{f}</span></li>)}</ul>
            </div>
          ))}
          <div className="site-card site-plan">
            <div className="site-plan-head"><h2>{ENTERPRISE.name}</h2></div>
            <div className="site-plan-price"><b>Custom</b><span>per contract</span></div>
            <p>{ENTERPRISE.blurb}</p>
            <Link className="btn" href="/support">Contact us</Link>
            <ul className="site-checks">
              <li><span>Limits agreed with you</span></li>
              <li><span>Everything in Business</span></li>
              <li><span>Sidekick live in your meetings <span className="site-badge-soon">Coming soon</span></span></li>
            </ul>
          </div>
        </div>
        <div className="site-grid">
          <div className="site-card"><h3 style={{ marginTop: 0 }}>Who counts as a person</h3><p>Anyone with a Sidekick account in your organization, whatever their role. Client guests in Teams chats are free.</p></div>
          <div className="site-card"><h3 style={{ marginTop: 0 }}>Change or cancel any time</h3><p>From Usage &amp; billing. After canceling, Sidekick stays usable until the end of what you paid for, then turns read-only; nothing is deleted.</p></div>
          <div className="site-card"><h3 style={{ marginTop: 0 }}>Meeting notes</h3><p>Notes from imported transcripts on every plan today. Automatic notes after every meeting are coming soon.</p></div>
        </div>
      </div>
      <div className="site-wrap site-narrow site-stack" style={{ paddingTop: 0 }}>
        <FaqList title="Pricing questions" items={faqFor("pricing")} />
        <p className="muted" style={{ margin: 0 }}>More answers on the <Link href="/faq">FAQ</Link>. Already have an account? <Link href="/login">Sign in</Link>.</p>
      </div>
    </PublicShell>
  );
}
