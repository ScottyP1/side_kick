/**
 * Terms of use (/terms): plain-language draft, clearly marked for a lawyer to review (`DraftNote`).
 * Public (no sign-in, `src/proxy.ts`); it's also the `termsOfUseUrl` of the Teams app package and the Teams Store
 * listing, which Microsoft requires to be specific to the offering and hosted on the publisher's own site.
 * Numbers come from the code that enforces them (lib/rolloff-policy.ts, lib/plans.ts, lib/rate-limit.ts).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { DraftNote, PublicShell } from "@/components/public-shell";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { BACKUP_RETENTION_DAYS, ORG_GRACE_DAYS } from "@/lib/rolloff-policy";
import { EXTRA_GROUP, usd } from "@/lib/plans";
import { ASK_PER_HOUR } from "@/lib/rate-limit";

export const metadata: Metadata = pageMetadata("/terms");

/** A heading and its paragraph, the same spacing everywhere on the page. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p style={{ margin: 0 }}>{children}</p>
    </section>
  );
}

export default function TermsPage() {
  return (
    <PublicShell narrow current="/terms">
      <div className="page-head"><div><div className="eyebrow">Terms of use</div><h1>The rules for using {BRAND.name}</h1><p>Last updated October 25, 2026.</p></div></div>
      <DraftNote />
      <div className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <Section title="The service">
          {BRAND.name} is an AI teammate built for Microsoft Teams: it answers a team&apos;s questions from its own documents and meetings, writes meeting notes and posts reminders. It&apos;s run as a personal project by the {BRAND.name} team, offered as it is, may change, and may have outages. These terms are between the {BRAND.name} team and the organization that signs up (&quot;you&quot;).
        </Section>
        <Section title="Your organization's account">
          The person who signs up becomes the Org Owner and accepts these terms for the organization. You decide who you add, what roles they get and what goes into {BRAND.name}, and you&apos;re responsible for how your people use it. Keep sign-in details private and tell us straight away if you think an account was misused.
        </Section>
        <Section title="Microsoft Teams and Microsoft 365">
          {BRAND.name} isn&apos;t made or endorsed by Microsoft. Your use of Teams and Microsoft 365 stays under your agreement with Microsoft. {BRAND.name} only reads what your Microsoft 365 admin approves (listed in the <a href="/privacy#microsoft">privacy policy</a>) and only works in chats a Team Lead or admin assigns to a group. Your admin can withdraw the approval, and anyone with the right in Teams can remove {BRAND.name} from a chat, at any time.
        </Section>
        <Section title="Your content">
          Your documents, meetings, messages and the notes {BRAND.name} writes from them stay yours. You let us store and process them only to run {BRAND.name} for you, as the <a href="/privacy">privacy policy</a> describes; we don&apos;t use them to train AI models. You must have the right to put that content into {BRAND.name}, including content that belongs to your clients, and to have the meetings you capture transcribed.
        </Section>
        <Section title="AI answers can be wrong">
          Answers, notes and reminders are written by an AI model (Claude, by Anthropic) and can be incomplete or wrong, even with sources. Check anything important against the sources {BRAND.name} shows. {BRAND.name} isn&apos;t legal, financial, medical or other professional advice, and decisions you make with it are yours. Mark a bad answer with the 👎 button (counted for your admins and for us, without the text), and report a harmful or wrong answer to <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>: we read every report and reply.
        </Section>
        <Section title="Acceptable use">
          Don&apos;t use {BRAND.name} to break the law, harass people, or create hateful, sexual or harmful content. Don&apos;t try to get around its guardrails (for example by telling it to ignore its rules), reach other groups&apos; or organizations&apos; data, probe or overload the service, or copy it. Each person can ask up to {ASK_PER_HOUR} questions an hour. We may block requests or pause an account that breaks these rules.
        </Section>
        <Section title="Plans and payment">
          Payments are in <b>test mode</b>: no money is charged and prices are placeholders. Plans are priced per organization per month by the number of groups (one per client engagement), with extra groups at {usd(EXTRA_GROUP.priceUsd)} each a month; people, meeting hours and AI credit are limits of the plan. When real payments start, these terms will say how billing, renewals and refunds work. If a payment fails or a trial ends, {BRAND.name} turns read-only; your data isn&apos;t deleted because of that.
        </Section>
        <Section title="Support and availability">
          Help is in the <Link href="/docs">help center</Link> and on the <a href="/support">Support</a> page, and you can write to <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>. We try to keep {BRAND.name} running and to fix problems quickly, but we don&apos;t promise a particular uptime yet.
        </Section>
        <Section title="Ending">
          You can cancel any time from Usage &amp; billing. {BRAND.name} stays usable until the end of what you paid for, then read-only for {ORG_GRACE_DAYS} days so you can download your data; after that all of your organization&apos;s data is deleted (see the <a href="/privacy">privacy policy</a>; backups age out within {BACKUP_RETENTION_DAYS} days) and you can ask for the deletion certificate. Paying again before then keeps everything. The {BRAND.name} team may pause an organization that breaks these terms, or end the service for it with the same {ORG_GRACE_DAYS} days&apos; read-only notice.
        </Section>
        <Section title="Responsibility">
          {BRAND.name} is provided as it is, without warranties, to the extent the law allows. The {BRAND.name} team isn&apos;t responsible for indirect losses, and its total responsibility is limited to what you paid in the last 12 months. (Placeholder wording: to be written by a lawyer.)
        </Section>
        <Section title="Changes and contact">
          When these terms change, the date at the top changes, and for important changes we tell Org Owners before they take effect. Questions: <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>.
        </Section>
      </div></div>
    </PublicShell>
  );
}
