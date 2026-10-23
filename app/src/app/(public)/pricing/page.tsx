/**
 * Pricing (/pricing): the plans from lib/plans.ts (the single source; made-up, test-mode prices), priced per
 * organization by groups (one per client engagement), as cards with their main limits, the extra-group
 * price, a "Start free trial" button per plan that opens /signup with that plan picked, and
 * Enterprise as "talk to us" (set up by the Sidekick team, never self-service). While sign-up isn't open (the
 * default) a note says so and the buttons say "Contact us" (components/signup-status.tsx). Then good-to-know
 * notes and the pricing questions from lib/faq.ts. No sign-in needed.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { FaqList } from "@/components/faq-list";
import { PublicShell, TestModeBanner } from "@/components/public-shell";
import { PlansArt } from "@/components/site-art";
import { SignupClosedNotice, TrialButton } from "@/components/signup-status";
import { faqFor } from "@/lib/faq";
import { ENTERPRISE, EXTRA_GROUP, limitText, PLANS, TRIAL_DAYS, usd, type Plan } from "@/lib/plans";
import { BRAND } from "@/lib/brand";
import { BACKUP_RETENTION_DAYS, ORG_GRACE_DAYS } from "@/lib/rolloff-policy";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/pricing");

/** The limits a buyer compares, from the plan itself. */
const limits = (p: Plan) => [
  `${limitText(p.workspaces)} group${p.workspaces === 1 ? "" : "s"} (client engagements)`,
  `Up to ${limitText(p.seats)} people`,
  `${limitText(p.meetingHours)} meeting hours / month`,
  `${limitText(p.chats)} tracked Teams chats`,
];

export default function PricingPage() {
  return (
    <PublicShell layout="full" current="/pricing">
      <div className="site-wrap site-glow">
        <div className="site-page-art">
          <div className="site-page-head">
            <span className="site-eyebrow">Pricing</span>
            <h1>Priced per client engagement</h1>
            <p>One monthly price for your organization, by the number of groups (one per client engagement), not per person. Every plan starts with a {TRIAL_DAYS}-day free trial. Client guests in your Teams chats are always free.</p>
          </div>
          <PlansArt />
        </div>
      </div>
      <div className="site-wrap site-stack">
        <SignupClosedNotice />
        <TestModeBanner />
        <div className="site-plans">
          {PLANS.map((p) => (
            <div key={p.id} className={`site-card site-plan ${p.id === "team" ? "featured" : ""}`}>
              <div className="site-plan-head"><h2>{p.name}</h2>{p.id === "team" && <span className="pill accent nodot">Most popular</span>}</div>
              <div className="site-plan-price"><b>{usd(p.priceUsd)}</b><span>per month</span></div>
              <p>{p.blurb}</p>
              <TrialButton plan={p.id} primary={p.id === "team"} />
              <ul className="site-checks">{[...limits(p), ...p.features.filter((f) => !/groups?, up to|meeting hours/.test(f))].map((f) => <li key={f}><span>{f}</span></li>)}</ul>
            </div>
          ))}
          <div className="site-card site-plan">
            <div className="site-plan-head"><h2>{ENTERPRISE.name}</h2></div>
            <div className="site-plan-price"><b>From {usd(ENTERPRISE.priceUsd)}</b><span>per month, per contract</span></div>
            <p>{ENTERPRISE.blurb}</p>
            <Link className="btn" href="/support">Contact us</Link>
            <ul className="site-checks">
              <li><span>Unlimited groups, limits agreed with you</span></li>
              <li><span>Everything in Business</span></li>
              <li><span>Dedicated database option</span></li>
              <li><span>{BRAND.name} live in your meetings <span className="site-badge-soon">Coming soon</span></span></li>
            </ul>
          </div>
        </div>
        <div className="site-grid">
          <div className="site-card"><h3 style={{ marginTop: 0 }}>Extra groups</h3><p>Need one more engagement? Add an extra group to any plan for {usd(EXTRA_GROUP.priceUsd)} a month. Each brings {EXTRA_GROUP.adds.seats} more people, {EXTRA_GROUP.adds.meetingHours} meeting hours and {usd(EXTRA_GROUP.adds.aiCreditUsd)} of AI credit. When you add a group past your plan, {BRAND.name} shows the cheaper way: extra groups or the next plan.</p></div>
          <div className="site-card"><h3 style={{ marginTop: 0 }}>When an engagement ends</h3><p>Set its group to end: it turns read-only, stops counting toward your plan, and you can download everything. On the date you pick (30 days by default) it&apos;s deleted and you get a deletion certificate.</p></div>
          <div className="site-card"><h3 style={{ marginTop: 0 }}>Change or cancel any time</h3><p>From Usage &amp; billing. After canceling, {BRAND.name} stays usable until the end of what you paid for, then read-only for {ORG_GRACE_DAYS} days so you can export; then everything is deleted (backups age out within {BACKUP_RETENTION_DAYS} days).</p></div>
          <div className="site-card"><h3 style={{ marginTop: 0 }}>Meeting notes</h3><p>Automatic notes after every Teams meeting on every plan, within the plan&apos;s meeting hours. Past or outside meetings can be added from their transcript.</p></div>
        </div>
      </div>
      <div className="site-wrap site-narrow site-stack" style={{ paddingTop: 0 }}>
        <FaqList title="Pricing questions" items={faqFor("pricing")} />
        <p className="muted" style={{ margin: 0 }}>More answers on the <Link href="/faq">FAQ</Link>. Already have an account? <Link href="/login">Sign in</Link>.</p>
      </div>
    </PublicShell>
  );
}
