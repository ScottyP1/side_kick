"use client";

/**
 * AI models & agent (/agent): which Claude model each feature uses and how Sidekick is instructed to behave.
 * Models are changed with SIDEKICK_MODEL_* settings in app/.env.local (see lib/claude.ts).
 */

import { useApp } from "@/components/shell";
import { Pill } from "@/components/ui";

const ROLES: Record<string, [string, string]> = {
  extract: ["Meeting notes", "Reads a transcript and writes the summary, decisions, action items, open questions and facts."],
  ask: ["Answering questions", "Answers from this workspace's documents and meetings only, with a source for every claim."],
  insights: ["Knowledge map", "Groups what the team knows into topics, scores coverage and finds gaps."],
};

export default function AgentPage() {
  const { me } = useApp();
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">AI models & agent</div>
          <h1>How Sidekick thinks</h1>
          <p>Each feature uses a Claude model you can change in <code>app/.env.local</code>. Your documents and meetings are never used to train any model.</p>
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
        <div className="panel-h"><h2>Coming in steps 2–3</h2></div>
        <div className="list">
          {[
            ["Step 2", "Sidekick in Teams chat: @Sidekick questions in channels, notes posted automatically, draft Jira / Azure DevOps stories"],
            ["Step 2", "Microsoft sign-in, Azure-hosted Claude (Microsoft Foundry), Azure AI Search with meaning-based search"],
            ["Step 3", "Live meetings: joins calls, listens, raises a virtual hand, answers out loud (Azure AI Speech)"],
            ["Step 3", "Persona settings: voice, speaking style, participation mode, hand-raise triggers"],
          ].map(([s, t], i) => (
            <div key={i} className="li"><Pill kind="info" nodot>{s}</Pill><div className="grow">{t}</div></div>
          ))}
        </div>
      </div>
    </>
  );
}
