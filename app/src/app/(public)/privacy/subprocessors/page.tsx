/**
 * Sub-processors (/privacy/subprocessors): the outside services that process customer data for Sidekick, from
 * lib/subprocessors.ts. Public (no sign-in; `src/proxy.ts` treats everything under /privacy as public), linked from
 * the privacy policy, the site footer and the help center. A plain-language draft for legal review (`DraftNote`).
 */
import type { Metadata } from "next";
import { DraftNote, PublicShell } from "@/components/public-shell";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { SUBPROCESSORS } from "@/lib/subprocessors";

export const metadata: Metadata = pageMetadata("/privacy/subprocessors");

export default function SubprocessorsPage() {
  return (
    <PublicShell narrow current="/privacy">
      <div className="page-head"><div><div className="eyebrow">Sub-processors</div><h1>Who processes data for {BRAND.name}</h1><p>Last updated October 25, 2026.</p></div></div>
      <DraftNote />
      <p style={{ margin: 0 }}>These services process customer data on {BRAND.name}&apos;s behalf. We tell customers before adding a new one. How {BRAND.name} itself handles data is in the <a href="/privacy">privacy policy</a>.</p>
      {SUBPROCESSORS.map((s) => (
        <div key={s.name} className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 style={{ margin: 0 }}>{s.name}</h2>
          <p className="muted" style={{ margin: 0 }}>{s.company} · {s.location}</p>
          {s.onlyWhen && <p style={{ margin: 0 }}><b>Only when</b>: {s.onlyWhen}</p>}
          <p style={{ margin: 0 }}><b>What for</b>: {s.purpose}</p>
          <p style={{ margin: 0 }}><b>Data it sees</b>: {s.data}</p>
          <p style={{ margin: 0 }}><a href={s.terms} target="_blank" rel="noreferrer">Their data protection terms</a></p>
        </div></div>
      ))}
      <p className="muted" style={{ margin: 0 }}>Not on this list: tools a group chooses to connect (for example Azure DevOps, Jira, Confluence, GitHub, SharePoint or OneDrive). They&apos;re your organization&apos;s own services; {BRAND.name} only reads from them, with the access your organization gives it. No payment provider yet: payments are in test mode.</p>
    </PublicShell>
  );
}
