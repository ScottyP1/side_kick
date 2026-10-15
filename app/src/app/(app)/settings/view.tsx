"use client";

import { useRef, useState } from "react";
import { useApp } from "@/components/shell";
import { api, Icon, useToast } from "@/components/ui";

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
                    <button key={n} className="swatch-btn" aria-pressed={accent === c} title={n} aria-label={`Brand color ${n}`} onClick={() => setAccent(c)} style={{ background: c ?? "#0f6b5c" }} />
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
