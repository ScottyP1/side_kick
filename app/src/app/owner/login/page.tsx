"use client";

/**
 * Owner Console sign-in (/owner/login), separate from client sign-in. After a password reset from the
 * command line (scripts/reset-password.mjs) the sign-in answers `mustChange`, and this page asks for a new
 * password (POST /api/owner/auth/password) before opening the console. With two-step sign-in on, a correct
 * password leads to the second step first (components/two-step.tsx).
 */

import { useEffect, useState } from "react";
import { SecondStepForm } from "@/components/two-step";
import { api } from "@/components/ui";
import { BRAND } from "@/lib/brand";

export default function OwnerLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Set after signing in with a temporary password: the page then asks for a new one.
  const [mustChange, setMustChange] = useState(false);
  const [secondStep, setSecondStep] = useState<("totp" | "passkey")[] | null>(null);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/owner/auth/setup")
      .then((r) => r.needsSetup && window.location.assign("/owner/setup"))
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ mustChange?: boolean; secondStep?: { methods: ("totp" | "passkey")[] } }>("/api/owner/auth/login", { method: "POST", json: { email, password } });
      if (r.secondStep) {
        setSecondStep(r.secondStep.methods);
        setBusy(false);
        return;
      }
      if (r.mustChange) {
        setMustChange(true);
        setBusy(false);
        return;
      }
      window.location.assign("/owner");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError("The two new passwords don't match.");
    setBusy(true);
    setError("");
    try {
      await api("/api/owner/auth/password", { method: "POST", json: { current: password, next } });
      window.location.assign("/owner");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password.");
      setBusy(false);
    }
  };

  if (secondStep && !mustChange) {
    return (
      <div className="auth-wrap">
        <SecondStepForm
          base="/api/owner/auth/mfa"
          methods={secondStep}
          onDone={(r) => (r.mustChange ? setMustChange(true) : window.location.assign("/owner"))}
          onCancel={() => { setSecondStep(null); setPassword(""); }}
        />
      </div>
    );
  }

  if (mustChange) {
    return (
      <div className="auth-wrap">
        <form className="auth-card" onSubmit={change}>
          <div>
            <h1>Pick a new password</h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>You signed in with a temporary password. Choose your own (at least 12 characters, not one from a known data breach) to open the Owner Console. A password manager can make one for you.</p>
          </div>
          <div className="field">
            <label htmlFor="next">New password</label>
            <input id="next" className="input" type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="confirm">New password again</label>
            <input id="confirm" className="input" type="password" autoComplete="new-password" minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save and continue"}</button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark owner-mark">S</span>
          <div><b style={{ color: "var(--fg)" }}>{BRAND.name}</b></div>
        </div>
        <div>
          <h1>Owner Console</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>For the {BRAND.name} team only. Client users sign in at the main portal.</p>
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
