/**
 * Support (/support): how to get help, and the guides. Public (no sign-in); also the support link for the
 * Teams Store listing. Placeholder contact details until there's a real support address.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";

export const metadata: Metadata = { title: "Sidekick: support" };

export default function SupportPage() {
  return (
    <PublicShell narrow>
      <div className="page-head"><div><div className="eyebrow">Support</div><h1>Getting help with Sidekick</h1><p>Sidekick is a personal project, so support is best effort, usually within two working days.</p></div></div>
      <div className="callout warn" role="note"><span><b>Draft.</b> The contact address below is a placeholder until Sidekick has a real support mailbox.</span></div>
      <div className="grid g2">
        <div className="panel"><div className="panel-h"><h2>Contact</h2></div><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span>Email <b>support@sidekick.example</b> (placeholder).</span>
          <span className="muted">If you saw an error with a reference code (like K7Q2-9XM4), include it: it lets us find exactly what went wrong.</span>
          <span className="muted">Never send passwords or payment details by email.</span>
        </div></div>
        <div className="panel"><div className="panel-h"><h2>Common questions</h2></div><div className="panel-b">
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            <li><b>Forgot your password?</b> Ask your Org Owner or Org Admin to reset it from Users &amp; access.</li>
            <li><b>Change plan or cancel?</b> Org Owners and Billing Admins: Usage &amp; billing → Plan.</li>
            <li><b>Sidekick says it&apos;s read-only?</b> Your plan&apos;s trial ended or a payment failed. Pay on Usage &amp; billing to turn everything back on.</li>
            <li><b>Adding Sidekick to Teams?</b> Add the Sidekick app to the chat, then link it from Workspaces in the portal.</li>
          </ul>
        </div></div>
      </div>
      <p className="muted" style={{ margin: 0 }}>New here? See <Link href="/pricing">plans and pricing</Link> or <Link href="/signup">sign up</Link>.</p>
    </PublicShell>
  );
}
