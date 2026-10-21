"use client";

/**
 * Connectors (/connectors): the tools Sidekick will read from (Outlook, SharePoint, Jira, ...).
 * Uploads, transcript import and Teams (chats and channels assigned on each group's page) work today; the
 * other tools are planned and will each connect with their own sign-in.
 */

import { Pill } from "@/components/ui";

const APPS: { name: string; g: string; mono: string; bg: string; fg?: string; desc: string; live?: boolean }[] = [
  { name: "Document upload", g: "Available now", mono: "⇪", bg: "var(--accent)", desc: "PDF, Word, text, Teams transcripts", live: true },
  { name: "Teams transcripts", g: "Available now", mono: "T", bg: "#5B5FC7", desc: "Import .vtt or .docx from meeting recaps", live: true },
  { name: "Outlook", g: "Microsoft 365", mono: "O", bg: "#0F6CBD", desc: "Calendar and email" },
  { name: "Teams chats and channels", g: "Available now", mono: "T", bg: "#5B5FC7", desc: "Assign them on each group's page", live: true },
  { name: "SharePoint", g: "Microsoft 365", mono: "S", bg: "#038387", desc: "Sites and document libraries" },
  { name: "OneDrive", g: "Microsoft 365", mono: "OD", bg: "#0364B8", desc: "Shared files and folders" },
  { name: "Planner", g: "Microsoft 365", mono: "P", bg: "#31752F", desc: "Tasks and plans" },
  { name: "Azure DevOps", g: "Engineering", mono: "DO", bg: "#0078D4", desc: "Boards, Repos, Pipelines" },
  { name: "GitHub", g: "Engineering", mono: "GH", bg: "#24292F", desc: "Issues, PRs, Actions" },
  { name: "Jira", g: "Work & docs", mono: "J", bg: "#0052CC", desc: "Issues and sprints" },
  { name: "Confluence", g: "Work & docs", mono: "C", bg: "#1868DB", desc: "Spaces and pages" },
  { name: "ServiceNow", g: "Business apps", mono: "SN", bg: "#1F3D3A", desc: "Incidents and changes" },
  { name: "Salesforce", g: "Business apps", mono: "SF", bg: "#00A1E0", desc: "Accounts and opportunities" },
];
const GROUPS = ["Available now", "Microsoft 365", "Engineering", "Work & docs", "Business apps"];

export default function ConnectorsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Connectors</div>
          <h1>Give Sidekick access to your tools</h1>
          <p>Uploads, transcript import and Teams chats and channels work today. The other tools are planned; each will connect with its own sign-in (no passwords stored).</p>
        </div>
      </div>
      {GROUPS.map((g) => (
        <section key={g} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="eyebrow">{g}</div>
          <div className="app-grid">
            {APPS.filter((a) => a.g === g).map((a) => (
              <div key={a.name} className={`app-tile${a.live ? " on" : ""}`} style={{ cursor: "default" }}>
                <span className="app-ico" style={{ background: a.bg, color: a.fg ?? "#fff", width: 48, height: 48, fontSize: 17 }} aria-hidden="true">{a.mono}</span>
                <b>{a.name}</b>
                <span className="muted">{a.desc}</span>
                {a.live ? <Pill kind="good">Ready</Pill> : <span className="app-cta" style={{ opacity: 0.8 }}>Planned</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
