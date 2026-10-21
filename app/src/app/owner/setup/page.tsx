"use client";

/**
 * Owner Console setup (/owner/setup): creates the first owner account, from the machine running Sidekick or,
 * on the live site, with the one-time setup code (`SIDEKICK_SETUP_CODE`, see lib/owner.ts).
 */

import { useEffect, useState } from "react";
import { api } from "@/components/ui";

export default function OwnerSetupPage() {
  const [f, setF] = useState({ name: "", email: "", password: "", setupCode: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean; needsCode: boolean }>("/api/owner/auth/setup")
      .then((r) => {
        if (!r.needsSetup) window.location.assign("/owner/login");
        setNeedsCode(r.needsCode);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't reach Sidekick."));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/owner/auth/setup", { method: "POST", json: f });
      window.location.assign("/owner");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div>
          <div className="eyebrow">One-time setup</div>
          <h1>Create the owner account</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>This account sees every client&apos;s usage and can pause features. It&apos;s separate from any client login, and can only be created once.</p>
        </div>
        <div className="field"><label htmlFor="name">Your name</label><input id="name" className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
        <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></div>
        {needsCode && (
          <div className="field">
            <label htmlFor="setupCode">Setup code</label>
            <input id="setupCode" className="input" type="password" autoComplete="off" value={f.setupCode} onChange={(e) => setF({ ...f, setupCode: e.target.value })} required />
            <span className="hint">The one-time code set as SIDEKICK_SETUP_CODE on the server. Remove it from the server afterwards.</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="new-password" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          <span className="hint">At least 12 characters. Use a different password from your client login.</span>
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create owner account"}</button>
      </form>
    </div>
  );
}
