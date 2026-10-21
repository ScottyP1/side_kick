"use client";

/**
 * Two-step sign-in screens, shared by the portal and the Owner Console (`base` is `/api/auth/mfa` or
 * `/api/owner/auth/mfa`; the API is described in lib/mfa-routes.ts):
 * - `SecondStepForm`: the step after a correct password at sign-in (a code from the app, a backup code,
 *   or "Use a passkey").
 * - `TwoStepPanel`: the security panel where someone turns two-step sign-in on, adds an authenticator app
 *   or passkeys, removes them (password asked again) and makes new backup codes.
 * - `BackupCodes`: the one-time list of backup codes, shown once.
 */

import { useCallback, useEffect, useState } from "react";
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api, Icon, Pill, useReportError, useToast } from "@/components/ui";

type Method = "totp" | "passkey";
type Factor = { id: string; kind: Method; label: string; added: string; lastUsed: string | null };
type Status = { factors: Factor[]; backupCodesLeft: number };

/** A passkey prompt the person cancelled (or that timed out) is not an error worth more than a short note. */
const passkeyMessage = (e: unknown) =>
  e instanceof Error && /NotAllowedError|cancel|timed out|not allowed/i.test(`${e.name} ${e.message}`)
    ? "The passkey prompt was closed. Try again, or use a code."
    : e instanceof Error ? e.message : "The passkey didn't work.";

/**
 * The second step of signing in. Calls `onDone({ mustChange })` once the session has started.
 *
 * @param methods what the account has: "totp" shows the code box (backup codes also go there), "passkey" the button
 */
export function SecondStepForm({ base, methods, onDone, onCancel }: { base: string; methods: Method[]; onDone: (r: { mustChange?: boolean }) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const verify = async (json: unknown) => {
    setBusy(true);
    setError("");
    try {
      onDone(await api<{ mustChange?: boolean }>(`${base}/verify`, { method: "POST", json }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      setBusy(false);
    }
  };
  const usePasskey = async () => {
    setError("");
    try {
      const { options } = await api<{ options: PublicKeyCredentialRequestOptionsJSON | null }>(`${base}/signin-options`, { method: "POST", json: {} });
      if (!options) return setError("No passkey is set up for this account. Use a code.");
      await verify({ passkey: await startAuthentication({ optionsJSON: options }) });
    } catch (e) {
      setError(passkeyMessage(e));
      setBusy(false);
    }
  };

  return (
    <form className="auth-card" onSubmit={(e) => { e.preventDefault(); verify({ code }); }}>
      <div>
        <h1>Check it&apos;s you</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Your password was right. Now confirm with your second step.</p>
      </div>
      {methods.includes("passkey") && (
        <button type="button" className="btn primary" onClick={usePasskey} disabled={busy}><Icon n="lock" />Use a passkey</button>
      )}
      <div className="field">
        <label htmlFor="mfa-code">{methods.includes("totp") ? "Code from your authenticator app, or a backup code" : "Or a backup code"}</label>
        <input id="mfa-code" className="input" autoComplete="one-time-code" inputMode={methods.includes("totp") ? "numeric" : "text"} value={code} onChange={(e) => setCode(e.target.value)} autoFocus={!methods.includes("passkey")} />
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className={methods.includes("passkey") ? "btn" : "btn primary"} type="submit" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Continue"}</button>
      <button type="button" className="btn ghost small" onClick={onCancel}>Back to sign-in</button>
    </form>
  );
}

/** The one-time list of backup codes, with a copy button. Shown right after they're made, never again. */
export function BackupCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const toast = useToast();
  const reportError = useReportError();
  return (
    <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10, background: "var(--bg-soft, transparent)" }}>
      <b>Your backup codes</b>
      <span className="muted">Each one works once, if you lose your phone or passkey. Save them in your password manager now: they won&apos;t be shown again.</span>
      <code style={{ display: "grid", gridTemplateColumns: "repeat(2, max-content)", gap: "4px 24px", fontSize: 14 }}>
        {codes.map((c) => <span key={c}>{c}</span>)}
      </code>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(codes.join("\n")).then(() => toast("Backup codes copied"), reportError)}>Copy</button>
        <button className="btn small primary" onClick={onClose}>I&apos;ve saved them</button>
      </div>
    </div>
  );
}

/**
 * Two-step sign-in settings for the signed-in account. `note` is shown under the title (e.g. that
 * Microsoft sign-in has its own checks).
 */
