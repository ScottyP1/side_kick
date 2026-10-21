"use client";

/**
 * Checkout (/checkout): pay for the organization's plan, after sign-up or from Usage & billing.
 * Signed-in Org Owners and Billing Admins. Shows the plan (`?plan=` picks another one), the price per person,
 * the people counted today and the monthly total, and one **Pay (test mode)** button. Test mode only: no
 * money moves and **no payment details are collected**: there are no card fields here, on purpose. With a
 * real provider later this page would hand over to the provider's own payment page instead.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/components/ui";
import { PublicShell, TestModeBanner } from "@/components/public-shell";
import { planById, PLANS, STATUS_LABEL, TRIAL_DAYS, type PlanId, type SubStatus } from "@/lib/plans";

type Billing = {
  subscription: { plan: PlanId; status: SubStatus; trial_ends_at: string | null } | null;
  usage: { seats: number; workspaces: number };
  canManage: boolean;
  testMode: boolean;
};

export default function CheckoutPage() {
  const [b, setB] = useState<Billing | null>(null);
  const [plan, setPlan] = useState<PlanId>("team");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const asked = PLANS.find((p) => p.id === new URLSearchParams(location.search).get("plan"));
    api<Billing>("/api/billing")
      .then((r) => {
        setB(r);
        setPlan(asked?.id ?? r.subscription?.plan ?? "team");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your plan."));
  }, []);

  const payNow = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/billing", { method: "POST", json: { action: "pay", plan } });
      // A new organization carries on with the setup wizard; one that's already set up goes back to billing.
      const me = await api<{ setupPending?: boolean }>("/api/me");
      location.href = me.setupPending ? "/get-started?paid=1" : "/usage?paid=1";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed.");
      setBusy(false);
    }
  };

  const p = planById(plan)!;
  const seats = Math.max(1, b?.usage.seats ?? 1);
  return (
    <PublicShell narrow>
      <div style={{ display: "grid", placeItems: "center" }}>
        <div className="auth-card">
          <div>
            <div className="eyebrow">Checkout</div>
            <h1>Pay for Sidekick</h1>
          </div>
          <TestModeBanner />
          {error && <p className="err" role="alert">{error}</p>}
          {!b ? (!error && <span className="muted">Loading…</span>) : !b.subscription ? (
            <p className="muted" style={{ margin: 0 }}>Your organization&apos;s plan is managed by the Sidekick team, so there&apos;s nothing to pay here. <Link href="/">Go to Sidekick</Link>.</p>
          ) : !b.canManage ? (
            <p className="muted" style={{ margin: 0 }}>Only the Org Owner or a Billing Admin can pay. <Link href="/">Go to Sidekick</Link>.</p>
          ) : (
            <>
              <div className="field">
                <label htmlFor="plan">Plan</label>
                <select id="plan" className="input" value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}>
                  {PLANS.map((x) => <option key={x.id} value={x.id}>{x.name}: ${x.pricePerSeat} per person / month</option>)}
                </select>
              </div>
              <div className="kv" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
                <span className="muted">Price</span><span className="num">${p.pricePerSeat} × {seats} {seats === 1 ? "person" : "people"}</span>
                <span className="muted">Every 30 days</span><b className="num">${(p.pricePerSeat * seats).toFixed(2)}</b>
                <span className="muted">Status now</span><span>{STATUS_LABEL[b.subscription.status]}</span>
              </div>
              <span className="muted" style={{ fontSize: 13 }}>The total follows the number of people in your organization. Nothing is charged in test mode.</span>
              <button className="btn primary" onClick={payNow} disabled={busy}>{busy ? "Paying…" : "Pay (test mode)"}</button>
              {b.subscription.status === "trialing" && <Link className="btn ghost" href="/get-started">Not now: use the {TRIAL_DAYS}-day free trial</Link>}
            </>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
