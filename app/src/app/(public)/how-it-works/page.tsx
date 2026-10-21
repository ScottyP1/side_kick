/**
 * How it works (/how-it-works): the path from sign-up to the first answer in Teams, in five steps (sign up,
 * approve for Microsoft 365, install in Teams, create groups with Team Leads, pick chats), and how the setup
 * wizard after checkout walks an admin through them. Public and static; details link to the admin and
 * Teams guides in the help center. Ends with the setup questions from lib/faq.ts.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { FaqList } from "@/components/faq-list";
import { PublicShell } from "@/components/public-shell";
import { faqFor } from "@/lib/faq";
import { TRIAL_DAYS } from "@/lib/plans";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/how-it-works");

export default function HowItWorksPage() {
  return (
    <PublicShell layout="full" current="/how-it-works">
      <div className="site-wrap site-narrow site-page-head">
        <span className="site-eyebrow">How it works</span>
        <h1>From sign-up to the first answer in Teams</h1>
        <p>Five steps, most of them one click. After you pay, the <b>setup wizard</b> walks you through them in order and remembers where you stopped.</p>
      </div>
      <div className="site-wrap site-narrow site-stack">
        <ol className="site-steps">
          <li>
            <div>
              <h3>Sign up</h3>
              <p>Create your organization with your work email and pick a plan. You become its Org Owner. Every plan starts with a {TRIAL_DAYS}-day free trial.</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Approve Sidekick for Microsoft 365</h3>
              <p>Sign in once with your work Microsoft account so your people can use <b>Sign in with Microsoft</b>. A Microsoft admin at your company approves Sidekick once, which lets you import people from your directory.</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Install it in Teams</h3>
              <p>Your Teams admin makes the Sidekick app available. We recommend giving it to Team Leads and admins only: they&apos;re the ones who add Sidekick to chats.</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Create a group per client, with its Team Lead</h3>
              <p>A group is one client engagement: its name, the client, an optional engagement code and the Team Lead who runs it day to day. The Team Lead adds the rest of the team.</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Pick the chats</h3>
              <p>A Team Lead adds Sidekick to the team&apos;s group chat in Teams. Sidekick waits, reading nothing, until the chat is assigned to a group in the portal. From then on it follows that chat and answers from that group only.</p>
            </div>
          </li>
        </ol>

        <div className="site-card">
          <h3 style={{ marginTop: 0 }}>The setup wizard</h3>
          <p>Right after checkout, Sidekick opens a short wizard for the Org Owner:</p>
          <ul>
            <li><b>Welcome</b>: your plan, your trial and how groups and Team Leads work</li>
            <li><b>Connect Microsoft 365</b>: one sign-in with your work account</li>
            <li><b>Add to Teams</b>: who gets the app, and what your Teams admin does</li>
            <li><b>Rules</b>: a guardrails starting point, Standard or Strict</li>
            <li><b>First groups</b>: a name, client and Team Lead for each team</li>
          </ul>
          <p style={{ marginTop: 10 }}>You can leave and come back: a &quot;Finish setting up&quot; note in the portal takes you back to where you were.</p>
        </div>

        <div className="callout info" role="note">
          <span>Want the details? The <Link href="/docs/admin-guide">admin guide</Link> covers each step, and <Link href="/docs/teams-guide">Sidekick in Teams</Link> shows what your team sees in the chat.</span>
        </div>

        <FaqList title="Setup questions" items={faqFor("how-it-works")} />

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
