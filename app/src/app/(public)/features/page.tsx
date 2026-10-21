/**
 * Features (/features): everything Sidekick does, grouped by where people meet it (in Teams, in the portal,
 * for admins), in plain language. Public and static. Each claim matches a shipped feature described in the
 * guides (docs/guide/), which the cards link to.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { SiteIcon } from "@/components/site-icons";
import { TeamsDemo } from "@/components/teams-demo";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/features");

type Feature = { icon: string; title: string; text: string; points: string[] };

const GROUPS: { id: string; title: string; lead: string; items: Feature[] }[] = [
  {
    id: "teams",
    title: "In Microsoft Teams",
    lead: "Where your people already work: group chats (including meeting chats), channels and 1:1 chats.",
    items: [
      { icon: "answer", title: "Answers with sources", text: "Mention @Sidekick with a question and get an answer from that client's group, with the documents and meetings it came from.", points: ["Says \"I couldn't find that\" instead of guessing", "Unanswered questions become knowledge gaps to fill", "Follows the chat once a Team Lead assigns it to a group"] },
      { icon: "notes", title: "Meeting notes and action items", text: "After a meeting, Sidekick posts a notes card and one card per action item.", points: ["Summary, decisions and open questions", "Owners and due dates on action items", "Assign or mark done right from the card"] },
      { icon: "bell", title: "Reminders", text: "A daily check per chat raises what's slipping, so nobody has to chase it.", points: ["Overdue and unowned action items", "Decisions still waiting to be made", "Documents that look out of date or conflict"] },
      { icon: "people", title: "Team Leads in charge", text: "Only Team Leads and admins can add Sidekick to a chat; anyone else, and it politely leaves.", points: ["@Sidekick add @name to bring someone into the group", "Chats nobody assigns are left after 7 days", "Client guests in a chat only get shareable material"] },
    ],
  },
  {
    id: "portal",
    title: "In the Sidekick portal",
    lead: "A web portal for each organization, with Sign in with Microsoft.",
    items: [
      { icon: "groups", title: "Groups per client", text: "One walled-off group per client engagement, with its client name, engagement code, Team Lead, people and chats.", points: ["Health at a glance: chats, overdue items, leads", "Documents: PDF, Word, text and Teams transcripts", "Searches only the group you're in"] },
      { icon: "map", title: "Knowledge map and memory", text: "See what each group knows and where the gaps are.", points: ["Topics with coverage", "Gaps from questions nobody could answer", "Decisions, facts and open questions from meetings"] },
      { icon: "spark", title: "Home assistant", text: "Ask the portal's assistant to do quick admin jobs, like creating a group or adding a person.", points: ["Only offers what your role allows", "Changes nothing until you confirm"] },
    ],
  },
  {
    id: "admin",
    title: "For admins",
    lead: "Rules, records and costs, for Org Owners and Org Admins.",
    items: [
      { icon: "shield", title: "Guardrails", text: "A locked safety floor plus switches and custom rules for the whole company or one group.", points: ["Groups can be stricter, never looser", "Test a question against the rules before it matters", "Answers are checked against their sources"] },
      { icon: "audit", title: "Audit log and activity", text: "Who did what and when, and what Sidekick did step by step (timings and counts, never document text).", points: ["Sign-ins, role changes, links, rule changes", "Reference codes on every error for quick support"] },
      { icon: "lock", title: "Roles and access", text: "Six roles from Org Owner to Viewer, Team Leads per group, and Microsoft sign-in you can require.", points: ["Import people from Microsoft 365", "Billing Admins see costs, not content"] },
      { icon: "cloud", title: "Usage and billing", text: "AI use per group and per person, and your plan, in one place.", points: ["Change plan or cancel any time", "Nothing is deleted when a plan lapses: it turns read-only"] },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <PublicShell layout="full" current="/features">
      <div className="site-wrap site-page-head">
        <span className="site-eyebrow">Features</span>
        <h1>Everything a client team needs to remember, in the chat they already use</h1>
        <p>Sidekick answers, takes the notes and keeps track, separately for every client. Here&apos;s what&apos;s in the box.</p>
      </div>
      {GROUPS.map((g, i) => (
        <section key={g.id} className={`site-section ${i % 2 ? "alt" : ""}`} aria-labelledby={`f-${g.id}`}>
          <div className="site-wrap">
            <h2 id={`f-${g.id}`}>{g.title}</h2>
            <p className="site-lead">{g.lead}</p>
            {g.id === "teams" ? (
              <div className="site-grid two" style={{ alignItems: "start" }}>
                <div className="site-grid two">{g.items.map((f) => <FeatureCard key={f.title} f={f} />)}</div>
                <TeamsDemo />
              </div>
            ) : (
              <div className="site-grid">{g.items.map((f) => <FeatureCard key={f.title} f={f} />)}</div>
            )}
          </div>
        </section>
      ))}
      <section className="site-section">
        <div className="site-wrap">
          <div className="site-band">
            <div>
              <h2>See how setup works</h2>
              <p>From sign-up to the first answer in Teams, step by step.</p>
            </div>
            <div className="site-hero-cta">
              <Link className="btn primary" href="/how-it-works">How it works</Link>
              <Link className="btn" href="/pricing">Pricing</Link>
            </div>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

function FeatureCard({ f }: { f: Feature }) {
  return (
    <div className="site-card">
      <SiteIcon name={f.icon} />
      <h3>{f.title}</h3>
      <p>{f.text}</p>
      <ul>{f.points.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );
}
