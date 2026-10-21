"use client";

/**
 * Checkout (/checkout): pay for the organization's plan, after sign-up or from Usage & billing.
 * Signed-in Org Owners and Billing Admins. Shows the plan (`?plan=` picks another one) and extra groups
 * (`?extras=`), the plan's price per organization, the extra groups' price and the monthly total (people are a
 * limit, not part of the price), and one **Pay (test mode)** button. Test mode only: no
 * money moves and **no payment details are collected**: there are no card fields here, on purpose. With a
 * real provider later this page would hand over to the provider's own payment page instead.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/components/ui";
import { PublicShell, TestModeBanner } from "@/components/public-shell";
import { EXTRA_GROUP, limitsWithExtras, limitText, MAX_EXTRA_GROUPS, monthlyPrice, planById, PLANS, STATUS_LABEL, TRIAL_DAYS, usd, type PlanId, type SubStatus } from "@/lib/plans";
import { BRAND } from "@/lib/brand";

type Billing = {
  subscription: { plan: PlanId; status: SubStatus; trial_ends_at: string | null; extra_groups: number } | null;
  usage: { seats: number; workspaces: number };
  canManage: boolean;
  testMode: boolean;
};

export default function CheckoutPage() {
  const [b, setB] = useState<Billing | null>(null);
  const [plan, setPlan] = useState<PlanId>("team");
  const [extras, setExtras] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const asked = PLANS.find((p) => p.id === q.get("plan"));
    const askedExtras = q.has("extras") ? Number(q.get("extras")) : NaN;
    api<Billing>("/api/billing")
      .then((r) => {
        setB(r);
        setPlan(asked?.id ?? r.subscription?.plan ?? "team");
        setExtras(Number.isInteger(askedExtras) && askedExtras >= 0 && askedExtras <= MAX_EXTRA_GROUPS ? askedExtras : (r.subscription?.extra_groups ?? 0));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your plan."));
  }, []);

  const payNow = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/billing", { method: "POST", json: { action: "pay", plan, extraGroups: extras } });
      // A new organization carries on with the setup wizard; one that's already set up goes back to billing.
      const me = await api<{ setupPending?: boolean }>("/api/me");
      location.href = me.setupPending ? "/get-started?paid=1" : "/usage?paid=1";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed.");
      setBusy(false);
    }
  };

  const p = planById(plan)!;
  const lim = limitsWithExtras(p, extras);
  return (
    <PublicShell narrow>
      <div style={{ display: "grid", placeItems: "center" }}>
        <div className="auth-card">
          <div>
            <div className="eyebrow">Checkout</div>
            <h1>Pay for {BRAND.name}</h1>
          </div>
          <TestModeBanner />
          {error && <p className="err" role="alert">{error}</p>}
          {!b ? (!error && <span className="muted">Loading…</span>) : !b.subscription ? (
            <p className="muted" style={{ margin: 0 }}>Your organization&apos;s plan is managed by the {BRAND.name} team, so there&apos;s nothing to pay here. <Link href="/home">Go to {BRAND.name}</Link>.</p>
          ) : !b.canManage ? (
            <p className="muted" style={{ margin: 0 }}>Only the Org Owner or a Billing Admin can pay. <Link href="/home">Go to {BRAND.name}</Link>.</p>
          ) : (
            <>
              <div className="field">
                <label htmlFor="plan">Plan</label>
                <select id="plan" className="input" value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}>
                  {PLANS.map((x) => <option key={x.id} value={x.id}>{x.name}: {usd(x.priceUsd)} / month, {limitText(x.workspaces)} group{x.workspaces === 1 ? "" : "s"}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="extras">Extra groups ({usd(EXTRA_GROUP.priceUsd)} each / month)</label>
                <input id="extras" className="input num" type="number" min={0} max={MAX_EXTRA_GROUPS} value={extras} onChange={(e) => setExtras(Math.max(0, Math.min(MAX_EXTRA_GROUPS, Math.floor(Number(e.target.value) || 0))))} />
              </div>
              <div className="kv" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
                <span className="muted">{p.name}</span><span className="num">{usd(p.priceUsd)}</span>
                {extras > 0 && <><span className="muted">{extras} extra group{extras === 1 ? "" : "s"} × {usd(EXTRA_GROUP.priceUsd)}</span><span className="num">{usd(extras * EXTRA_GROUP.priceUsd)}</span></>}
                <span className="muted">Every 30 days</span><b className="num">{usd(monthlyPrice(p, extras))}</b>
                <span className="muted">Includes</span><span>{limitText(lim.workspaces)} groups, up to {limitText(lim.seats)} people</span>
                <span className="muted">Status now</span><span>{STATUS_LABEL[b.subscription.status]}</span>
              </div>
              <span className="muted" style={{ fontSize: 13 }}>One price for the whole organization, by groups (one per client engagement); people are a limit, not a charge. Nothing is charged in test mode.</span>
              <button className="btn primary" onClick={payNow} disabled={busy}>{busy ? "Paying…" : "Pay (test mode)"}</button>
              {b.subscription.status === "trialing" && <Link className="btn ghost" href="/get-started">Not now: use the {TRIAL_DAYS}-day free trial</Link>}
            </>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
