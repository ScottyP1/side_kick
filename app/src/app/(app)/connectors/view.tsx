"use client";

/**
 * Connectors (/connectors): the tools Sidekick reads from. Uploads, transcript import and Teams (chats and channels
 * assigned on each group's page) work today, and so do **Azure DevOps Boards, Jira, GitHub Issues, Confluence and
 * Microsoft 365 files** (read-only, each with its own sign-in; the SharePoint and OneDrive tiles are the same
 * Microsoft 365 connector): their tiles show Connected / Allowed / Needs attention / Sign-in expired / Requested /
 * Not allowed and jump to their panel below (./tools.tsx: the Org Owner's allow switch, each group's connection,
 * requests from Team Leads, health, linked projects). The other tools are planned. Says how many connectors
 * the organization's plan includes (lib/plans.ts `connectors`: none, one, or all), from /api/me. Tile icons:
 * components/connector-icons.tsx.
 * Who: Org Owners/Admins and Team Leads (like GET /api/connectors). Members and Viewers get a message instead: each
 * group's page lists the tools that feed it ("Sources").
 */

import { useApp } from "@/components/shell";
import { Pill } from "@/components/ui";
import { CONNECTOR_ICONS } from "@/components/connector-icons";
import { BRAND } from "@/lib/brand";
import { KINDS, toolPill, ToolPanels, useConnectors } from "./tools";

const APPS: { name: string; g: string; mono: string; bg: string; fg?: string; desc: string; live?: boolean; tool?: (typeof KINDS)[number] }[] = [
  { name: "Document upload", g: "Available now", mono: "⇪", bg: "var(--accent)", desc: "PDF, Word, PowerPoint, text, Teams transcripts", live: true },
  { name: "Teams transcripts", g: "Available now", mono: "T", bg: "#5B5FC7", desc: "Import .vtt or .docx from meeting recaps", live: true },
  { name: "Outlook", g: "Microsoft 365", mono: "O", bg: "#0F6CBD", desc: "Calendar and email" },
  { name: "Teams chats and channels", g: "Available now", mono: "T", bg: "#5B5FC7", desc: "Assign them on each group's page", live: true },
  { name: "SharePoint", g: "Microsoft 365", mono: "S", bg: "#038387", desc: "Document libraries and folders, read-only", tool: "m365" },
  { name: "OneDrive", g: "Microsoft 365", mono: "OD", bg: "#0364B8", desc: "Shared folders, read-only", tool: "m365" },
  { name: "Planner", g: "Microsoft 365", mono: "P", bg: "#31752F", desc: "Tasks and plans" },
  { name: "Azure DevOps", g: "Engineering", mono: "DO", bg: "#0078D4", desc: "Boards: work items, read-only", tool: "ado" },
  { name: "GitHub", g: "Engineering", mono: "GH", bg: "#24292F", desc: "Issues and pull requests, read-only", tool: "github" },
  { name: "Jira", g: "Work & docs", mono: "J", bg: "#0052CC", desc: "Issues, read-only", tool: "jira" },
  { name: "Confluence", g: "Work & docs", mono: "C", bg: "#1868DB", desc: "Spaces and pages, read-only", tool: "confluence" },
  { name: "ServiceNow", g: "Business apps", mono: "SN", bg: "#1F3D3A", desc: "Incidents and changes" },
  { name: "Salesforce", g: "Business apps", mono: "SF", bg: "#00A1E0", desc: "Accounts and opportunities" },
];
const GROUPS = ["Available now", "Microsoft 365", "Engineering", "Work & docs", "Business apps"];

/** The page: Org Owners/Admins and Team Leads get the connectors; Members and Viewers a pointer to their group's sources. */
export default function ConnectorsPage() {
  const { me } = useApp();
  if (!me.user.admin && !me.user.lead) return <div className="callout bad">Only Org Owners, Org Admins and Team Leads can open Connectors. Each group&apos;s page shows which tools feed it.</div>;
  return <Connectors />;
}

/** Connectors for Org Owners/Admins and Team Leads. */
function Connectors() {
  const { me } = useApp();
  const { data, load } = useConnectors();
  const included = me.plan?.connectors;
  const yours = me.plan?.name ? `Your ${me.plan.name} plan` : "Your plan";
  const planText = included === undefined ? null
    : included === null ? `${yours} includes every connector.`
    : included === 0 ? `${yours} doesn't include connectors to other tools; Team includes one and Business all of them.`
    : `${yours} allows ${included} type${included === 1 ? "" : "s"} of tool (Azure DevOps, Jira, GitHub, Confluence or Microsoft 365 files: SharePoint and OneDrive count as one); Business includes all of them.`;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Connectors</div>
          <h1>Give {BRAND.name} access to your tools</h1>
          <p>Uploads, transcript import, Teams chats and channels, SharePoint and OneDrive files, Azure DevOps Boards, Jira, GitHub Issues and Confluence work today. The Org Owner chooses which tools the organization allows; each Team Lead then connects an allowed tool for their group with the account the client gives them (read-only, no passwords stored), or asks for one that isn&apos;t allowed. The other tools are planned.</p>
          {planText && <p className="muted">{planText}</p>}
        </div>
      </div>
      {GROUPS.map((g) => (
        <section key={g} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="eyebrow">{g}</div>
          <div className="app-grid">
            {APPS.filter((a) => a.g === g).map((a) => {
              const inner = (
                <>
                  <span className="app-ico" style={{ background: a.bg, color: a.fg ?? "#fff", width: 48, height: 48, fontSize: 17 }} aria-hidden="true">{CONNECTOR_ICONS[a.name] ?? a.mono}</span>
                  <b>{a.name}</b>
                  <span className="muted">{a.desc}</span>
                  {a.tool ? toolPill(a.tool, data, included) : a.live ? <Pill kind="good">Ready</Pill> : <Pill>Planned</Pill>}
                </>
              );
              // The connectable tools jump to their panel below (connect, health, linked projects).
              return a.tool ? (
                <a key={a.name} href={`#tool-${a.tool}`} className={`app-tile${data?.allowed.includes(a.tool) ? " on" : ""}`}>{inner}</a>
              ) : (
                <div key={a.name} className={`app-tile${a.live ? " on" : ""}`} style={{ cursor: "default" }}>{inner}</div>
              );
            })}
          </div>
        </section>
      ))}
      <ToolPanels data={data} load={load} />
    </>
  );
}
