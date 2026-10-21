"use client";

/**
 * First-run setup (/setup): creates the organization and its Org Owner on a new install. On a production
 * server it also asks for the one-time setup code (`SIDEKICK_SETUP_CODE`, see lib/owner.ts).
 */

import { useEffect, useState } from "react";
import { api } from "@/components/ui";
import { BRAND } from "@/lib/brand";

export default function SetupPage() {
  const [f, setF] = useState({ org: "", name: "", email: "", password: "", setupCode: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean; needsCode: boolean }>("/api/auth/setup").then((r) => {
      if (!r.needsSetup) location.href = "/login";
      setNeedsCode(r.needsCode);
    }).catch((e) => setError(e instanceof Error ? e.message : `Couldn't reach ${BRAND.name}.`));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/setup", { method: "POST", json: f });
      location.href = "/workspaces";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f, label: string, type = "text", hint?: string, auto?: string) => (
    <div className="field">
      <label htmlFor={k}>{label}</label>
      <input id={k} className="input" type={type} autoComplete={auto} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required minLength={k === "password" ? 10 : undefined} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div>
          <div className="eyebrow">First-time setup</div>
          <h1>Set up {BRAND.name}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>You&apos;ll be the Org Owner. You can add your team afterward.</p>
        </div>
        {field("org", "Organization name")}
        {field("name", "Your name", "text", undefined, "name")}
        {field("email", "Work email", "email", undefined, "username")}
        {field("password", "Password", "password", "At least 12 characters, and not one from a known data breach.", "new-password")}
        {needsCode && field("setupCode", "Setup code", "password", "The one-time code set as SIDEKICK_SETUP_CODE on the server.", "off")}
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button>
      </form>
    </div>
  );
}
