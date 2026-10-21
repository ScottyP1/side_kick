/**
 * Terms of use (/terms): plain-language placeholder, clearly marked as a draft for a lawyer to review.
 * Public (no sign-in); also the terms link for the Teams Store listing.
 */
import type { Metadata } from "next";
import { DraftNote, PublicShell } from "@/components/public-shell";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/terms");

export default function TermsPage() {
  return (
    <PublicShell narrow current="/terms">
      <div className="page-head"><div><div className="eyebrow">Terms of use</div><h1>The rules for using Sidekick</h1><p>Last updated October 20, 2026.</p></div></div>
      <DraftNote />
      <div className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0 }}>The service</h2>
        <p style={{ margin: 0 }}>Sidekick is an AI teammate for Microsoft Teams, run as a personal project. It&apos;s offered as it is, may change, and may have outages. Answers come from an AI model and can be wrong: check anything important against the sources it shows.</p>
        <h2 style={{ margin: 0 }}>Your organization&apos;s account</h2>
        <p style={{ margin: 0 }}>The person who signs up becomes the Org Owner and is responsible for who they add and what they upload. Keep passwords private. You must have the right to upload the documents and meetings you give Sidekick.</p>
        <h2 style={{ margin: 0 }}>Acceptable use</h2>
        <p style={{ margin: 0 }}>Don&apos;t use Sidekick to break the law, harass people, or try to get around its guardrails or reach other organizations&apos; data.</p>
        <h2 style={{ margin: 0 }}>Plans and payment</h2>
        <p style={{ margin: 0 }}>Payments are in <b>test mode</b>: no money is charged and prices are placeholders. When real payments start, these terms will say how billing, renewals and refunds work. If a plan lapses, Sidekick turns read-only; your data isn&apos;t deleted because of it.</p>
        <h2 style={{ margin: 0 }}>Ending</h2>
        <p style={{ margin: 0 }}>You can cancel any time from Usage &amp; billing. The Sidekick team may pause an organization that breaks these terms.</p>
      </div></div>
    </PublicShell>
  );
}
