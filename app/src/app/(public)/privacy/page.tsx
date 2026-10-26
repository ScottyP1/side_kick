/**
 * Privacy policy (/privacy): plain-language draft, clearly marked for a lawyer to review (`DraftNote`).
 * Public (no sign-in, `src/proxy.ts`); it's also the `privacyUrl` of the Teams app package and the Teams Store
 * listing, which Microsoft requires to cover what is stored, retention, deletion, security and contact details.
 *
 * Every number and list comes from the code that enforces it, so the page can't drift from what Sidekick does:
 * retention and roll-off (lib/rolloff-policy.ts, lib/retention.ts `RETENTION`, lib/reminders.ts, lib/trace.ts),
 * the Microsoft 365 permissions and what each reads (lib/graph-permissions.ts), the Teams chat waiting period
 * (lib/teams/install.ts) and the per-person question limit (lib/rate-limit.ts). The sub-processor list is on
 * /privacy/subprocessors (lib/subprocessors.ts).
 */
import type { Metadata } from "next";
import { DraftNote, PublicShell } from "@/components/public-shell";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { BACKUP_RETENTION_DAYS, GROUP_DEFAULT_DAYS, MIN_GROUP_DAYS, ORG_GRACE_DAYS } from "@/lib/rolloff-policy";
import { APP_PERMISSIONS, CHAT_PERMISSIONS, DELEGATED_PERMISSIONS } from "@/lib/graph-permissions";
import { RETENTION } from "@/lib/retention";
import { CHAT_RETENTION_DAYS } from "@/lib/reminders";
import { TRACE_RETENTION_DAYS } from "@/lib/trace";
import { WAITING_DAYS } from "@/lib/teams/install";
import { ASK_PER_HOUR } from "@/lib/rate-limit";

export const metadata: Metadata = pageMetadata("/privacy");

/** The date this draft last changed (shown at the top; change it with the text). */
const UPDATED = "October 25, 2026";

const days = (table: string) => RETENTION.find((r) => r.table === table)?.days ?? 0;
const months = (d: number) => (d >= 360 ? `${Math.round(d / 30.8)} months` : `${d} days`);

/** A section heading and its body, the same spacing everywhere on the page. */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

const list = { margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 } as const;

