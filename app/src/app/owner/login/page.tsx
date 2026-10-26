"use client";

/**
 * Owner Console sign-in (/owner/login), separate from client sign-in.
 * - **Sign in with Microsoft** is the normal way in when it's set up (`microsoft` from GET /api/owner/auth/setup):
 *   the button goes to /api/owner/auth/microsoft/start, and only the allowed operator accounts get through
 *   (lib/owner.ts). A refusal comes back as `?error=1` with the reason in a flash cookie (lib/flash.ts). With a
 *   passkey registered, Microsoft's callback sends the browser back here with `?step=passkey` for it.
 * - **Other ways to sign in** (behind a small link when Microsoft is on; shown straight away when it isn't, e.g.
 *   on localhost): email + password. After a password reset from the command line (scripts/reset-password.mjs)
 *   the sign-in answers `mustChange`, and this page asks for a new password (POST /api/owner/auth/password)
 *   before opening the console. With two-step sign-in on, a correct password leads to the second step first
 *   (components/two-step.tsx). The first-owner setup page is only offered when Microsoft sign-in is off.
 */

import { useEffect, useState } from "react";
import { SecondStepForm } from "@/components/two-step";
import { api } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { takeFlash } from "@/lib/flash";

export default function OwnerLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Set after signing in with a temporary password: the page then asks for a new one.
  const [mustChange, setMustChange] = useState(false);
  const [secondStep, setSecondStep] = useState<("totp" | "passkey")[] | null>(null);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  // Whether "Sign in with Microsoft" is on, and whether the password form is open ("Other ways to sign in").
  const [microsoft, setMicrosoft] = useState(false);
  const [otherWays, setOtherWays] = useState(false);

  useEffect(() => {
    // Read after mount: the page is static, and Microsoft's callback says what happened in the address.
    const q = new URLSearchParams(location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.has("error")) setError(takeFlash("Microsoft sign-in didn't finish. Try again."));
    if (q.get("step") === "passkey") setSecondStep(["passkey"]);
    api<{ needsSetup: boolean; microsoft: boolean }>("/api/owner/auth/setup")
      .then((r) => {
        setMicrosoft(r.microsoft);
        if (r.needsSetup && !r.microsoft) window.location.assign("/owner/setup");
      })
      .catch((e) => setError(e instanceof Error ? e.message : `Couldn't reach ${BRAND.name}.`));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ mustChange?: boolean; secondStep?: { methods: ("totp" | "passkey")[] } }>("/api/owner/auth/login", { method: "POST", json: { email, password } });
      if (r.secondStep) {
        setSecondStep(r.secondStep.methods);
        setBusy(false);
        return;
      }
      if (r.mustChange) {
        setMustChange(true);
        setBusy(false);
        return;
      }
      window.location.assign("/owner");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError("The two new passwords don't match.");
    setBusy(true);
    setError("");
    try {
      await api("/api/owner/auth/password", { method: "POST", json: { current: password, next } });
      window.location.assign("/owner");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password.");
      setBusy(false);
    }
  };

  if (secondStep && !mustChange) {
    return (
      <div className="auth-wrap">
        <SecondStepForm
          base="/api/owner/auth/mfa"
          methods={secondStep}
          onDone={(r) => (r.mustChange ? setMustChange(true) : window.location.assign("/owner"))}
          onCancel={() => { setSecondStep(null); setPassword(""); history.replaceState(null, "", "/owner/login"); }}
        />
      </div>
    );
  }

  if (mustChange) {
    return (
      <div className="auth-wrap">
        <form className="auth-card" onSubmit={change}>
          <div>
            <h1>Pick a new password</h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>You signed in with a temporary password. Choose your own (at least 12 characters, not one from a known data breach) to open the Owner Console. A password manager can make one for you.</p>
          </div>
          <div className="field">
            <label htmlFor="next">New password</label>
            <input id="next" className="input" type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="confirm">New password again</label>
            <input id="confirm" className="input" type="password" autoComplete="new-password" minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save and continue"}</button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark owner-mark">S</span>
          <div><b style={{ color: "var(--fg)" }}>{BRAND.name}</b></div>
        </div>
        <div>
          <h1>Owner Console</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>For the {BRAND.name} team only. Client users sign in at the main portal.</p>
        </div>
        {microsoft && (
          <a className="btn ms-btn" href="/api/owner/auth/microsoft/start">
            <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
            Sign in with Microsoft
          </a>
        )}
        {(!microsoft || otherWays) && (
          <>
            {microsoft && <div className="or-line"><span>or use your email</span></div>}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {error && <p className="err" role="alert">{error}</p>}
        {(!microsoft || otherWays) && <button className={microsoft ? "btn" : "btn primary"} type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>}
        {microsoft && !otherWays && (
          <button type="button" className="linklike muted" style={{ fontSize: 13, alignSelf: "center", textDecoration: "underline" }} onClick={() => setOtherWays(true)}>Other ways to sign in</button>
        )}
      </form>
    </div>
  );
}
