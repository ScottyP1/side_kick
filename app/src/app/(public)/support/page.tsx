/**
 * Support (/support): the public contact form (components/support-form.tsx → a ticket for the Sidekick team),
 * common questions, and pointers to the help center, the help bot and the portal's Help & support. Public (no
 * sign-in); also the support link for the Teams Store listing.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { SupportForm } from "@/components/support-form";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = pageMetadata("/support");

export default function SupportPage() {
  return (
    <PublicShell narrow current="/support">
      <div className="page-head"><div><div className="eyebrow">Support</div><h1>Getting help with {BRAND.name}</h1><p>{BRAND.name} is a personal project, so support is best effort, usually within two working days.</p></div></div>
      <div className="grid g2">
        <div className="panel"><div className="panel-h"><h2>Contact support</h2></div><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="muted">Already using {BRAND.name}? Sign in and use <b>Help &amp; support</b> instead: your details are filled in and you can follow the ticket there.</span>
          <SupportForm />
        </div></div>
        <div className="panel"><div className="panel-h"><h2>Common questions</h2></div><div className="panel-b">
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            <li><b>Forgot your password?</b> Ask your Org Owner or Org Admin to reset it from Users &amp; access.</li>
            <li><b>Change plan or cancel?</b> Org Owners and Billing Admins: Usage &amp; billing → Plan.</li>
            <li><b>{BRAND.name} says it&apos;s read-only?</b> Your plan&apos;s trial ended or a payment failed. Pay on Usage &amp; billing to turn everything back on.</li>
            <li><b>Adding {BRAND.name} to Teams?</b> A Team Lead or admin adds the {BRAND.name} app to the chat, then assigns the chat to a group in the portal. See <Link href="/docs/teams-guide">{BRAND.name} in Teams</Link>.</li>
          </ul>
        </div></div>
      </div>
      <p className="muted" style={{ margin: 0 }}>Most answers are in the <Link href="/docs">help center</Link>, and the help bot (the round button, bottom left) can answer questions about {BRAND.name}. New here? See <Link href="/pricing">plans and pricing</Link> or <Link href="/signup">sign up</Link>.</p>
    </PublicShell>
  );
}
