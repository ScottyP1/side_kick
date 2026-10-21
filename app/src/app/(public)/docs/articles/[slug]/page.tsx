/**
 * One public support article (/docs/articles/<slug>): a known issue and its fix, written by the Sidekick team in
 * the Owner Console (lib/support-articles.ts). Public. Only **published, public** articles are found here;
 * customer-only and internal articles, drafts and unknown names all get the 404 page.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { MarkdownBlocks } from "@/components/markdown";
import { PublicShell } from "@/components/public-shell";
import { helpLink } from "@/lib/help";
import { parseMarkdown, plainText } from "@/lib/markdown";
import { metadataFor } from "@/lib/site";
import { publicArticle } from "@/lib/support-articles";
import { BRAND } from "@/lib/brand";

// Articles live in the database, so the page is rendered per request and waits for the article (a real 404 for others).
export const instant = false;

/** Title and description from the article. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  await connection();
  const a = await publicArticle((await params).slug);
  if (!a) return { title: `Not found · ${BRAND.name}` };
  const first = parseMarkdown(a.body, helpLink).find((b) => b.t === "p");
  return metadataFor({ title: `${a.title} · ${BRAND.name} help center`, description: first && first.t === "p" ? plainText(first.c).slice(0, 200) : a.title });
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const a = await publicArticle((await params).slug);
  if (!a) notFound();
  return (
    <PublicShell narrow current="/docs">
      <span className="site-eyebrow"><Link href="/docs" style={{ color: "inherit", textDecoration: "none" }}>Help center</Link> · Support article</span>
      <h1 style={{ fontSize: 30, margin: 0 }}>{a.title}</h1>
      <MarkdownBlocks blocks={parseMarkdown(a.body, helpLink)} />
      <div className="callout info" role="note"><span>Still stuck? <Link href="/support">Contact support</Link>, or ask the help bot (the round button, bottom left).</span></div>
    </PublicShell>
  );
}
