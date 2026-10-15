"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/ui";

export default function SetupPage() {
  const [f, setF] = useState({ org: "", name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/auth/setup").then((r) => {
      if (!r.needsSetup) location.href = "/login";
    }).catch(() => {});
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
          <h1>Set up Sidekick</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>You&apos;ll be the Org Owner. You can add your team afterward.</p>
        </div>
        {field("org", "Organization name")}
        {field("name", "Your name", "text", undefined, "name")}
        {field("email", "Work email", "email", undefined, "username")}
        {field("password", "Password", "password", "At least 10 characters.", "new-password")}
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button>
      </form>
    </div>
  );
}