export default function PrivacyPage() {
  return (
    <PublicShell narrow current="/privacy">
      <div className="page-head"><div><div className="eyebrow">Privacy policy</div><h1>How {BRAND.name} handles your data</h1><p>Last updated {UPDATED}.</p></div></div>
      <DraftNote />
      <div className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <Section id="short" title="The short version">
          <ul style={list}>
            <li>{BRAND.name} keeps your organization&apos;s content only to answer your own team, and walls each organization and each client group off from the others.</li>
            <li>The AI (Claude, by Anthropic) sees only what one task needs, and your content isn&apos;t used to train AI models.</li>
            <li>{BRAND.name} only reads Microsoft 365 and Teams with the permissions your admin approves, and never changes anything there except the few settings listed below.</li>
            <li>When a client engagement ends, or your organization leaves, the data is deleted on a date you can see, and you get a deletion certificate.</li>
            <li>We don&apos;t sell data, show ads or share it with anyone except the services listed on the <a href="/privacy/subprocessors">sub-processor list</a>.</li>
          </ul>
        </Section>

        <Section id="who" title="Who runs it and how to reach us">
          <p style={{ margin: 0 }}>{BRAND.name} is a personal project run by one person (the &quot;{BRAND.name} team&quot;). It isn&apos;t a company yet. For privacy questions or requests, write to <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a> or use the <a href="/support">Support</a> page.</p>
          <p style={{ margin: 0 }}>Your organization (the customer that signs up) decides who uses {BRAND.name} and what goes into it, so for the content your organization puts in, it is in charge and {BRAND.name} processes it on its behalf.</p>
        </Section>

        <Section id="what" title="What we store">
          <ul style={list}>
            <li><b>People</b>: names, work emails, job titles and roles of the people your organization adds, and their Microsoft account id once they sign in with Microsoft or are imported. Passwords are stored only as one-way hashes; two-step sign-in secrets are encrypted.</li>
            <li><b>Group content</b>: documents you upload, meeting transcripts and the notes, decisions and action items written from them, questions asked and the answers given, items saved to a group&apos;s knowledge, and your firm library.</li>
            <li><b>Teams chat messages</b>: only in chats and channels a Team Lead or admin has assigned to a group, kept {CHAT_RETENTION_DAYS} days.</li>
            <li><b>Connected tools</b>: when a group connects a tool (for example Azure DevOps, Jira, GitHub, Confluence, or SharePoint and OneDrive files), the work items, pages and files that connection can read. Connections are read-only; their sign-in tokens are encrypted, and no passwords are stored.</li>
            <li><b>Records</b>: who did what (audit log), AI usage and cost, guardrail counts, and technical traces (timings and counts, never document text).</li>
            <li><b>Billing</b>: your plan and its status. Payments are in test mode, so no payment details are collected; later, card payments would be handled by a payment provider on its own page, and {BRAND.name} would never see card numbers.</li>
          </ul>
        </Section>

        <Section id="microsoft" title="What we read from Microsoft 365 and Teams, and why">
          <p style={{ margin: 0 }}>A Microsoft 365 admin of your organization approves {BRAND.name} once (Microsoft&apos;s admin consent). Each permission can be checked on Settings → Microsoft permissions in {BRAND.name}, and withdrawn at any time in Microsoft Entra (Enterprise applications). These are all of them:</p>
          <ul style={list}>
            {APP_PERMISSIONS.map((p) => <li key={p.id}><b>{p.name}</b> <span className="muted">({p.id})</span>: {p.what}</li>)}
          </ul>
          <p style={{ margin: 0 }}>In Teams itself, the person who adds {BRAND.name} to a chat or team grants two per-chat permissions:</p>
          <ul style={list}>
            {CHAT_PERMISSIONS.map((p) => <li key={p.id}><b>{p.name}</b> <span className="muted">({p.id})</span>: {p.what}</li>)}
          </ul>
          <p style={{ margin: 0 }}>Signing in with Microsoft uses two more, for the person signing in only: {DELEGATED_PERMISSIONS.map((p, i) => <span key={p.id}>{i ? "; " : ""}<b>{p.name}</b> <span className="muted">({p.id})</span>: {p.what}</span>)}</p>
          <p style={{ margin: 0 }}>Only a Team Lead or admin may add {BRAND.name} to a chat. Until the chat is assigned to a group, {BRAND.name} reads, keeps and answers nothing there, and it leaves the chat if nobody assigns it within {WAITING_DAYS} days.</p>
        </Section>

        <Section id="transcripts" title="Meeting transcripts">
          <ul style={list}>
            <li>{BRAND.name} never joins or records a call itself. When automatic notes are on, it reads the transcript Microsoft Teams made, after the meeting, to write the notes.</li>
            <li>It only takes meetings that clearly belong to one of your groups (the meeting chat is linked to the group, or enough of the group&apos;s people were there). For any other meeting only Microsoft&apos;s ids, the title and the time are kept, so an admin or Team Lead can pick the right group or leave it.</li>
            <li>The transcript is kept with the meeting&apos;s notes in that group until someone deletes the meeting or the group ends.</li>
            <li>Turning on Record and transcribe automatically is a separate, optional switch, and is never used on meetings with people from outside your organization.</li>
          </ul>
        </Section>

        <Section id="walls" title="Walls between organizations and groups">
          <ul style={list}>
            <li>Every record belongs to one organization. The database enforces this with row-level security: each request can only read and write its own organization&apos;s rows, on top of the checks in the application.</li>
            <li>Inside an organization, each group (one per client engagement) is walled off: people see only the groups they belong to, in the portal, in Teams and in the tab. A group&apos;s Teams chats, meetings and connected tools feed only that group.</li>
            <li>In chats with guests from other companies, answers only use content marked as shareable.</li>
            <li>The {BRAND.name} team sees counts and usage for support and billing, not your documents.</li>
          </ul>
        </Section>

        <Section id="ai" title="Powered by Claude: how the AI is used">
          <ul style={list}>
            <li>Answers, meeting notes and reminders are written by Claude, Anthropic&apos;s AI model, through Anthropic&apos;s commercial API. Claude sees only what one task needs, for example the few passages that answer one question, or one meeting&apos;s transcript.</li>
            <li>Your content is not used to train AI models: Anthropic&apos;s commercial terms say API data isn&apos;t used for training, and {BRAND.name} doesn&apos;t train models either.</li>
            <li>To find the right passages, {BRAND.name} builds a search index of each group&apos;s content. When the cloud search is on, short passages are turned into search vectors by an embedding model in Microsoft Azure.</li>
            <li>AI answers can be wrong. Every answer shows its sources so people can check them, and anyone can mark a bad answer with the 👎 button (only the count is kept) or report it to Support.</li>
          </ul>
        </Section>

        <Section id="guardrails" title="Guardrails">
          <p style={{ margin: 0 }}>Every question is checked before it&apos;s answered and every answer on the way out. A fixed floor nobody can switch off: no hateful, harassing or sexual content, no help with harming people, never another group&apos;s or organization&apos;s data, no talking {BRAND.name} out of its rules, and answers only from sources (&quot;I don&apos;t know&quot; instead of guessing). Org Owners and Admins can add stricter rules. {BRAND.name} counts how often each rule fires, but never keeps the question or answer text for that. Each person can ask up to {ASK_PER_HOUR} questions an hour.</p>
        </Section>

        <Section id="retention" title="How long we keep it, and deletion">
          <ul style={list}>
            <li><b>While you use {BRAND.name}</b>: group content is kept until you delete it or the group ends. Saved Teams messages are kept {CHAT_RETENTION_DAYS} days, technical traces {TRACE_RETENTION_DAYS} days, server errors {days("app_errors")} days, guardrail counts {months(days("guard_events"))}, and the audit log and AI usage {months(days("audit_log"))}. Sign-in sessions and sign-ins in progress are deleted once they expire.</li>
            <li><b>When an engagement ends</b>: an Org Owner or Org Admin sets its group to end. It becomes read-only straight away and can be downloaded; on the date they pick ({GROUP_DEFAULT_DAYS} days by default, at least {MIN_GROUP_DAYS}) everything in the group is deleted, including its search index.</li>
            <li><b>When your organization leaves</b>: after a plan is canceled, {BRAND.name} stays usable until the end of what was paid for, then read-only for {ORG_GRACE_DAYS} days so admins can download everything. Then all of the organization&apos;s data is deleted: groups and their content, people and their sign-in details, Teams links, settings, usage details and the audit log.</li>
            <li><b>Deletion certificate</b>: each deletion produces a certificate listing which kinds of data were deleted and how many, when and at whose request. It contains no content. We keep it, with the organization&apos;s name and the dates, as the record of the deletion and for billing history.</li>
            <li><b>Backups</b>: our database provider keeps backups for {BACKUP_RETENTION_DAYS} days, so deleted data is gone from backups within {BACKUP_RETENTION_DAYS} days of the deletion. Backups are only used to recover from a failure.</li>
          </ul>
        </Section>

        <Section id="security" title="Security">
          <p style={{ margin: 0 }}>{BRAND.name} runs in Microsoft Azure data centers in the United States. Traffic is encrypted in transit (HTTPS), the database is encrypted at rest by Azure, secrets are kept in Azure Key Vault, and connector tokens are encrypted again by {BRAND.name}. Sign-in supports Microsoft accounts, passkeys and two-step codes, and an organization can require two-step sign-in for everyone. More on the <a href="/security">Security</a> page.</p>
        </Section>

        <Section id="sharing" title="Who else sees it">
          <p style={{ margin: 0 }}>The services {BRAND.name} runs on process data on our behalf, under their own security and privacy commitments: see the <a href="/privacy/subprocessors">sub-processor list</a>. We tell customers before adding a new one. We don&apos;t sell data or show ads, and we&apos;d only hand data to authorities when the law requires it, telling the customer unless we&apos;re not allowed to.</p>
        </Section>

        <Section id="choices" title="Your choices">
          <p style={{ margin: 0 }}>Org Owners and Org Admins can download or delete documents, meetings and whole groups at any time, download all of the organization&apos;s data from Settings, remove {BRAND.name} from any chat, and withdraw the Microsoft 365 approval. People who want to see, correct or delete what {BRAND.name} holds about them can ask their organization&apos;s admin, or write to Support and we&apos;ll work with their organization. To have your organization&apos;s data deleted sooner, contact Support.</p>
        </Section>

        <Section id="changes" title="Changes to this policy">
          <p style={{ margin: 0 }}>When this policy changes, the date at the top changes, and for important changes we tell Org Owners before they take effect.</p>
        </Section>
      </div></div>
    </PublicShell>
  );
}
