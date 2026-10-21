"use client";

/**
 * Owner Console → Security (/owner/security): the signed-in owner's own sign-in: change the Owner Console
 * password (POST /api/owner/auth/password, which also signs out other browsers) and two-step sign-in
 * (authenticator app, passkeys, backup codes; components/two-step.tsx with /api/owner/auth/mfa).
 */
import { useState } from "react";
import { TwoStepPanel } from "@/components/two-step";
import { api, useToast } from "@/components/ui";

export default function OwnerSecurityPage() {
  const toast = useToast();
  const [pw, setPw] = useState({ current: "", next: "" });
  const [err, setErr] = useState("");
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await api("/api/owner/auth/password", { method: "POST", json: pw });
      setPw({ current: "", next: "" });
      toast("Password changed. Other browsers were signed out.");
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Couldn't change the password.");
    }
  };
  return (
    <>
      <div className="page-head"><div><div className="eyebrow">Owner Console</div><h1>Security</h1></div></div>
      <div className="grid g2">
        <TwoStepPanel base="/api/owner/auth/mfa" note="Strongly recommended here: the Owner Console sees every client." />
        <form className="panel" onSubmit={change}>
          <div className="panel-h"><h2>Change password</h2></div>
          <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field"><label htmlFor="cur">Current password</label><input id="cur" className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
            <div className="field"><label htmlFor="new">New password</label><input id="new" className="input" type="password" autoComplete="new-password" minLength={12} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /><span className="hint">At least 12 characters, not one from a known data breach, and different from your client login.</span></div>
            {err && <p className="err" role="alert">{err}</p>}
            <div><button className="btn primary" type="submit" disabled={!pw.current || pw.next.length < 12}>Change password</button></div>
          </div>
        </form>
      </div>
    </>
  );
}
