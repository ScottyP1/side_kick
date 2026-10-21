"use client";

/**
 * Sign-up state on the public pricing page. Self-service sign-up is off by default (lib/signup.ts), so the
 * page asks GET /api/signup once and, while it's closed, shows a "not open yet, contact us" note and turns
 * each plan's "Start free trial" button into "Contact us" (to /support) instead of a link to a form that
 * would refuse. While it's loading, or when the check fails, the buttons stay as links: /signup itself
 * shows the closed state too.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

let cached: Promise<boolean | null> | null = null;
/** Whether sign-up is open (null = unknown). One request per page load, shared by every button. */
function useSignupOpen() {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    cached ??= fetch("/api/signup").then((r) => (r.ok ? r.json() : null)).then((j) => (j ? Boolean(j.open) : null), () => null);
    cached.then(setOpen);
  }, []);
  return open;
}

/** The "sign-up isn't open yet" note, shown only while sign-up is closed. */
export function SignupClosedNotice() {
  if (useSignupOpen() !== false) return null;
  return (
    <div className="callout warn" role="note">
      <span>
        <b>Sign-up isn&apos;t open yet.</b> Sidekick is taking new organizations by invitation for now. <Link href="/support">Contact us</Link> and we&apos;ll set yours up.
      </span>
    </div>
  );
}

/** A plan's call to action: "Start free trial" (to /signup with the plan) or, while closed, "Contact us". */
export function TrialButton({ plan, primary }: { plan: string; primary?: boolean }) {
  const open = useSignupOpen();
  const cls = `btn ${primary ? "primary" : ""}`;
  if (open === false) return <Link className={cls} href="/support">Contact us</Link>;
  return <Link className={cls} href={`/signup?plan=${plan}`}>Start free trial</Link>;
}
