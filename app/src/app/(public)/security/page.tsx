/**
 * Security & trust (/security): a hero line, a row of trust pillars with icons (walls, guardrails, sign-in,
 * encryption, audit log, backups and monitoring, AI training), a diagram of the walls (company → groups →
 * chats and documents, client guests seeing only Shareable material, another company fully separate), where
 * the data lives (Azure: app, Postgres database, search; no addresses), and the security questions from
 * lib/faq.ts. Public and static. The AI-training statement is marked as a draft for legal review, like the
 * privacy and terms pages.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { FaqList } from "@/components/faq-list";
import { PublicShell } from "@/components/public-shell";
import { WallsArt } from "@/components/site-art";
import { SiteIcon } from "@/components/site-icons";
import { faqFor } from "@/lib/faq";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = pageMetadata("/security");

const PILLARS: { icon: string; title: string; text: string; draft?: boolean }[] = [
  { icon: "groups", title: "Walls between companies and groups", text: "Nothing is shared between organizations, and each client group is walled off inside yours. Searches stay inside one group." },
  { icon: "shield", title: "Guardrails on every answer", text: `A locked safety floor plus your own rules, checked before ${BRAND.name} answers and again after. If it doesn't know, it says so.` },
  { icon: "lock", title: "Microsoft and two-step sign-in", text: "Sign in with Microsoft (which you can require), or a password plus a passkey or authenticator app." },
  { icon: "key", title: "Encrypted", text: `HTTPS only, including to the database. Data is encrypted at rest by Azure, and sign-in secrets are encrypted again by ${BRAND.name}.` },
  { icon: "audit", title: "An audit log you can read", text: "Sign-ins, role changes, chat links and rule changes are recorded with who and when. Traces hold timings, never document text." },
  { icon: "pulse", title: "Backups and monitoring", text: "Automatic database backups kept for 35 days, health checks, uptime alerts and a reference code on every error." },
  { icon: "spark", title: "Not used to train AI", text: `${BRAND.name}'s AI is Claude, through Anthropic's API, whose commercial terms say API data isn't used for training by default.`, draft: true },
];

export default function SecurityPage() {
  return (
    <PublicShell layout="full" current="/security">
      <div className="site-wrap site-glow">
        <div className="site-page-art">
          <div className="site-page-head">
            <span className="site-eyebrow">Security &amp; trust</span>
            <h1>Client work stays with the client it belongs to</h1>
            <p>Firms trust {BRAND.name} with many clients at once, so separation is built into everything it does.</p>
          </div>
          <WallsArt />
        </div>
      </div>

      <div className="site-wrap site-stack">
        <div className="site-pillars">
          {PILLARS.map((p) => (
            <div key={p.title} className="site-card site-pillar">
              <SiteIcon name={p.icon} />
              <h2>{p.title}</h2>
              <p>{p.text}</p>
              {p.draft && <span className="site-faq-note">Draft wording, pending legal review. Anthropic&apos;s own terms are what count.</span>}
            </div>
          ))}
        </div>
      </div>

      <section className="site-section alt" aria-labelledby="walls-title">
        <div className="site-wrap">
          <span className="site-eyebrow">How the walls work</span>
          <h2 id="walls-title">Every answer comes from one group</h2>
          <p className="site-lead">Each Teams chat belongs to exactly one group, and {BRAND.name} searches only that group before it ranks anything. Client guests only get material marked Shareable.</p>
          <Walls />
        </div>
      </section>

      <section className="site-section" aria-labelledby="where-title">
        <div className="site-wrap site-grid two" style={{ alignItems: "start" }}>
          <div>
            <span className="site-eyebrow">Where your data lives</span>
            <h2 id="where-title">In Microsoft Azure</h2>
            <p className="site-lead" style={{ marginBottom: 12 }}>{BRAND.name} runs entirely in Microsoft Azure. The pages load nothing from other websites: no trackers, ads or third-party scripts.</p>
            <p className="muted" style={{ margin: 0 }}>Org Owners and Org Admins can delete documents, meetings and whole groups at any time. To remove your whole organization, <Link href="/support">contact support</Link>.</p>
          </div>
          <ul className="site-where">
            <li><SiteIcon name="cloud" /><span><b>The {BRAND.name} app</b><small>Runs in Azure, HTTPS only</small></span></li>
            <li><SiteIcon name="db" /><span><b>Database</b><small>Azure Database for PostgreSQL, encrypted, backed up automatically</small></span></li>
            <li><SiteIcon name="map" /><span><b>Search index</b><small>Azure AI Search, filtered by company and group</small></span></li>
            <li><SiteIcon name="spark" /><span><b>AI answers</b><small>Claude by Anthropic; only the passages one answer needs</small></span></li>
          </ul>
        </div>
      </section>

      <div className="site-wrap site-narrow site-stack">
        <FaqList title="Security questions" items={faqFor("security")} />
        <div className="callout info" role="note">
          <span>More detail: <Link href="/docs/concepts#how-your-data-is-protected">how your data is protected</Link>, <Link href="/docs/roles-and-permissions">roles and permissions</Link> and the <Link href="/privacy">privacy policy</Link>. Found a security problem? Tell us on <Link href="/support">Support</Link>.</span>
        </div>
      </div>
    </PublicShell>
  );
}

/** The walls diagram: your company with two client groups, a guest who sees only Shareable, another company apart. */
function Walls() {
  return (
    <figure className="site-walls" aria-label="Diagram: your company holds separate groups, each with its own chats and documents; a client guest sees only Shareable documents; another company is completely separate.">
      <div className="site-walls-org">
        <div className="site-walls-label"><SiteIcon name="building" /><b>Your company</b></div>
        <div className="site-walls-groups">
          <div className="site-walls-group">
            <b>Payments Platform</b><small>Client: Northwind Bank</small>
            <div className="site-walls-items">
              <span>Team chat</span><span>Cutover plan</span><span className="share">Status deck · Shareable</span>
            </div>
            <div className="site-walls-guest"><span className="site-avatar">G</span><span>Client guest sees <b>Shareable</b> only</span></div>
          </div>
          <div className="site-walls-wall" aria-hidden="true"><span>wall</span></div>
          <div className="site-walls-group">
            <b>Store Rollout</b><small>Client: Fabrikam Retail</small>
            <div className="site-walls-items">
              <span>Team chat</span><span>Rates · Internal</span><span>Weekly sync notes</span>
            </div>
          </div>
        </div>
      </div>
      <div className="site-walls-wall big" aria-hidden="true"><span>wall</span></div>
      <div className="site-walls-org other">
        <div className="site-walls-label"><SiteIcon name="building" /><b>Another company</b></div>
        <small>Its own people, groups and data. Nothing is shared, ever.</small>
      </div>
      <figcaption className="site-demo-caption">Made-up example.</figcaption>
    </figure>
  );
}
