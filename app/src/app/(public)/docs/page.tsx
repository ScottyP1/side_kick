/**
 * Help center (/docs): the public guides (lib/help.ts; copied from docs/guide/ by scripts/sync-help.mjs) as
 * cards, a search box over every section of them (components/help-search.tsx, in the browser), and where to
 * go for anything else, plus the public support articles ("Known issues and fixes", lib/support-articles.ts,
 * read per request). Public; the rest is static. Only customer guides appear here: never the Owner Console guide,
 * developer docs, or customer-only and internal articles.
 */
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { HelpSearch } from "@/components/help-search";
import { PublicShell } from "@/components/public-shell";
import { HelpArt } from "@/components/site-art";
import { guides, helpSections } from "@/lib/help";
import { pageMetadata } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { publishedArticles } from "@/lib/support-articles";

/** The published public support articles (known issues and fixes), read per request inside a Suspense boundary. */
async function PublicArticles() {
  await connection();
  const list = await publishedArticles(["public"]);
  if (!list.length) return null;
  return (
    <section aria-labelledby="known-issues" className="site-stack">
      <h2 id="known-issues">Known issues and fixes</h2>
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
        {list.map((a) => <li key={a.id}><Link href={`/docs/articles/${a.slug}`}>{a.title}</Link></li>)}
      </ul>
    </section>
  );
}

export const metadata: Metadata = pageMetadata("/docs");

export default function HelpCenterPage() {
  const all = guides();
  return (
    <PublicShell layout="full" current="/docs">
      <div className="site-wrap site-glow">
        <div className="site-page-art">
          <div className="site-page-head">
            <span className="site-eyebrow">Help center</span>
            <h1>How can we help?</h1>
            <p>Plain-language guides for everyone who uses {BRAND.name}. New here? Start with <Link href="/docs/concepts">Concepts</Link>.</p>
          </div>
          <HelpArt />
        </div>
      </div>
      <div className="site-wrap site-stack">
        <HelpSearch sections={helpSections()}>
          <div className="site-grid two">
            {all.map((g) => (
              <Link key={g.slug} href={`/docs/${g.slug}`} className="site-card" style={{ textDecoration: "none", color: "var(--fg)" }}>
                <span className="pill accent nodot">{g.audience}</span>
                <h3>{g.title}</h3>
                <p>{g.summary}</p>
              </Link>
            ))}
          </div>
        </HelpSearch>
        <Suspense fallback={null}><PublicArticles /></Suspense>
        <div className="callout info" role="note">
          <span>Can&apos;t find it? <Link href="/support">Contact support</Link>, and include the reference code if you saw an error.</span>
        </div>
      </div>
    </PublicShell>
  );
}
