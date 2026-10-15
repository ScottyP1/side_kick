"use client";

/**
 * Owner Console sign-in (/owner/login), separate from client sign-in.
 */

import { useEffect, useState } from "react";
import { api } from "@/components/ui";

export default function OwnerLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      await api("/api/owner/auth/login", { method: "POST", json: { email, password } });
      window.location.assign("/owner");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark owner-mark">S</span>
          <div><b style={{ color: "var(--fg)" }}>Sidekick</b></div>
        </div>
        <div>
          <h1>Owner Console</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>For the Sidekick team only. Client users sign in at the main portal.</p>
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
