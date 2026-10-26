/**
 * Features (/features): everything Sidekick does, grouped by where people meet it (in Teams, in the portal,
 * for admins), in plain language, with a real chat shot and the portal's Ask page on a laptop
 * (components/product-shot.tsx). Public and static. Each claim matches a shipped feature described in the
 * guides (docs/guide/), which the cards link to.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { SiteIcon } from "@/components/site-icons";
import { ProductShot } from "@/components/product-shot";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = pageMetadata("/features");

type Feature = { icon: string; title: string; text: string; points: string[] };

const GROUPS: { id: string; title: string; lead: string; items: Feature[] }[] = [
  {
    id: "teams",
    title: "In Microsoft Teams",
    lead: `Where your people already work: group chats, channels and 1:1 chats with ${BRAND.name} and meeting chats, plus a ${BRAND.name} tab with the group's meetings and action items.`,
    items: [
      { icon: "answer", title: "Answers with sources", text: `Mention @${BRAND.name} with a question and get an answer from that client's group, with the documents and meetings it came from.`, points: ["Says \"I couldn't find that\" instead of guessing", "Unanswered questions become knowledge gaps to fill", "Follows the chat once a Team Lead assigns it to a group"] },
      { icon: "notes", title: "Meeting notes and action items", text: `After every Teams meeting ${BRAND.name} reads the transcript and posts a notes card and one card per action item to the group's notes chat. Save decisions to the group's knowledge right from the card.`, points: ["Summary, decisions and open questions", "Owners and due dates on action items", "Assign or mark done right from the card"] },
      { icon: "bell", title: "Reminders", text: "A daily check per chat raises what's slipping, so nobody has to chase it.", points: ["Overdue and unowned action items", "Decisions still waiting to be made", "Documents that look out of date or conflict"] },
      { icon: "people", title: "Team Leads in charge", text: `Only Team Leads and admins can add ${BRAND.name} to a chat; anyone else, and it politely leaves.`, points: [`@${BRAND.name} add @name to bring someone into the group`, "Chats nobody assigns are left after 7 days", "Client guests in a chat only get shareable material"] },
    ],
  },
  {
    id: "portal",
    title: `In the ${BRAND.name} portal`,
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
    lead: "Rules, records and usage, for Org Owners and Org Admins.",
    items: [
      { icon: "shield", title: "Guardrails", text: "A locked safety floor plus switches and custom rules for the whole company or one group.", points: ["Groups can be stricter, never looser", "Test a question against the rules before it matters", "Answers are checked against their sources"] },
      { icon: "audit", title: "Audit log and activity", text: `Who did what and when, and what ${BRAND.name} did step by step (timings and counts, never document text).`, points: ["Sign-ins, role changes, links, rule changes", "Reference codes on every error for quick support"] },
      { icon: "lock", title: "Roles and access", text: "Five roles from Org Owner to Viewer, Team Leads per group, and Microsoft sign-in you can require.", points: ["Import people from Microsoft 365", "Only Org Owners and Org Admins see billing"] },
      { icon: "cloud", title: "Usage and billing", text: "What it did per group (questions, meetings, documents, reminders), your AI allowance and your plan, in one place.", points: ["Export per group for chargeback", "Change plan or cancel any time", "Nothing is deleted when a plan lapses: it turns read-only"] },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <PublicShell layout="full" current="/features">
      <div className="site-wrap site-page-head">
        <span className="site-eyebrow">Features</span>
        <h1>Everything your team needs to remember, in the chat they already use</h1>
        <p>{BRAND.name} answers, takes the notes and keeps track, separately for every client. Here&apos;s what&apos;s in the box.</p>
      </div>
      {GROUPS.map((g, i) => (
        <section key={g.id} className={`site-section ${i % 2 ? "alt" : ""}`} aria-labelledby={`f-${g.id}`}>
          <div className="site-wrap">
            <h2 id={`f-${g.id}`}>{g.title}</h2>
            <p className="site-lead">{g.lead}</p>
            {g.id === "teams" ? (
              <div className="site-grid two" style={{ alignItems: "start" }}>
                <div className="site-grid two">{g.items.map((f) => <FeatureCard key={f.title} f={f} />)}</div>
                <ProductShot name="chat-answer" frame="window" alt={`A team chat where someone asks ${BRAND.name} when the wave 2 cutover is; ${BRAND.name} answers with the date, store count and rollback owner, and lists five sources from meetings and documents.`} caption="Made-up example data." />
              </div>
            ) : (
              <>
                {g.id === "portal" && (
                  <div style={{ marginBottom: 28 }}>
                    <ProductShot name="portal-ask" frame="laptop" alt={`The ${BRAND.name} portal's Ask page: a question about the wave 2 cutover, an answer with numbered source markers, and the matching passages from documents and meetings below it.`} caption="Ask with sources in the portal. Made-up example data." />
                    <div className="site-grid two" style={{ marginTop: 28, alignItems: "start" }}>
                      <ProductShot name="portal-meeting" frame="laptop" alt={`Meeting notes in the ${BRAND.name} portal for Contoso's Sprint 14 planning, captured from Microsoft Teams: summary, decisions (one saved to knowledge), action items with owners, due dates and status, and open questions.`} caption="Notes captured from a Teams meeting, with Save to knowledge. Made-up example data." />
                      <ProductShot name="portal-attention" frame="laptop" alt={`The ${BRAND.name} home page for a Team Lead: recent meetings, and Needs attention listing a question nobody could answer, an overdue action item, action items without an owner and a runbook a later decision changed, each with a next step.`} caption="Needs attention: what's slipping, with the next step. Made-up example data." />
                    </div>
                  </div>
                )}
                {g.id === "admin" && (
                  <div style={{ marginBottom: 28 }}>
                    <ProductShot name="portal-connectors" frame="laptop" alt={`The ${BRAND.name} Connectors page: GitHub, Jira and Confluence connected read-only, Azure DevOps connected with a project that needs attention, business apps planned, and the connected tools with their health.`} caption="Connectors: Azure DevOps, Jira, GitHub and Confluence, read-only. Made-up example data." />
                  </div>
                )}
                <div className="site-grid">{g.items.map((f) => <FeatureCard key={f.title} f={f} />)}</div>
              </>
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
