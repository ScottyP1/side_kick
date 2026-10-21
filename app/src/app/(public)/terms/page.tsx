/**
 * Terms of use (/terms): plain-language placeholder, clearly marked as a draft for a lawyer to review.
 * Public (no sign-in); also the terms link for the Teams Store listing.
 */
import type { Metadata } from "next";
import { DraftNote, PublicShell } from "@/components/public-shell";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { BACKUP_RETENTION_DAYS, ORG_GRACE_DAYS } from "@/lib/rolloff-policy";
import { EXTRA_GROUP, usd } from "@/lib/plans";

export const metadata: Metadata = pageMetadata("/terms");

export default function TermsPage() {
  return (
    <PublicShell narrow current="/terms">
      <div className="page-head"><div><div className="eyebrow">Terms of use</div><h1>The rules for using {BRAND.name}</h1><p>Last updated October 21, 2026.</p></div></div>
      <DraftNote />
      <div className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0 }}>The service</h2>
        <p style={{ margin: 0 }}>{BRAND.name} is an AI teammate for Microsoft Teams, run as a personal project. It&apos;s offered as it is, may change, and may have outages. Answers come from an AI model and can be wrong: check anything important against the sources it shows.</p>
        <h2 style={{ margin: 0 }}>Your organization&apos;s account</h2>
        <p style={{ margin: 0 }}>The person who signs up becomes the Org Owner and is responsible for who they add and what they upload. Keep passwords private. You must have the right to upload the documents and meetings you give {BRAND.name}.</p>
        <h2 style={{ margin: 0 }}>Acceptable use</h2>
        <p style={{ margin: 0 }}>Don&apos;t use {BRAND.name} to break the law, harass people, or try to get around its guardrails or reach other organizations&apos; data.</p>
        <h2 style={{ margin: 0 }}>Plans and payment</h2>
        <p style={{ margin: 0 }}>Payments are in <b>test mode</b>: no money is charged and prices are placeholders. Plans are priced per organization per month by the number of groups (one per client engagement), with extra groups at {usd(EXTRA_GROUP.priceUsd)} each a month; people, meeting hours and AI credit are limits of the plan. When real payments start, these terms will say how billing, renewals and refunds work. If a payment fails or a trial ends, {BRAND.name} turns read-only; your data isn&apos;t deleted because of that.</p>
        <h2 style={{ margin: 0 }}>Ending</h2>
        <p style={{ margin: 0 }}>You can cancel any time from Usage &amp; billing. {BRAND.name} stays usable until the end of what you paid for, then read-only for {ORG_GRACE_DAYS} days so you can download your data; after that all of your organization&apos;s data is deleted (see the <a href="/privacy">privacy policy</a>; backups age out within {BACKUP_RETENTION_DAYS} days) and you can ask for the deletion certificate. Paying again before then keeps everything. The {BRAND.name} team may pause an organization that breaks these terms, or end the service for it with the same {ORG_GRACE_DAYS} days&apos; read-only notice.</p>
      </div></div>
    </PublicShell>
  );
}
