"use client";

/**
 * Sign up (/signup): a company creates its Sidekick organization. Organization name, your name, work email,
 * password (at least 10 characters, as in Setup) and plan (from lib/plans.ts; `?plan=` from the pricing page
 * picks one). POST /api/signup creates the organization, makes you its Org Owner, starts the free trial and
 * signs you in; then you go to checkout. Sign-up is off by default (lib/signup.ts): while it's closed the
 * page shows a "not open yet, contact us" card instead of the form. "Sign up with Microsoft" will be added here once multi-tenant Microsoft sign-in exists.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/components/ui";
import { PublicShell, TestModeBanner } from "@/components/public-shell";
import { PLANS, planById, priceText, TRIAL_DAYS, type PlanId } from "@/lib/plans";

export default function SignupPage() {
  const [f, setF] = useState({ org: "", name: "", email: "", password: "", plan: "team" as PlanId });
  const [open, setOpen] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Read after mount: the page is static, and the plan comes from the pricing page's link.
    const plan = planById(new URLSearchParams(location.search).get("plan"));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (plan) setF((cur) => ({ ...cur, plan: plan.id }));
    api<{ open: boolean }>("/api/signup").then((r) => setOpen(r.open)).catch((e) => setError(e instanceof Error ? e.message : "Couldn't reach Sidekick."));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ next: string }>("/api/signup", { method: "POST", json: f });
      location.href = r.next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-up failed.");
      setBusy(false);
    }
  };
  const field = (k: "org" | "name" | "email" | "password", label: string, type = "text", hint?: string, auto?: string) => (
    <div className="field">
      <label htmlFor={k}>{label}</label>
      <input id={k} className="input" type={type} autoComplete={auto} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required minLength={k === "password" ? 10 : undefined} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );

  return (
    <PublicShell narrow>
      <div style={{ display: "grid", placeItems: "center" }}>
        {open === false ? (
          <div className="auth-card">
            <h1>Sign-up isn&apos;t open yet</h1>
            <p className="muted" style={{ margin: 0 }}>Sidekick is taking new organizations by invitation for now. <Link href="/support">Contact us</Link> and we&apos;ll set yours up. Already have an account? <Link href="/login">Sign in</Link>.</p>
            <Link className="btn primary" href="/support">Contact us</Link>
          </div>
        ) : (
          <form className="auth-card" onSubmit={submit}>
            <div>
              <div className="eyebrow">Start your {TRIAL_DAYS}-day free trial</div>
              <h1>Sign up for Sidekick</h1>
              <p className="muted" style={{ margin: "4px 0 0" }}>You&apos;ll be your organization&apos;s Org Owner and can add your team afterward.</p>
            </div>
            <TestModeBanner />
            {field("org", "Organization name")}
            {field("name", "Your name", "text", undefined, "name")}
            {field("email", "Work email", "email", "One Sidekick account per email.", "username")}
            {field("password", "Password", "password", "At least 10 characters.", "new-password")}
            <div className="field">
              <label htmlFor="plan">Plan</label>
              <select id="plan" className="input" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value as PlanId })}>
                {PLANS.map((p) => <option key={p.id} value={p.id}>{p.name}: {priceText(p)}</option>)}
              </select>
              <span className="hint"><Link href="/pricing">Compare plans</Link>. You can change it later.</span>
            </div>
            {error && <p className="err" role="alert">{error}</p>}
            <button className="btn primary" type="submit" disabled={busy || open === null}>{busy ? "Creating…" : "Create organization"}</button>
            <span className="muted" style={{ fontSize: 13 }}>By signing up you agree to the <Link href="/terms">terms of use</Link> and <Link href="/privacy">privacy policy</Link> (drafts). Already have an account? <Link href="/login">Sign in</Link>.</span>
          </form>
        )}
      </div>
    </PublicShell>
  );
}
