/**
 * How it works (/how-it-works): the journey from sign-up to the first answer in Teams as a visual timeline.
 * Six numbered steps alternate left and right; each has an icon, a short headline and line, and a small
 * picture of the screen involved (components/how-mocks.tsx: sign-up form, Microsoft approval, Teams app,
 * group card, chat waiting for a group, Teams answer). Then the setup wizard as a horizontal stepper, what's
 * coming for meetings, and the setup questions from lib/faq.ts. Public and static; on phones the steps stack.
 */
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FaqList } from "@/components/faq-list";
import { AnswerMock, ApproveMock, GroupMock, InstallMock, SignupMock, WaitingChatMock } from "@/components/how-mocks";
import { PublicShell } from "@/components/public-shell";
import { SiteIcon } from "@/components/site-icons";
import { faqFor } from "@/lib/faq";
import { TRIAL_DAYS } from "@/lib/plans";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = pageMetadata("/how-it-works");

const STEPS: { icon: string; who: string; title: string; text: string; mock: ReactNode }[] = [
  { icon: "spark", who: "Org Owner", title: "Sign up and pick a plan", text: `Create your organization with your work email. Every plan starts with a ${TRIAL_DAYS}-day free trial.`, mock: <SignupMock /> },
  { icon: "lock", who: "Your Microsoft admin", title: `Approve ${BRAND.name} for Microsoft 365`, text: "One approval lets your people sign in with Microsoft and lets you import them from your directory.", mock: <ApproveMock /> },
  { icon: "teams", who: "Your Teams admin", title: "Install it in Teams", text: `Make the ${BRAND.name} app available, ideally to Team Leads and admins: they're the ones who add it to chats.`, mock: <InstallMock /> },
  { icon: "groups", who: "Org Owner or Admin", title: "Create a group per client, with its Team Lead", text: "One walled-off group per engagement. The Team Lead runs it day to day and adds the rest of the team.", mock: <GroupMock /> },
  { icon: "people", who: "Team Lead", title: "Pick the chats", text: `Add ${BRAND.name} to the team's group chat, then assign the chat to the group. Until then it reads nothing.`, mock: <WaitingChatMock /> },
  { icon: "answer", who: "Everyone", title: "Ask in Teams", text: `Mention @${BRAND.name} and get an answer from that group's documents and meetings, with its sources.`, mock: <AnswerMock /> },
];

const WIZARD = ["Welcome", "Microsoft 365", "Add to Teams", "Rules", "First groups", "Done"];

export default function HowItWorksPage() {
  return (
    <PublicShell layout="full" current="/how-it-works">
      <div className="site-wrap site-page-head site-center">
        <span className="site-eyebrow">How it works</span>
        <h1>From sign-up to the first answer in Teams</h1>
        <p>Five setup steps, most of them one click, and then your team just asks. After you pay, a setup wizard walks you through them and remembers where you stopped.</p>
      </div>

      <div className="site-wrap">
        <ol className="site-journey">
          {STEPS.map((s, i) => (
            <li key={s.title} className="site-journey-step">
              <div className="site-journey-text">
                <div className="site-journey-meta">
                  <span className="site-journey-num" aria-hidden="true">{i + 1}</span>
                  <SiteIcon name={s.icon} />
                  <span className="pill nodot">{s.who}</span>
                </div>
                <h2><span className="sr-only">Step {i + 1}: </span>{s.title}</h2>
                <p>{s.text}</p>
              </div>
              <div className="site-journey-visual" aria-hidden="true">{s.mock}</div>
            </li>
          ))}
        </ol>
      </div>

      <section className="site-section alt" aria-labelledby="wizard-title">
        <div className="site-wrap">
          <span className="site-eyebrow">The setup wizard</span>
          <h2 id="wizard-title">Guided, start to finish</h2>
          <p className="site-lead">Right after checkout the Org Owner gets a short wizard. Leave any time: a &quot;Finish setting up&quot; note in the portal brings you back.</p>
          <ol className="site-stepper">
            {WIZARD.map((w, i) => (
              <li key={w} data-done={i < 2 ? "" : undefined} aria-current={i === 2 ? "step" : undefined}>
                <span className="dot" aria-hidden="true">{i < 2 ? "✓" : i + 1}</span>
                <span>{w}</span>
              </li>
            ))}
          </ol>
          <p className="faint" style={{ fontSize: 13, margin: "10px 0 0" }}>Example: two steps done, Add to Teams next.</p>
        </div>
      </section>

      <section className="site-section" aria-labelledby="meet-title">
        <div className="site-wrap">
          <span className="site-eyebrow">Meetings</span>
          <h2 id="meet-title">Meeting notes today, more on the way</h2>
          <div className="site-grid">
            <div className="site-card"><span className="site-badge-now">Today</span><h3>Notes from transcripts</h3><p>Import a meeting&apos;s Teams transcript and {BRAND.name} posts the notes and action items to the group&apos;s chat.</p></div>
            <div className="site-card"><span className="site-badge-soon">Coming soon</span><h3>Automatic notes</h3><p>Notes after every meeting without importing anything, including in the meeting&apos;s own chat.</p></div>
            <div className="site-card"><span className="site-badge-soon">Coming soon · Enterprise</span><h3>{BRAND.name} in the meeting</h3><p>{BRAND.name} joins the call live to answer and take notes as you talk.</p></div>
          </div>
        </div>
      </section>

      <div className="site-wrap site-narrow site-stack">
        <FaqList title="Setup questions" items={faqFor("how-it-works")} />
        <div className="callout info" role="note">
          <span>Every detail is in the <Link href="/docs/admin-guide">admin guide</Link> and <Link href="/docs/teams-guide">{BRAND.name} in Teams</Link>.</span>
        </div>
        <div className="site-band">
          <div>
            <h2>Ready when you are</h2>
            <p>Sign up and the wizard takes it from there.</p>
          </div>
          <div className="site-hero-cta">
            <Link className="btn primary" href="/signup">Get started</Link>
            <Link className="btn" href="/pricing">See pricing</Link>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
