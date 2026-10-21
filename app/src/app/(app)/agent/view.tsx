"use client";

/**
 * AI models & agent (/agent): what each AI feature does and whether it's working, and what's ready vs coming next.
 * Plain wording only: model and provider names are for the Sidekick team (Owner Console), so customers see
 * "Working" / "Essentials only" rather than the plumbing. Models are set by the Sidekick team (lib/claude.ts).
 */

import { useApp } from "@/components/shell";
import { Pill } from "@/components/ui";

const ROLES: Record<string, [string, string]> = {
  extract: ["Meeting notes", "Reads a transcript and writes the summary, decisions, action items, open questions and facts."],
  ask: ["Answering questions", "Answers from this workspace's documents and meetings only, with a source for every claim."],
  insights: ["Knowledge map", "Groups what the team knows into topics, scores coverage and finds gaps."],
  guard: ["Guardrail check", "Checks every question against your organization's guardrails before Sidekick answers (see Guardrails)."],
  remind: ["Reminders in Teams", "Words the daily and after-meeting reminder cards from items Sidekick picked itself; every point cites its source."],
  assist: ["In-app assistant", "The chat box on the home page: answers questions about Sidekick and offers actions your role allows, each confirmed first."],
};

/**
 * The roadmap shown at the bottom of the page: "Ready" (shipped) first, then what's coming. Keep it in
 * step with docs/PROGRESS.md when something ships.
 */
const ROADMAP: [string, string][] = [
  ["Ready", "Sidekick in Teams chat: @Sidekick answers with sources, meeting notes and action-item cards posted automatically"],
  ["Ready", "Microsoft sign-in, with the same person and role in Teams and the portal"],
  ["Ready", "Azure AI Search with meaning-based search, and the in-app assistant on the home page"],
  ["Ready", "Proactive reminders in Teams: overdue and unowned action items, open decisions, out-of-date documents, with sources and Assign / Done / Snooze buttons"],
  ["Ready", "Per-chat settings: dedicated meeting-notes chat, and chats Sidekick keeps track of (every message, 90 days)"],
  ["Next", "Draft Jira / Azure DevOps stories from action items"],
  ["Ready", "Plan limits and a monthly AI credit: answers keep working when it runs out, extras pause until the 1st"],
  ["Later", "Live meetings: joins calls, listens, raises a virtual hand, answers out loud (Azure AI Speech)"],
  ["Later", "Persona settings: voice, speaking style, participation mode, hand-raise triggers"],
];

/** Features that keep working ("essentials only") once the month's AI credit is used up. */
const ESSENTIAL = new Set(["ask", "guard", "extract"]);

export default function AgentPage() {
  const { me } = useApp();
  const essentials = me.credit?.level === "essentials";
  const state = (k: string) => (!me.ai.working ? ["warn", "Not set up"] : essentials && !ESSENTIAL.has(k) ? ["warn", "Paused (AI credit)"] : essentials ? ["info", "Essentials only"] : ["good", "Working"]);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">AI models & agent</div>
          <h1>How Sidekick thinks</h1>
          <p>What each AI feature does for your team. The Sidekick team picks and runs the AI behind them. Your documents and meetings are never used to train any model.</p>
        </div>
        {(!me.ai.working || essentials) && <div className="actions"><Pill kind="warn">{!me.ai.working ? "AI answers: not set up" : "AI answers: essentials only"}</Pill></div>}
      </div>
      {essentials && <div className="callout warn"><span>This month&apos;s AI credit is used up, so Sidekick runs on essentials until the 1st: answers, guardrail checks and notes for shorter meetings keep working; the rest is paused.</span></div>}
      <div className="grid g3">
        {Object.entries(ROLES).map(([k, [label, text]]) => {
          const [kind, word] = state(k);
          return (
            <div key={k} className="model">
              <span className="eyebrow">{label}</span>
              <span className="muted">{text}</span>
              <div className="stat-line"><span className="muted">Status</span><Pill kind={kind}>{word}</Pill></div>
            </div>
          );
        })}
      </div>
      <div className="panel">
        <div className="panel-h"><h2>What’s ready and what’s next</h2></div>
        <div className="list">
          {ROADMAP.map(([status, text], i) => (
            <div key={i} className="li">
              <Pill kind={status === "Ready" ? "good" : "info"} nodot>{status}</Pill>
              <div className="grow">{text}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
