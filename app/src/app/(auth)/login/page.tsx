"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/auth/setup").then((r) => {
      if (r.needsSetup) location.href = "/setup";
      setNeedsSetup(r.needsSetup);
    }).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", json: { email, password } });
      location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

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
        <span className="muted" style={{ fontSize: 12.5 }}>Microsoft sign-in (Entra ID) arrives in step 2.</span>
      </form>
    </div>
  );
}
