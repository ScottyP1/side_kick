/**
 * Privacy policy (/privacy): plain-language placeholder, clearly marked as a draft for a lawyer to review.
 * Public (no sign-in); also the privacy link for the Teams Store listing.
 */
import type { Metadata } from "next";
import { DraftNote, PublicShell } from "@/components/public-shell";

export const metadata: Metadata = { title: "Sidekick: privacy policy (draft)" };

export default function PrivacyPage() {
  return (
    <PublicShell narrow>
      <div className="page-head"><div><div className="eyebrow">Privacy policy</div><h1>How Sidekick handles your data</h1><p>Last updated October 20, 2026.</p></div></div>
      <DraftNote />
      <div className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Who runs Sidekick</h2>
        <p style={{ margin: 0 }}>Sidekick is a personal project run by one person (the &quot;Sidekick team&quot;). It isn&apos;t a company yet. Contact details are on the <a href="/support">Support</a> page.</p>
        <h2 style={{ margin: 0 }}>What we store</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li><b>Accounts</b>: names, work emails and roles of the people your organization adds. Passwords are stored only as one-way hashes.</li>
          <li><b>Your content</b>: documents you upload, meeting transcripts you import, questions asked, and (only in chats where an admin turns it on) Teams messages, kept 90 days.</li>
          <li><b>Records</b>: an audit log of who did what, usage and cost of AI requests, and technical traces (timings and counts, never document text).</li>
          <li><b>Billing</b>: your plan and its status. In test mode no payment details are collected at all; later, card payments would be handled by a payment provider on its own page, and Sidekick would never see card numbers.</li>
        </ul>
        <h2 style={{ margin: 0 }}>How it&apos;s used</h2>
        <p style={{ margin: 0 }}>Only to run Sidekick for your organization: answering your team, writing notes and reminders, and keeping the service working. Your content is sent to the AI model (Claude) to produce answers and is not used to train models. Each organization&apos;s data is walled off from every other, and each workspace from the others.</p>
        <h2 style={{ margin: 0 }}>Who else sees it</h2>
        <p style={{ margin: 0 }}>The services Sidekick runs on (Microsoft Azure hosting, Microsoft Teams, the Claude AI model) process data on our behalf. We don&apos;t sell data or show ads. The Sidekick team sees counts and usage for support, not your documents.</p>
        <h2 style={{ margin: 0 }}>Your choices</h2>
        <p style={{ margin: 0 }}>Org Owners and Org Admins can delete documents, meetings and whole workspaces at any time. To have your organization&apos;s data removed entirely, contact Support.</p>
      </div></div>
    </PublicShell>
  );
}
