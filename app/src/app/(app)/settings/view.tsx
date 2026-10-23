"use client";

/**
 * Settings (/settings): Microsoft sign-in (connect the org's Microsoft tenant, require it), "Require two-step
 * sign-in for everyone" (Org Owner; Org Admins see it read-only), organization
 * branding (logo and brand color) and your own account: password, two-step sign-in (components/two-step.tsx)
 * and where you're signed in (sign out other sessions). Org Owners and Org Admins also get **Export your
 * data** (the whole organization as a zip, GET /api/export) and **Roll-offs and certificates**: groups
 * ending, a pending deletion of the organization, and deletion certificates to download (GET /api/rolloffs).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/shell";
import { TwoStepPanel } from "@/components/two-step";
import { api, Icon, Pill, Switch, useReportError, useToast } from "@/components/ui";
import { takeFlash } from "@/lib/flash";
import { BACKUP_RETENTION_DAYS, ORG_GRACE_DAYS } from "@/lib/rolloff-policy";
import { BRAND } from "@/lib/brand";

type MsStatus = { configured: boolean; connected: boolean; tenantId: string | null; required: boolean; linked: boolean; canManage: boolean };

/**
 * Microsoft sign-in panel. Everyone sees whether it's on and whether their own account is linked; the Org
 * Owner connects the tenant (by signing in with Microsoft), requires it, or disconnects it. Results of the
 * Microsoft round trip come back as `?microsoft=connected` or `?error=1` (message in a one-time cookie,
 * lib/flash.ts) and are shown here.
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
    if (q.has("error")) setError(takeFlash("Connecting Microsoft sign-in didn't finish. Try again."));
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
    if (!confirm(`Disconnect Microsoft sign-in? People will need their ${BRAND.name} password to sign in.`)) return;
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
          People sign in with the Microsoft work account they use for Teams and Outlook. {BRAND.name} still decides what they can see: they must be added on Users &amp; access first, and their role and workspaces apply as usual.
        </p>
        {!s.configured && <p className="callout warn" style={{ margin: 0 }}>Microsoft sign-in isn&apos;t set up on this {BRAND.name} yet (the {BRAND.name} team adds the app details).</p>}
        {s.configured && s.connected && s.tenantId && <span className="muted" style={{ fontSize: 12.5 }}>Microsoft tenant: <code>{s.tenantId}</code></span>}
        <span style={{ fontSize: 13 }}>Your account: {s.linked ? <Pill kind="good">Linked to Microsoft</Pill> : <Pill>Not linked yet</Pill>}{!s.linked && s.connected && s.configured && <> · <a href="/api/auth/microsoft/start?next=/settings">Sign in with Microsoft to link it</a></>}</span>
        {s.canManage && s.configured && !s.connected && (
          <div>
            <a className="btn primary" href="/api/auth/microsoft/start?mode=link">Connect with Microsoft</a>
            <span className="hint" style={{ display: "block", marginTop: 6 }}>Sign in with your work account: your company&apos;s Microsoft organization gets connected to this {BRAND.name} organization.</span>
          </div>
        )}
        {s.canManage && s.connected && (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13.5 }}>
              <Switch on={s.required} onChange={setRequired} label="Require Microsoft sign-in" />
              <span><b>Require Microsoft sign-in</b><span className="muted"> · turns passwords off and signs everyone else out</span></span>
            </div>
            {!s.linked && <span className="hint">Link your own account first, so you can&apos;t get locked out.</span>}
            {!s.required && (
              <span className="callout" style={{ margin: 0, fontSize: 13 }}>
                Recommended: require Microsoft sign-in. Microsoft then checks every sign-in with your company&apos;s own rules (multi-factor
                sign-in, Conditional Access), and nobody can guess a {BRAND.name} password. If Microsoft sign-in ever breaks, the {BRAND.name} team
                can let you back in.
              </span>
            )}
            <div><button className="btn small danger" onClick={disconnect}>Disconnect</button></div>
          </>
        )}
        {error && <p className="err" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

type TwoStepPolicy = { required: boolean; microsoftRequired: boolean; canManage: boolean; withoutTwoStep: number | null };

/**
 * "Two-step sign-in for everyone" (Org Owners and Admins see it; only the Org Owner can flip it). When on,
 * everyone who signs in with a password and has no authenticator app or passkey is asked to set one up
 * before using the portal (GET/PATCH /api/auth/two-step-policy; enforcement in lib/auth.ts). Microsoft
 * sign-in is exempt, so the panel says it isn't needed when the org requires Microsoft sign-in.
 */
