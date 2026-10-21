/**
 * Privacy policy (/privacy): plain-language placeholder, clearly marked as a draft for a lawyer to review.
 * Includes the retention and deletion policy (numbers from lib/rolloff-policy.ts, the same the server uses).
 * Public (no sign-in); also the privacy link for the Teams Store listing.
 */
import type { Metadata } from "next";
import { DraftNote, PublicShell } from "@/components/public-shell";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { BACKUP_RETENTION_DAYS, GROUP_DEFAULT_DAYS, MIN_GROUP_DAYS, ORG_GRACE_DAYS } from "@/lib/rolloff-policy";

export const metadata: Metadata = pageMetadata("/privacy");

export default function PrivacyPage() {
  return (
    <PublicShell narrow current="/privacy">
      <div className="page-head"><div><div className="eyebrow">Privacy policy</div><h1>How {BRAND.name} handles your data</h1><p>Last updated October 21, 2026.</p></div></div>
      <DraftNote />
      <div className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Who runs {BRAND.name}</h2>
        <p style={{ margin: 0 }}>{BRAND.name} is a personal project run by one person (the &quot;{BRAND.name} team&quot;). It isn&apos;t a company yet. Contact details are on the <a href="/support">Support</a> page.</p>
        <h2 style={{ margin: 0 }}>What we store</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li><b>Accounts</b>: names, work emails and roles of the people your organization adds. Passwords are stored only as one-way hashes.</li>
          <li><b>Your content</b>: documents you upload, meeting transcripts you import, questions asked, and (only in chats where an admin turns it on) Teams messages, kept 90 days.</li>
          <li><b>Records</b>: an audit log of who did what, usage and cost of AI requests, and technical traces (timings and counts, never document text).</li>
          <li><b>Billing</b>: your plan and its status. In test mode no payment details are collected at all; later, card payments would be handled by a payment provider on its own page, and {BRAND.name} would never see card numbers.</li>
        </ul>
        <h2 style={{ margin: 0 }}>How it&apos;s used</h2>
        <p style={{ margin: 0 }}>Only to run {BRAND.name} for your organization: answering your team, writing notes and reminders, and keeping the service working. Your content is sent to the AI model (Claude) to produce answers and is not used to train models. Each organization&apos;s data is walled off from every other, and each workspace from the others.</p>
        <h2 style={{ margin: 0 }}>Powered by Claude</h2>
        <p style={{ margin: 0 }}>{BRAND.name}&apos;s answers, meeting notes and reminders are powered by Claude, Anthropic&apos;s AI model. Claude sees only what one task needs (for example the few passages that answer one question), under terms where your content isn&apos;t used to train models. The {BRAND.name} team picks and runs the AI; your organization doesn&apos;t need its own AI account.</p>
        <h2 style={{ margin: 0 }}>Who else sees it</h2>
        <p style={{ margin: 0 }}>The services {BRAND.name} runs on (Microsoft Azure hosting, Microsoft Teams, the Claude AI model) process data on our behalf. We don&apos;t sell data or show ads. The {BRAND.name} team sees counts and usage for support, not your documents.</p>
        <h2 style={{ margin: 0 }}>How long we keep it, and deletion</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li><b>While you use {BRAND.name}</b>: your content is kept until you delete it, except saved Teams messages (90 days) and technical traces (30 days).</li>
          <li><b>When an engagement ends</b>: an Org Owner or Org Admin sets its group to end. It becomes read-only straight away and can be downloaded; on the date they pick ({GROUP_DEFAULT_DAYS} days by default, at least {MIN_GROUP_DAYS}) everything in the group is deleted, including its search index.</li>
          <li><b>When your organization leaves</b>: after a plan is canceled, {BRAND.name} stays usable until the end of what was paid for, then read-only for {ORG_GRACE_DAYS} days so admins can download everything. Then all of the organization&apos;s data is deleted: groups and their content, people and their sign-in details, Teams links, settings, usage details and the audit log.</li>
          <li><b>Deletion certificate</b>: each deletion produces a certificate listing which kinds of data were deleted and how many, when and at whose request. It contains no content. We keep it, with the organization&apos;s name and the dates, as the record of the deletion and for billing history.</li>
          <li><b>Backups</b>: our database provider keeps backups for {BACKUP_RETENTION_DAYS} days, so deleted data is gone from backups within {BACKUP_RETENTION_DAYS} days of the deletion. Backups are only used to recover from a failure.</li>
        </ul>
        <h2 style={{ margin: 0 }}>Your choices</h2>
        <p style={{ margin: 0 }}>Org Owners and Org Admins can download or delete documents, meetings and whole groups at any time, and download all of the organization&apos;s data from Settings. To have your organization&apos;s data deleted sooner, contact Support.</p>
      </div></div>
    </PublicShell>
  );
}
