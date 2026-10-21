/**
 * One help-center guide (/docs/<name>), rendered from its Markdown (lib/help.ts → components/markdown.tsx)
 * with the list of guides beside it. Public. Every public guide is built ahead of time (generateStaticParams);
 * any other name, including paths like `..%2FPROGRESS`, gets the 404 page, because guides are looked up by
 * name in a fixed list and never read from disk.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { MarkdownBlocks } from "@/components/markdown";
import { PublicShell } from "@/components/public-shell";
import { guide, guides } from "@/lib/help";
import { metadataFor } from "@/lib/site";

/**
 * The page waits for its guide name before sending anything (no streamed shell), so an unknown name gets a
 * real 404 status instead of a 200 page that says "not found". The public guides are prebuilt anyway.
 */
export const instant = false;

/** The public guides, built at build time. */
export function generateStaticParams() {
  return guides().map((g) => ({ slug: g.slug }));
}

/** Title and description from the guide itself. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const g = guide((await params).slug);
  if (!g) return { title: "Not found · Sidekick" };
  return metadataFor({ title: `${g.title} · Sidekick help center`, description: g.summary.slice(0, 200) });
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const g = guide(slug);
  if (!g) notFound();
  return (
    <PublicShell layout="full" current="/docs">
      <div className="site-wrap site-docs">
        <nav className="site-docs-nav" aria-label="Guides">
          <span className="h">Guides</span>
          <Link href="/docs">All guides</Link>
          {guides().map((x) => <Link key={x.slug} href={`/docs/${x.slug}`} aria-current={x.slug === slug ? "page" : undefined}>{x.title}</Link>)}
          <Link href="/support">Support</Link>
        </nav>
        <article>
          <span className="site-eyebrow"><Link href="/docs" style={{ color: "inherit", textDecoration: "none" }}>Help center</Link></span>
          <h1 style={{ fontSize: 34, marginBottom: 16 }}>{g.title}</h1>
          <MarkdownBlocks blocks={g.blocks} />
          <div className="callout info" role="note" style={{ maxWidth: 760, marginTop: 24 }}>
            <span>Still stuck? <Link href="/support">Contact support</Link>.</span>
          </div>
        </article>
      </div>
    </PublicShell>
  );
}
