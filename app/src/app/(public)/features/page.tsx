/**
 * Features (/features): everything Sidekick does, grouped by where people meet it (in Teams, live in Teams
 * meetings, in the portal, for admins), in plain language, with an example group chat drawn in HTML
 * (components/chat-demo.tsx), the portal's Ask page on a laptop (components/product-shot.tsx) and an example
 * meeting drawn in HTML with the real crystal ball (components/meeting-demo.tsx). Public and static. Each claim matches a shipped feature described in the
 * guides (docs/guide/), which the cards link to.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { SiteIcon } from "@/components/site-icons";
import { ProductShot } from "@/components/product-shot";
import { MeetingDemo } from "@/components/meeting-demo";
import { ChatDemo } from "@/components/chat-demo";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = pageMetadata("/features");

type Feature = { icon: string; title: string; text: string; points: string[] };

const GROUPS: { id: string; title: string; lead: string; badge?: string; items: Feature[] }[] = [
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
    id: "live",
    title: "Live in your Teams meetings",
    badge: "Available on Enterprise",
    lead: `${BRAND.name} can join a Teams meeting as a member of the call. It listens, reads the meeting chat, knows everything in the client's group, and helps like a teammate who did the reading.`,
    items: [
      { icon: "answer", title: "Ask it, out loud or in the chat", text: `Say or type "${BRAND.name}, …" and it answers from the group's documents, past meetings and connected tools.`, points: ["A short spoken answer, the full one in the chat", "Every answer lists its sources", "Shows in the call as a moving crystal ball"] },
      { icon: "people", title: "Raises its hand", text: `When someone asks the room and nobody knows, and ${BRAND.name} is sure of the answer, it raises its hand and waits to be called on.`, points: ["\"Go ahead, Sidekick\" and it answers", "Never talks over anyone", "Stays quiet when it isn't sure"] },
      { icon: "notes", title: "Keeps the list as you talk", text: "It notes decisions and action items during the meeting, and asks once when an action item has no owner or date.", points: ["\"Quick check: by when should Lou do this?\"", "\"Sidekick, recap\" reads the list back", "The notes follow in the group's chat afterwards"] },
      { icon: "shield", title: "Polite, and in your control", text: `Let it in from the lobby; say "${BRAND.name}, leave" and it says goodbye and goes. Client guests in the call only get shareable material.`, points: ["The meeting audio stays in Sidekick's own Azure", "Team Leads choose when it joins and whether it speaks", "Everything is in the audit log"] },
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
            <h2 id={`f-${g.id}`}>{g.title} {g.badge && <span className="site-badge-ent" style={{ verticalAlign: "middle" }}>{g.badge}</span>}</h2>
            <p className="site-lead">{g.lead}</p>
            {g.id === "teams" ? (
              <>
                <ChatDemo caption="An example group chat with made-up client content." />
                <div className="site-cards-row">{g.items.map((f) => <FeatureCard key={f.title} f={f} />)}</div>
              </>
            ) : g.id === "live" ? (
              <>
                <div style={{ marginBottom: 28 }}><MeetingDemo caption="An example meeting with made-up client content." /></div>
                <div className="site-grid two">{g.items.map((f) => <FeatureCard key={f.title} f={f} />)}</div>
                              </>
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
