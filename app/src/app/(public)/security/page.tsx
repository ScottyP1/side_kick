/**
 * Security & trust (/security): how Sidekick keeps each company's and each client group's data apart, the
 * guardrails on every answer, the audit log, where data lives (Microsoft Azure), encryption in transit, and
 * the AI model ("Powered by Claude"). Public and static. Statements about the AI provider's data use are
 * marked as a draft for legal review, like the privacy and terms pages. Ends with the security questions
 * from lib/faq.ts.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { FaqList } from "@/components/faq-list";
import { PublicShell } from "@/components/public-shell";
import { SiteIcon } from "@/components/site-icons";
import { faqFor } from "@/lib/faq";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/security");

const PILLARS: { icon: string; title: string; points: string[] }[] = [
  {
    icon: "groups",
    title: "Walls between companies and groups",
    points: [
      "Every company's Sidekick is completely separate: people, groups, documents and meetings are never shared between organizations.",
      "Inside a company, each client group is walled off too. Search is limited to the group before anything is ranked, so an answer for one client can't use another client's material.",
      "Each Teams chat belongs to exactly one group, and only Team Leads and admins can connect one.",
      "Owners and Admins see every group; everyone else, Team Leads included, sees only the groups they've been added to.",
    ],
  },
  {
    icon: "shield",
    title: "Guardrails on every answer",
    points: [
      "A locked safety floor that nobody can turn off, plus company-wide switches and custom rules. A group can be made stricter, never looser.",
      "Questions are checked before Sidekick answers, and answers are checked against their sources afterwards.",
      "In chats with client guests, Sidekick only uses material marked shareable.",
      "When it doesn't know, Sidekick says so instead of guessing.",
    ],
  },
  {
    icon: "audit",
    title: "An audit log you can read",
    points: [
      "Sign-ins, role changes, chat links, rule changes and other important actions are recorded with who did them and when.",
      "Activity traces record timings and counts, never document text.",
      "Every error shows a reference code, so support can find exactly what happened without seeing your content.",
    ],
  },
  {
    icon: "lock",
    title: "Sign-in and access",
    points: [
      "Sign in with Microsoft, which your Org Owner can make required for everyone.",
      "Six roles, from Org Owner to Viewer. Billing Admins see costs, not content.",
      "Passwords are stored only as one-way hashes, and repeated wrong passwords pause sign-in.",
    ],
  },
  {
    icon: "cloud",
    title: "Where your data lives",
    points: [
      "Sidekick runs in Microsoft Azure: the app, its database and its search index.",
      "Everything travels encrypted (HTTPS only), including the connection to the database.",
      "The pages load nothing from other websites: no trackers, no ads, no third-party scripts.",
      "Org Owners and Org Admins can delete documents, meetings and whole groups at any time.",
    ],
  },
];

export default function SecurityPage() {
  return (
    <PublicShell layout="full" current="/security">
      <div className="site-wrap site-page-head">
        <span className="site-eyebrow">Security &amp; trust</span>
        <h1>Client work stays with the client it belongs to</h1>
        <p>Firms trust Sidekick with many clients at once, so separation is built into everything it does. Here&apos;s how, in plain language.</p>
      </div>
      <div className="site-wrap site-stack">
        <div className="site-grid two">
          {PILLARS.map((p) => (
            <div key={p.title} className="site-card">
              <SiteIcon name={p.icon} />
              <h3>{p.title}</h3>
              <ul className="site-checks" style={{ marginTop: 10, paddingLeft: 0 }}>
                {p.points.map((t) => <li key={t}><span>{t}</span></li>)}
              </ul>
            </div>
          ))}
          <div className="site-card">
            <SiteIcon name="spark" />
            <h3>Powered by Claude</h3>
            <p>Sidekick&apos;s answers, notes and checks are written by Claude, an AI model made by Anthropic. Sidekick sends Claude only what one request needs (the question and the passages from that group) and keeps the walls between clients itself.</p>
            <div className="callout warn" role="note" style={{ marginTop: 12 }}>
              <span>
                <b>Draft for legal review.</b> Anthropic&apos;s commercial terms say data sent through its API isn&apos;t used to train its models by default. This summary is a placeholder until a lawyer has checked it; Anthropic&apos;s own terms are what count.
              </span>
            </div>
          </div>
        </div>
        <FaqList title="Security questions" items={faqFor("security")} />
        <div className="callout info" role="note">
          <span>More detail: <Link href="/docs/concepts#how-your-data-is-protected">how your data is protected</Link>, <Link href="/docs/roles-and-permissions">roles and permissions</Link> and the <Link href="/privacy">privacy policy</Link>. Found a security problem? Tell us on <Link href="/support">Support</Link>.</span>
        </div>
      </div>
    </PublicShell>
  );
}
