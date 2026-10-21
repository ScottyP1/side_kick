"use client";

/**
 * Sign in (/login) to the client portal: "Sign in with Microsoft" (when set up; see lib/entra.ts) or email
 * and password. Problems from the Microsoft round trip come back as `?error=…` and are shown here. With
 * two-step sign-in on, a correct password leads to the second step (components/two-step.tsx).
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { SecondStepForm } from "@/components/two-step";
import { api } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [microsoft, setMicrosoft] = useState(false);
  // Set when the password was right and the account has two-step sign-in: its methods.
  const [secondStep, setSecondStep] = useState<("totp" | "passkey")[] | null>(null);

  useEffect(() => {
    // Read after mount: the page is static, and the error comes back from Microsoft in the address.
    const back = new URLSearchParams(location.search).get("error");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (back) setError(back);
    api<{ needsSetup: boolean; microsoft: boolean }>("/api/auth/setup").then((r) => {
      if (r.needsSetup) location.href = "/setup";
      setNeedsSetup(r.needsSetup);
      setMicrosoft(r.microsoft);
    }).catch((e) => setError(e instanceof Error ? e.message : "Couldn't reach Sidekick."));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ secondStep?: { methods: ("totp" | "passkey")[] } }>("/api/auth/login", { method: "POST", json: { email, password } });
      if (r.secondStep) {
        setSecondStep(r.secondStep.methods);
        setBusy(false);
        return;
      }
      location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  if (secondStep) {
    return (
      <div className="auth-wrap">
        <SecondStepForm base="/api/auth/mfa" methods={secondStep} onDone={() => (location.href = "/")} onCancel={() => { setSecondStep(null); setPassword(""); }} />
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">S</span>
          <div>
            <b style={{ color: "var(--fg)" }}>Sidekick</b>
          </div>
        </div>
        <div>
          <h1>Sign in</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Your AI teammate for Teams meetings.</p>
        </div>
        {microsoft && (
          <>
            <a className="btn ms-btn" href="/api/auth/microsoft/start">
              <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
              Sign in with Microsoft
            </a>
            <div className="or-line"><span>or use your email</span></div>
          </>
        )}
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {needsSetup && <Link href="/setup">Set up your organization</Link>}
      </form>
    </div>
  );
}
