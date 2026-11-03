/**
 * Website home (/) for visitors: what Sidekick is in one screen with an illustration (components/site-art.tsx),
 * the headline feature, Sidekick live in Teams meetings (an example meeting drawn in HTML with the real crystal
 * ball as Sidekick's tile: components/meeting-demo.tsx), "every meeting, remembered", what it does, an example group
 * chat drawn in HTML (answer with sources, notes card, daily reminder: components/chat-demo.tsx), the portal on a
 * laptop (components/product-shot.tsx), who it's for, "A week with Sidekick": three illustrative scenarios,
 * labelled as examples and never presented as customer quotes (real stories replace them later), and Get started / Sign in. Public and static.
 *
 * Signed-in people never see this page: src/proxy.ts sends anyone with a portal session cookie from / to
 * their portal home at /home (docs/ARCHITECTURE.md → Routes).
 */
import Link from "next/link";
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { SiteIcon } from "@/components/site-icons";
import { ProductShot } from "@/components/product-shot";
import { MeetingDemo } from "@/components/meeting-demo";
import { ChatDemo } from "@/components/chat-demo";
import { HeroArt, RememberArt } from "@/components/site-art";
import { TRIAL_DAYS } from "@/lib/plans";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = pageMetadata("/");

const HIGHLIGHTS: [string, string, string][] = [
  ["answer", "Answers with sources", `Ask in the chat. ${BRAND.name} answers from that client's documents, meetings and chat, and shows where each answer came from. If it doesn't know, it says so.`],
  ["notes", "Meeting notes, done", `After every Teams meeting ${BRAND.name} writes the summary, decisions, open questions and action items with owners and due dates, and posts them to the team's chat. No bot in the call; past or outside meetings can be added from their transcript.`],
  ["bell", "Reminders that matter", "Overdue and unowned action items, decisions still waiting, and documents that look out of date, raised in the chat before they slip."],
  ["groups", "One group per client", "Each engagement gets its own walled-off group with its own Team Lead, chats and documents. One client's material never shows up in another's answers."],
  ["shield", "Guardrails on every answer", `Company-wide and per-group rules, checked before ${BRAND.name} answers and again after. Client guests only ever see what's marked shareable.`],
  ["audit", "Everything on the record", `An audit log of who did what, and usage per group, so admins and Team Leads always know what ${BRAND.name} is doing.`],
];

/** "A week with Sidekick": typical moments for the teams it's built for. Illustrative, never presented as quotes. */
const SCENARIOS: [string, string, string][] = [
  ["Delivery lead · consultancy", "Monday's client call, already written up", `By the time the call ends, the notes, decisions and action items with owners are in the team's chat. Nobody had to volunteer to take minutes.`],
  ["Project manager · agency", "\"When did we agree to that?\"", `Someone asks in Teams. ${BRAND.name} answers with the meeting and the document it came from, and points out that the older brief says something else.`],
  ["Engagement manager · tech firm", "A raised hand at the right moment", `The client asks what could delay go-live and the room goes quiet. ${BRAND.name} raises its hand, answers out loud with sources, and asks who owns the follow-up.`],
];