function TwoStepPolicyPanel() {
  const toast = useToast();
  const reportError = useReportError();
  const [p, setP] = useState<TwoStepPolicy | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<TwoStepPolicy>("/api/auth/two-step-policy").then(setP).catch(reportError), [reportError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!p) return null;
  const set = async (required: boolean) => {
    setError("");
    try {
      await api("/api/auth/two-step-policy", { method: "PATCH", json: { required } });
      toast(required ? "Two-step sign-in is now required" : "Two-step sign-in is optional again");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change it.");
    }
  };
  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Two-step sign-in for everyone</h2>
        {p.required ? <Pill kind="good">Required</Pill> : <Pill>Optional</Pill>}
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          When it&apos;s required, everyone who signs in with an email and password must also use an authenticator app or a passkey. People who don&apos;t have one yet are asked to set it up the next time they open {BRAND.name}. Signing in with Microsoft is exempt: Microsoft runs its own checks.
        </p>
        {p.microsoftRequired && <span className="callout" style={{ margin: 0, fontSize: 13 }}>Your organization requires Microsoft sign-in, so nobody signs in with a password and this switch isn&apos;t needed.</span>}
        {p.canManage ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13.5 }}>
            <Switch on={p.required} onChange={set} label="Require two-step sign-in for everyone" />
            <span><b>Require two-step sign-in for everyone</b><span className="muted"> · password sign-ins only</span></span>
          </div>
        ) : (
          <span className="hint">Only the Org Owner can change this.</span>
        )}
        {p.withoutTwoStep !== null && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            {p.withoutTwoStep === 0 ? "Everyone in your organization has set up two-step sign-in." : `${p.withoutTwoStep} ${p.withoutTwoStep === 1 ? "person hasn't" : "people haven't"} set up two-step sign-in yet${p.required ? " (they'll be asked when they next sign in with a password)" : ""}.`}
          </span>
        )}
        {error && <p className="err" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

type SessionInfo = { id: string; current: boolean; started: string | null; lastUsed: string | null; device: string; ip: string | null };

/** Where you're signed in: your sessions (browser, address, when), with "Sign out" per session and for all others. */
function SessionsPanel() {
  const toast = useToast();
  const reportError = useReportError();
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const load = useCallback(() => api<{ sessions: SessionInfo[] }>("/api/auth/sessions").then((r) => setList(r.sessions)).catch(reportError), [reportError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!list) return null;
  const end = async (id?: string) => {
    try {
      const r = await api<{ ended: number }>("/api/auth/sessions", { method: "DELETE", json: id ? { id } : {} });
      toast(id ? "Signed out that session" : `Signed out everywhere else (${r.ended})`);
      load();
    } catch (e) {
      reportError(e);
    }
  };
  const when = (t: string | null) => (t ? new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "unknown");
  const others = list.filter((x) => !x.current).length;
  return (
    <div className="panel">
      <div className="panel-h"><h2>Where you&apos;re signed in</h2><span className="muted">{list.length} {list.length === 1 ? "session" : "sessions"}</span></div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {list.map((x) => (
          <div key={x.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 200 }}>
              <b>{x.device}</b>{x.current && <> <Pill kind="good">This browser</Pill></>}
              <span className="muted" style={{ display: "block", fontSize: 12.5 }}>{x.ip ? `${x.ip} · ` : ""}signed in {when(x.started)} · last used {when(x.lastUsed)}</span>
            </span>
            {!x.current && <button className="btn small ghost" onClick={() => end(x.id)}>Sign out</button>}
          </div>
        ))}
        <span className="hint">Don&apos;t recognise one? Sign it out and change your password (that also signs out everywhere else).</span>
        {others > 0 && <div><button className="btn small danger" onClick={() => end()}>Sign out everywhere else</button></div>}
      </div>
    </div>
  );
}

const ACCENTS: [string, string | null][] = [["Default", null], ["Cobalt", "#2457c5"], ["Crimson", "#b4233c"], ["Violet", "#7a3fd1"], ["Purple", "#A100FF"], ["Graphite", "#3d4a52"]];

type RolloffRow = { id: string; scope: "group" | "org"; group: string | null; status: "scheduled" | "running" | "canceled" | "done"; deleteOn: string; requestedBy: string; closedAt: string | null; certificate: { id: string } | null };

/**
 * Export your data and the organization's roll-offs (Org Owners and Org Admins): download everything as
 * a zip at any time (also while read-only after canceling), see groups that are ending or the
 * organization's scheduled deletion, and download each deletion certificate (PDF or text).
 */
function DataPanel() {
  const reportError = useReportError();
  const [rows, setRows] = useState<RolloffRow[] | null>(null);
  useEffect(() => {
    api<{ rolloffs: RolloffRow[] }>("/api/rolloffs").then((r) => setRows(r.rolloffs)).catch(reportError);
  }, [reportError]);
  const label = (r: RolloffRow) => (r.scope === "group" ? `Group “${r.group}”` : "The whole organization");
  const day = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
  return (
    <div className="panel">
      <div className="panel-h"><h2>Your data</h2><span className="muted">Export, roll-offs, certificates</span></div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div><a className="btn" href="/api/export"><Icon n="upload" />Export your data (zip)</a></div>
        <span className="hint">Every group (documents&apos; text, meetings with notes and action items, questions, Teams chat summary), everyone in the organization and the audit log, with an index page. To end one engagement, open its group → Settings. If you cancel your plan, everything stays read-only for {ORG_GRACE_DAYS} days after the paid period, then it&apos;s deleted; backups age out within {BACKUP_RETENTION_DAYS} days.</span>
        <h3 style={{ margin: "6px 0 0", fontSize: 15 }}>Roll-offs and certificates</h3>
        {!rows ? <span className="muted">Loading…</span> : !rows.length ? <span className="muted">Nothing has been scheduled for deletion.</span> : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r) => (
              <li key={r.id}>
                {label(r)}: {r.status === "done" ? `deleted ${day(r.closedAt)}` : r.status === "canceled" ? "deletion cancelled" : `deleted on ${day(r.deleteOn)}`} <span className="muted">(asked by {r.requestedBy})</span>
                {r.certificate && <> · <a href={`/api/rolloffs/${r.id}/certificate?format=pdf`}>Certificate {r.certificate.id} (PDF)</a> · <a href={`/api/rolloffs/${r.id}/certificate`}>text</a></>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

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
        {me.user.admin && <TwoStepPolicyPanel />}
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
            <div className="field"><label htmlFor="new">New password</label><input id="new" className="input" type="password" autoComplete="new-password" minLength={12} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /><span className="hint">At least 12 characters, and not one from a known data breach. A password manager can make one.</span></div>
            {pwErr && <p className="err">{pwErr}</p>}
            <div><button className="btn primary" type="submit" disabled={!pw.current || pw.next.length < 12}>Change password</button></div>
          </div>
        </form>
        <TwoStepPanel base="/api/auth/mfa" note="Signing in with Microsoft skips this step: Microsoft runs its own checks." />
        <SessionsPanel />
        {me.user.admin && <DataPanel />}
      </div>
    </>
  );
}
