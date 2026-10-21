/**
 * Pricing (/pricing): Sidekick's public landing page. What Sidekick does, the plans from lib/plans.ts with
 * their (made-up, test-mode) prices, and a "Start free trial" button per plan that opens /signup with that
 * plan picked; while sign-up isn't open (the default) a note says so and the buttons say "Contact us"
 * (components/signup-status.tsx). No sign-in needed.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell, TestModeBanner } from "@/components/public-shell";
import { SignupClosedNotice, TrialButton } from "@/components/signup-status";
import { limitText, PLANS, priceText, TRIAL_DAYS } from "@/lib/plans";

export const metadata: Metadata = { title: "Sidekick: plans and pricing" };

export default function PricingPage() {
  return (
    <PublicShell>
      <div className="page-head">
        <div>
          <div className="eyebrow">Sidekick for Microsoft Teams</div>
          <h1>An AI teammate that remembers every meeting and document</h1>
          <p>
            Sidekick answers your team&apos;s questions in Teams with sources, writes meeting notes and action items,
            and reminds the chat about what&apos;s overdue. Each client engagement gets its own walled-off workspace.
            Every plan starts with a {TRIAL_DAYS}-day free trial.
          </p>
        </div>
      </div>
      <SignupClosedNotice />
      <TestModeBanner />
      <div className="grid g3">
        {PLANS.map((p) => (
          <div key={p.id} className="panel" style={{ display: "flex", flexDirection: "column" }}>
            <div className="panel-h"><h2>{p.name}</h2>{p.id === "team" && <span className="pill accent nodot">Most popular</span>}</div>
            <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
              <div><span className="v" style={{ fontSize: 28, fontWeight: 600 }}>${p.pricePerSeat}</span> <span className="muted">per person / month</span></div>
              <p className="muted" style={{ margin: 0 }}>{p.blurb}</p>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                {p.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <span className="faint" style={{ fontSize: 12.5 }}>{limitText(p.seats)} people · {limitText(p.workspaces)} workspaces · {priceText(p)}</span>
              <span style={{ flex: 1 }} />
              <TrialButton plan={p.id} primary={p.id === "team"} />
            </div>
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Good to know</h2></div>
        <div className="panel-b">
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>A <b>person</b> is anyone with a Sidekick account in your organization, whatever their role. Client guests in Teams chats are free.</li>
            <li>Change plans or cancel any time from <b>Usage &amp; billing</b>. After canceling, Sidekick stays usable until the end of what you paid for, then turns read-only; nothing is deleted.</li>
            <li>Already have an account? <Link href="/login">Sign in</Link>. Questions? See <Link href="/support">Support</Link>.</li>
          </ul>
        </div>
      </div>
    </PublicShell>
  );
}