export default function HomePage() {
  return (
    <PublicShell layout="full" current="/">
      <div className="site-wrap site-glow">
        <section className="site-hero" aria-labelledby="hero-title">
          <div>
            <span className="site-eyebrow">AI teammate for Microsoft Teams</span>
            <h1 id="hero-title">Every meeting, <em>remembered</em>.</h1>
            <p className="site-hero-text">
              {BRAND.name} turns your Teams meetings into notes, decisions and action items, posted straight to your team&apos;s chat, then keeps everyone on track.
            </p>
            <p className="site-hero-sub">A fast, reliable teammate in Teams chats, channels and 1:1. Answers with sources. A wall around every client.</p>
            <ul className="site-hero-badges" aria-label="What's new and coming">
              <li><span className="site-badge">New · Enterprise</span> <a href="#live-title">{BRAND.name} live in your Teams meetings</a></li>
              <li><span className="site-badge">New</span> Automatic notes after every Teams meeting</li>
            </ul>
            <div className="site-hero-cta">
              <Link className="btn primary" href="/signup">Get started</Link>
              <Link className="btn" href="/login">Sign in</Link>
              <Link className="btn ghost" href="/how-it-works">How it works →</Link>
            </div>
            <div className="site-hero-note">{TRIAL_DAYS}-day free trial on every plan. Set up in an afternoon with the setup wizard.</div>
          </div>
          <HeroArt />
        </section>
      </div>

      <section className="site-section" aria-labelledby="live-title">
        <div className="site-wrap">
          <span className="site-eyebrow">Live in your meetings</span>
          <h2 id="live-title">{BRAND.name} joins the call and answers, with sources</h2>
          <p className="site-lead">Ask a question out loud or in the meeting chat. {BRAND.name} thinks, then answers from that client&apos;s documents and past meetings, and shows where the answer came from. <span className="site-badge-ent">Available on Enterprise</span></p>
          <div className="site-live-stack">
            <MeetingDemo caption="An example meeting with made-up client content. In Teams, Sidekick is one more person in the call." />
            <ul className="site-checks">
              <li><span><b>Hears the question</b>, said or typed: &quot;{BRAND.name}, when is the wave 2 cutover?&quot;</span></li>
              <li><span><b>Raises its hand</b> when the room asks something nobody answers, and waits to be called on.</span></li>
              <li><span><b>Answers out loud and in the chat</b>, with the documents and meetings it used.</span></li>
              <li><span><b>Asks its own questions</b>, like who owns an action item and by when.</span></li>
              <li><span><b>Recaps and leaves</b> when asked. The notes follow in the group&apos;s chat.</span></li>
            </ul>
          </div>
          <p style={{ margin: "20px 0 0" }}><Link href="/features#f-live">More about live meetings →</Link> The meeting audio stays in {BRAND.name}&apos;s own Azure.</p>
        </div>
      </section>

      <section className="site-section alt" aria-labelledby="mem-title">
        <div className="site-wrap site-grid two" style={{ alignItems: "center" }}>
          <RememberArt />
          <div>
            <span className="site-eyebrow">Every meeting, remembered</span>
            <h2 id="mem-title">Decisions don&apos;t get lost between meetings</h2>
            <p className="site-lead" style={{ marginBottom: 14 }}>Each meeting adds to what the group knows, so the answer to &quot;what did we decide?&quot; is one question away, with the meeting it came from.</p>
            <ul className="site-checks">
              <li><span><span className="site-badge-now">Today</span> Automatic notes, decisions and action items after every Teams meeting</span></li>
              <li><span><span className="site-badge-now">Today</span> Save decisions to the group&apos;s knowledge, right from the notes card</span></li>
              <li><span><span className="site-badge-ent">Enterprise</span> {BRAND.name} live in your meetings: answers, a raised hand, a running list</span></li>
            </ul>
          </div>
        </div>
      </section>

      <section className="site-section" aria-labelledby="what-title">
        <div className="site-wrap">
          <span className="site-eyebrow">What it does</span>
          <h2 id="what-title">Less hunting for answers, fewer dropped balls</h2>
          <p className="site-lead">Your people already live in Teams. {BRAND.name} joins the chats you choose and keeps each client&apos;s knowledge in one place.</p>
          <div className="site-grid">
            {HIGHLIGHTS.map(([icon, title, text]) => (
              <div key={title} className="site-card">
                <SiteIcon name={icon} />
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <p style={{ margin: "20px 0 0" }}><Link href="/features">See all features →</Link></p>
        </div>
      </section>

      <section className="site-section alt" aria-labelledby="see-title">
        <div className="site-wrap">
          <span className="site-eyebrow">See it at work</span>
          <h2 id="see-title">Right in your team&apos;s Teams chat</h2>
          <p className="site-lead">Answers with sources, meeting notes with owners and dates, and a short daily reminder of what&apos;s still open, posted where the team already talks.</p>
          <ChatDemo caption="An example group chat with made-up client content. Cards as Sidekick posts them." />
        </div>
      </section>

      <section className="site-section" aria-labelledby="who-title">
        <div className="site-wrap site-grid two" style={{ alignItems: "center" }}>
          <div>
            <span className="site-eyebrow">Who it&apos;s for</span>
            <h2 id="who-title">Built for firms with many clients</h2>
            <p className="site-lead" style={{ marginBottom: 12 }}>
              Consultancies, agencies and tech firms where every client engagement has its own team, its own documents and its own Teams chats.
            </p>
            <ul className="site-checks">
              <li><span><b>Team Leads</b> run their group: they add people and pick which chats {BRAND.name} follows.</span></li>
              <li><span><b>Admins</b> set the rules once for the whole company, and see usage and the audit log.</span></li>
              <li><span><b>Everyone</b> asks in the chat they&apos;re already in, and gets an answer with its sources.</span></li>
            </ul>
          </div>
          <div>
            <ProductShot name="portal-groups" frame="laptop" alt={`The ${BRAND.name} portal's Groups page: one card per client team (Adatum Health, Alpine Ski House, Woodgrove Bank, Coho Winery, Contoso Retail, Fabrikam Bank) with its Team Lead, people, chats, documents, meetings and a health label.`} />
            <p style={{ margin: "14px 0 0", textAlign: "center" }}>Up and running in five steps. <Link href="/how-it-works">How it works →</Link></p>
          </div>
        </div>
      </section>

      <section className="site-section alt" aria-labelledby="proof-title">
        <div className="site-wrap">
          <span className="site-eyebrow">A week with {BRAND.name}</span>
          <h2 id="proof-title">How teams use it</h2>
          <p className="site-lead">Three typical moments, from the kinds of teams {BRAND.name} is built for.</p>
          <div className="site-grid">
            {SCENARIOS.map(([who, title, text]) => (
              <div key={title} className="site-card site-scenario">
                <span className="site-scenario-who">{who}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <p className="site-demo-caption">Illustrative examples, not customer quotes. {BRAND.name} is new; real customer stories will go here once teams agree to share them.</p>
        </div>
      </section>

      <section className="site-section">
        <div className="site-wrap">
          <div className="site-band">
            <div>
              <h2>Give every team a {BRAND.name}</h2>
              <p>Start a {TRIAL_DAYS}-day free trial, or read the help center first.</p>
            </div>
            <div className="site-hero-cta">
              <Link className="btn primary" href="/signup">Get started</Link>
              <Link className="btn" href="/docs">Help center</Link>
            </div>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}
