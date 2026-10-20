"use client";

/**
 * AI models & agent (/agent): which Claude model each feature uses, how Sidekick is instructed to behave, and what's ready vs coming next.
 * Models are changed by the Sidekick team with SIDEKICK_MODEL_* settings (app/.env.local on the server, see lib/claude.ts);
 * the page itself tells clients to ask the Sidekick team, since they can't reach the server's settings.
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
  ["Next", "Claude hosted in Azure (Microsoft Foundry), and Sidekick itself hosted in Azure"],
  ["Later", "Live meetings: joins calls, listens, raises a virtual hand, answers out loud (Azure AI Speech)"],
  ["Later", "Persona settings: voice, speaking style, participation mode, hand-raise triggers"],
];

export default function AgentPage() {
  const { me } = useApp();
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">AI models & agent</div>
          <h1>How Sidekick thinks</h1>
          <p>Each feature uses the Claude model below. To use a different model for a feature, ask the Sidekick team. Your documents and meetings are never used to train any model.</p>
        </div>
        <div className="actions"><Pill kind={me.claude.configured ? "good" : "warn"}>{me.claude.configured ? "Claude connected" : "Claude not connected"}</Pill></div>
      </div>
      <div className="grid g3">
        {Object.entries(me.claude.models).map(([k, model]) => (
          <div key={k} className="model">
            <span className="eyebrow">{ROLES[k]?.[0] ?? k}</span>
            <span className="name">{model}</span>
            <span className="muted">{ROLES[k]?.[1]}</span>
            <div className="stat-line"><span className="muted">Setting</span><span className="mono">SIDEKICK_MODEL_{k.toUpperCase()}</span></div>
          </div>
        ))}
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
