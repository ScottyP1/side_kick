"use client";

/**
 * Settings (/settings): Microsoft sign-in (connect the org's Microsoft tenant, require it), organization
 * branding (logo and brand color) and your own account (password).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/shell";
import { api, Icon, Pill, Switch, useReportError, useToast } from "@/components/ui";

type MsStatus = { configured: boolean; connected: boolean; tenantId: string | null; required: boolean; linked: boolean; canManage: boolean };

/**
 * Microsoft sign-in panel. Everyone sees whether it's on and whether their own account is linked; the Org
 * Owner connects the tenant (by signing in with Microsoft), requires it, or disconnects it. Results of the
 * Microsoft round trip come back as `?microsoft=connected` or `?error=…` and are shown here.
 */
function MicrosoftPanel() {
  const toast = useToast();
  const reportError = useReportError();
  const [s, setS] = useState<MsStatus | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<MsStatus>("/api/auth/microsoft").then(setS).catch(reportError), [reportError]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("microsoft") === "connected") toast("Microsoft sign-in connected");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.get("error")) setError(q.get("error")!);
    if (q.size) history.replaceState(null, "", "/settings");
    load();
  }, [load, toast]);
  if (!s) return null;

  const setRequired = async (required: boolean) => {
    setError("");
    try {
      await api("/api/auth/microsoft", { method: "PATCH", json: { required } });
      toast(required ? "Passwords are off: everyone signs in with Microsoft" : "Password sign-in allowed again");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change it.");
    }
  };
  const disconnect = async () => {
    if (!confirm("Disconnect Microsoft sign-in? People will need their Sidekick password to sign in.")) return;
    try {
      await api("/api/auth/microsoft", { method: "DELETE" });
      toast("Microsoft sign-in disconnected");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't disconnect.");
    }
  };

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Microsoft sign-in</h2>
        {s.connected ? <Pill kind="good">Connected</Pill> : <Pill>Not connected</Pill>}
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          People sign in with the Microsoft work account they use for Teams and Outlook. Sidekick still decides what they can see: they must be added on Users &amp; access first, and their role and workspaces apply as usual.
        </p>
        {!s.configured && <p className="callout warn" style={{ margin: 0 }}>Microsoft sign-in isn&apos;t set up on this Sidekick yet (the Sidekick team adds the app details).</p>}
        {s.configured && s.connected && s.tenantId && <span className="muted" style={{ fontSize: 12.5 }}>Microsoft tenant: <code>{s.tenantId}</code></span>}
        <span style={{ fontSize: 13 }}>Your account: {s.linked ? <Pill kind="good">Linked to Microsoft</Pill> : <Pill>Not linked yet</Pill>}{!s.linked && s.connected && s.configured && <> · <a href="/api/auth/microsoft/start?next=/settings">Sign in with Microsoft to link it</a></>}</span>
        {s.canManage && s.configured && !s.connected && (
          <div>
            <a className="btn primary" href="/api/auth/microsoft/start?mode=link">Connect with Microsoft</a>
            <span className="hint" style={{ display: "block", marginTop: 6 }}>Sign in with your work account: your company&apos;s Microsoft organization gets connected to this Sidekick organization.</span>
          </div>
        )}
        {s.canManage && s.connected && (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13.5 }}>
              <Switch on={s.required} onChange={setRequired} label="Require Microsoft sign-in" />
              <span><b>Require Microsoft sign-in</b><span className="muted"> · turns passwords off and signs everyone else out</span></span>
            </div>
            {!s.linked && <span className="hint">Link your own account first, so you can&apos;t get locked out.</span>}
            <div><button className="btn small danger" onClick={disconnect}>Disconnect</button></div>
          </>
        )}
        {error && <p className="err" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

const ACCENTS: [string, string | null][] = [["Default", null], ["Cobalt", "#2457c5"], ["Crimson", "#b4233c"], ["Violet", "#7a3fd1"], ["Purple", "#A100FF"], ["Graphite", "#3d4a52"]];

export default function SettingsPage() {
  const { me, reload } = useApp();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [logo, setLogo] = useState<string | null>(me.branding.logo ?? null);
  const [accent, setAccent] = useState<string | null>(me.branding.accent ?? null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwErr, setPwErr] = useState("");

  const loadLogo = (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return toast("Choose an image file (PNG, SVG or JPG).");
    if (f.size > 500_000) return toast("Use a logo under 500 KB.");
    const r = new FileReader();
    r.onload = () => setLogo(String(r.result));
    r.readAsDataURL(f);
  };
  const saveBrand = async () => {
    try {
      await api("/api/settings", { method: "PUT", json: { logo, accent } });
      await reload();
      toast("Branding saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save.");
    }
  };
  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwErr("");
    try {
      await api("/api/auth/password", { method: "POST", json: pw });
      setPw({ current: "", next: "" });
      await reload();
      toast("Password changed");
    } catch (err) {
      setPwErr(err instanceof Error ? err.message : "Couldn't change the password.");
    }
  };

  return (
    <>
      <div className="page-head"><div><div className="eyebrow">Settings</div><h1>Organization & account</h1></div></div>
      <div className="grid g2">
        <MicrosoftPanel />
        {me.user.admin && (
          <div className="panel">
            <div className="panel-h"><h2>Your branding</h2><span className="muted">Applies to the whole portal</span></div>
            <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="field">
                <label>Logo</label>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <div className="logo-slot">{logo ? <img src={logo} alt="Organization logo" /> : <span className="muted" style={{ fontSize: 12 }}>No logo yet</span>}</div>
                  <button className="btn small" onClick={() => ref.current?.click()}><Icon n="upload" />Upload logo</button>
                  {logo && <button className="btn small ghost" onClick={() => setLogo(null)}>Remove</button>}
                  <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => loadLogo(e.target.files?.[0])} />
                </div>
                <span className="hint">Use the official file from your brand portal. PNG or SVG with a transparent background works best.</span>
              </div>
              <div className="field">
                <label>Brand color</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {ACCENTS.map(([n, c]) => (
                    <button key={n} className="swatch-btn" aria-pressed={accent === c} title={n} aria-label={`Brand color ${n}`} onClick={() => setAccent(c)} style={{ background: c ?? "#4f46e5" }} />
                  ))}
                  <label className="btn small" style={{ position: "relative" }}>
                    Custom
                    <input type="color" aria-label="Custom brand color" style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} onChange={(e) => setAccent(e.target.value)} />
                  </label>
                </div>
              </div>
              <div><button className="btn primary" onClick={saveBrand}>Save branding</button></div>
            </div>
          </div>
        )}
        <form className="panel" onSubmit={changePw}>
          <div className="panel-h"><h2>Change password</h2></div>
          <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field"><label htmlFor="cur">Current password</label><input id="cur" className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
            <div className="field"><label htmlFor="new">New password</label><input id="new" className="input" type="password" autoComplete="new-password" minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /><span className="hint">At least 10 characters.</span></div>
            {pwErr && <p className="err">{pwErr}</p>}
            <div><button className="btn primary" type="submit" disabled={!pw.current || pw.next.length < 10}>Change password</button></div>
          </div>
        </form>
      </div>
    </>
  );
}