export function TwoStepPanel({ base, note }: { base: string; note?: string }) {
  const toast = useToast();
  const reportError = useReportError();
  const [s, setS] = useState<Status | null>(null);
  const [totp, setTotp] = useState<{ id: string; secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Status>(`${base}/status`).then(setS).catch(reportError), [base, reportError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!s) return null;
  const on = s.factors.length > 0;

  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  const startTotp = () => run(async () => setTotp(await api(`${base}/totp-start`, { method: "POST", json: {} })));
  const confirmTotp = () => run(async () => {
    const r = await api<{ backupCodes: string[] | null }>(`${base}/totp-confirm`, { method: "POST", json: { id: totp!.id, code } });
    setTotp(null);
    setCode("");
    if (r.backupCodes) setCodes(r.backupCodes);
    toast("Authenticator app added");
    await load();
  });
  const addPasskey = () => run(async () => {
    const label = prompt("Name this passkey (for example “MacBook Touch ID” or “iPhone”)", "Passkey");
    if (label === null) return;
    const options = await api<PublicKeyCredentialCreationOptionsJSON>(`${base}/passkey-options`, { method: "POST", json: {} });
    let response;
    try {
      response = await startRegistration({ optionsJSON: options });
    } catch (e) {
      throw new Error(passkeyMessage(e));
    }
    const r = await api<{ backupCodes: string[] | null }>(`${base}/passkey-add`, { method: "POST", json: { response, label } });
    if (r.backupCodes) setCodes(r.backupCodes);
    toast("Passkey added");
    await load();
  });
  const remove = (f: Factor) => run(async () => {
    const last = s.factors.length === 1;
    const password = prompt(`${last ? "This turns two-step sign-in off. " : ""}Type your password to remove “${f.label}”.`);
    if (!password) return;
    await api(`${base}/remove`, { method: "POST", json: { id: f.id, password } });
    toast(last ? "Two-step sign-in is off" : `Removed “${f.label}”`);
    await load();
  });
  const newCodes = () => run(async () => {
    const password = prompt("Type your password to make new backup codes. The old ones stop working.");
    if (!password) return;
    setCodes((await api<{ backupCodes: string[] }>(`${base}/backup-codes`, { method: "POST", json: { password } })).backupCodes);
    await load();
  });

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Two-step sign-in</h2>
        {on ? <Pill kind="good">On</Pill> : <Pill kind="warn">Off</Pill>}
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="muted">
          After your password, Sidekick also asks for a code from an authenticator app or a passkey (Face ID, Touch ID,
          Windows Hello). Someone who learns your password still can&apos;t get in.{note ? ` ${note}` : ""}
        </span>
        {s.factors.map((f) => (
          <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Icon n={f.kind === "passkey" ? "lock" : "shield"} />
            <span style={{ flex: 1 }}><b>{f.label}</b><span className="muted"> · added {new Date(f.added).toLocaleDateString()}{f.lastUsed ? ` · last used ${new Date(f.lastUsed).toLocaleDateString()}` : ""}</span></span>
            <button className="btn small ghost" onClick={() => remove(f)}>Remove</button>
          </div>
        ))}
        {codes && <BackupCodes codes={codes} onClose={() => setCodes(null)} />}
        {totp ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={totp.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: "#fff", borderRadius: 8 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 220 }}>
              <span>Scan this with your authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…). Can&apos;t scan? Enter this key:</span>
              <code style={{ wordBreak: "break-all" }}>{totp.secret.match(/.{1,4}/g)!.join(" ")}</code>
              <div className="field"><label htmlFor="totp-code">Then type the 6-digit code it shows</label><input id="totp-code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn primary small" onClick={confirmTotp} disabled={code.replace(/\s/g, "").length !== 6}>Turn on</button>
                <button className="btn small ghost" onClick={() => { setTotp(null); setCode(""); }}>Cancel</button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn small" onClick={addPasskey}><Icon n="plus" />Add a passkey</button>
            {!s.factors.some((f) => f.kind === "totp") && <button className="btn small" onClick={startTotp}><Icon n="plus" />Add an authenticator app</button>}
            {on && <button className="btn small ghost" onClick={newCodes}>New backup codes ({s.backupCodesLeft} left)</button>}
          </div>
        )}
        {error && <p className="err" role="alert">{error}</p>}
      </div>
    </div>
  );
}
